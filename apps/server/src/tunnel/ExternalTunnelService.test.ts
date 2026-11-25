// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ExternalTunnelService,
  classifyTunnelCandidate,
  diagnoseTunnelLogs,
  layer as externalTunnelLayer,
  parseCommandArgs,
} from "./ExternalTunnelService.ts";

describe("ExternalTunnelService helpers", () => {
  it("parses quoted and unquoted command arguments", () => {
    expect(parseCommandArgs("-Mode auto -SshTarget \"tencent sv\" --flag='abc def'")).toEqual([
      "-Mode",
      "auto",
      "-SshTarget",
      "tencent sv",
      "--flag=abc def",
    ]);
  });

  it("classifies tunnel binaries and launcher scripts", () => {
    expect(classifyTunnelCandidate("C:\\Users\\alice\\.t3\\tunnel\\t3-tunnel.ps1")?.kind).toBe(
      "launcher",
    );
    expect(classifyTunnelCandidate("C:\\Users\\alice\\.t3\\tunnel\\bin\\hysteria.exe")?.kind).toBe(
      "hysteria",
    );
    expect(classifyTunnelCandidate("/usr/local/bin/frpc")?.kind).toBe("frpc");
    expect(classifyTunnelCandidate("/home/me/scripts/vps-tunnel.sh")?.kind).toBe("ssh_script");
    expect(classifyTunnelCandidate("/home/me/notes.txt")).toBeNull();
  });

  it("diagnoses Hysteria2 auth/TLS failures vs FRP auth failures vs Windows Defender PUA blocks", () => {
    const hy2 = diagnoseTunnelLogs([
      "2026-11-26 00:01:00 [info] Starting hysteria.exe",
      "2026-11-26 00:01:02 [error] failed to connect to server: authentication failed (status code 403)",
    ]);
    expect(hy2?.code).toBe("hy2_auth_or_handshake");

    const av = diagnoseTunnelLogs([
      "2026-11-26 00:01:05 [error] frpc.exe launch failed: Access is denied (PUA:Win32/FRProxy)",
    ]);
    expect(av?.code).toBe("av_blocked");

    const frp = diagnoseTunnelLogs([
      "2026-11-26 00:01:06 [error] login to server failed: token in login doesn't match",
    ]);
    expect(frp?.code).toBe("frp_auth_or_connect");

    const recovered = diagnoseTunnelLogs([
      "2026-11-26 00:01:02 [error] authentication failed",
      "2026-11-26 00:02:00 [info] hy2 connected (local forwarders ready)",
    ]);
    expect(recovered).toBeNull();
  });
});

describe("ExternalTunnelService runtime", () => {
  effectIt.effect(
    "scans an approximate directory asynchronously with progress events and exports/imports bundles",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ext-tunnel-"))),
        (tmpRoot) =>
          Effect.gen(function* () {
            const tunnelDir = NodePath.join(tmpRoot, "my-tunnel");
            const binDir = NodePath.join(tunnelDir, "bin");
            const configDir = NodePath.join(tunnelDir, "config");
            const logDir = NodePath.join(tunnelDir, "logs");
            yield* Effect.promise(async () => {
              await NodeFSP.mkdir(binDir, { recursive: true });
              await NodeFSP.mkdir(configDir, { recursive: true });
              await NodeFSP.mkdir(logDir, { recursive: true });

              const launcherPath = NodePath.join(tunnelDir, "t3-tunnel.ps1");
              await NodeFSP.writeFile(launcherPath, "# dummy launcher\n", "utf8");
              await NodeFSP.writeFile(NodePath.join(binDir, "hysteria.exe"), "bin", "utf8");
              await NodeFSP.writeFile(NodePath.join(logDir, "t3-tunnel.log"), "ok\n", "utf8");
              await NodeFSP.writeFile(
                NodePath.join(configDir, "hysteria.yaml"),
                "server: vps.example.com:443\nauth: super-secret-hy2\ntls:\n  sni: example.com\n",
                "utf8",
              );
              await NodeFSP.writeFile(
                NodePath.join(configDir, "frpc.toml"),
                'auth.token = "super-secret-frp"\n',
                "utf8",
              );
            });

            const launcherPath = NodePath.join(tunnelDir, "t3-tunnel.ps1");
            let currentSettings: ServerSettingsValue = {
              ...DEFAULT_SERVER_SETTINGS,
              externalTunnel: {
                ...DEFAULT_SERVER_SETTINGS.externalTunnel,
                enabled: false,
                entryPath: launcherPath,
                logPath: NodePath.join(logDir, "t3-tunnel.log"),
              },
            };

            const testLayer = externalTunnelLayer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  ServerConfig.layerTest(tmpRoot, { prefix: "ext-tunnel-" }),
                  Layer.mock(ServerSettings.ServerSettingsService)({
                    getSettings: Effect.sync(() => currentSettings),
                    updateSettings: (patch) =>
                      Effect.sync(() => {
                        currentSettings = {
                          ...currentSettings,
                          ...(patch.externalTunnel
                            ? {
                                externalTunnel: {
                                  ...currentSettings.externalTunnel,
                                  ...patch.externalTunnel,
                                },
                              }
                            : {}),
                        };
                        return currentSettings;
                      }),
                  }),
                ),
              ),
              Layer.provide(NodeServices.layer),
            );

            yield* Effect.scoped(
              Effect.gen(function* () {
                const svc = yield* ExternalTunnelService;

                const scanEvents = yield* svc
                  .scan({ searchPath: tmpRoot, maxDepth: 4 })
                  .pipe(Stream.runCollect);
                const complete = scanEvents[scanEvents.length - 1];
                expect(complete?.type).toBe("complete");
                if (complete?.type === "complete") {
                  expect(complete.candidates.some((c) => c.kind === "launcher")).toBe(true);
                  expect(complete.candidates.some((c) => c.kind === "hysteria")).toBe(true);
                }

                // Export without credentials redacts secrets
                const redactedBundle = yield* svc.exportBundle({
                  targetHostName: "macbook",
                  remotePort: 3774,
                  includeCredentials: false,
                });
                expect(redactedBundle.bundleJson).toContain("<REPLACE_WITH_HY2_AUTH>");
                expect(redactedBundle.bundleJson).not.toContain("super-secret-hy2");
                expect(redactedBundle.caddySnippet).toContain("reverse_proxy 127.0.0.1:3774");
                expect(redactedBundle.caddySnippet).toContain("t3-macbook.example.com");

                // Export with credentials includes them and imports into a fresh dir without network downloads
                const fullBundle = yield* svc.exportBundle({
                  targetHostName: "linux-box",
                  remotePort: 3775,
                  includeCredentials: true,
                });
                expect(fullBundle.bundleJson).toContain("super-secret-hy2");
                expect(fullBundle.bundleJson).toContain("super-secret-frp");

                const importDir = NodePath.join(tmpRoot, "imported-host");
                const importEvents = yield* svc
                  .importBundle({
                    bundleJson: fullBundle.bundleJson,
                    installDir: importDir,
                    autoInstallTools: false,
                    autoStart: false,
                  })
                  .pipe(Stream.runCollect);
                const importComplete = importEvents[importEvents.length - 1];
                expect(importComplete?.type).toBe("complete");
                if (importComplete?.type === "complete") {
                  expect(importComplete.installDir).toBe(NodePath.resolve(importDir));
                }
                const writtenHy2 = yield* Effect.promise(() =>
                  NodeFSP.readFile(NodePath.join(importDir, "config", "hysteria.yaml"), "utf8"),
                );
                expect(writtenHy2).toContain("auth: super-secret-hy2");
                const writtenFrp = yield* Effect.promise(() =>
                  NodeFSP.readFile(NodePath.join(importDir, "config", "frpc.toml"), "utf8"),
                );
                expect(writtenFrp).toContain("remotePort = 3775");
              }).pipe(Effect.provide(testLayer)),
            );
          }),
        (tmpRoot) =>
          Effect.promise(() =>
            NodeFSP.rm(tmpRoot, { recursive: true, force: true }).catch(() => {}),
          ),
      ),
  );
});
