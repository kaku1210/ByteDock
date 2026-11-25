// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import { decodeAntigravityStepToolCall } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// CORTEX_STEP_TYPE_PLANNER_RESPONSE: the model answered within this turn.
const PLANNER_RESPONSE_STEP_TYPE = 15;
// CORTEX_STEP_TYPE_RUN_COMMAND: shell commands that can outlive the ACP wire update.
const RUN_COMMAND_STEP_TYPE = 21;
// CORTEX_STEP_TYPE_GENERIC: includes native `schedule` waits (status = 2 while waiting).
const GENERIC_STEP_TYPE = 132;
const STEP_STATUS_PENDING = 1;
const STEP_STATUS_RUNNING = 2;
const MAX_ACTIVE_WAIT_ROWS = 32;
const MAX_ACTIVE_WAIT_BLOB_BYTES = 256 * 1024;
// The harness error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
// The Go harness's rendering of a Google API error, as the agent's api_errors.py reads it.
// Status is a gRPC code, or an HTTP status line such as "502 Bad Gateway". A message
// stops at the next error, so each start scans its own span and the match stays linear.
const API_ERROR =
  /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s;
// Antigravity 1.5 with a Google account writes "STATUS (code NNN): message".
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
// Newer Antigravity builds attach the HTTP JSON body (pretty-printed or compact) to the error step.
const ERROR_JSON_START = /\{\s*"error"\s*:/g;
const decodeVerificationError = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        code: Schema.Literal(403),
        status: Schema.Literal("PERMISSION_DENIED"),
        details: Schema.Array(Schema.Unknown),
      }),
    }),
  ),
);
const decodeVerificationErrorInfo = Schema.decodeUnknownOption(
  Schema.Struct({
    "@type": Schema.Literal("type.googleapis.com/google.rpc.ErrorInfo"),
    domain: Schema.Literal("cloudcode-pa.googleapis.com"),
    reason: Schema.Literal("VALIDATION_REQUIRED"),
    metadata: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ validation_url: Schema.optionalKey(Schema.Unknown) })),
    ),
  }),
);
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
// Claude rejects a saved thinking block without a valid signature. It sits in the native
// history, so every later prompt to that session fails the same way.
const INVALID_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
// google.rpc.RetryInfo, which plain rate limits carry instead of a quota reset.
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
// Antigravity 1.5 may state the reset only in the message: "... Resets in 4m42s.".
const RESETS_IN = /\bResets in ((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?!\w|\.\d)/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]+$/;
const TRANSIENT_GATEWAY_STATUSES = new Set(["502", "503", "504"]);
const decodeDaemonArg = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ IsDaemon: Schema.optional(Schema.Boolean) })),
);

interface LastStep {
  readonly type: number;
  readonly payload: Uint8Array | null;
  readonly reachedModel: boolean;
}

class AntigravitySessionLogError extends Schema.TaggedError<AntigravitySessionLogError>()(
  "AntigravitySessionLogError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity session log.";
  }
}

const sessionLogError = (cause: unknown) => new AntigravitySessionLogError({ cause });

const readSteps = <A>(file: string, read: (database: NodeSqlite.DatabaseSync) => A) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        return hasSteps ? read(database) : undefined;
      } finally {
        database.close();
      }
    },
    catch: sessionLogError,
  });

const lastStepIndex = (database: NodeSqlite.DatabaseSync) => {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
};

const lastStepAfter =
  (index: number) =>
  (database: NodeSqlite.DatabaseSync): LastStep | undefined => {
    const row = database
      .prepare(
        `SELECT step_type AS type, substr(step_payload, 1, ?) AS payload
         FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      )
      .get(MAX_ERROR_PAYLOAD_BYTES, index);
    if (typeof row?.type !== "number") return undefined;
    const reachedModel =
      database
        .prepare("SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1")
        .get(index, PLANNER_RESPONSE_STEP_TYPE) !== undefined;
    return {
      type: row.type,
      payload: row.payload instanceof Uint8Array ? row.payload : null,
      reachedModel,
    };
  };

const hasActiveWaitAfter =
  (index: number) =>
  (database: NodeSqlite.DatabaseSync): boolean => {
    const columns = new Set(
      database
        .prepare("PRAGMA table_info(steps)")
        .all()
        .flatMap((row) =>
          row !== null && typeof row === "object" && "name" in row && typeof row.name === "string"
            ? [row.name]
            : [],
        ),
    );
    if (!columns.has("status") || !columns.has("step_type")) return false;
    const hasMetadata = columns.has("metadata");
    const hasPayload = columns.has("step_payload");
    const selectColumns = [
      "step_type AS type",
      hasMetadata
        ? "CASE WHEN length(metadata) <= ? THEN metadata END AS metadata"
        : "NULL AS metadata",
      hasPayload
        ? "CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload"
        : "NULL AS step_payload",
    ].join(", ");
    const bindArgs: Array<number> = [];
    if (hasMetadata) bindArgs.push(MAX_ACTIVE_WAIT_BLOB_BYTES);
    if (hasPayload) bindArgs.push(MAX_ACTIVE_WAIT_BLOB_BYTES);
    bindArgs.push(
      index,
      STEP_STATUS_PENDING,
      STEP_STATUS_RUNNING,
      RUN_COMMAND_STEP_TYPE,
      GENERIC_STEP_TYPE,
      MAX_ACTIVE_WAIT_ROWS,
    );
    const rows = database
      .prepare(
        `SELECT ${selectColumns}
         FROM steps
         WHERE idx > ? AND status IN (?, ?) AND step_type IN (?, ?)
         ORDER BY idx DESC
         LIMIT ?`,
      )
      .iterate(...bindArgs);
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const type = "type" in row ? Number(row.type) : 0;
      const metadata =
        "metadata" in row && row.metadata instanceof Uint8Array ? row.metadata : undefined;
      const payload =
        "step_payload" in row && row.step_payload instanceof Uint8Array
          ? row.step_payload
          : undefined;
      const toolCall = decodeAntigravityStepToolCall({ metadata, payload });
      const isDaemon =
        toolCall?.argumentsJson !== undefined &&
        Option.getOrUndefined(decodeDaemonArg(toolCall.argumentsJson))?.IsDaemon === true;
      if (isDaemon) continue;
      if (type === GENERIC_STEP_TYPE) {
        if (toolCall?.name === "schedule") return true;
        continue;
      }
      if (type === RUN_COMMAND_STEP_TYPE) {
        return true;
      }
    }
    return false;
  };

function resetAtFrom(text: string, now: DateTime.Utc | undefined): string | undefined {
  // makeProviderFailure drops a timestamp that does not parse, so fall back to the delay.
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && Option.isSome(DateTime.make(timestamp))) return timestamp;
  const delay =
    RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1] ?? RESETS_IN.exec(text)?.[1];
  if (delay === undefined || now === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })) : undefined;
}

// Reorders STATUS_ERROR's groups to API_ERROR's: HTTP status, message, status name.
function statusError(text: string) {
  const match = STATUS_ERROR.exec(text);
  return match === null ? null : ([match[0], match[2], match[3], match[1]] as const);
}

function balancedJsonObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function verificationErrorInfo(text: string) {
  for (const match of text.matchAll(ERROR_JSON_START)) {
    const json = balancedJsonObject(text, match.index);
    if (json === undefined) continue;
    const response = Option.getOrUndefined(decodeVerificationError(json));
    if (response === undefined) continue;
    for (const detail of response.error.details) {
      const info = Option.getOrUndefined(decodeVerificationErrorInfo(detail));
      if (info !== undefined) return info;
    }
  }
  return undefined;
}

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc | undefined,
  options?: { readonly retired?: boolean; readonly earlyCheck?: boolean },
):
  | {
      readonly failure: OrchestrationV2ProviderFailure;
      readonly threadDisposition: "reusable" | "broken";
      readonly resumeWith?: string;
      readonly maxResumes?: number;
      readonly resumeDelay?: "2 seconds";
    }
  | undefined {
  const errorText =
    step?.type === ERROR_STEP_TYPE
      ? new TextDecoder().decode(step.payload ?? new Uint8Array())
      : undefined;
  if (options?.earlyCheck === true) {
    if (errorText === undefined) return undefined;
    const apiError = API_ERROR.exec(errorText) ?? statusError(errorText);
    if (apiError === null) return undefined;
    const [, httpStatus, message, status] = apiError;
    if (Number(httpStatus) < 500) return undefined;
    return {
      failure: makeProviderFailure({
        class: "provider_error",
        message: message!.trim(),
        code: status ?? null,
        retryable: true,
      }),
      threadDisposition: "reusable",
    };
  }
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  const apiError = API_ERROR.exec(text) ?? statusError(text);
  const reusable = (failure: OrchestrationV2ProviderFailure) =>
    ({ failure, threadDisposition: "reusable" }) as const;
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    return reusable(
      makeProviderFailure({
        class: "usage_limit",
        message: "You have reached your Antigravity quota for this period.",
        code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
        retryable: true,
        resetAt: resetAtFrom(text, now) ?? null,
      }),
    );
  }
  if (INVALID_THINKING_SIGNATURE.test(text)) {
    return {
      failure: makeProviderFailure({
        class: "provider_error",
        message:
          "Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.",
        code: "INVALID_THINKING_SIGNATURE",
        retryable: true,
      }),
      threadDisposition: "broken",
    };
  }
  const verification = verificationErrorInfo(text);
  if (verification !== undefined) {
    return reusable(
      makeProviderFailure({
        class: "permission_error",
        message: "Verify your Google account, then retry this turn.",
        code: "VALIDATION_REQUIRED",
        retryable: false,
        verificationUrl: verification.metadata?.validation_url,
      }),
    );
  }
  if (apiError === null) {
    return reusable(
      makeProviderFailure({
        class: "provider_error",
        message: "Antigravity stopped this turn because of an error.",
      }),
    );
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  // A 404 before the model answered is an unknown or unentitled model; after, a transient edge error.
  const transientNotFound = httpStatus === "404" && step?.reachedModel === true;
  const transientGatewayError =
    httpStatus !== undefined && TRANSIENT_GATEWAY_STATUSES.has(httpStatus);
  const failure = makeProviderFailure({
    class: rateLimited ? "usage_limit" : "provider_error",
    message: message!.trim(),
    code: status ?? null,
    retryable: rateLimited || transientNotFound || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, now) ?? null,
  });
  if (options?.retired === true) {
    return reusable(failure);
  }
  if (transientNotFound) {
    return { failure, threadDisposition: "reusable", resumeWith: "continue" };
  }
  if (transientGatewayError) {
    return {
      failure,
      threadDisposition: "reusable",
      resumeWith: "continue",
      maxResumes: 2,
      resumeDelay: "2 seconds",
    };
  }
  return reusable(failure);
}

const conversationSegments = ["antigravity-acp", "conversations"];

interface VerifiedSessionBaseline {
  readonly root: string;
  readonly segments: ReadonlyArray<string>;
  readonly identity: Awaited<ReturnType<typeof antigravityManagedPath>> extends infer R
    ? R extends { readonly info: infer I }
      ? I | undefined
      : never
    : never;
  readonly startIndex: number;
}

const snapshotSessionBaseline = Effect.fn("AntigravityTurnOutcome.snapshotBaseline")(function* (
  profileDirectory: string,
  sessionId: string,
): Effect.fn.Return<VerifiedSessionBaseline | undefined> {
  if (!NATIVE_SESSION_ID.test(sessionId)) return undefined;
  const segments = [...conversationSegments, `${sessionId}.db`];
  const before = yield* Effect.tryPromise({
    try: async () => {
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      if ((await antigravityManagedPath(root, conversationSegments, "directory")) === undefined) {
        return undefined;
      }
      const database = await antigravityManagedPath(root, segments, "file");
      // A path that exists but fails the proof is a link or other foreign entry.
      if (database === undefined) {
        const present = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
          () => true,
          () => false,
        );
        return present ? undefined : { root, identity: undefined, startIndex: -1 };
      }
      return { root, identity: database.info, startIndex: undefined };
    },
    catch: sessionLogError,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (before === undefined) {
    yield* Effect.logWarning("The Antigravity session log is not this session's own file.");
    return undefined;
  }
  const startIndex =
    before.startIndex ??
    (yield* readSteps(NodePath.join(before.root, ...segments), lastStepIndex).pipe(
      Effect.map((index) => index ?? -1),
      Effect.orElseSucceed(() => undefined),
    ));
  if (startIndex === undefined) {
    yield* Effect.logWarning("Could not read the Antigravity session log before the prompt.");
    return undefined;
  }
  return {
    root: before.root,
    segments,
    identity: before.identity,
    startIndex,
  };
});

const verifyBaselineFile = (baseline: VerifiedSessionBaseline) =>
  Effect.tryPromise({
    try: () => antigravityManagedPath(baseline.root, baseline.segments, "file"),
    catch: sessionLogError,
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.map((after) => {
      const sameFile =
        after !== undefined &&
        (baseline.identity === undefined ||
          (after.info.dev === baseline.identity.dev && after.info.ino === baseline.identity.ino));
      return sameFile ? after.path : undefined;
    }),
  );

/**
 * Antigravity reports an upstream API failure as a chat message and `end_turn`. Its
 * session log ends that turn with an error step, so the check reads only steps the
 * current prompt added, read-only, from this session's own unlinked database. Without
 * that evidence a typed `refusal` still fails the turn.
 */
export const watchAntigravityPromptOutcome = Effect.fn("AntigravityTurnOutcome.watch")(function* (
  profileDirectory: string,
  sessionId: string,
) {
  const typedOnly = (
    result: EffectAcpSchema.PromptResponse,
    options?: { readonly retired?: boolean; readonly earlyCheck?: boolean },
  ) =>
    DateTime.now.pipe(Effect.map((now) => turnFailure(result.stopReason, undefined, now, options)));
  const baseline = yield* snapshotSessionBaseline(profileDirectory, sessionId);
  if (baseline === undefined) return typedOnly;
  return Effect.fn("AntigravityTurnOutcome.check")(function* (
    result: EffectAcpSchema.PromptResponse,
    options?: { readonly retired?: boolean; readonly earlyCheck?: boolean },
  ) {
    const filePath = yield* verifyBaselineFile(baseline);
    const step =
      filePath !== undefined
        ? yield* readSteps(filePath, lastStepAfter(baseline.startIndex)).pipe(
            Effect.tapError(() =>
              Effect.logWarning("Could not read the Antigravity session log after the prompt."),
            ),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    // A retired prompt's check runs long after the error, so a relative delay has no anchor.
    const now =
      options?.retired === true || options?.earlyCheck === true ? undefined : yield* DateTime.now;
    return turnFailure(result.stopReason, step, now, options);
  });
});

/**
 * Watches whether the current prompt opened a native non-daemon wait step (`schedule` or
 * `run_command` with `status` pending/running) after the baseline step index. Used to pause
 * the prompt inactivity watchdog when `agy` holds `session/prompt` open during long timers.
 */
export const watchAntigravityActiveWait = Effect.fn("AntigravityTurnOutcome.watchActiveWait")(
  function* (profileDirectory: string, sessionId: string) {
    const baseline = yield* snapshotSessionBaseline(profileDirectory, sessionId);
    if (baseline === undefined) return () => Effect.succeed(false);
    return Effect.fn("AntigravityTurnOutcome.checkActiveWait")(function* () {
      const filePath = yield* verifyBaselineFile(baseline);
      if (filePath === undefined) return false;
      return yield* readSteps(filePath, hasActiveWaitAfter(baseline.startIndex)).pipe(
        Effect.map((active) => active === true),
        Effect.orElseSucceed(() => false),
      );
    });
  },
);
