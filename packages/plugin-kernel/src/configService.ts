// @effect-diagnostics nodeBuiltinImport:off -- Config service manages atomic YAML persistence with Windows Defender retry backoff.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as YAML from "yaml";

export interface PluginsYamlDocument {
  readonly schemaVersion: 1;
  readonly plugins: Readonly<
    Record<
      string,
      { readonly enabled?: boolean; readonly config?: Readonly<Record<string, unknown>> }
    >
  >;
}

export class StaleConfigWriteError extends Schema.TaggedError<StaleConfigWriteError>()(
  "StaleConfigWriteError",
  {
    filePath: Schema.String,
    expectedMtimeMs: Schema.Number,
    actualMtimeMs: Schema.Number,
  },
) {}

export class ConfigWriteIoError extends Schema.TaggedError<ConfigWriteIoError>()(
  "ConfigWriteIoError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface PluginConfigSnapshot {
  readonly mtimeMs: number;
  readonly document: PluginsYamlDocument;
}

export interface PluginConfigServiceHandle {
  readonly read: () => Effect.Effect<PluginConfigSnapshot>;
  readonly updatePluginConfig: (input: {
    readonly pluginId: string;
    readonly expectedMtimeMs: number;
    readonly enabled?: boolean | undefined;
    readonly config?: Readonly<Record<string, unknown>> | undefined;
  }) => Effect.Effect<PluginConfigSnapshot, StaleConfigWriteError | ConfigWriteIoError>;
}

const DEFENDER_RETRY_DELAYS_MS = [200, 400, 800] as const;

function defaultDocument(): PluginsYamlDocument {
  return { schemaVersion: 1, plugins: {} };
}

function readYamlDisk(filePath: string): PluginConfigSnapshot {
  if (!NodeFS.existsSync(filePath)) {
    return { mtimeMs: 0, document: defaultDocument() };
  }
  const stat = NodeFS.statSync(filePath);
  const raw = NodeFS.readFileSync(filePath, "utf8");
  const parsed = (YAML.parse(raw) ?? {}) as Partial<PluginsYamlDocument>;
  return {
    mtimeMs: Math.trunc(stat.mtimeMs),
    document: {
      schemaVersion: 1,
      plugins: parsed.plugins && typeof parsed.plugins === "object" ? parsed.plugins : {},
    },
  };
}

function writeTmpAndRenameOnce(
  tmpPath: string,
  filePath: string,
  content: string,
):
  | { readonly ok: true; readonly mtimeMs: number }
  | { readonly ok: false; readonly retryable: boolean; readonly cause: unknown } {
  try {
    NodeFS.writeFileSync(tmpPath, content, "utf8");
    NodeFS.renameSync(tmpPath, filePath);
    return { ok: true, mtimeMs: Math.trunc(NodeFS.statSync(filePath).mtimeMs) };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    return { ok: false, retryable: code === "EBUSY" || code === "EPERM", cause };
  }
}

function cleanupTmpBestEffort(tmpPath: string): void {
  try {
    if (NodeFS.existsSync(tmpPath)) NodeFS.unlinkSync(tmpPath);
  } catch {
    // Best-effort cleanup of temp file.
  }
}

const atomicWriteWithDefenderBackoff = Effect.fn("pluginKernel.atomicWriteWithDefenderBackoff")(
  function* (filePath: string, content: string) {
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    const nowMs = yield* Clock.currentTimeMillis;
    const tmpPath = `${filePath}.${process.pid}.${nowMs}.tmp`;

    for (let attempt = 0; attempt <= DEFENDER_RETRY_DELAYS_MS.length; attempt += 1) {
      const outcome = writeTmpAndRenameOnce(tmpPath, filePath, content);
      if (outcome.ok) {
        return outcome.mtimeMs;
      }
      const delayMs = DEFENDER_RETRY_DELAYS_MS[attempt];
      if (outcome.retryable && delayMs !== undefined) {
        yield* Effect.sleep(`${delayMs} millis`);
        continue;
      }
      cleanupTmpBestEffort(tmpPath);
      return yield* new ConfigWriteIoError({ filePath, cause: outcome.cause });
    }

    cleanupTmpBestEffort(tmpPath);
    return yield* new ConfigWriteIoError({ filePath, cause: new Error("Retry budget exhausted") });
  },
);

/**
 * Tier-1 single-writer CAS config store for ~/.bytedock/plugins.yml (ADR-05).
 * Manual user edits always win on mtime CAS mismatch (returns StaleConfigWriteError).
 */
export const makePluginConfigService = Effect.fn("pluginKernel.makePluginConfigService")(function* (
  filePath: string,
) {
  const writeLane = yield* Semaphore.make(1);
  const snapshotRef = yield* Ref.make<PluginConfigSnapshot>(readYamlDisk(filePath));

  const read = () =>
    Effect.sync(() => readYamlDisk(filePath)).pipe(
      Effect.tap((snap) => Ref.set(snapshotRef, snap)),
    );

  const updatePluginConfig: PluginConfigServiceHandle["updatePluginConfig"] = (input) =>
    writeLane.withPermits(1)(
      Effect.gen(function* () {
        const current = readYamlDisk(filePath);
        if (current.mtimeMs !== input.expectedMtimeMs) {
          return yield* new StaleConfigWriteError({
            filePath,
            expectedMtimeMs: input.expectedMtimeMs,
            actualMtimeMs: current.mtimeMs,
          });
        }

        const prevEntry = current.document.plugins[input.pluginId] ?? {};
        const nextDocument: PluginsYamlDocument = {
          schemaVersion: 1,
          plugins: {
            ...current.document.plugins,
            [input.pluginId]: {
              ...(input.enabled !== undefined
                ? { enabled: input.enabled }
                : prevEntry.enabled !== undefined
                  ? { enabled: prevEntry.enabled }
                  : {}),
              ...(input.config !== undefined
                ? { config: input.config }
                : prevEntry.config !== undefined
                  ? { config: prevEntry.config }
                  : {}),
            },
          },
        };

        const serialized = YAML.stringify(nextDocument);
        const nextMtimeMs = yield* atomicWriteWithDefenderBackoff(filePath, serialized);
        const nextSnapshot: PluginConfigSnapshot = {
          mtimeMs: nextMtimeMs,
          document: nextDocument,
        };
        yield* Ref.set(snapshotRef, nextSnapshot);
        return nextSnapshot;
      }),
    );

  return {
    read,
    updatePluginConfig,
  } satisfies PluginConfigServiceHandle;
});
