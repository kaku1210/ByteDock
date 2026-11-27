// @effect-diagnostics nodeBuiltinImport:off -- Prefix hashing uses node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import type { HookDecision, HookInvocation } from "@bytedock/plugin-sdk/bridge";
import type {
  CompactContribution,
  OpenContribution,
  OpenPrepareContribution,
  OutboundTurnPayload,
  TurnContextContribution,
} from "@bytedock/plugin-sdk/cacheGuard";
import type { PluginHookName } from "@bytedock/plugin-sdk/manifest";

export const TURN_BEFORE_TOTAL_BUDGET_MS = 500;
export const DEFAULT_HOOK_TIMEOUT_MS = 2_000;

export interface RegisteredHookEntry {
  readonly id: string;
  readonly pluginId: string;
  readonly revision: number;
  readonly name: PluginHookName;
  readonly priority: number;
  readonly onError: "pass" | "deny";
  readonly timeoutMs: number;
  readonly handler: (invocation: HookInvocation) => Effect.Effect<HookDecision>;
}

export interface TurnBeforeResult {
  readonly payload: OutboundTurnPayload;
  readonly contributions: ReadonlyArray<{
    readonly pluginId: string;
    readonly contribution: TurnContextContribution;
  }>;
  readonly timedOutPlugins: ReadonlyArray<string>;
  readonly rejectedResets: ReadonlyArray<string>;
}

export interface OpenAfterPrepareResult {
  readonly contribution: OpenContribution;
  readonly prefixHash: string;
}

export interface CompactBeforeResult {
  readonly handoffSummaries: ReadonlyArray<{ readonly pluginId: string; readonly summary: string }>;
  readonly resetAuthorized: boolean;
}

export interface HookRegistryService {
  readonly register: (
    entry: Omit<RegisteredHookEntry, "id">,
  ) => Effect.Effect<string, never, Scope.Scope>;
  readonly setPluginEnabled: (pluginId: string, enabled: boolean) => Effect.Effect<void>;
  readonly isPluginEnabled: (pluginId: string) => Effect.Effect<boolean>;
  readonly listByHook: (name: PluginHookName) => Effect.Effect<ReadonlyArray<RegisteredHookEntry>>;
  readonly runOpenPrepare: (input: {
    readonly threadId: string;
    readonly revision: number;
    readonly modelId?: string | undefined;
  }) => Effect.Effect<OpenPrepareContribution>;
  readonly runOpenAfterPrepare: (input: {
    readonly threadId: string;
    readonly providerSessionId: string;
    readonly revision: number;
  }) => Effect.Effect<OpenAfterPrepareResult>;
  readonly runTurnBefore: (input: {
    readonly threadId: string;
    readonly providerSessionId?: string | undefined;
    readonly revision: number;
    readonly projectedMessage: string;
    readonly totalBudgetMs?: number | undefined;
  }) => Effect.Effect<TurnBeforeResult>;
  readonly runCompactBefore: (input: {
    readonly threadId: string;
    readonly revision: number;
  }) => Effect.Effect<CompactBeforeResult>;
  readonly runToolAfter: (input: {
    readonly threadId: string;
    readonly revision: number;
    readonly toolName: string;
    readonly outputBytes: number;
    readonly outputText?: string | undefined;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly pluginId: string; readonly artifactRef?: string | undefined }>
  >;
  readonly runEgressBefore: (input: {
    readonly host: string;
    readonly port: number;
    readonly protocol: string;
    readonly revision: number;
  }) => Effect.Effect<{
    readonly allowed: boolean;
    readonly deniedBy?: string | undefined;
    readonly reason?: string | undefined;
  }>;
}

function hashStableBlocks(
  blocks: ReadonlyArray<{ readonly id: string; readonly hash: string; readonly body: string }>,
): string {
  const canonical = blocks.map((b) => `${b.id}:${b.hash}:${b.body}`).join("\n---\n");
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Scope-bound plugin hook dispatcher enforcing per-plugin isolation, 500ms turn hot-path
 * budget, fail-closed security hooks, and projection-safe `outboundUserText` wrapping.
 */
export const makeHookRegistry = Effect.fn("pluginKernel.makeHookRegistry")(function* () {
  const entriesRef = yield* Ref.make<ReadonlyArray<RegisteredHookEntry>>([]);
  const disabledPluginsRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  let nextSeq = 1;

  const setPluginEnabled = (pluginId: string, enabled: boolean) =>
    Ref.update(disabledPluginsRef, (set) => {
      const next = new Set(set);
      if (enabled) next.delete(pluginId);
      else next.add(pluginId);
      return next;
    });

  const isPluginEnabled = (pluginId: string) =>
    Ref.get(disabledPluginsRef).pipe(Effect.map((set) => !set.has(pluginId)));

  const register = Effect.fn("HookRegistry.register")(function* (
    entry: Omit<RegisteredHookEntry, "id">,
  ) {
    const id = `hook:${entry.pluginId}:${entry.name}:${nextSeq++}`;
    const full: RegisteredHookEntry = { ...entry, id };
    yield* Effect.acquireRelease(
      Ref.update(entriesRef, (list) =>
        [...list, full].sort(
          (a, b) => a.priority - b.priority || a.pluginId.localeCompare(b.pluginId),
        ),
      ),
      () => Ref.update(entriesRef, (list) => list.filter((item) => item.id !== id)),
    );
    return id;
  });

  const listByHook = (name: PluginHookName) =>
    Effect.all([Ref.get(entriesRef), Ref.get(disabledPluginsRef)]).pipe(
      Effect.map(([list, disabled]) =>
        list.filter((e) => e.name === name && !disabled.has(e.pluginId)),
      ),
    );

  const invokeSingle = Effect.fn("HookRegistry.invokeSingle")(function* (
    entry: RegisteredHookEntry,
    input: unknown,
    budgetMs: number,
  ) {
    const effectiveTimeoutMs = Math.max(1, Math.min(entry.timeoutMs, budgetMs));
    const invocation: HookInvocation = {
      name: entry.name,
      revision: entry.revision,
      input,
      deadlineMs: effectiveTimeoutMs,
    };
    const exit = yield* Effect.exit(
      entry.handler(invocation).pipe(Effect.timeoutOption(`${effectiveTimeoutMs} millis`)),
    );
    if (Exit.isFailure(exit)) {
      return {
        timedOut: false,
        decision:
          entry.onError === "deny"
            ? ({
                verdict: "deny",
                reason: `Hook ${entry.pluginId} failed (fail-closed)`,
              } satisfies HookDecision)
            : ({ verdict: "pass" } satisfies HookDecision),
      };
    }
    if (Option.isNone(exit.value)) {
      return {
        timedOut: true,
        decision:
          entry.onError === "deny"
            ? ({
                verdict: "deny",
                reason: `Hook ${entry.pluginId} timed out after ${effectiveTimeoutMs}ms`,
              } satisfies HookDecision)
            : ({ verdict: "pass" } satisfies HookDecision),
      };
    }
    return { timedOut: false, decision: exit.value.value };
  });

  const runOpenPrepare: HookRegistryService["runOpenPrepare"] = Effect.fn(
    "HookRegistry.runOpenPrepare",
  )(function* (input) {
    const hooks = yield* listByHook("agent.open.before");
    const mcpOverrides: Array<{ readonly id: string; readonly enabled: boolean }> = [];
    const directTools = new Set<string>();
    let deferred = true;

    for (const hook of hooks) {
      const { decision } = yield* invokeSingle(
        hook,
        { stage: "prepare", ...input },
        DEFAULT_HOOK_TIMEOUT_MS,
      );
      if (
        decision.verdict === "pass" &&
        decision.contribution &&
        typeof decision.contribution === "object"
      ) {
        const patch = decision.contribution as Partial<OpenPrepareContribution>;
        if (Array.isArray(patch.mcpServerOverrides)) {
          mcpOverrides.push(...patch.mcpServerOverrides);
        }
        if (patch.mcpExposure) {
          for (const t of patch.mcpExposure.directTools) directTools.add(t);
          deferred = deferred && patch.mcpExposure.deferred;
        }
      }
    }

    return {
      ...(mcpOverrides.length > 0 ? { mcpServerOverrides: mcpOverrides } : {}),
      mcpExposure: {
        directTools: [...directTools].sort(),
        deferred,
      },
    } satisfies OpenPrepareContribution;
  });

  const runOpenAfterPrepare: HookRegistryService["runOpenAfterPrepare"] = Effect.fn(
    "HookRegistry.runOpenAfterPrepare",
  )(function* (input) {
    const hooks = yield* listByHook("agent.open.before");
    const mergedEnv: Record<string, string> = {};
    const blocks: Array<{ readonly id: string; readonly hash: string; readonly body: string }> = [];
    const directTools = new Set<string>();
    let deferred = true;
    let roleBlock: string | undefined;

    for (const hook of hooks) {
      const { decision } = yield* invokeSingle(
        hook,
        { stage: "after-prepare", ...input },
        DEFAULT_HOOK_TIMEOUT_MS,
      );
      if (
        decision.verdict === "pass" &&
        decision.contribution &&
        typeof decision.contribution === "object"
      ) {
        const patch = decision.contribution as Partial<OpenContribution>;
        if (patch.env) {
          for (const [k, v] of Object.entries(patch.env)) {
            mergedEnv[k] = v;
          }
        }
        if (patch.roleBlock) roleBlock = patch.roleBlock;
        if (Array.isArray(patch.stablePrefixBlocks)) {
          blocks.push(...patch.stablePrefixBlocks);
        }
        if (patch.mcpExposure) {
          for (const t of patch.mcpExposure.directTools) directTools.add(t);
          deferred = deferred && patch.mcpExposure.deferred;
        }
      }
    }

    // Deterministic sort guarantees byte-identical prompt prefixes across restarts (ADR-06 Law #1).
    const sortedBlocks = [...blocks].sort((a, b) => a.id.localeCompare(b.id));
    const contribution: OpenContribution = {
      ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
      ...(roleBlock !== undefined ? { roleBlock } : {}),
      stablePrefixBlocks: sortedBlocks,
      mcpExposure: {
        directTools: [...directTools].sort(),
        deferred,
      },
    };
    return {
      contribution,
      prefixHash: hashStableBlocks(sortedBlocks),
    } satisfies OpenAfterPrepareResult;
  });

  const runTurnBefore: HookRegistryService["runTurnBefore"] = Effect.fn(
    "HookRegistry.runTurnBefore",
  )(function* (input) {
    const hooks = yield* listByHook("agent.turn.before");
    const totalBudgetMs = input.totalBudgetMs ?? TURN_BEFORE_TOTAL_BUDGET_MS;
    const startedAt = yield* Clock.currentTimeMillis;

    const contributions: Array<{
      readonly pluginId: string;
      readonly contribution: TurnContextContribution;
    }> = [];
    const timedOutPlugins: Array<string> = [];
    const rejectedResets: Array<string> = [];
    const appendSegments: Array<string> = [];

    for (const hook of hooks) {
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
      const remaining = totalBudgetMs - elapsed;
      if (remaining <= 0) {
        timedOutPlugins.push(hook.pluginId);
        continue;
      }
      const { timedOut, decision } = yield* invokeSingle(hook, input, remaining);
      if (timedOut) {
        timedOutPlugins.push(hook.pluginId);
        continue;
      }
      if (
        decision.verdict === "pass" &&
        decision.contribution &&
        typeof decision.contribution === "object"
      ) {
        const patch = decision.contribution as TurnContextContribution;
        if (patch.forceCacheReset !== undefined) {
          // Law #4: forceCacheReset is forbidden outside agent.compact.before.
          rejectedResets.push(hook.pluginId);
        }
        const safeContribution: TurnContextContribution =
          patch.appendContext !== undefined ? { appendContext: patch.appendContext } : {};
        if (safeContribution.appendContext) {
          appendSegments.push(safeContribution.appendContext);
          contributions.push({ pluginId: hook.pluginId, contribution: safeContribution });
        }
      }
    }

    const outboundUserText =
      appendSegments.length === 0
        ? input.projectedMessage
        : `${input.projectedMessage}\n\n${appendSegments.join("\n\n")}`;

    return {
      payload: {
        projectedMessage: input.projectedMessage,
        outboundUserText,
      },
      contributions,
      timedOutPlugins,
      rejectedResets,
    } satisfies TurnBeforeResult;
  });

  const runCompactBefore: HookRegistryService["runCompactBefore"] = Effect.fn(
    "HookRegistry.runCompactBefore",
  )(function* (input) {
    const hooks = yield* listByHook("agent.compact.before");
    const handoffSummaries: Array<{ readonly pluginId: string; readonly summary: string }> = [];
    let resetAuthorized = false;

    for (const hook of hooks) {
      const { decision } = yield* invokeSingle(hook, input, DEFAULT_HOOK_TIMEOUT_MS);
      if (
        decision.verdict === "pass" &&
        decision.contribution &&
        typeof decision.contribution === "object"
      ) {
        const patch = decision.contribution as CompactContribution;
        if (patch.handoffSummary) {
          handoffSummaries.push({ pluginId: hook.pluginId, summary: patch.handoffSummary });
        }
        if (patch.forceCacheReset?.compactProof) {
          resetAuthorized = true;
        }
      }
    }

    return { handoffSummaries, resetAuthorized } satisfies CompactBeforeResult;
  });

  const runToolAfter: HookRegistryService["runToolAfter"] = Effect.fn("HookRegistry.runToolAfter")(
    function* (input) {
      const hooks = yield* listByHook("agent.tool.after");
      const results: Array<{
        readonly pluginId: string;
        readonly artifactRef?: string | undefined;
      }> = [];
      for (const hook of hooks) {
        const { decision } = yield* invokeSingle(hook, input, DEFAULT_HOOK_TIMEOUT_MS);
        if (
          decision.verdict === "pass" &&
          decision.contribution &&
          typeof decision.contribution === "object"
        ) {
          const patch = decision.contribution as { readonly artifactRef?: string };
          results.push({
            pluginId: hook.pluginId,
            ...(patch.artifactRef !== undefined ? { artifactRef: patch.artifactRef } : {}),
          });
        }
      }
      return results;
    },
  );

  const runEgressBefore: HookRegistryService["runEgressBefore"] = Effect.fn(
    "HookRegistry.runEgressBefore",
  )(function* (input) {
    const hooks = yield* listByHook("egress.request.before");
    for (const hook of hooks) {
      const { decision } = yield* invokeSingle(hook, input, DEFAULT_HOOK_TIMEOUT_MS);
      if (decision.verdict === "deny") {
        return {
          allowed: false,
          deniedBy: hook.pluginId,
          ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
        };
      }
    }
    return { allowed: true };
  });

  return {
    register,
    setPluginEnabled,
    isPluginEnabled,
    listByHook,
    runOpenPrepare,
    runOpenAfterPrepare,
    runTurnBefore,
    runCompactBefore,
    runToolAfter,
    runEgressBefore,
  } satisfies HookRegistryService;
});
