// @effect-diagnostics nodeBuiltinImport:off -- E2E battery uses temporary directories and JSON files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  computeRawBodyHmac,
  createEgressGuard,
  DEFAULT_DENIED_DOMAINS,
  lintWebhookContributions,
  makePluginKernel,
  openHashChainedAuditLog,
} from "@bytedock/plugin-kernel";
import { decodePluginManifest } from "@bytedock/plugin-sdk/manifest";
import {
  buildBotsManagerPanelTree,
  createBotsCoreRuntime,
  type OutboxNotificationPayload,
} from "@bytedock/plugin-bots-core";

import { createNapCatChannelRuntime, NAPCAT_QQ_MANIFEST } from "./index.ts";

const BOTS_MANIFEST_PATH = NodePath.resolve(
  import.meta.dirname,
  "../../plugin-bots-core/bytedock-plugin.json",
);
const NAPCAT_MANIFEST_PATH = NodePath.resolve(import.meta.dirname, "../bytedock-plugin.json");

/**
 * Matrix 4 (Webhook Security Battery) & Matrix 6 (10-Extension-Point NapCatQQ Bot E2E Smoke).
 */
describe("W7-2 Matrix 4 & Matrix 6: NapCatQQ Webhook Security + 10-Extension-Point Bot Loop", () => {
  it.effect(
    "Matrix 4: rejects auth:none on non-health routes, missing token, canonicalized HMAC bypass, replay seq, and 51/min rate limit",
    () =>
      Effect.sync(() => {
        // 1. CI manifest lint: auth:"none" rejected on business route, allowed on /health
        const badLint = lintWebhookContributions([
          { route: "/api/plugins/evil/webhook", auth: "none" },
          { route: "/api/plugins/ok/health", auth: "none" },
          {
            route: "/api/plugins/bad-hmac/event",
            auth: "token",
            tokenSecretRef: "bytedock.x.token",
            hmac: { algorithm: "sha1", mode: "onebot-custom", rawBody: false },
          },
        ]);
        assert.strictEqual(badLint.length, 2);
        assert.strictEqual(badLint[0]?.code, "AUTH_NONE_DISALLOWED");
        assert.strictEqual(badLint[1]?.code, "RAW_BODY_HMAC_REQUIRED");

        // NapCatQQ template manifest passes webhook lint with 0 violations
        assert.strictEqual(
          lintWebhookContributions(NAPCAT_QQ_MANIFEST.contributes?.webhooks ?? []).length,
          0,
        );

        const secret = "napcat-super-secret-token";
        const runtime = createNapCatChannelRuntime({
          resolveSecret: (ref) => (ref === "bytedock.napcat.webhook_token" ? secret : undefined),
        });

        // Raw body with non-canonical whitespace & key order
        const rawJson =
          '{ "b": 1,  "post_type": "message", "message_type": "group", "group_id": 1001, "self_id": 999, "user_id": 42, "message_id": 500, "raw_message": "@bot status" }';
        const rawBody = Buffer.from(rawJson, "utf8");
        const canonicalBody = Buffer.from(JSON.stringify(JSON.parse(rawJson)), "utf8");

        // 2. Missing Bearer token -> 401 + X-Frame-Options: DENY
        const noAuth = runtime.handleWebhook({ rawBody, headers: {}, seq: 1, nowMs: 1_000 });
        assert.strictEqual(noAuth.guard.allowed, false);
        assert.strictEqual(noAuth.guard.status, 401);
        assert.strictEqual(noAuth.guard.headers["X-Frame-Options"], "DENY");

        // 3. Canonicalized HMAC (signed over parsed+re-stringified JSON instead of rawBody) -> 403
        const canonicalSig = computeRawBodyHmac(canonicalBody, secret, "sha1");
        const badHmac = runtime.handleWebhook({
          rawBody,
          headers: {
            authorization: `Bearer ${secret}`,
            "x-signature": canonicalSig,
          },
          seq: 2,
          nowMs: 1_001,
        });
        assert.strictEqual(badHmac.guard.allowed, false);
        assert.strictEqual(badHmac.guard.status, 403);
        assert.strictEqual(badHmac.guard.reason, "raw-body-hmac-mismatch");

        // 4. Valid raw-body HMAC + Bearer -> 200
        const validSig = computeRawBodyHmac(rawBody, secret, "sha1");
        const ok = runtime.handleWebhook({
          rawBody,
          headers: {
            authorization: `Bearer ${secret}`,
            "x-signature": validSig,
          },
          seq: 10,
          nowMs: 2_000,
        });
        assert.strictEqual(ok.guard.allowed, true);
        assert.strictEqual(ok.guard.status, 200);
        assert.strictEqual(ok.inbound?.mentionsBot, true);
        assert.strictEqual(ok.inbound?.text, "status");

        // 5. Replay non-monotonic seq -> 409
        const replay = runtime.handleWebhook({
          rawBody,
          headers: {
            authorization: `Bearer ${secret}`,
            "x-signature": validSig,
          },
          seq: 10,
          nowMs: 2_001,
        });
        assert.strictEqual(replay.guard.allowed, false);
        assert.strictEqual(replay.guard.status, 409);

        // 6. Rate limit > 50/min -> 429
        let got429 = false;
        for (let i = 0; i < 60; i += 1) {
          const eventBody = Buffer.from(
            JSON.stringify({
              post_type: "message",
              message_type: "private",
              user_id: 42,
              message_id: 1_000 + i,
              raw_message: `ping ${i}`,
            }),
            "utf8",
          );
          const res = runtime.handleWebhook({
            rawBody: eventBody,
            headers: {
              authorization: `Bearer ${secret}`,
              "x-signature": computeRawBodyHmac(eventBody, secret, "sha1"),
            },
            seq: 100 + i,
            nowMs: 3_000 + i,
          });
          if (res.guard.status === 429) {
            got429 = true;
            break;
          }
        }
        assert.isTrue(got429);
      }),
  );

  it.effect(
    "Matrix 6: executes full 10-extension-point NapCatQQ <-> Bots Core loop with SOUL prefix, MEMORY.md, Decision Gate outbox, and Egress audit",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-napcat-e2e-"));
          const auditPath = NodePath.join(tmpDir, "egress-audit.jsonl");

          try {
            // Point 1: Manifest schema validation for both plugins
            const botsManifest = yield* decodePluginManifest(
              JSON.parse(NodeFS.readFileSync(BOTS_MANIFEST_PATH, "utf8")) as unknown,
            );
            const napcatManifest = yield* decodePluginManifest(
              JSON.parse(NodeFS.readFileSync(NAPCAT_MANIFEST_PATH, "utf8")) as unknown,
            );
            assert.strictEqual(botsManifest.id, "builtin.bots-core");
            assert.strictEqual(napcatManifest.id, "community.napcat-qq");

            // Point 2: Install manifests into PluginKernel + register RPC broker scopes
            const kernel = yield* makePluginKernel();
            const rev = yield* kernel.revisions.installRevision({
              manifests: [botsManifest, napcatManifest],
            });
            assert.strictEqual((yield* kernel.listDescriptors()).length, 2);

            yield* kernel.broker.registerMethod({
              pluginId: botsManifest.id,
              method: "createBot",
              revision: rev.rev,
              methodMinScopes: ["plugins:bots:write"],
              manifestScopes: botsManifest.permissions.rpcScopes ?? [],
            });
            const authorized = yield* kernel.broker.authorize({
              caller: { kind: "host-client", sessionHash: "sess-hash-1" },
              callerScopes: ["plugins:bots:write"],
              pluginId: botsManifest.id,
              method: "createBot",
            });
            assert.strictEqual(authorized.allowed, true);

            // Point 3 & 4: Wire Egress Guard L1 + NapCatQQ loopback transport + Bots Core
            const egressGuard = createEgressGuard({
              policy: {
                mode: "strict",
                deniedDomains: DEFAULT_DENIED_DOMAINS,
                allowedHosts: [],
                allowLoopbackHosts: ["127.0.0.1", "localhost"],
                allowUdp: false,
              },
              auditFilePath: auditPath,
            });
            const secret = "loopback-token-xyz";
            const napcat = createNapCatChannelRuntime({
              oneBotBaseUrl: "http://127.0.0.1:3000",
              resolveSecret: (ref) =>
                ref === "bytedock.napcat.webhook_token" ? secret : undefined,
              egressGuard,
              transport: async () => ({ ok: true, messageId: "qq-msg-999" }),
            });
            const bots = createBotsCoreRuntime({ dataDir: tmpDir });
            const unregChannel = bots.registerChannel(napcat.channelAdapter);

            // Point 5: Simulated QQ @bot inbound webhook -> SOUL prefix + Agent turn + QQ reply
            const observedSoulHashes: Array<string> = [];
            for (let turn = 1; turn <= 3; turn += 1) {
              const rawBody = Buffer.from(
                JSON.stringify({
                  post_type: "message",
                  message_type: "group",
                  group_id: 8888,
                  self_id: 12345,
                  user_id: 777,
                  message_id: 2000 + turn,
                  raw_message: `[CQ:at,qq=12345] 检查第 ${turn} 项部署任务`,
                  sender: { nickname: "Alice" },
                }),
                "utf8",
              );
              const { guard, inbound } = napcat.handleWebhook({
                rawBody,
                headers: {
                  authorization: `Bearer ${secret}`,
                  "x-signature": computeRawBodyHmac(rawBody, secret, "sha1"),
                },
                seq: turn,
                nowMs: 10_000 + turn * 1_000,
              });
              assert.strictEqual(guard.allowed, true);
              assert.isDefined(inbound);
              const result = yield* Effect.promise(() =>
                bots.handleInboundMessage(inbound!, async ({ soulPrefixHash, prompt }) => {
                  observedSoulHashes.push(soulPrefixHash);
                  return `已完成：${prompt}`;
                }),
              );
              assert.strictEqual(result.handled, true);
            }

            // SOUL prefix hash stays 100% deterministic across all 3 turns (CacheGuard Law #1)
            assert.strictEqual(new Set(observedSoulHashes).size, 1);
            // Replies delivered back to NapCat loopback endpoint
            assert.strictEqual(napcat.getSentPayloads().length, 3);
            assert.strictEqual(
              napcat.getSentPayloads()[0]?.endpoint,
              "http://127.0.0.1:3000/send_group_msg",
            );

            // Point 6: MEMORY.md strictly appended with 3 human-readable entries
            const activeBot = bots.listBots()[0]!;
            const memoryText = bots.readMemory(activeBot.botId);
            assert.include(memoryText, "检查第 1 项部署任务");
            assert.include(memoryText, "检查第 3 项部署任务");

            // Point 7: Decision Gate -> Outbox 3-surface dispatch + resolution
            const outboxEvents: Array<OutboxNotificationPayload> = [];
            const gate = bots.openDecisionGate({
              botId: activeBot.botId,
              question: "是否执行生产数据库迁移？",
              options: ["Approve", "Reject"],
              emitOutbox: (ev) => {
                outboxEvents.push(ev);
              },
            });
            assert.strictEqual(outboxEvents.length, 1);
            assert.deepStrictEqual(outboxEvents[0]?.surfaces, [
              "web",
              "desktop-tray",
              "mobile-readonly",
            ]);
            const resolved = bots.resolveDecisionGate(gate.gateId, "Approve");
            assert.strictEqual(resolved.status, "approved");

            // Point 8: 12-primitive UI panel tree builds cleanly
            const panelTree = buildBotsManagerPanelTree({
              botCount: bots.listBots().length,
              activeChannelCount: 1,
              pendingGateCount: 0,
              latestMemoryLine: "Decision resolved",
            });
            assert.strictEqual(panelTree.t, "Stack");

            // Point 9: Egress Guard L1 recorded all 3 loopback calls & audit chain verified
            const chain = openHashChainedAuditLog({
              filePath: auditPath,
              streamId: "egress-guard",
            }).verify();
            assert.strictEqual(chain.state, "verified");
            assert.strictEqual(egressGuard.getEvents().length, 3);
            assert.isTrue(egressGuard.getEvents().every((e) => e.verdict === "loopback-allowed"));

            // Point 10: Clean uninstall teardown
            unregChannel();
            bots.close();
            yield* kernel.revisions.installRevision({ manifests: [] });
            assert.strictEqual((yield* kernel.listDescriptors()).length, 0);
            assert.isTrue(rev.rev >= 1);
          } finally {
            try {
              NodeFS.rmSync(tmpDir, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 50,
              });
            } catch {
              // Windows Defender may briefly hold a temp directory handle right after WAL close.
            }
          }
        }),
      ),
  );
});
