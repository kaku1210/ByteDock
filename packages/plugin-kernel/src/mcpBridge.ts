import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { HookRegistryService } from "./hooks.ts";

export class PluginMcpToolError extends Schema.TaggedError<PluginMcpToolError>()(
  "PluginMcpToolError",
  { message: Schema.String },
) {}

export interface PluginMcpToolDefinition {
  readonly pluginId: string;
  readonly revision: number;
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly direct?: boolean | undefined;
  readonly handler: (input: {
    readonly threadId?: string | undefined;
    readonly providerSessionId?: string | undefined;
    readonly args: unknown;
  }) => Effect.Effect<{ readonly text: string; readonly structured?: unknown }, PluginMcpToolError>;
}

export interface SearchablePluginTool {
  readonly name: string;
  readonly description: string;
}

interface SessionToolSnapshot {
  readonly inTurn: boolean;
  readonly visibleTools: ReadonlySet<string>;
  readonly pendingListChanged: boolean;
  readonly onListChanged?: (() => void) | undefined;
}

export interface PluginMcpBridgeService {
  readonly registerTool: (tool: PluginMcpToolDefinition) => Effect.Effect<void, never, Scope.Scope>;
  readonly listTools: () => ReadonlyArray<PluginMcpToolDefinition>;
  readonly listSearchableTools: () => ReadonlyArray<SearchablePluginTool>;
  readonly subscribeSession: (providerSessionId: string, onListChanged?: () => void) => () => void;
  readonly markTurnStarted: (providerSessionId: string) => void;
  readonly flushAtTurnBoundary: (providerSessionId: string) => boolean;
  readonly loadToolsForSession: (
    providerSessionId: string,
    names: ReadonlyArray<string>,
  ) => boolean;
  readonly isVisibleForSession: (providerSessionId: string, toolName: string) => boolean;
  readonly invokeTool: (input: {
    readonly name: string;
    readonly args: unknown;
    readonly threadId?: string | undefined;
    readonly providerSessionId?: string | undefined;
    readonly revision?: number | undefined;
  }) => Effect.Effect<
    {
      readonly text: string;
      readonly structured?: unknown;
      readonly artifactRefs: ReadonlyArray<string>;
    },
    PluginMcpToolError
  >;
}

/**
 * Revision-bound dynamic plugin MCP bridge (Seam 5 / Blueprint §4.1 Card 5).
 * Isolates tool visibility snapshots per `providerSessionId` so mid-turn sessions stay
 * cache-frozen while other sessions flush `list_changed` at their own turn boundary.
 */
export function makePluginMcpBridge(options?: {
  readonly hooks?: HookRegistryService | undefined;
}): PluginMcpBridgeService {
  const toolsByName = new Map<string, PluginMcpToolDefinition>();
  const sessions = new Map<string, SessionToolSnapshot>();

  const computeDirectToolSet = (): Set<string> => {
    const direct = new Set<string>();
    for (const tool of toolsByName.values()) {
      if (tool.direct === true) direct.add(tool.name);
    }
    return direct;
  };

  const notifyAllSessionsOfCatalogChange = () => {
    const direct = computeDirectToolSet();
    for (const [sessionId, snap] of sessions.entries()) {
      if (snap.inTurn) {
        // Mid-turn freeze: defer list_changed until this session reaches its own turn boundary.
        sessions.set(sessionId, { ...snap, pendingListChanged: true });
      } else {
        const nextVisible = new Set<string>(direct);
        for (const existing of snap.visibleTools) {
          if (toolsByName.has(existing)) nextVisible.add(existing);
        }
        sessions.set(sessionId, {
          ...snap,
          visibleTools: nextVisible,
          pendingListChanged: false,
        });
        snap.onListChanged?.();
      }
    }
  };

  const registerTool = Effect.fn("PluginMcpBridge.registerTool")(function* (
    tool: PluginMcpToolDefinition,
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        toolsByName.set(tool.name, tool);
        notifyAllSessionsOfCatalogChange();
      }),
      () =>
        Effect.sync(() => {
          const current = toolsByName.get(tool.name);
          if (current === tool) {
            toolsByName.delete(tool.name);
            notifyAllSessionsOfCatalogChange();
          }
        }),
    );
  });

  const subscribeSession = (providerSessionId: string, onListChanged?: () => void) => {
    const existing = sessions.get(providerSessionId);
    const visible = existing ? new Set(existing.visibleTools) : computeDirectToolSet();
    sessions.set(providerSessionId, {
      inTurn: existing?.inTurn ?? false,
      visibleTools: visible,
      pendingListChanged: existing?.pendingListChanged ?? false,
      onListChanged,
    });
    return () => {
      sessions.delete(providerSessionId);
    };
  };

  const markTurnStarted = (providerSessionId: string) => {
    const existing = sessions.get(providerSessionId);
    sessions.set(providerSessionId, {
      inTurn: true,
      visibleTools: existing ? new Set(existing.visibleTools) : computeDirectToolSet(),
      pendingListChanged: existing?.pendingListChanged ?? false,
      onListChanged: existing?.onListChanged,
    });
  };

  const flushAtTurnBoundary = (providerSessionId: string): boolean => {
    const snap = sessions.get(providerSessionId);
    if (!snap) return false;
    const hadPending = snap.pendingListChanged;
    const nextVisible = new Set<string>(computeDirectToolSet());
    for (const name of snap.visibleTools) {
      if (toolsByName.has(name)) nextVisible.add(name);
    }
    sessions.set(providerSessionId, {
      ...snap,
      inTurn: false,
      visibleTools: nextVisible,
      pendingListChanged: false,
    });
    if (hadPending) {
      snap.onListChanged?.();
    }
    return hadPending;
  };

  const loadToolsForSession = (
    providerSessionId: string,
    names: ReadonlyArray<string>,
  ): boolean => {
    const snap = sessions.get(providerSessionId) ?? {
      inTurn: false,
      visibleTools: computeDirectToolSet(),
      pendingListChanged: false,
    };
    const nextVisible = new Set(snap.visibleTools);
    let added = false;
    for (const name of names) {
      if (toolsByName.has(name) && !nextVisible.has(name)) {
        nextVisible.add(name);
        added = true;
      }
    }
    if (!added) return false;
    if (snap.inTurn) {
      sessions.set(providerSessionId, {
        ...snap,
        visibleTools: nextVisible,
        pendingListChanged: true,
      });
    } else {
      sessions.set(providerSessionId, {
        ...snap,
        visibleTools: nextVisible,
        pendingListChanged: false,
      });
      snap.onListChanged?.();
    }
    return true;
  };

  const isVisibleForSession = (providerSessionId: string, toolName: string): boolean => {
    const snap = sessions.get(providerSessionId);
    if (snap) {
      return snap.visibleTools.has(toolName);
    }
    const def = toolsByName.get(toolName);
    return def?.direct === true;
  };

  const invokeTool: PluginMcpBridgeService["invokeTool"] = Effect.fn("PluginMcpBridge.invokeTool")(
    function* (input) {
      const tool = toolsByName.get(input.name);
      if (!tool) {
        return yield* new PluginMcpToolError({ message: `Unknown plugin MCP tool: ${input.name}` });
      }
      const result = yield* tool.handler({
        threadId: input.threadId,
        providerSessionId: input.providerSessionId,
        args: input.args,
      });
      const artifactRefs: Array<string> = [];
      if (options?.hooks && input.threadId) {
        const afterResults = yield* options.hooks.runToolAfter({
          threadId: input.threadId,
          revision: input.revision ?? tool.revision,
          toolName: tool.name,
          outputBytes: Buffer.byteLength(result.text, "utf8"),
          outputText: result.text,
        });
        for (const item of afterResults) {
          if (item.artifactRef) artifactRefs.push(item.artifactRef);
        }
      }
      return {
        text: result.text,
        ...(result.structured !== undefined ? { structured: result.structured } : {}),
        artifactRefs,
      };
    },
  );

  return {
    registerTool,
    listTools: () => [...toolsByName.values()],
    listSearchableTools: () =>
      [...toolsByName.values()].map((t) => ({ name: t.name, description: t.description })),
    subscribeSession,
    markTurnStarted,
    flushAtTurnBoundary,
    loadToolsForSession,
    isVisibleForSession,
    invokeTool,
  };
}
