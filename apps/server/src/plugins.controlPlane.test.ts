// @effect-diagnostics nodeBuiltinImport:off -- Integration tests exercise real plugins.yml and default ~/.bytedock/plugins disk paths.
// @effect-diagnostics anyUnknownInErrorContext:off -- In-process McpServer.tools entries carry erased handler error/context types.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as PluginKernel from "@bytedock/plugin-kernel";
import * as ServerConfig from "./config.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpInvocationContext from "./mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as BuiltinPluginRuntime from "./plugins/BuiltinPluginRuntime.ts";
import { makePluginControlPlane, PluginControlPlane } from "./plugins/PluginControlPlane.ts";

const tempDirs: Array<string> = [];

function makeTempEnv(): {
  readonly rootDir: string;
  readonly stateDir: string;
  readonly logsDir: string;
  readonly pluginConfigPath: string;
  readonly pluginsDir: string;
} {
  const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-cp-test-"));
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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && NodeFS.existsSync(dir)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ByteDock AI Control Plane (OpenSpec bytedock-ai-control-plane)", () => {
  it.effect("derives default pluginConfigPath and pluginsDir in ServerConfig", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      expect(config.pluginConfigPath).toBe(NodePath.join(config.stateDir, "plugins.yml"));
      expect(config.pluginsDir).toBe(NodePath.join(config.baseDir, "plugins"));
      expect(NodeFS.existsSync(config.pluginsDir)).toBe(true);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "bytedock-config-paths-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect(
    "toggles normal plugins and hot-reloads config immediately via control plane and plugins.yml",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          watchFiles: false,
        });

        // Register a hook and dynamic MCP tool for builtin.token-optimizer to verify disable gating.
        let hookCalls = 0;
        yield* kernel.hooks.register({
          pluginId: "builtin.token-optimizer",
          revision: 2,
          name: "agent.turn.before",
          priority: 10,
          onError: "pass",
          timeoutMs: 200,
          handler: () =>
            Effect.sync(() => {
              hookCalls += 1;
              return { verdict: "pass" as const, contribution: { appendContext: "opt-tag" } };
            }),
        });
        yield* kernel.mcpBridge.registerTool({
          pluginId: "builtin.token-optimizer",
          revision: 2,
          name: "token_optimizer_probe",
          description: "Probe tool for token optimizer",
          direct: true,
          handler: () => Effect.succeed({ text: "ok" }),
        });

        const initial = yield* cp.getState();
        expect(initial.plugins.find((p) => p.id === "builtin.token-optimizer")?.status).toBe(
          "active",
        );

        // 1. Disable normal plugin from main MCP thread -> applies immediately without approval.
        const mainActor = {
          kind: "mcp-main-thread" as const,
          threadId: "thread-main-1",
          providerInstanceId: "codex",
        };
        const disabled = yield* cp.setPluginEnabled({
          pluginId: "builtin.token-optimizer",
          enabled: false,
          actor: mainActor,
        });
        expect(disabled.status).toBe("applied");
        if (disabled.status === "applied") {
          expect(disabled.enabled).toBe(false);
          expect(disabled.pluginStatus).toBe("disabled");
        }
        expect(NodeFS.existsSync(env.pluginConfigPath)).toBe(true);

        // Hooks, dynamic MCP tool, and builtin invoke must all respect disabled state.
        const turnResult = yield* kernel.hooks.runTurnBefore({
          threadId: "t1",
          revision: 2,
          projectedMessage: "hello",
        });
        expect(hookCalls).toBe(0);
        expect(turnResult.payload.outboundUserText).toBe("hello");
        expect(kernel.mcpBridge.listSearchableTools()).toEqual([]);

        const invokeDisabledExit = yield* Effect.exit(
          BuiltinPluginRuntime.invokeBuiltinPluginMethod({
            kernel,
            controlPlane: cp,
            targetStateDir: env.stateDir,
            pluginId: "builtin.token-optimizer",
            method: "status",
            payload: {},
          }),
        );
        expect(Exit.isFailure(invokeDisabledExit)).toBe(true);

        // 2. Re-enable and patch normal business config -> applies immediately.
        const reEnabled = yield* cp.setPluginEnabled({
          pluginId: "builtin.token-optimizer",
          enabled: true,
          actor: mainActor,
        });
        expect(reEnabled.status).toBe("applied");

        const patched = yield* cp.patchPluginConfig({
          pluginId: "builtin.token-optimizer",
          patch: { cacheGuardActive: false, steadyStateTargetPct: 82 },
          actor: mainActor,
        });
        expect(patched.status).toBe("applied");

        const optStatus = (yield* BuiltinPluginRuntime.invokeBuiltinPluginMethod({
          kernel,
          controlPlane: cp,
          targetStateDir: env.stateDir,
          pluginId: "builtin.token-optimizer",
          method: "status",
          payload: {},
        })) as { readonly cacheGuardActive: boolean; readonly steadyStateTargetPct: number };
        expect(optStatus.cacheGuardActive).toBe(false);
        expect(optStatus.steadyStateTargetPct).toBe(82);

        const turnAfterEnable = yield* kernel.hooks.runTurnBefore({
          threadId: "t1",
          revision: 2,
          projectedMessage: "hello",
        });
        expect(hookCalls).toBe(1);
        expect(turnAfterEnable.payload.outboundUserText).toContain("opt-tag");

        // 3. Invalid YAML on disk keeps previous valid snapshot and exposes diagnostic.
        NodeFS.writeFileSync(env.pluginConfigPath, "schemaVersion: 1\nplugins: [broken:\n", "utf8");
        const badReload = yield* cp.reloadFromDisk({ reason: "test-malformed-yaml" });
        expect(badReload.status).toBe("kept-previous-on-error");
        expect(badReload.configDiagnostic).toBeDefined();
        const cfgAfterBad = yield* cp.getPluginConfig("builtin.token-optimizer");
        expect(cfgAfterBad.steadyStateTargetPct).toBe(82);

        // 4. Out-of-range schema on disk keeps previous valid snapshot and exposes diagnostic.
        NodeFS.writeFileSync(
          env.pluginConfigPath,
          "schemaVersion: 1\nplugins:\n  community.napcat-qq:\n    enabled: true\n    config:\n      rateLimitPerMin: 0\n",
          "utf8",
        );
        const badSchemaReload = yield* cp.reloadFromDisk({ reason: "test-bad-schema" });
        expect(badSchemaReload.status).toBe("kept-previous-on-error");
        expect(badSchemaReload.configDiagnostic?.pluginId).toBe("community.napcat-qq");

        // 5. Plaintext secret in MCP patch is rejected without writing disk.
        const secretExit = yield* Effect.exit(
          cp.patchPluginConfig({
            pluginId: "community.napcat-qq",
            patch: { apiKey: "sk-plaintextleak1234567890" },
            actor: mainActor,
          }),
        );
        expect(Exit.isFailure(secretExit)).toBe(true);

        // 6. CAS stale mtime protects manual disk edits.
        NodeFS.writeFileSync(
          env.pluginConfigPath,
          "schemaVersion: 1\nplugins:\n  community.napcat-qq:\n    enabled: true\n    config:\n      rateLimitPerMin: 90\n",
          "utf8",
        );
        yield* cp.reloadFromDisk({ reason: "restore-valid" });
        const staleExit = yield* Effect.exit(
          cp.patchPluginConfig({
            pluginId: "community.napcat-qq",
            patch: { rateLimitPerMin: 75 },
            expectedMtimeMs: 1,
            actor: mainActor,
          }),
        );
        expect(Exit.isFailure(staleExit)).toBe(true);
        const afterStale = yield* cp.getPluginConfig("community.napcat-qq");
        expect(afterStale.rateLimitPerMin).toBe(90);
      }),
  );

  it.live(
    "auto-reloads plugins.yml changes via live fs.watch and handles default ~/.bytedock/plugins hot reload + error rollback",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          watchFiles: true,
        });

        // Subscribe to control-plane events stream before modifying plugins.yml on disk.
        const eventFiber = yield* cp
          .subscribeEvents()
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        NodeFS.writeFileSync(
          env.pluginConfigPath,
          "schemaVersion: 1\nplugins:\n  community.napcat-qq:\n    enabled: true\n    config:\n      rateLimitPerMin: 120\n",
          "utf8",
        );

        // Wait deterministically for the control-plane PubSub event triggered by fs.watch debounce.
        const streamed = yield* Fiber.join(eventFiber);
        expect(streamed.length).toBe(1);
        const napcatCfg = yield* cp.getPluginConfig("community.napcat-qq");
        expect(napcatCfg.rateLimitPerMin).toBe(120);

        // Create a local plugin in default ~/.bytedock/plugins/local-demo.
        const localDir = NodePath.join(env.pluginsDir, "local-demo");
        NodeFS.mkdirSync(localDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(localDir, "manifest.json"),
          JSON.stringify({
            id: "local.demo",
            name: "Local Demo Plugin",
            version: "0.1.0",
            apiVersion: "0.1",
            execution: "trusted-worker",
            trust: "local-dev",
            entry: { server: "./index.ts" },
            permissions: { storage: "none", networkHosts: ["127.0.0.1"] },
          }),
          "utf8",
        );
        NodeFS.writeFileSync(
          NodePath.join(localDir, "index.ts"),
          "export const activate = () => ({ ok: true });\n",
          "utf8",
        );

        yield* cp.reloadFromDisk({ reason: "discover-local" });
        const beforeApprove = yield* cp.getState();
        const localBefore = beforeApprove.plugins.find((p) => p.id === "local.demo");
        expect(localBefore).toBeDefined();
        expect(localBefore?.approved).toBe(false);
        expect(localBefore?.status).toBe("disabled");

        // Enabling unapproved local plugin from main session MUST require human approval.
        const mainActor = { kind: "mcp-main-thread" as const, threadId: "thread-main-local" };
        const reqOutcome = yield* cp.setPluginEnabled({
          pluginId: "local.demo",
          enabled: true,
          actor: mainActor,
        });
        expect(reqOutcome.status).toBe("approval_required");
        if (reqOutcome.status !== "approval_required") return;
        expect(reqOutcome.request.kind).toBe("local-plugin-enable");

        // Human host approves -> plugin compiles and becomes active.
        const resolved = yield* cp.resolveApproval({
          requestId: reqOutcome.request.requestId,
          decision: "approve",
          actor: { kind: "host-client", actorId: "human-1" },
        });
        expect(resolved.request.status).toBe("approved");
        expect(resolved.applied?.pluginStatus).toBe("active");
        const revAfterGood = resolved.applied?.activeRevision ?? 0;

        // Introduce syntax error in local plugin -> hot reload keeps previous revision and exposes line/column diagnostic.
        NodeFS.writeFileSync(
          NodePath.join(localDir, "index.ts"),
          "export const broken = (\n",
          "utf8",
        );
        const brokenReload = yield* cp.reloadFromDisk({ reason: "local-syntax-error" });
        expect(brokenReload.status).toBe("kept-previous-on-error");
        expect(brokenReload.activeRevision).toBe(revAfterGood);
        expect(brokenReload.reloadDiagnostic?.pluginId).toBe("local.demo");
        expect(brokenReload.reloadDiagnostic?.line).toBeGreaterThanOrEqual(1);
      }),
  );

  it.effect(
    "enforces firewall main-session-only restriction, human approval gate, expiry, single-use, and audit chain",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          watchFiles: false,
          approvalTtlMs: 60_000,
        });

        // 1. Subagent / non-main caller modifying builtin.egress-guard -> immediate deny, zero approval created.
        const subagentActor = {
          kind: "mcp-non-main" as const,
          reason: "delegated-subagent-thread",
          actorId: "subagent:child-1",
        };
        const subagentExit = yield* Effect.exit(
          cp.patchPluginConfig({
            pluginId: "builtin.egress-guard",
            patch: { mode: "strict", allowedHosts: ["api.openai.com"] },
            actor: subagentActor,
          }),
        );
        expect(Exit.isFailure(subagentExit)).toBe(true);
        expect((yield* cp.approvals.listApprovals()).length).toBe(0);

        const subagentDisableExit = yield* Effect.exit(
          cp.setPluginEnabled({
            pluginId: "builtin.egress-guard",
            enabled: false,
            actor: subagentActor,
          }),
        );
        expect(Exit.isFailure(subagentDisableExit)).toBe(true);
        expect((yield* cp.approvals.listApprovals()).length).toBe(0);

        // 2. Main session modifying firewall mode/allowedHosts -> creates pending approval without mutating policy.
        const mainActor = { kind: "mcp-main-thread" as const, threadId: "thread-main-fw" };
        const fwReq = yield* cp.patchPluginConfig({
          pluginId: "builtin.egress-guard",
          patch: {
            mode: "strict",
            allowedHosts: ["api.openai.com", "api.example.com"],
            deniedDomains: ["custom-blocked.example"],
          },
          actor: mainActor,
        });
        expect(fwReq.status).toBe("approval_required");
        if (fwReq.status !== "approval_required") return;
        expect(kernel.egress.getPolicy().mode).toBe("audit-only");

        // 3. MCP caller cannot self-approve.
        const selfApproveExit = yield* Effect.exit(
          cp.resolveApproval({
            requestId: fwReq.request.requestId,
            decision: "approve",
            actor: mainActor,
          }),
        );
        expect(Exit.isFailure(selfApproveExit)).toBe(true);

        // 4. Host human approves -> atomically persists plugins.yml, updates live policy, keeps DEFAULT_DENIED_DOMAINS.
        const approved = yield* cp.resolveApproval({
          requestId: fwReq.request.requestId,
          decision: "approve",
          actor: { kind: "host-client", actorId: "desktop-user" },
        });
        expect(approved.request.status).toBe("approved");
        const livePolicy = kernel.egress.getPolicy();
        expect(livePolicy.mode).toBe("strict");
        expect(livePolicy.allowedHosts).toContain("api.example.com");
        for (const baseline of PluginKernel.DEFAULT_DENIED_DOMAINS) {
          expect(livePolicy.deniedDomains).toContain(baseline);
        }
        expect(livePolicy.deniedDomains).toContain("custom-blocked.example");

        // 5. Re-resolving already approved request fails cleanly.
        const doubleResolveExit = yield* Effect.exit(
          cp.resolveApproval({
            requestId: fwReq.request.requestId,
            decision: "reject",
            actor: { kind: "host-client", actorId: "desktop-user" },
          }),
        );
        expect(Exit.isFailure(doubleResolveExit)).toBe(true);

        // 6. Rejection leaves policy untouched.
        const disableReq = yield* cp.setPluginEnabled({
          pluginId: "builtin.egress-guard",
          enabled: false,
          actor: mainActor,
        });
        expect(disableReq.status).toBe("approval_required");
        if (disableReq.status !== "approval_required") return;
        const rejected = yield* cp.resolveApproval({
          requestId: disableReq.request.requestId,
          decision: "reject",
          actor: { kind: "host-client", actorId: "desktop-user" },
        });
        expect(rejected.request.status).toBe("rejected");
        expect(yield* cp.isPluginEnabled("builtin.egress-guard")).toBe(true);

        // 7. Expiration after TTL blocks late approval.
        const expReq = yield* cp.patchPluginConfig({
          pluginId: "builtin.egress-guard",
          patch: { allowUdp: true },
          actor: mainActor,
        });
        expect(expReq.status).toBe("approval_required");
        if (expReq.status !== "approval_required") return;

        yield* TestClock.adjust("65 seconds");
        const lateExit = yield* Effect.exit(
          cp.resolveApproval({
            requestId: expReq.request.requestId,
            decision: "approve",
            actor: { kind: "host-client", actorId: "desktop-user" },
          }),
        );
        expect(Exit.isFailure(lateExit)).toBe(true);
        expect(kernel.egress.getPolicy().allowUdp).toBe(false);

        // 8. Hash-chained audit log integrity verifies cleanly.
        const audit = cp.approvals.verifyAuditChain();
        expect(audit.state).toBe("verified");
        expect(audit.count).toBeGreaterThanOrEqual(6);
      }),
  );

  it.effect(
    "exposes bytedock_* MCP tools via handlers and enforces read-only, linked, subagent, and main-session rules",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          watchFiles: false,
        });

        const mainThreadId = ThreadId.make("thread-main-mcp");
        const childThreadId = ThreadId.make("thread-child-mcp");
        const providerInstanceId = ProviderInstanceId.make("codex");
        const environmentId = EnvironmentId.make("env-local-test");

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

        const mcpServices = McpHttpServer.layerToolSearch.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provideMerge(Layer.succeed(PluginControlPlane, cp)),
          Layer.provideMerge(Layer.succeed(PluginKernel.PluginKernel, kernel)),
          Layer.provideMerge(mockThreads),
        );

        const mcpClient = McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: {},
          clientInfo: { name: "bytedock-test", version: "0.1.0" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "bytedock-test", version: "0.1.0" },
          },
          getClient: Effect.die("unused"),
        });

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
          requestNamespace: "ns-main",
          thread: {
            threadId: mainThreadId,
            providerSessionId: "sess-main",
            providerInstanceId,
          },
          client: undefined,
        };
        const subagentScope: McpInvocationContext.McpInvocationScope = {
          ...mainScope,
          thread: {
            threadId: childThreadId,
            providerSessionId: "sess-child",
            providerInstanceId,
            subagent: true,
          },
        };
        const readOnlyClientScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: nowMs,
          requestNamespace: "ns-ro",
          thread: undefined,
          client: { sessionId: "ro-1", label: "RO", access: "read-only" },
        };
        const linkedClientScope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt: nowMs,
          requestNamespace: "ns-linked",
          thread: undefined,
          client: { sessionId: "link-1", label: "Peer", access: "full-access", linked: true },
        };

        yield* Effect.gen(function* () {
          const mcp = yield* McpServer.McpServer;
          const names = mcp.tools.map((t) => t.tool.name);
          expect(names).toContain("bytedock_config_read");
          expect(names).toContain("bytedock_plugin_set_enabled");
          expect(names).toContain("bytedock_plugin_config_patch");
          expect(names).toContain("bytedock_plugins_reload");
          expect(names).toContain("tool_search");

          // Verify deferred tool discovery via tool_search finds bytedock_* tools.
          const searchRes = yield* callAs(mainScope, "tool_search", { query: "bytedock" });
          expect(searchRes.isError).toBeFalsy();
          const searched = (
            searchRes.structuredContent as
              | { readonly tools?: ReadonlyArray<{ readonly name: string }> }
              | undefined
          )?.tools;
          expect(searched?.map((t) => t.name)).toContain("bytedock_config_read");
          expect(searched?.map((t) => t.name)).toContain("bytedock_plugin_set_enabled");

          // Read config as main thread.
          const readRes = yield* callAs(mainScope, "bytedock_config_read", {});
          expect(readRes.isError).toBeFalsy();
          const readContent = readRes.structuredContent as
            | { readonly plugins: ReadonlyArray<{ readonly id: string }> }
            | undefined;
          expect(readContent?.plugins.length).toBe(5);

          // Read-only client cannot toggle plugins.
          const roToggle = yield* callAs(readOnlyClientScope, "bytedock_plugin_set_enabled", {
            pluginId: "builtin.token-optimizer",
            enabled: false,
          });
          expect(roToggle.isError).toBe(true);

          // Linked caller cannot patch plugins (even with full-access link).
          const linkedPatch = yield* callAs(linkedClientScope, "bytedock_plugin_config_patch", {
            pluginId: "builtin.token-optimizer",
            patch: { steadyStateTargetPct: 85 },
          });
          expect(linkedPatch.isError).toBe(true);

          // Main thread toggles normal plugin immediately.
          const toggleRes = yield* callAs(mainScope, "bytedock_plugin_set_enabled", {
            pluginId: "builtin.token-optimizer",
            enabled: false,
          });
          expect(toggleRes.isError).toBeFalsy();
          const toggleContent = toggleRes.structuredContent as
            | { readonly applied: boolean; readonly pluginStatus?: string }
            | undefined;
          expect(toggleContent?.applied).toBe(true);
          expect(toggleContent?.pluginStatus).toBe("disabled");

          // Subagent attempting firewall patch is denied with no approval created.
          const subagentFw = yield* callAs(subagentScope, "bytedock_plugin_config_patch", {
            pluginId: "builtin.egress-guard",
            patch: { mode: "strict", allowedHosts: ["api.openai.com"] },
          });
          expect(subagentFw.isError).toBe(true);
          expect((yield* cp.approvals.listApprovals()).length).toBe(0);

          // Main thread firewall patch returns approval_required.
          const mainFw = yield* callAs(mainScope, "bytedock_plugin_config_patch", {
            pluginId: "builtin.egress-guard",
            patch: { mode: "strict", allowedHosts: ["api.openai.com"] },
          });
          expect(mainFw.isError).toBeFalsy();
          const fwContent = mainFw.structuredContent as
            | {
                readonly status: string;
                readonly applied: boolean;
                readonly approval?: { readonly requestId: string };
              }
            | undefined;
          expect(fwContent?.status).toBe("approval_required");
          expect(fwContent?.applied).toBe(false);
          expect(fwContent?.approval?.requestId).toBeDefined();

          // Reload tool returns cleanly.
          const reloadRes = yield* callAs(mainScope, "bytedock_plugins_reload", {});
          expect(reloadRes.isError).toBeFalsy();
          const reloadContent = reloadRes.structuredContent as
            | { readonly activeRevision: number }
            | undefined;
          expect(reloadContent?.activeRevision).toBeGreaterThanOrEqual(2);
        }).pipe(Effect.provide(mcpServices));
      }),
  );
});
