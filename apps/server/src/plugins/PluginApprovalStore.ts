// @effect-diagnostics nodeBuiltinImport:off -- Approval store persists local plugin permission fingerprints and hash-chained audit logs on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { openHashChainedAuditLog, type HashChainedAuditWriter } from "@bytedock/plugin-kernel";

const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalKind =
  | "plugin-toggle"
  | "plugin-config-patch"
  | "local-plugin-enable"
  | "host-settings-patch"
  | "provider-mutation"
  | "legacy-import"
  | "system-action";

export type HostSystemActionKind =
  | "storage_cleanup"
  | "database_reclaim"
  | "tunnel_action"
  | "terminal_open"
  | "terminal_write"
  | "terminal_close";

export type HostApprovalMutation =
  | {
      readonly kind: "host-settings-patch";
      readonly patch: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "provider-mutation";
      readonly mutation: Readonly<Record<string, unknown>>;
      readonly patch?: Readonly<Record<string, unknown>> | undefined;
    }
  | {
      readonly kind: "legacy-import";
      readonly sourceBaseDir: string;
      readonly sourceBrand?: "t3-plus" | "t3" | "custom" | undefined;
      readonly categories: ReadonlyArray<string>;
      readonly overwrite: boolean;
      readonly deferLockedStateDb: boolean;
    }
  | {
      readonly kind: "system-action";
      readonly action: HostSystemActionKind;
      readonly payload: Readonly<Record<string, unknown>>;
    };

export type ApprovalMutation =
  | {
      readonly kind: "set-enabled";
      readonly pluginId: string;
      readonly enabled: boolean;
      readonly permissionsFingerprint?: string | undefined;
    }
  | {
      readonly kind: "patch-config";
      readonly pluginId: string;
      readonly nextConfig: Readonly<Record<string, unknown>>;
    }
  | HostApprovalMutation;

export interface ControlPlaneApprovalRequest {
  readonly requestId: string;
  readonly kind: ApprovalKind;
  readonly pluginId: string;
  readonly riskLevel: "high";
  readonly reasons: ReadonlyArray<string>;
  readonly summary: string;
  readonly diffPreview: {
    readonly before: unknown;
    readonly after: unknown;
  };
  readonly requestedBy: {
    readonly kind: "main-thread";
    readonly threadId: string;
    readonly providerInstanceId?: string | undefined;
  };
  readonly expectedMtimeMs: number;
  readonly mutation: ApprovalMutation;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly createdAtMs: number;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  readonly resolvedAt?: string | undefined;
  readonly resolvedBy?: string | undefined;
  readonly resolutionNote?: string | undefined;
}

export class ApprovalStoreError extends Schema.TaggedError<ApprovalStoreError>()(
  "ApprovalStoreError",
  {
    code: Schema.Literals(["approval_not_found", "approval_expired", "approval_already_resolved"]),
    requestId: Schema.String,
    message: Schema.String,
  },
) {}

interface PersistedApprovalsDocument {
  readonly schemaVersion: 1;
  readonly approvedLocalPlugins: Readonly<
    Record<
      string,
      {
        readonly permissionsFingerprint: string;
        readonly approvedAt: string;
        readonly approvedBy: string;
      }
    >
  >;
}

export interface PluginApprovalStoreService {
  readonly auditFilePath: string;
  readonly recordAudit: (event: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
  readonly verifyAuditChain: () => {
    readonly state: "verified" | "rotated-unverified" | "broken";
    readonly count: number;
    readonly tailHash: string;
  };
  readonly isLocalPluginApproved: (
    pluginId: string,
    permissionsFingerprint: string,
  ) => Effect.Effect<boolean>;
  readonly getApprovedFingerprint: (pluginId: string) => Effect.Effect<string | undefined>;
  readonly recordLocalPluginApproval: (input: {
    readonly pluginId: string;
    readonly permissionsFingerprint: string;
    readonly approvedBy: string;
  }) => Effect.Effect<void>;
  readonly createApproval: (input: {
    readonly kind: ApprovalKind;
    readonly pluginId: string;
    readonly reasons: ReadonlyArray<string>;
    readonly summary: string;
    readonly diffPreview: { readonly before: unknown; readonly after: unknown };
    readonly requestedBy: ControlPlaneApprovalRequest["requestedBy"];
    readonly expectedMtimeMs: number;
    readonly mutation: ApprovalMutation;
    readonly ttlMs?: number | undefined;
  }) => Effect.Effect<ControlPlaneApprovalRequest>;
  readonly listApprovals: () => Effect.Effect<ReadonlyArray<ControlPlaneApprovalRequest>>;
  readonly getApproval: (
    requestId: string,
  ) => Effect.Effect<ControlPlaneApprovalRequest | undefined>;
  readonly assertPendingForResolution: (
    requestId: string,
  ) => Effect.Effect<ControlPlaneApprovalRequest, ApprovalStoreError>;
  readonly finalizeResolution: (input: {
    readonly requestId: string;
    readonly decision: "approved" | "rejected";
    readonly resolvedBy: string;
    readonly note?: string | undefined;
  }) => Effect.Effect<ControlPlaneApprovalRequest, ApprovalStoreError>;
}

function isoFromMs(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

function readPersistedApprovals(filePath: string): PersistedApprovalsDocument {
  if (!NodeFS.existsSync(filePath)) {
    return { schemaVersion: 1, approvedLocalPlugins: {} };
  }
  try {
    const parsed = JSON.parse(
      NodeFS.readFileSync(filePath, "utf8"),
    ) as Partial<PersistedApprovalsDocument>;
    return {
      schemaVersion: 1,
      approvedLocalPlugins:
        parsed.approvedLocalPlugins && typeof parsed.approvedLocalPlugins === "object"
          ? parsed.approvedLocalPlugins
          : {},
    };
  } catch {
    return { schemaVersion: 1, approvedLocalPlugins: {} };
  }
}

function writePersistedApprovalsAtomic(filePath: string, doc: PersistedApprovalsDocument): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;
  NodeFS.writeFileSync(tmpPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  NodeFS.renameSync(tmpPath, filePath);
}

/** Manages short-lived human approval requests, approved local-plugin permission fingerprints, and hash-chained control-plane audits. */
export const makePluginApprovalStore = Effect.fn("PluginApprovalStore.make")(function* (input: {
  readonly stateDir: string;
  readonly logsDir: string;
  readonly defaultTtlMs?: number | undefined;
}) {
  const defaultTtlMs = input.defaultTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const persistedPath = NodePath.join(input.stateDir, "plugin-approvals.json");
  const auditFilePath = NodePath.join(input.logsDir, "control-plane-audit.jsonl");

  const auditWriter: HashChainedAuditWriter = openHashChainedAuditLog({
    filePath: auditFilePath,
    streamId: "control-plane",
  });

  const requestsRef = yield* Ref.make(new Map<string, ControlPlaneApprovalRequest>());
  const persistedRef = yield* Ref.make<PersistedApprovalsDocument>(
    readPersistedApprovals(persistedPath),
  );

  const recordAudit = (event: Readonly<Record<string, unknown>>) =>
    Effect.sync(() => {
      auditWriter.append(event);
    });

  const expireDueRequests = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const expiredIds = yield* Ref.modify(requestsRef, (map) => {
      let changed = false;
      const expired: Array<ControlPlaneApprovalRequest> = [];
      const next = new Map(map);
      for (const [id, req] of map.entries()) {
        if (req.status === "pending" && nowMs >= req.expiresAtMs) {
          const updated: ControlPlaneApprovalRequest = {
            ...req,
            status: "expired",
            resolvedAt: isoFromMs(nowMs),
            resolutionNote: "Expired before human review.",
          };
          next.set(id, updated);
          expired.push(updated);
          changed = true;
        }
      }
      return [expired, changed ? next : map] as const;
    });

    for (const item of expiredIds) {
      yield* recordAudit({
        event: "approval_expired",
        requestId: item.requestId,
        pluginId: item.pluginId,
        kind: item.kind,
        expiresAt: item.expiresAt,
      });
    }
  });

  const isLocalPluginApproved = (pluginId: string, permissionsFingerprint: string) =>
    Ref.get(persistedRef).pipe(
      Effect.map(
        (doc) =>
          doc.approvedLocalPlugins[pluginId]?.permissionsFingerprint === permissionsFingerprint,
      ),
    );

  const getApprovedFingerprint = (pluginId: string) =>
    Ref.get(persistedRef).pipe(
      Effect.map((doc) => doc.approvedLocalPlugins[pluginId]?.permissionsFingerprint),
    );

  const recordLocalPluginApproval: PluginApprovalStoreService["recordLocalPluginApproval"] =
    Effect.fn("PluginApprovalStore.recordLocalPluginApproval")(function* (args) {
      const nowMs = yield* Clock.currentTimeMillis;
      const nextDoc = yield* Ref.modify(persistedRef, (doc) => {
        const updated: PersistedApprovalsDocument = {
          schemaVersion: 1,
          approvedLocalPlugins: {
            ...doc.approvedLocalPlugins,
            [args.pluginId]: {
              permissionsFingerprint: args.permissionsFingerprint,
              approvedAt: isoFromMs(nowMs),
              approvedBy: args.approvedBy,
            },
          },
        };
        return [updated, updated] as const;
      });
      yield* Effect.sync(() => writePersistedApprovalsAtomic(persistedPath, nextDoc));
    });

  const createApproval: PluginApprovalStoreService["createApproval"] = Effect.fn(
    "PluginApprovalStore.createApproval",
  )(function* (args) {
    yield* expireDueRequests;
    const nowMs = yield* Clock.currentTimeMillis;
    const ttlMs = args.ttlMs ?? defaultTtlMs;
    const expiresAtMs = nowMs + ttlMs;
    const request: ControlPlaneApprovalRequest = {
      requestId: NodeCrypto.randomUUID(),
      kind: args.kind,
      pluginId: args.pluginId,
      riskLevel: "high",
      reasons: [...args.reasons],
      summary: args.summary,
      diffPreview: args.diffPreview,
      requestedBy: args.requestedBy,
      expectedMtimeMs: args.expectedMtimeMs,
      mutation: args.mutation,
      status: "pending",
      createdAt: isoFromMs(nowMs),
      createdAtMs: nowMs,
      expiresAt: isoFromMs(expiresAtMs),
      expiresAtMs,
    };

    yield* Ref.update(requestsRef, (map) => {
      const next = new Map(map);
      next.set(request.requestId, request);
      return next;
    });
    yield* recordAudit({
      event: "approval_created",
      requestId: request.requestId,
      pluginId: request.pluginId,
      kind: request.kind,
      reasons: request.reasons,
      threadId: request.requestedBy.threadId,
      expiresAt: request.expiresAt,
    });
    return request;
  });

  const listApprovals = () =>
    expireDueRequests.pipe(
      Effect.andThen(Ref.get(requestsRef)),
      Effect.map((map) => [...map.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)),
    );

  const getApproval = (requestId: string) =>
    expireDueRequests.pipe(
      Effect.andThen(Ref.get(requestsRef)),
      Effect.map((map) => map.get(requestId)),
    );

  const assertPendingForResolution: PluginApprovalStoreService["assertPendingForResolution"] =
    Effect.fn("PluginApprovalStore.assertPendingForResolution")(function* (requestId) {
      yield* expireDueRequests;
      const req = (yield* Ref.get(requestsRef)).get(requestId);
      if (!req) {
        return yield* new ApprovalStoreError({
          code: "approval_not_found",
          requestId,
          message: `Approval request "${requestId}" was not found.`,
        });
      }
      if (req.status === "expired") {
        return yield* new ApprovalStoreError({
          code: "approval_expired",
          requestId,
          message: `Approval request "${requestId}" expired at ${req.expiresAt}.`,
        });
      }
      if (req.status !== "pending") {
        return yield* new ApprovalStoreError({
          code: "approval_already_resolved",
          requestId,
          message: `Approval request "${requestId}" has already been resolved (${req.status}).`,
        });
      }
      return req;
    });

  const finalizeResolution: PluginApprovalStoreService["finalizeResolution"] = Effect.fn(
    "PluginApprovalStore.finalizeResolution",
  )(function* (args) {
    const req = yield* assertPendingForResolution(args.requestId);
    const nowMs = yield* Clock.currentTimeMillis;
    const finalized: ControlPlaneApprovalRequest = {
      ...req,
      status: args.decision,
      resolvedAt: isoFromMs(nowMs),
      resolvedBy: args.resolvedBy,
      ...(args.note !== undefined ? { resolutionNote: args.note } : {}),
    };
    yield* Ref.update(requestsRef, (map) => {
      const next = new Map(map);
      next.set(finalized.requestId, finalized);
      return next;
    });
    yield* recordAudit({
      event: args.decision === "approved" ? "approval_approved" : "approval_rejected",
      requestId: finalized.requestId,
      pluginId: finalized.pluginId,
      kind: finalized.kind,
      resolvedBy: args.resolvedBy,
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
    return finalized;
  });

  return {
    auditFilePath,
    recordAudit,
    verifyAuditChain: () => auditWriter.verify(),
    isLocalPluginApproved,
    getApprovedFingerprint,
    recordLocalPluginApproval,
    createApproval,
    listApprovals,
    getApproval,
    assertPendingForResolution,
    finalizeResolution,
  } satisfies PluginApprovalStoreService;
});
