// @effect-diagnostics nodeBuiltinImport:off -- Integration tests exercise temp dirs for plugins, legacy T3 import, and scaffolding.
// @effect-diagnostics anyUnknownInErrorContext:off -- In-process McpServer.tools entries carry erased handler error/context types.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DatabaseStorageStatus,
  type ExternalTunnelStatus,
  type HostResourcesSnapshot,
  type LaunchEditorInput,
  type StorageCleanupReport,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as PluginKernel from "@bytedock/plugin-kernel";
import * as Keybindings from "./keybindings.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import { makePluginControlPlane, PluginControlPlane } from "./plugins/PluginControlPlane.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as ExternalTunnelService from "./tunnel/ExternalTunnelService.ts";

const tempDirs: Array<string> = [];

function makeTempEnv() {
  const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-full-ctrl-"));
  tempDirs.push(rootDir);
  const stateDir = NodePath.join(rootDir, "userdata");
  const logsDir = NodePath.join(stateDir, "logs");
  const pluginsDir = NodePath.join(rootDir, "plugins");
  NodeFS.mkdirSync(logsDir, { recursive: true });
  NodeFS.mkdirSync(pluginsDir, { recursive: true });
  return {
    rootDir,
    stateDir,
    logsDir,
    pluginConfigPath: NodePath.join(stateDir, "plugins.yml"),
    pluginsDir,
  };
}

function makeMcpClient() {
  return McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "bytedock-full-control-test", version: "0.1.0" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bytedock-full-control-test", version: "0.1.0" },
    },
    getClient: Effect.die("unused"),
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && NodeFS.existsSync(dir)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ByteDock Full AI Control (OpenSpec bytedock-full-ai-control)", () => {
  it.effect(
    "discovers all 9 bytedock_* tools, enforces tiered settings/keybindings/provider controls, and protects secrets",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          watchFiles: false,
        });

        const mainThreadId = ThreadId.make("thread-full-main");
        const childThreadId = ThreadId.make("thread-full-child");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const environmentId = EnvironmentId.make("env-full-test");

        const mockThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id: ThreadId) =>
            Effect.succeed({
              id,
              projectId: "proj-1" as never,
              deletedAt: null,
              archivedAt: null,
              activeRunId: "run-1" as never,
              providerInstanceId,
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              pendingBackgroundTasks: [],
              lineage:
                id === childThreadId
                  ? {
                      kind: "delegated-task" as const,
                      parentThreadId: mainThreadId,
                      rootThreadId: mainThreadId,
                    }
                  : { kind: "root" as const },
            } as never),
        });

        const keybindingsRef = yield* Ref.make<
          Array<{ readonly key: string; readonly command: string }>
        >([]);
        const mockKeybindings = Layer.mock(Keybindings.Keybindings)({
          getSnapshot: Ref.get(keybindingsRef).pipe(
            Effect.map((rules) => ({
              keybindings: rules as never,
              issues: [],
            })),
          ),
          upsertKeybindingRule: (input) =>
            Ref.updateAndGet(keybindingsRef, (prev) => [
              ...prev.filter((r) => r.command !== input.command),
              { key: input.key, command: input.command },
            ]).pipe(Effect.map((rules) => ({ keybindings: rules as never, issues: [] }))),
          removeKeybindingRule: (input) =>
            Ref.updateAndGet(keybindingsRef, (prev) =>
              prev.filter((r) => !(r.key === input.key && r.command === input.command)),
            ).pipe(Effect.map((rules) => ({ keybindings: rules as never, issues: [] }))),
        });

        const launchedEditors: Array<LaunchEditorInput> = [];
        const mockLauncher = Layer.mock(ExternalLauncher.ExternalLauncher)({
          resolveAvailableEditors: () => Effect.succeed(["vscode", "cursor"] as const),
          launchEditor: (input) =>
            Effect.sync(() => {
              launchedEditors.push(input);
            }),
        });

        const settingsLayer = ServerSettings.ServerSettingsService.layerTest({
          ...DEFAULT_SERVER_SETTINGS,
          cloudSpeechCredentials: {
            openai: "sk-supersecretvalue1234567890",
          },
        });

        const mcpServices = McpHttpServer.layerToolSearch.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(Layer.succeed(PluginControlPlane, cp)),
          Layer.provideMerge(Layer.succeed(PluginKernel.PluginKernel, kernel)),
          Layer.provideMerge(mockThreads),
          Layer.provideMerge(settingsLayer),
          Layer.provideMerge(mockKeybindings),
          Layer.provideMerge(mockLauncher),
        );

        const mcpClient = makeMcpClient();
        const callAs = (
          scope: McpInvocationContext.McpInvocationScope,
          toolName: string,
          args: Record<string, unknown>,
        ) =>
          Effect.gen(function* () {
            const mcp = yield* McpServer.McpServer;
            return yield* mcp
              .callTool({ name: toolName, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, mcpClient),
              );
          });

        const nowMs = yield* Clock.currentTimeMillis;
        const mainScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: nowMs,
          requestNamespace: "ns-full-main",
          thread: {
            threadId: mainThreadId,
            providerSessionId: "sess-full-main",
            providerInstanceId,
          },
          client: undefined,
        };
        const subagentScope: McpInvocationContext.McpInvocationScope = {
          ...mainScope,
          thread: {
            threadId: childThreadId,
            providerSessionId: "sess-full-child",
            providerInstanceId,
            subagent: true,
          },
        };
        const readOnlyScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: nowMs,
          requestNamespace: "ns-full-ro",
          thread: undefined,
          client: { sessionId: "ro-full", label: "RO", access: "read-only" },
        };
        const linkedScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: nowMs,
          requestNamespace: "ns-full-linked",
          thread: undefined,
          client: { sessionId: "link-full", label: "Peer", access: "full-access", linked: true },
        };

        yield* Effect.gen(function* () {
          // 1. Capabilities catalog + tool_search discover all 9 bytedock_* tools.
          const catalogRes = yield* callAs(readOnlyScope, "bytedock_capabilities_catalog", {});
          expect(catalogRes.isError).toBeFalsy();
          const catalog = catalogRes.structuredContent as {
            readonly tools: ReadonlyArray<{ readonly name: string }>;
            readonly services: Record<string, boolean>;
          };
          expect(catalog.tools.length).toBe(9);
          expect(catalog.services.serverSettings).toBe(true);
          expect(catalog.services.keybindings).toBe(true);
          expect(catalog.services.externalLauncher).toBe(true);
          expect(catalog.services.externalTunnel).toBe(false);

          const searchRes = yield* callAs(mainScope, "tool_search", { query: "bytedock" });
          expect(searchRes.isError).toBeFalsy();
          const foundNames = (
            (
              searchRes.structuredContent as {
                readonly tools?: ReadonlyArray<{ readonly name: string }>;
              }
            ).tools ?? []
          ).map((t) => t.name);
          expect(foundNames).toContain("bytedock_capabilities_catalog");
          expect(foundNames).toContain("bytedock_settings_control");
          expect(foundNames).toContain("bytedock_plugin_action");
          expect(foundNames).toContain("bytedock_ui_control");
          expect(foundNames).toContain("bytedock_system_control");

          // 2. Read settings as read-only client -> succeeds and NEVER echoes plaintext secret.
          const readRes = yield* callAs(readOnlyScope, "bytedock_settings_control", {
            action: "read",
          });
          expect(readRes.isError).toBeFalsy();
          const readData = (readRes.structuredContent as { readonly data: Record<string, unknown> })
            .data;
          expect(readData.settingsAvailable).toBe(true);
          expect(readData.availableEditors).toEqual(["vscode", "cursor"]);
          const rawJson = JSON.stringify(readData);
          expect(rawJson).not.toContain("sk-supersecretvalue1234567890");

          // Read-only & linked callers cannot patch settings or edit keybindings.
          const roPatch = yield* callAs(readOnlyScope, "bytedock_settings_control", {
            action: "patch_settings",
            patch: { promptSuggestionsEnabled: false },
          });
          expect(roPatch.isError).toBe(true);

          const linkedPatch = yield* callAs(linkedScope, "bytedock_settings_control", {
            action: "patch_settings",
            patch: { promptSuggestionsEnabled: false },
          });
          expect(linkedPatch.isError).toBe(true);

          // 3. Plaintext secret in settings patch is rejected.
          const secretPatch = yield* callAs(mainScope, "bytedock_settings_control", {
            action: "patch_settings",
            patch: { cloudSpeechCredentials: { openai: "sk-plaintextsecret999999999" } },
          });
          expect(secretPatch.isError).toBe(true);

          // 4. Low-risk settings patch applies directly without approval.
          const lowRiskRes = yield* callAs(mainScope, "bytedock_settings_control", {
            action: "patch_settings",
            patch: { promptSuggestionsEnabled: false, branchNamePrefix: "bd/" },
          });
          expect(lowRiskRes.isError).toBeFalsy();
          expect((lowRiskRes.structuredContent as { readonly status: string }).status).toBe(
            "applied",
          );
          const settingsSvc = yield* ServerSettings.ServerSettingsService;
          const afterLow = yield* settingsSvc.getSettings;
          expect(afterLow.promptSuggestionsEnabled).toBe(false);
          expect(afterLow.branchNamePrefix).toBe("bd/");

          // 5. Keybinding upsert & remove apply directly.
          const upsertKb = yield* callAs(mainScope, "bytedock_settings_control", {
            action: "upsert_keybinding",
            rule: { key: "mod+shift+k", command: "chat.new" },
          });
          expect(upsertKb.isError).toBeFalsy();
          expect((yield* Ref.get(keybindingsRef)).length).toBe(1);

          const removeKb = yield* callAs(mainScope, "bytedock_settings_control", {
            action: "remove_keybinding",
            rule: { key: "mod+shift+k", command: "chat.new" },
          });
          expect(removeKb.isError).toBeFalsy();
          expect((yield* Ref.get(keybindingsRef)).length).toBe(0);

          // 6. High-risk settings patch denied for subagent (zero approval created).
          const subHighRisk = yield* callAs(subagentScope, "bytedock_settings_control", {
            action: "patch_settings",
            patch: { enableAgentBrowserAccess: false },
          });
          expect(subHighRisk.isError).toBe(true);
          expect((yield* cp.approvals.listApprovals()).length).toBe(0);

          // 7. High-risk settings patch from main thread -> approval_required -> human approve applies!
          const mainHighRisk = yield* callAs(mainScope, "bytedock_settings_control", {
            action: "patch_settings",
            patch: { enableAgentBrowserAccess: false, defaultRuntimeMode: "approval-required" },
          });
          expect(mainHighRisk.isError).toBeFalsy();
          const highContent = mainHighRisk.structuredContent as {
            readonly status: string;
            readonly applied: boolean;
            readonly approval?: { readonly requestId: string; readonly kind: string };
          };
          expect(highContent.status).toBe("approval_required");
          expect(highContent.applied).toBe(false);
          expect(highContent.approval?.kind).toBe("host-settings-patch");
          const beforeApproveSettings = yield* settingsSvc.getSettings;
          expect(beforeApproveSettings.defaultRuntimeMode).not.toBe("approval-required");

          const approvedSettings = yield* cp.resolveApproval({
            requestId: highContent.approval!.requestId,
            decision: "approve",
            actor: { kind: "host-client", actorId: "human-reviewer" },
          });
          expect(approvedSettings.request.status).toBe("approved");
          const afterApproveSettings = yield* settingsSvc.getSettings;
          expect(afterApproveSettings.enableAgentBrowserAccess).toBe(false);
          expect(afterApproveSettings.defaultRuntimeMode).toBe("approval-required");

          // 8. Provider mutation: denied for subagent, approval-gated for main thread, applied on approval.
          const subProv = yield* callAs(subagentScope, "bytedock_settings_control", {
            action: "update_provider",
            mutation: {
              operation: "upsert",
              instanceId: "codex-alt",
              instance: { driver: "codex", displayName: "Codex Alt", enabled: true },
            },
          });
          expect(subProv.isError).toBe(true);

          const mainProv = yield* callAs(mainScope, "bytedock_settings_control", {
            action: "update_provider",
            mutation: {
              operation: "upsert",
              instanceId: "codex-alt",
              instance: { driver: "codex", displayName: "Codex Alt", enabled: true },
            },
          });
          expect(mainProv.isError).toBeFalsy();
          const provContent = mainProv.structuredContent as {
            readonly status: string;
            readonly approval?: { readonly requestId: string; readonly kind: string };
          };
          expect(provContent.status).toBe("approval_required");
          expect(provContent.approval?.kind).toBe("provider-mutation");

          yield* cp.resolveApproval({
            requestId: provContent.approval!.requestId,
            decision: "approve",
            actor: { kind: "host-client", actorId: "human-reviewer" },
          });
          const afterProv = yield* settingsSvc.getSettings;
          expect(
            afterProv.providerInstances[ProviderInstanceId.make("codex-alt")]?.displayName,
          ).toBe("Codex Alt");

          // 9. System status reports unavailable optional services honestly without fake data.
          const sysStatus = yield* callAs(readOnlyScope, "bytedock_system_control", {
            action: "status",
          });
          expect(sysStatus.isError).toBeFalsy();
          const sysData = (
            sysStatus.structuredContent as {
              readonly data: {
                readonly hostResources: { readonly available: boolean };
                readonly externalLauncher: {
                  readonly available: boolean;
                  readonly availableEditors?: ReadonlyArray<string>;
                };
              };
            }
          ).data;
          expect(sysData.hostResources.available).toBe(false);
          expect(sysData.externalLauncher.available).toBe(true);
          expect(sysData.externalLauncher.availableEditors).toEqual(["vscode", "cursor"]);

          // 10. Low-risk open_editor executes directly.
          const editorRes = yield* callAs(mainScope, "bytedock_system_control", {
            action: "open_editor",
            payload: { cwd: env.rootDir, editor: "vscode" },
          });
          expect(editorRes.isError).toBeFalsy();
          expect(launchedEditors).toHaveLength(1);
          expect(launchedEditors[0]?.editor).toBe("vscode");
        }).pipe(Effect.provide(mcpServices));
      }),
  );

  it.effect(
    "supports plugin actions, safe local plugin scaffolding, legacy T3 import approval, UI event bus, and high-risk system actions",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          watchFiles: false,
        });

        // Prepare a fake read-only legacy T3 source directory.
        const legacySourceDir = NodePath.join(env.rootDir, "legacy-t3");
        const legacyUserdata = NodePath.join(legacySourceDir, "userdata");
        NodeFS.mkdirSync(legacyUserdata, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(legacyUserdata, "settings.json"),
          JSON.stringify({ branchNamePrefix: "legacy/" }),
          "utf8",
        );

        const mainThreadId = ThreadId.make("thread-sys-main");
        const childThreadId = ThreadId.make("thread-sys-child");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const environmentId = EnvironmentId.make("env-sys-test");

        const mockThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id: ThreadId) =>
            Effect.succeed({
              id,
              projectId: "proj-1" as never,
              deletedAt: null,
              archivedAt: null,
              activeRunId: "run-1" as never,
              providerInstanceId,
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              pendingBackgroundTasks: [],
              lineage:
                id === childThreadId
                  ? {
                      kind: "delegated-task" as const,
                      parentThreadId: mainThreadId,
                      rootThreadId: mainThreadId,
                    }
                  : { kind: "root" as const },
            } as never),
        });

        let cleanupRuns = 0;
        let reclaimRuns = 0;
        const tunnelActions: Array<string> = [];
        const terminalOps: Array<string> = [];

        const mockHostResources = Layer.mock(HostResources.HostResources)({
          read: Effect.succeed({
            sampledAt: 1700000000000,
            cpuUtilization: 0.25,
            cpuCount: 8,
            availableMemoryBytes: 8_000_000_000,
            totalMemoryBytes: 16_000_000_000,
          } satisfies HostResourcesSnapshot),
        });

        const fakeCleanupReport = {
          ranAt: "2026-11-27T00:00:00Z",
          deletedWorktrees: 1,
          deletedBrowserArtifacts: 0,
          deletedLogs: 0,
          freedBytes: 4096,
        } as unknown as StorageCleanupReport;

        const mockStorageCleanup = Layer.mock(StorageCleanup.StorageCleanup)({
          latestReport: Effect.succeed(fakeCleanupReport),
          runNow: Effect.sync(() => {
            cleanupRuns += 1;
            return fakeCleanupReport;
          }),
        });

        const fakeDbStatus: DatabaseStorageStatus = {
          databaseBytes: 10_000_000,
          reclaimableBytes: 2_000_000,
          incrementalVacuumEnabled: false,
          compactCommand: "bytedock doctor",
          canReclaim: true,
        };
        const mockDbStorage = Layer.mock(DatabaseStorage.DatabaseStorage)({
          status: Stream.make(fakeDbStatus),
          requestReclaim: Effect.sync(() => {
            reclaimRuns += 1;
          }),
        });

        const fakeTunnelStatus = {
          running: false,
          healthState: "idle",
        } as unknown as ExternalTunnelStatus;
        const mockTunnel = Layer.mock(ExternalTunnelService.ExternalTunnelService)({
          getStatus: Effect.succeed(fakeTunnelStatus),
          action: (input) =>
            Effect.sync(() => {
              tunnelActions.push(input.action);
              return fakeTunnelStatus;
            }),
        });

        const mockTerminal = Layer.mock(TerminalManager.TerminalManager)({
          open: (input: TerminalOpenInput) =>
            Effect.sync(() => {
              terminalOps.push(`open:${input.terminalId}`);
              return {
                threadId: input.threadId,
                terminalId: input.terminalId,
                cwd: input.cwd,
                worktreePath: null,
                status: "running" as const,
                pid: 4242,
                history: "",
                exitCode: null,
                exitSignal: null,
                label: input.terminalId,
                updatedAt: "2026-11-27T00:00:00Z",
              };
            }),
          write: (input: TerminalWriteInput) =>
            Effect.sync(() => {
              terminalOps.push(`write:${input.terminalId}:${input.data}`);
            }),
          close: (input: TerminalCloseInput) =>
            Effect.sync(() => {
              terminalOps.push(`close:${input.terminalId ?? "*"}`);
            }),
        });

        const mcpServices = McpHttpServer.layerToolSearch.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(Layer.succeed(PluginControlPlane, cp)),
          Layer.provideMerge(Layer.succeed(PluginKernel.PluginKernel, kernel)),
          Layer.provideMerge(mockThreads),
          Layer.provideMerge(mockHostResources),
          Layer.provideMerge(mockStorageCleanup),
          Layer.provideMerge(mockDbStorage),
          Layer.provideMerge(mockTunnel),
          Layer.provideMerge(mockTerminal),
        );

        const mcpClient = makeMcpClient();
        const callAs = (
          scope: McpInvocationContext.McpInvocationScope,
          toolName: string,
          args: Record<string, unknown>,
        ) =>
          Effect.gen(function* () {
            const mcp = yield* McpServer.McpServer;
            return yield* mcp
              .callTool({ name: toolName, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
                Effect.provideService(McpSchema.McpServerClient, mcpClient),
              );
          });

        const nowMs = yield* Clock.currentTimeMillis;
        const mainScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: nowMs,
          requestNamespace: "ns-sys-main",
          thread: {
            threadId: mainThreadId,
            providerSessionId: "sess-sys-main",
            providerInstanceId,
          },
          client: undefined,
        };
        const subagentScope: McpInvocationContext.McpInvocationScope = {
          ...mainScope,
          thread: {
            threadId: childThreadId,
            providerSessionId: "sess-sys-child",
            providerInstanceId,
            subagent: true,
          },
        };
        const readOnlyScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: nowMs,
          requestNamespace: "ns-sys-ro",
          thread: undefined,
          client: { sessionId: "ro-sys", label: "RO", access: "read-only" },
        };

        yield* Effect.gen(function* () {
          // 1. Plugin actions: egress_audit, egress_proof, legacy_scan, invoke.
          const auditRes = yield* callAs(readOnlyScope, "bytedock_plugin_action", {
            action: "egress_audit",
          });
          expect(auditRes.isError).toBeFalsy();

          const proofRes = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "egress_proof",
          });
          expect(proofRes.isError).toBeFalsy();
          const proofData = (
            proofRes.structuredContent as {
              readonly data: {
                readonly liveAttribution: { readonly verdict: string };
                readonly detachedAllBlock: { readonly verdict: string };
              };
            }
          ).data;
          expect(proofData.liveAttribution.verdict).toBe("pass");
          expect(proofData.detachedAllBlock.verdict).toBe("pass");

          const scanRes = yield* callAs(readOnlyScope, "bytedock_plugin_action", {
            action: "legacy_scan",
            customSourceDir: legacySourceDir,
          });
          expect(scanRes.isError).toBeFalsy();

          const invokeOk = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "invoke",
            pluginId: "builtin.token-optimizer",
            method: "status",
          });
          expect(invokeOk.isError).toBeFalsy();

          const invokeSummary = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "invoke",
            pluginId: "builtin.token-optimizer",
            method: "threadSummary",
            payload: { threadId: mainThreadId },
          });
          expect(invokeSummary.isError).toBeFalsy();
          const summaryData = (
            invokeSummary.structuredContent as {
              readonly data: {
                readonly threadId: string;
                readonly config: { readonly watchdogWarnAfterSec: number };
                readonly summary: { readonly prefixHashStable: boolean };
              };
            }
          ).data;
          expect(summaryData.threadId).toBe(mainThreadId);
          expect(summaryData.config.watchdogWarnAfterSec).toBe(45);
          expect(summaryData.summary.prefixHashStable).toBe(true);

          // Privileged control-plane and direct legacy import invoke are blocked.
          const invokeCp = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "invoke",
            pluginId: "builtin.control-plane",
            method: "resolveApproval",
          });
          expect(invokeCp.isError).toBe(true);

          const invokeDirectImport = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "invoke",
            pluginId: "builtin.legacy-importer",
            method: "import",
          });
          expect(invokeDirectImport.isError).toBe(true);

          // 2. Scaffold local plugin: rejects traversal & builtin collision, creates disabled unapproved plugin.
          const badTraversal = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "scaffold_local_plugin",
            pluginId: "../escape",
          });
          expect(badTraversal.isError).toBe(true);

          const badCollision = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "scaffold_local_plugin",
            pluginId: "builtin.egress-guard",
          });
          expect(badCollision.isError).toBe(true);

          const scaffoldOk = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "scaffold_local_plugin",
            pluginId: "local.ai-helper",
            displayName: "AI Helper",
          });
          expect(scaffoldOk.isError).toBeFalsy();
          const stateAfterScaffold = yield* cp.getState();
          const createdPlugin = stateAfterScaffold.plugins.find((p) => p.id === "local.ai-helper");
          expect(createdPlugin).toBeDefined();
          expect(createdPlugin?.approved).toBe(false);
          expect(createdPlugin?.status).toBe("disabled");

          // Duplicate scaffold refuses overwrite.
          const scaffoldDup = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "scaffold_local_plugin",
            pluginId: "local.ai-helper",
          });
          expect(scaffoldDup.isError).toBe(true);

          // 3. Legacy import requires main session + human approval.
          const subImport = yield* callAs(subagentScope, "bytedock_plugin_action", {
            action: "legacy_import",
            sourceBaseDir: legacySourceDir,
            categories: ["settings"],
          });
          expect(subImport.isError).toBe(true);
          expect(NodeFS.existsSync(NodePath.join(env.stateDir, "settings.json"))).toBe(false);

          const mainImport = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "legacy_import",
            sourceBaseDir: legacySourceDir,
            sourceBrand: "custom",
            categories: ["settings"],
          });
          expect(mainImport.isError).toBeFalsy();
          const importReqId = (
            mainImport.structuredContent as { readonly approval?: { readonly requestId: string } }
          ).approval?.requestId;
          expect(importReqId).toBeDefined();
          expect(NodeFS.existsSync(NodePath.join(env.stateDir, "settings.json"))).toBe(false);

          const importApproved = yield* cp.resolveApproval({
            requestId: importReqId!,
            decision: "approve",
            actor: { kind: "host-client", actorId: "human-1" },
          });
          expect(importApproved.request.status).toBe("approved");
          expect(NodeFS.existsSync(NodePath.join(env.stateDir, "settings.json"))).toBe(true);

          // 4. UI control bus emits real-time events and blocks unsafe navigation/nodes.
          const uiFiber = yield* cp
            .subscribeEvents()
            .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
          yield* Effect.yieldNow;

          const uiOpen = yield* callAs(mainScope, "bytedock_ui_control", {
            action: "open_control_center",
            tab: "import",
          });
          expect(uiOpen.isError).toBeFalsy();

          const uiOpenXray = yield* callAs(mainScope, "bytedock_ui_control", {
            action: "open_control_center",
            tab: "xray",
          });
          expect(uiOpenXray.isError).toBeFalsy();

          const uiNav = yield* callAs(mainScope, "bytedock_ui_control", {
            action: "navigate",
            path: "/settings/general",
          });
          expect(uiNav.isError).toBeFalsy();

          const streamedUi = yield* Fiber.join(uiFiber);
          expect(streamedUi.length).toBe(3);
          expect((streamedUi[0]?.payload as { readonly kind?: string } | undefined)?.kind).toBe(
            "ui-command",
          );
          expect((streamedUi[1]?.payload as { readonly kind?: string } | undefined)?.kind).toBe(
            "ui-command",
          );

          const badNav = yield* callAs(mainScope, "bytedock_ui_control", {
            action: "navigate",
            path: "https://evil.example/steal",
          });
          expect(badNav.isError).toBe(true);

          const badJsNav = yield* callAs(mainScope, "bytedock_ui_control", {
            action: "navigate",
            path: "javascript:alert(1)",
          });
          expect(badJsNav.isError).toBe(true);

          const badDockNode = yield* callAs(mainScope, "bytedock_ui_control", {
            action: "open_dock_panel",
            pluginId: "builtin.egress-guard",
            node: { t: "RawScriptTag" },
          });
          expect(badDockNode.isError).toBe(true);

          // 4b. Bots & NapCatQQ MCP controls: UI tab "bots" and safe read/openGate succeed, while host-only mutations & secrets are blocked.
          const uiOpenBots = yield* callAs(mainScope, "bytedock_ui_control", {
            action: "open_control_center",
            tab: "bots",
          });
          expect(uiOpenBots.isError).toBeFalsy();

          const botsStateRes = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "invoke",
            pluginId: "builtin.bots-core",
            method: "getState",
          });
          expect(botsStateRes.isError).toBeFalsy();

          const openGateRes = yield* callAs(mainScope, "bytedock_plugin_action", {
            action: "invoke",
            pluginId: "builtin.bots-core",
            method: "openGate",
            payload: { title: "MCP check", summary: "Confirm release notes" },
          });
          expect(openGateRes.isError).toBeFalsy();
          const createdGateId =
            (openGateRes.structuredContent as { readonly data?: { readonly gateId?: string } }).data
              ?.gateId ?? "";
          expect(createdGateId).toMatch(/^gate-/);

          for (const blocked of [
            {
              pluginId: "builtin.bots-core",
              method: "resolveGate",
              payload: { gateId: createdGateId, decision: "approved" },
            },
            {
              pluginId: "builtin.bots-core",
              method: "updateSoul",
              payload: { botId: "default", soulMarkdown: "pwned" },
            },
            {
              pluginId: "builtin.bots-core",
              method: "upsertBot",
              payload: { id: "default", name: "Hijack" },
            },
            {
              pluginId: "community.napcat-qq",
              method: "setTokenSecret",
              payload: { token: "leaked" },
            },
            { pluginId: "community.napcat-qq", method: "clearTokenSecret", payload: {} },
            {
              pluginId: "community.napcat-qq",
              method: "simulateInbound",
              payload: { chatType: "private", userId: "10001", text: `/approve ${createdGateId}` },
            },
            {
              pluginId: "community.napcat-qq",
              method: "sendReply",
              payload: { chatType: "private", targetId: "10001", text: "spam" },
            },
          ]) {
            const denied = yield* callAs(mainScope, "bytedock_plugin_action", {
              action: "invoke",
              pluginId: blocked.pluginId,
              method: blocked.method,
              payload: blocked.payload,
            });
            expect(denied.isError).toBe(true);
          }

          // Disabling builtin.bots-core via MCP cannot silently strip SOUL.md prefix guard -> requires human approval.
          const disableBotsRes = yield* callAs(mainScope, "bytedock_plugin_set_enabled", {
            pluginId: "builtin.bots-core",
            enabled: false,
          });
          expect(disableBotsRes.isError).toBeFalsy();
          expect((disableBotsRes.structuredContent as { readonly status?: string }).status).toBe(
            "approval_required",
          );

          // 5. High-risk system actions: denied for subagent, approval-gated for main thread, executed on human approve.
          const subCleanup = yield* callAs(subagentScope, "bytedock_system_control", {
            action: "storage_cleanup",
          });
          expect(subCleanup.isError).toBe(true);
          expect(cleanupRuns).toBe(0);

          const approveSystemAction = (
            action:
              | "storage_cleanup"
              | "database_reclaim"
              | "tunnel_action"
              | "terminal_open"
              | "terminal_write"
              | "terminal_close",
            payload?: Record<string, unknown>,
          ) =>
            Effect.gen(function* () {
              const res = yield* callAs(mainScope, "bytedock_system_control", {
                action,
                ...(payload !== undefined ? { payload } : {}),
              });
              expect(res.isError).toBeFalsy();
              const content = res.structuredContent as {
                readonly status: string;
                readonly approval?: {
                  readonly requestId: string;
                  readonly summary: string;
                  readonly reasons: ReadonlyArray<string>;
                };
              };
              expect(content.status).toBe("approval_required");
              if (action === "database_reclaim") {
                expect(content.approval?.reasons).toContain("restarts-bytedock-server");
                expect(content.approval?.summary.toLowerCase()).toContain("restart");
              }
              const resolved = yield* cp.resolveApproval({
                requestId: content.approval!.requestId,
                decision: "approve",
                actor: { kind: "host-client", actorId: "human-1" },
              });
              expect(resolved.request.status).toBe("approved");
            });

          yield* approveSystemAction("storage_cleanup");
          expect(cleanupRuns).toBe(1);

          yield* approveSystemAction("database_reclaim");
          expect(reclaimRuns).toBe(1);

          yield* approveSystemAction("tunnel_action", { action: "check" });
          expect(tunnelActions).toEqual(["check"]);

          yield* approveSystemAction("terminal_open", {
            threadId: mainThreadId,
            terminalId: "term-1",
            cwd: env.rootDir,
          });
          yield* approveSystemAction("terminal_write", {
            threadId: mainThreadId,
            terminalId: "term-1",
            data: "echo hi\n",
          });
          yield* approveSystemAction("terminal_close", {
            threadId: mainThreadId,
            terminalId: "term-1",
          });
          expect(terminalOps).toEqual(["open:term-1", "write:term-1:echo hi\n", "close:term-1"]);

          // 6. Audit chain remains intact across all operations.
          const audit = cp.approvals.verifyAuditChain();
          expect(audit.state).toBe("verified");
          expect(audit.count).toBeGreaterThanOrEqual(10);
        }).pipe(Effect.provide(mcpServices));
      }),
  );
});
