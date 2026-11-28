// @effect-diagnostics nodeBuiltinImport:off -- Integration test spins up a local loopback mock OneBot HTTP server and temp state dirs.
// @effect-diagnostics globalDate:off -- Test verifies OneBot wall-clock timestamps against webhook replay windows.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";

import * as PluginKernel from "@bytedock/plugin-kernel";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { makePluginControlPlane, PluginControlPlane } from "./PluginControlPlane.ts";
import { makePluginWebhookRoutes } from "./PluginWebhookHttp.ts";

const tempDirs: Array<string> = [];
const activeServers: Array<NodeHttp.Server> = [];

function makeTempEnv() {
  const rootDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bytedock-bots-napcat-"));
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

function makeInMemorySecretStore(): {
  readonly store: ServerSecretStore["Service"];
  readonly map: Map<string, Uint8Array>;
} {
  const map = new Map<string, Uint8Array>();
  const store: ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(map.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        map.set(name, new Uint8Array(value));
      }),
    create: (name, value) =>
      Effect.sync(() => {
        map.set(name, new Uint8Array(value));
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = map.get(name);
        if (existing) return existing;
        const fresh = new Uint8Array(bytes);
        map.set(name, fresh);
        return fresh;
      }),
    remove: (name) =>
      Effect.sync(() => {
        map.delete(name);
      }),
  };
  return { store, map };
}

interface RecordedOneBotRequest {
  readonly path: string;
  readonly authHeader: string | undefined;
  readonly body: Record<string, unknown>;
}

async function startMockOneBotServer(options?: { readonly forceRedirect?: boolean }): Promise<{
  readonly baseUrl: string;
  readonly received: Array<RecordedOneBotRequest>;
  readonly waitForRequest: (
    predicate: (req: RecordedOneBotRequest) => boolean,
  ) => Promise<RecordedOneBotRequest>;
  readonly close: () => Promise<void>;
}> {
  const received: Array<RecordedOneBotRequest> = [];
  const waiters: Array<{
    readonly predicate: (req: RecordedOneBotRequest) => boolean;
    readonly resolve: (req: RecordedOneBotRequest) => void;
  }> = [];
  const server = NodeHttp.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (options?.forceRedirect) {
        res.statusCode = 302;
        res.setHeader("Location", "http://example.com/steal");
        res.end();
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const record: RecordedOneBotRequest = {
        path: req.url ?? "",
        authHeader: req.headers.authorization,
        body: parsed,
      };
      received.push(record);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i]!;
        if (waiter.predicate(record)) {
          waiters.splice(i, 1);
          waiter.resolve(record);
        }
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/get_login_info") {
        res.end(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { user_id: 999999, nickname: "ByteDockMockBot" },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 42 } }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  activeServers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    waitForRequest: (predicate) => {
      const existing = received.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<RecordedOneBotRequest>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && NodeFS.existsSync(dir)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ByteDock Bots Core & NapCatQQ OneBot v11 end-to-end loop", () => {
  it.effect(
    "persists SOUL.md/MEMORY.md under <stateDir>/bots/, injects deterministic SOUL prefix, and hands off memory once after compact",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          watchFiles: false,
        });

        // Default bot bootstrapped under <stateDir>/bots/default/
        const initial = cp.botsCore.getState();
        expect(initial.botsDir).toBe(NodePath.join(env.stateDir, "bots"));
        expect(initial.bots.some((b) => b.id === "default")).toBe(true);

        // Path traversal, trailing dot (Windows NTFS bypass), and reserved metadata filenames are rejected.
        for (const invalidId of [
          "../escape",
          "default.",
          "bots.json",
          "decision-gates.json",
          "con",
        ]) {
          const badBot = yield* cp.botsCore
            .upsertBot({ id: invalidId, name: "Bad" })
            .pipe(Effect.result);
          expect(badBot._tag).toBe("Failure");
        }

        // Bind default bot to a thread and update SOUL.md.
        const bound = yield* cp.botsCore.upsertBot({
          id: "default",
          name: "Ops Bot",
          boundProjectId: "proj-ops",
          boundThreadId: "thread-ops-1",
        });
        expect(bound.boundThreadId).toBe("thread-ops-1");

        const updatedSoul = yield* cp.botsCore.updateSoul({
          botId: "default",
          soulMarkdown: "# Ops Soul\nAlways verify diffs before deploying.\n",
        });
        expect(updatedSoul.soulPrefixHash).toMatch(/^[a-f0-9]{64}$/);

        // Two consecutive turns produce byte-identical deterministic SOUL prefix (ADR-06).
        const activeRev = (yield* kernel.revisions.active()).rev;
        const turn1 = yield* kernel.hooks.runTurnBefore({
          threadId: "thread-ops-1",
          revision: activeRev,
          projectedMessage: "hello turn 1",
        });
        const turn2 = yield* kernel.hooks.runTurnBefore({
          threadId: "thread-ops-1",
          revision: activeRev,
          projectedMessage: "hello turn 2",
        });
        const botsContrib1 = turn1.contributions.find((c) => c.pluginId === "builtin.bots-core");
        const botsContrib2 = turn2.contributions.find((c) => c.pluginId === "builtin.bots-core");
        expect(botsContrib1?.contribution.appendContext).toContain(updatedSoul.soulPrefixHash);
        expect(botsContrib1?.contribution.appendContext).toBe(
          botsContrib2?.contribution.appendContext,
        );

        // Unbound thread gets no bots-core injection.
        const unboundTurn = yield* kernel.hooks.runTurnBefore({
          threadId: "thread-other",
          revision: activeRev,
          projectedMessage: "unbound",
        });
        expect(unboundTurn.contributions.some((c) => c.pluginId === "builtin.bots-core")).toBe(
          false,
        );

        // Append-only MEMORY.md preserves prior entries and hands off once across compaction.
        yield* cp.botsCore.appendMemory({
          botId: "default",
          entry: "Decision: release window is Friday 18:00.",
          source: "host-test",
        });
        const mem2 = yield* cp.botsCore.appendMemory({
          botId: "default",
          entry: "Note: keep Egress Guard enabled.",
          source: "host-test",
        });
        expect(mem2.memoryTail).toContain("release window is Friday 18:00");
        expect(mem2.memoryTail).toContain("keep Egress Guard enabled");

        const compactRes = yield* kernel.hooks.runCompactBefore({
          threadId: "thread-ops-1",
          revision: activeRev,
        });
        const botsHandoff = compactRes.handoffSummaries.find(
          (h) => h.pluginId === "builtin.bots-core",
        );
        expect(botsHandoff?.summary).toContain("release window is Friday 18:00");

        // Immediately following turn carries the one-shot handoff once; next turn returns to pure SOUL.
        const postCompact1 = yield* kernel.hooks.runTurnBefore({
          threadId: "thread-ops-1",
          revision: activeRev,
          projectedMessage: "after compact 1",
        });
        const postCompact2 = yield* kernel.hooks.runTurnBefore({
          threadId: "thread-ops-1",
          revision: activeRev,
          projectedMessage: "after compact 2",
        });
        const post1Text = postCompact1.contributions.find((c) => c.pluginId === "builtin.bots-core")
          ?.contribution.appendContext;
        const post2Text = postCompact2.contributions.find((c) => c.pluginId === "builtin.bots-core")
          ?.contribution.appendContext;
        expect(post1Text).toContain("ByteDock Bot Compaction Handoff");
        expect(post2Text).toBe(botsContrib1?.contribution.appendContext);
      }),
  );

  it.live(
    "enforces loopback/Origin/proxy checks, webhook security matrix (401/403/409/429/503), fail-closed allowlists, Decision Gate separation, and end-to-end OneBot delivery",
    () =>
      Effect.gen(function* () {
        const env = makeTempEnv();
        const { store: secretStore } = makeInMemorySecretStore();
        const mockOneBot = yield* Effect.promise(() => startMockOneBotServer());
        const kernel = yield* PluginKernel.makePluginKernel();
        const cp = yield* makePluginControlPlane({
          kernel,
          ...env,
          secretStore,
          watchFiles: false,
        });

        const dispatchedPrompts: Array<{
          readonly projectId: string;
          readonly threadId: string;
          readonly text: string;
        }> = [];
        cp.setThreadBridge({
          listThreads: () =>
            Effect.succeed([
              {
                threadId: "thread-qq-1",
                projectId: "proj-qq",
                title: "QQ Assistant Thread",
                updatedAt: "2026-11-28T00:00:00Z",
              },
            ]),
          sendAndWait: (input) =>
            Effect.sync(() => {
              dispatchedPrompts.push({
                projectId: input.projectId,
                threadId: input.threadId,
                text: input.text,
              });
              return {
                runId: "run-qq-99",
                delivery: "started",
                status: "completed",
                timedOut: false,
                replyText: "All checks passed on thread-qq-1.",
              };
            }),
        });

        // Bind default bot to thread-qq-1.
        yield* cp.botsCore.upsertBot({
          id: "default",
          name: "QQ Bot",
          boundProjectId: "proj-qq",
          boundThreadId: "thread-qq-1",
        });

        // Point NapCatQQ to local loopback mock OneBot server with tight rateLimit for burst testing later.
        const hostActor = { kind: "host-client" as const, actorId: "test-host" };
        yield* cp.patchPluginConfig({
          pluginId: "community.napcat-qq",
          patch: {
            oneBotBaseUrl: mockOneBot.baseUrl,
            rateLimitPerMin: 20,
          },
          actor: hostActor,
        });

        // Build HTTP Web handlers for both loopback and non-loopback remote addresses.
        const loopbackHandler = HttpRouter.toWebHandler(
          makePluginWebhookRoutes({ testRemoteAddress: "127.0.0.1" }).pipe(
            Layer.provide(Layer.succeed(PluginControlPlane, cp)),
          ),
        );
        const remoteHandler = HttpRouter.toWebHandler(
          makePluginWebhookRoutes({ testRemoteAddress: "203.0.113.42" }).pipe(
            Layer.provide(Layer.succeed(PluginControlPlane, cp)),
          ),
        );

        try {
          // 1. Minimal /health endpoint: allows loopback, rejects non-loopback and Origin header.
          const healthOk = yield* Effect.promise(() =>
            loopbackHandler.handler(
              new Request("http://127.0.0.1:3773/api/plugins/community.napcat-qq/health"),
            ),
          );
          expect(healthOk.status).toBe(200);
          expect(healthOk.headers.get("x-frame-options")).toBe("DENY");
          const healthJson = yield* Effect.promise(() => healthOk.json());
          expect(healthJson).toEqual({ ok: true, enabled: true });

          const healthCrossOrigin = yield* Effect.promise(() =>
            loopbackHandler.handler(
              new Request("http://127.0.0.1:3773/api/plugins/community.napcat-qq/health", {
                headers: { Origin: "https://evil.example" },
              }),
            ),
          );
          expect(healthCrossOrigin.status).toBe(403);

          const healthRemote = yield* Effect.promise(() =>
            remoteHandler.handler(
              new Request("http://127.0.0.1:3773/api/plugins/community.napcat-qq/health"),
            ),
          );
          expect(healthRemote.status).toBe(403);

          const healthRebind = yield* Effect.promise(() =>
            loopbackHandler.handler(
              new Request("http://127.0.0.1:3773/api/plugins/community.napcat-qq/health", {
                headers: { Host: "evil.example:3773" },
              }),
            ),
          );
          expect(healthRebind.status).toBe(403);

          // 2. Wrong webhook path returns 404.
          const wrongPath = yield* Effect.promise(() =>
            loopbackHandler.handler(
              new Request("http://127.0.0.1:3773/api/plugins/community.napcat-qq/wrong", {
                method: "POST",
                body: "{}",
              }),
            ),
          );
          expect(wrongPath.status).toBe(404);

          // 3. Unconfigured secret returns 503 BEFORE consuming rate-limit quota.
          const noSecret = yield* Effect.promise(() =>
            loopbackHandler.handler(
              new Request("http://127.0.0.1:3773/api/plugins/community.napcat-qq/onebot/event", {
                method: "POST",
                body: "{}",
              }),
            ),
          );
          expect(noSecret.status).toBe(503);

          // 4. Configure secret via ServerSecretStore (never echoed in return value or status).
          const secretValue = "napcat-super-secret-token-xyz";
          const setRes = yield* cp.napcat.setTokenSecret(secretValue);
          expect(setRes).toEqual({
            configured: true,
            secretRef: "bytedock.napcat.webhook_token",
          });
          expect(JSON.stringify(setRes)).not.toContain(secretValue);
          const statusAfterSecret = yield* cp.napcat.getStatus();
          expect(statusAfterSecret.secretConfigured).toBe(true);
          expect(JSON.stringify(statusAfterSecret)).not.toContain(secretValue);

          const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
          const postSigned = (
            payloadObj: Record<string, unknown>,
            opts?: {
              readonly alg?: "sha1" | "sha256";
              readonly sigOverride?: string;
              readonly bearer?: string;
              readonly extraHeaders?: Record<string, string>;
            },
          ) => {
            const raw = Buffer.from(JSON.stringify(payloadObj), "utf8");
            const sig =
              opts?.sigOverride ??
              PluginKernel.computeRawBodyHmac(raw, secretValue, opts?.alg ?? "sha1");
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
              ...(sig ? { "X-Signature": sig } : {}),
              ...(opts?.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
              ...opts?.extraHeaders,
            };
            return loopbackHandler.handler(
              new Request("http://127.0.0.1:3773/api/plugins/community.napcat-qq/onebot/event", {
                method: "POST",
                headers,
                body: raw,
              }),
            );
          };

          // 5. Missing/invalid HMAC -> 403; X-Forwarded-For -> 403.
          const badSig = yield* Effect.promise(() =>
            postSigned({ post_type: "meta_event", time: nowSec }, { sigOverride: "sha1=deadbeef" }),
          );
          expect(badSig.status).toBe(403);
          expect(badSig.headers.get("x-frame-options")).toBe("DENY");

          const forwarded = yield* Effect.promise(() =>
            postSigned(
              { post_type: "meta_event", time: nowSec },
              { extraHeaders: { "X-Forwarded-For": "8.8.8.8" } },
            ),
          );
          expect(forwarded.status).toBe(403);

          // 6. Missing event.time -> 400; stale timestamp (>300s) -> 409; duplicate rawBody replay -> 409 without poisoning seq.
          const missingTime = yield* Effect.promise(() =>
            postSigned({ post_type: "meta_event", meta_event_type: "heartbeat" }),
          );
          expect(missingTime.status).toBe(400);

          const stale = yield* Effect.promise(() =>
            postSigned(
              { post_type: "meta_event", time: nowSec - 600 },
              { extraHeaders: { "X-ByteDock-Seq": "9007199254740990" } },
            ),
          );
          expect(stale.status).toBe(409);

          const metaPayload = {
            post_type: "meta_event",
            meta_event_type: "heartbeat",
            time: nowSec,
          };
          const metaOk = yield* Effect.promise(() =>
            postSigned(metaPayload, { extraHeaders: { "X-ByteDock-Seq": "1" } }),
          );
          expect(metaOk.status).toBe(200);
          // Replaying same payload with huge seq must return 409 and NOT poison lastAcceptedSeq!
          const metaReplayPoison = yield* Effect.promise(() =>
            postSigned(metaPayload, { extraHeaders: { "X-ByteDock-Seq": "9007199254740991" } }),
          );
          expect(metaReplayPoison.status).toBe(409);
          const metaNextSeqOk = yield* Effect.promise(() =>
            postSigned(
              { post_type: "meta_event", meta_event_type: "heartbeat", time: nowSec, seqCheck: 2 },
              { extraHeaders: { "X-ByteDock-Seq": "2" } },
            ),
          );
          expect(metaNextSeqOk.status).toBe(200);

          // 7. Fail-Closed when allowedUserIds is empty!
          const emptyAllowlistRes = yield* Effect.promise(() =>
            postSigned({
              post_type: "message",
              message_type: "private",
              user_id: 10001,
              self_id: 999999,
              raw_message: "run shell",
              time: nowSec,
            }),
          );
          expect(emptyAllowlistRes.status).toBe(200);
          expect(yield* Effect.promise(() => emptyAllowlistRes.json())).toMatchObject({
            accepted: false,
            reason: "allowlist-empty",
          });
          expect(dispatchedPrompts).toHaveLength(0);

          // 8. Configure allowlists -> test group @bot requirement, unauthorized sender block, Decision Gate command, and privileged approval isolation.
          yield* cp.patchPluginConfig({
            pluginId: "community.napcat-qq",
            patch: {
              allowedUserIds: ["10001"],
              allowedGroupIds: ["88888"],
              requireAtInGroup: true,
            },
            actor: hostActor,
          });

          const groupNoAt = yield* Effect.promise(() =>
            postSigned({
              post_type: "message",
              message_type: "group",
              group_id: 88888,
              user_id: 10001,
              self_id: 999999,
              raw_message: "hello without mention",
              time: nowSec,
            }),
          );
          expect(yield* Effect.promise(() => groupNoAt.json())).toMatchObject({
            accepted: false,
            reason: "group-at-required",
          });

          const unauthGroupMember = yield* Effect.promise(() =>
            postSigned({
              post_type: "message",
              message_type: "group",
              group_id: 88888,
              user_id: 55555,
              self_id: 999999,
              message: [
                { type: "at", data: { qq: "999999" } },
                { type: "text", data: { text: "steal files" } },
              ],
              time: nowSec,
            }),
          );
          expect(yield* Effect.promise(() => unauthGroupMember.json())).toMatchObject({
            accepted: false,
            reason: "user-not-allowed",
          });

          // Create both a Bot Decision Gate AND a privileged Control Plane approval.
          const botGate = yield* cp.botsCore.openGate({
            botId: "default",
            title: "Deploy staging build",
            summary: "Confirm pushing staging image",
            createdBy: "test",
          });
          const cpApproval = yield* cp.createHostApproval({
            kind: "system-action",
            targetId: "host.system:storage_cleanup",
            reasons: ["system-action:storage_cleanup"],
            summary: "Privileged host cleanup",
            diffPreview: { before: null, after: {} },
            requestedBy: { kind: "main-thread", threadId: "thread-qq-1" },
            mutation: { kind: "system-action", action: "storage_cleanup", payload: {} },
          });

          // QQ /approve on Control Plane privileged approval MUST NOT resolve it!
          const tryPrivApprove = yield* Effect.promise(() =>
            postSigned({
              post_type: "message",
              message_type: "private",
              user_id: 10001,
              self_id: 999999,
              raw_message: `/approve ${cpApproval.requestId}`,
              time: nowSec,
            }),
          );
          expect(tryPrivApprove.status).toBe(200);
          const privBody = (yield* Effect.promise(() => tryPrivApprove.json())) as {
            readonly replyText?: string;
          };
          expect(privBody.replyText).toContain("ByteDock Control Center");
          const approvalsAfter = yield* cp.approvals.listApprovals();
          expect(approvalsAfter.find((a) => a.requestId === cpApproval.requestId)?.status).toBe(
            "pending",
          );

          // QQ group array-segment @bot /approve <botGateId> resolves the Bot Decision Gate and sends OneBot reply!
          const approveBotGateRes = yield* Effect.promise(() =>
            postSigned(
              {
                post_type: "message",
                message_type: "group",
                group_id: 88888,
                user_id: 10001,
                self_id: 999999,
                message: [
                  { type: "at", data: { qq: "999999" } },
                  { type: "text", data: { text: `/approve ${botGate.gateId}` } },
                ],
                time: nowSec,
              },
              { alg: "sha256" },
            ),
          );
          expect(approveBotGateRes.status).toBe(200);
          expect(cp.botsCore.listGates().find((g) => g.gateId === botGate.gateId)?.status).toBe(
            "approved",
          );

          // 9. Authorized private QQ prompt -> HTTP 202 -> dispatches to bound thread -> delivers reply to Mock OneBot Server -> appends MEMORY.md -> Egress audited!
          const replyDeliveredPromise = mockOneBot.waitForRequest(
            (r) =>
              r.path === "/send_private_msg" &&
              String(r.body.message ?? "").includes("All checks passed on thread-qq-1."),
          );
          const promptRes = yield* Effect.promise(() =>
            postSigned({
              post_type: "message",
              message_type: "private",
              user_id: 10001,
              self_id: 999999,
              raw_message: "Check build status please",
              time: nowSec,
            }),
          );
          expect(promptRes.status).toBe(202);
          const privateReplyReq = yield* Effect.promise(() => replyDeliveredPromise);
          expect(dispatchedPrompts).toHaveLength(1);
          expect(dispatchedPrompts[0]?.text).toContain("Check build status please");
          expect(privateReplyReq.authHeader).toBe(`Bearer ${secretValue}`);
          expect(privateReplyReq.body.user_id).toBe(10001);

          // Verify MEMORY.md recorded the completed QQ turn summary.
          const botAfterTurn = cp.botsCore.getDefaultOrActiveBot("default");
          expect(botAfterTurn?.memoryTail).toContain("Check build status please");

          // Verify Egress Guard recorded audit events for community.napcat-qq.
          expect(kernel.egress.getEvents().some((e) => e.pluginId === "community.napcat-qq")).toBe(
            true,
          );

          // 10. testConnection reaches /get_login_info; hmac-and-bearer enforces 401 without Bearer.
          const connTest = yield* cp.napcat.testConnection();
          expect(connTest.ok).toBe(true);
          expect(connTest.loginInfo).toMatchObject({
            data: { user_id: 999999, nickname: "ByteDockMockBot" },
          });

          yield* cp.patchPluginConfig({
            pluginId: "community.napcat-qq",
            patch: { webhookAuthMode: "hmac-and-bearer", rateLimitPerMin: 2 },
            actor: hostActor,
          });
          const missingBearer = yield* Effect.promise(() =>
            postSigned({ post_type: "meta_event", time: nowSec, nonce: 1 }),
          );
          expect(missingBearer.status).toBe(401);

          const withBearerOk = yield* Effect.promise(() =>
            postSigned(
              { post_type: "meta_event", time: nowSec, nonce: 2 },
              { bearer: secretValue },
            ),
          );
          expect(withBearerOk.status).toBe(200);

          const burstRateLimited = yield* Effect.promise(() =>
            postSigned(
              { post_type: "meta_event", time: nowSec, nonce: 3 },
              { bearer: secretValue },
            ),
          );
          expect(burstRateLimited.status).toBe(429);
        } finally {
          yield* Effect.promise(() => loopbackHandler.dispose());
          yield* Effect.promise(() => remoteHandler.dispose());
        }
      }),
  );

  it.live("blocks outbound OneBot HTTP redirects (redirect: 'error') to prevent SSRF", () =>
    Effect.gen(function* () {
      const env = makeTempEnv();
      const redirectServer = yield* Effect.promise(() =>
        startMockOneBotServer({ forceRedirect: true }),
      );
      const kernel = yield* PluginKernel.makePluginKernel();
      const cp = yield* makePluginControlPlane({
        kernel,
        ...env,
        watchFiles: false,
      });
      yield* cp.patchPluginConfig({
        pluginId: "community.napcat-qq",
        patch: { oneBotBaseUrl: redirectServer.baseUrl },
        actor: { kind: "host-client", actorId: "test-host" },
      });
      const res = yield* cp.napcat.testConnection();
      expect(res.ok).toBe(false);
    }),
  );
});
