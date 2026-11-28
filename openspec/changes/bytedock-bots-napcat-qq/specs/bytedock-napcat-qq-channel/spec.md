# Specification: ByteDock NapCatQQ OneBot v11 Channel

## Purpose

定义 `community.napcat-qq` 在 ByteDock 宿主机服务端的真实 OneBot v11 通道契约，包括回环隔离 HTTP Webhook 挂载、`ServerSecretStore` 命名空间密钥隔离、Fail-Closed 白名单、本地回环 Egress Guard 审计回发、指令路由、有界异步线程编排桥接以及诊断工具。

## ADDED Requirements

### Requirement: Hardened Loopback OneBot v11 HTTP Webhook Endpoint

ByteDock Server SHALL expose the `community.napcat-qq` OneBot v11 HTTP webhook via a single wildcard route `POST /api/plugins/community.napcat-qq/*` (accepting only requests whose pathname strictly matches active `config.webhookRoute`, returning `404` otherwise) and `GET /api/plugins/community.napcat-qq/health` inside the existing `kernel-mount` seam (zero new seams). In `endpointMode === "loopback-only"`, both endpoints SHALL reject non-loopback socket remote addresses and any request carrying `origin`, `x-forwarded-for`, `forwarded`, `cf-connecting-ip`, `x-real-ip`, or `x-t3-relay-delivery-id` headers with HTTP `403`. `GET /health` SHALL return only `{ ok: true, enabled }`. For `POST` webhooks, the server SHALL check plugin enabled state and secret availability first (`503` without consuming rate-limit tokens), cap raw request bodies at 1 MiB (`413`), and enforce `@bytedock/plugin-kernel`'s `createWebhookRouteGuard` checks supporting `webhookAuthMode: "onebot-hmac"` (default, verifying raw-body `X-Signature` `sha1=` / `sha256=` HMAC compatible with real NapCatQQ OneBot v11 POST delivery) or `"hmac-and-bearer"` (requiring both Bearer token and raw-body HMAC), OneBot `event.time` ±300s freshness, content-hash replay protection, per-minute sliding-window rate limit, and `X-Frame-Options: DENY` + `Cache-Control: no-store` response headers.

#### Scenario: Non-loopback or cross-origin request is rejected before auth or rate limiting

- **WHEN** an HTTP request reaches the NapCatQQ webhook or `/health` endpoint with an `Origin` or `X-Forwarded-For` header or a non-loopback socket address
- **THEN** the server responds with HTTP `403` and `X-Frame-Options: DENY` without consuming rate-limit quota

#### Scenario: Missing or invalid signature or bearer token is rejected with guard status codes

- **WHEN** a loopback HTTP `POST` hits the NapCatQQ webhook with mismatched/missing `X-Signature` over the raw body bytes (or missing/wrong `Authorization: Bearer ...` when `webhookAuthMode === "hmac-and-bearer"`)
- **THEN** the server responds with HTTP `403` (invalid HMAC) or HTTP `401` (invalid/missing Bearer token) and `X-Frame-Options: DENY`
- **AND** no thread dispatch, bot command, or outbound reply is executed

#### Scenario: Replayed event, stale timestamp, or rate-limit burst is rejected

- **WHEN** a previously accepted payload is replayed, `event.time` is outside ±300 seconds, or requests exceed configured `rateLimitPerMin`
- **THEN** the server responds with HTTP `409` (replay/stale) or HTTP `429` (rate limit) with `X-Frame-Options: DENY`

#### Scenario: Webhook refuses traffic when plugin disabled or secret unconfigured

- **WHEN** `community.napcat-qq` is disabled in `plugins.yml` or no webhook token is configured in `ServerSecretStore`
- **THEN** the webhook endpoint responds with HTTP `503` without executing any bot action or consuming rate-limit quota

### Requirement: Secret Storage via ServerSecretStore and Namespace Allowlist

The `community.napcat-qq` channel SHALL store and resolve its OneBot v11 webhook/API token exclusively via `ServerSecretStore` (explicitly provided to `PluginControlPlane.layer` in `server.ts`) using a `tokenSecretRef` matching `^bytedock\.napcat\.[A-Za-z0-9_-]{1,128}$` and verified against `assertPluginSecretRefAllowed({ pluginId: "community.napcat-qq", declaredNamespaces: ["bytedock.napcat"], secretRef })`. Plaintext tokens MUST NEVER be accepted in `plugins.yml`, echoed in RPC/status/MCP responses, or written to logs.

#### Scenario: Host client configures and rotates token secret without plaintext echo

- **WHEN** a host UI client calls `community.napcat-qq.setTokenSecret` with a non-empty token string
- **THEN** the server stores the secret in `ServerSecretStore` under the validated `bytedock.napcat.*` key and returns `{ configured: true, secretRef }` without returning the token value
- **AND** subsequent `status` calls report `secretConfigured: true` without exposing the token

#### Scenario: MCP caller is blocked from NapCatQQ privileged operations and secret mutation

- **WHEN** an AI agent calls `bytedock_plugin_action(action: "invoke", pluginId: "community.napcat-qq", method: "setTokenSecret" | "clearTokenSecret" | "simulateInbound" | "sendReply")`
- **THEN** `HostControlService` rejects the call with `capability_denied` (`host_client_required`)

#### Scenario: Non-namespaced or multi-segment tokenSecretRef is rejected by config validation

- **WHEN** a config patch sets `tokenSecretRef` to `bytedock.other.token` or `bytedock.napcat.prod.token`
- **THEN** `validatePluginConfig` rejects the patch before writing `plugins.yml`

### Requirement: Loopback-Only OneBot v11 Outbound Delivery Audited by Egress Guard L1

All outbound OneBot v11 HTTP calls (`/send_private_msg`, `/send_group_msg`, `/get_login_info`) SHALL enforce hard loopback validation (stripped IPv6 brackets matching `127.0.0.1`, `localhost`, or `::1`; `localhost` resolved via `guardedLookupAll` confirming all IPs are loopback; no URL credentials/query/hash; positive safe integer `user_id`/`group_id`; `fetch` with `redirect: "error"` and bounded timeout) and SHALL record and respect `PluginKernel.egress.evaluateRequest` regardless of Egress Guard `audit-only` mode.

#### Scenario: Non-loopback or credentialed oneBotBaseUrl is rejected at config validation

- **WHEN** a config patch attempts to set `oneBotBaseUrl` to `https://evil.example/onebot` or `http://user:pass@127.0.0.1:3000`
- **THEN** `validatePluginConfig` rejects the configuration patch

#### Scenario: Security-sensitive NapCatQQ config patches require human approval

- **WHEN** an MCP caller patches `oneBotBaseUrl`, `tokenSecretRef`, `webhookRoute`, `webhookAuthMode`, `allowedUserIds`, `allowedGroupIds`, or disables `requireAtInGroup`
- **THEN** `assessConfigPatchPrivilege` classifies the patch as `high` risk requiring main-session human approval

#### Scenario: Outbound OneBot reply is audited by Egress Guard without following redirects

- **WHEN** the channel sends a private or group reply to NapCatQQ at `http://127.0.0.1:3000/send_private_msg`
- **THEN** `PluginKernel.egress.evaluateRequest` records the audit event for `community.napcat-qq` and sends the HTTP request with `redirect: "error"`
- **AND** if Egress Guard denies the target host or target returns a redirect, the outbound call fails safely and is recorded in channel activity

### Requirement: Fail-Closed Allowlist, Trigger Rules, Bot Commands, and Bounded Async Thread Bridge

After webhook authentication succeeds, the channel SHALL enforce a **fail-closed** allowlist on real webhook traffic: if `allowedUserIds` is empty, inbound messages SHALL be rejected (`200 { accepted: false, reason: "allowlist-empty" }`); private messages require `user_id` in `allowedUserIds`; group messages require BOTH `group_id` in `allowedGroupIds` AND `user_id` in `allowedUserIds`, plus `@bot` / `[CQ:at,qq=<self_id>...]` (supporting both OneBot v11 array segments and string CQ codes with extra attributes) when `requireAtInGroup` is `true`. Authorized messages SHALL support bot commands (`/status`, `/gates`, `/approve <gateId>`, `/reject <gateId>`, `/memory <note>`) and regular prompt dispatch to the active bot's bound ByteDock thread via `ThreadManagementService.sendToThread` (`mode: "queue"`, `createdBy: "user"`, `creationSource: "server"`) followed by a bounded concurrency (`Semaphore`) service-scoped fiber (`Effect.forkIn(serviceScope)`) awaiting that specific `run.id` via `waitForThread` and delivering only that run's assistant message.

#### Scenario: Empty allowlist fails closed on webhook delivery

- **WHEN** an authenticated webhook message arrives while `allowedUserIds` is `[]`
- **THEN** the channel returns HTTP `200` with `{ accepted: false, reason: "allowlist-empty" }` and executes no bot command or thread dispatch

#### Scenario: Group message without @bot mention or from unapproved member is ignored

- **WHEN** an authenticated group message arrives without matching `[CQ:at,qq=<self_id>...]`/`@bot` (when `requireAtInGroup` is `true`) or from a sender not in `allowedUserIds`
- **THEN** the channel acknowledges HTTP `200` with `{ accepted: false }` and does not dispatch a thread turn

#### Scenario: Authorized QQ prompt dispatches into bound ByteDock thread and delivers that run's reply

- **WHEN** an authenticated private message (or `@bot` group message) from an allowed sender arrives for a bot bound to a ByteDock thread
- **THEN** the channel returns HTTP `202` immediately, dispatches the message via `ThreadManagementService.sendToThread` with `mode: "queue"`, awaits that `run.id` in a service-scoped bounded fiber up to `turnWaitTimeoutSec`, extracts the assistant message belonging to that `run.id`, appends a concise turn summary to `MEMORY.md`, and sends the bounded reply back via OneBot v11 (if `autoReplyEnabled` is `true`)

#### Scenario: Authorized QQ command resolves a pending Bot Decision Gate

- **WHEN** an authorized sender sends `/approve <gateId>` or `/reject <gateId>`
- **THEN** `BotsCoreService` resolves the matching pending Bot Decision Gate with `resolvedVia: "community.napcat-qq"` and sends a confirmation reply to that QQ chat

### Requirement: Local Simulation and Connection Diagnostics

The `community.napcat-qq` plugin SHALL provide `testConnection` (probing `<oneBotBaseUrl>/get_login_info` through loopback hard check + Egress Guard) and host-client-only `simulateInbound` (running command routing and thread dispatch locally without requiring an external QQ client) and record a bounded ring buffer of recent sanitized channel activity events.

#### Scenario: Local inbound simulation exercises command routing and records activity

- **WHEN** a host UI client invokes `community.napcat-qq.simulateInbound` with a private `/status` message
- **THEN** the channel returns the structured bot/channel status reply and appends a sanitized entry to the recent activity feed without emitting any secret material
