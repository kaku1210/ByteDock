# Specification: ByteDock Bots & NapCatQQ Control Center UI

## Purpose

定义 ByteDock Control Center 中 **Bots & QQ** 管理界面、实时与刷新初始化事件同步、状态栏入口、AI `bytedock_ui_control` 联动与全量 10 语言 i18n 规范。

## ADDED Requirements

### Requirement: ByteDock Control Center Bots & QQ Tab

The `ByteDockControlCenterModal` SHALL provide a dedicated **Bots & QQ** tab (`tab: "bots"`) accessible from the Control Center header tabs, the chat bottom status strip, Settings sidebar, and AI `bytedock_ui_control(action: "open_control_center", tab: "bots")`, displaying a 4-KPI declarative `PluginNodeRenderer` overview card (Active Bots, NapCatQQ Status, Pending Decision Gates, Egress Policy).

#### Scenario: AI opens the Bots & QQ tab via bytedock_ui_control

- **WHEN** an agent invokes `bytedock_ui_control` with `{ action: "open_control_center", tab: "bots" }`
- **THEN** the control-plane event stream emits a `ui-command` event with `tab: "bots"`
- **AND** `PluginSlotStore` opens the ByteDock Control Center directly on the `"bots"` tab

### Requirement: Interactive Bot SOUL, Append-Only MEMORY, and Thread Binding Controls

Within the **Bots & QQ** tab, users SHALL be able to select or create a bot profile, edit and save `SOUL.md` while observing its live SHA-256 prefix hash, view and append entries to append-only `MEMORY.md`, and bind or unbind the bot to an existing ByteDock thread fetched from the server.

#### Scenario: User updates SOUL.md and appends MEMORY.md entry

- **WHEN** the user edits the `SOUL.md` textarea and clicks Save, or enters a note in the append-only memory input and clicks Append
- **THEN** the UI invokes `builtin.bots-core.updateSoul` or `builtin.bots-core.appendMemory` over RPC and refreshes the displayed SHA-256 hash and memory tail

#### Scenario: User binds a bot to a ByteDock thread

- **WHEN** the user picks a ByteDock thread from the binding selector and saves
- **THEN** the UI invokes `builtin.bots-core.upsertBot` with the chosen `boundThreadId` and `boundProjectId` and persists the binding across reloads

### Requirement: NapCatQQ Channel Configuration, Secret Token Setup, Diagnostics, and Activity Stream

Within the **Bots & QQ** tab, users SHALL be able to view the copyable OneBot v11 webhook path, edit NapCatQQ channel settings (`oneBotBaseUrl`, `webhookAuthMode`, `allowedUserIds`, `allowedGroupIds`, `rateLimitPerMin`, `requireAtInGroup`) via `builtin.control-plane.patchConfig`, set or clear the webhook/API token via host-only `community.napcat-qq.setTokenSecret` / `clearTokenSecret` (using a masked password input that never writes plaintext into `plugins.yml`), run **Test Connection**, trigger a local **Simulate QQ Message** smoke test, and inspect the recent sanitized channel activity feed. The UI SHALL clearly warn when `allowedUserIds` is empty (fail-closed mode).

#### Scenario: User sets NapCatQQ token secret via masked input

- **WHEN** the user enters a token in the masked secret input and clicks Save Secret
- **THEN** the UI invokes `community.napcat-qq.setTokenSecret`, clears the local input buffer immediately, and displays the secret status as Configured without echoing the token

### Requirement: Decision Gate Resolution and Status Bar Visibility

The **Bots & QQ** tab SHALL display pending and recent Bot Decision Gates with one-click Approve and Reject actions (plus a Create Gate action for testing/manual gates). `PluginSlotStore` SHALL hydrate `pendingDecisionGateCount` when `PluginControlBusBridge` connects (so badges are accurate after page reload even before opening the modal), update in real time from `decision-gate-created`, `decision-gate-resolved`, `bots-updated`, `napcat-event`, and `state-updated` stream events, and show a compact **Bots & QQ** button with pending badge on the chat status strip and Settings sidebar.

#### Scenario: Pending Decision Gate appears live and clears upon approval

- **WHEN** a `decision-gate-created` stream event arrives and the user clicks Approve in the **Bots & QQ** tab
- **THEN** the pending gate badge increments on creation, transitions to Approved on resolution, and decrements in the status strip

### Requirement: Full 10-Locale i18n and Lint Hygiene

All user-visible copy in the **Bots & QQ** UI, Control Center tab button, and status strip controls SHALL use `gt-react` `<T>` / `gt(...)`, avoid Unicode em-dashes and native HTML `title` attributes, and ship complete translations across all 10 `apps/web` locales (`en`, `zh`, `de`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `sv`) passing `node scripts/i18n-check.ts`.

#### Scenario: i18n verification passes across all apps

- **WHEN** `node scripts/i18n-check.ts` executes after UI implementation
- **THEN** all 10 `apps/web` catalogs, `apps/mobile`, and `apps/desktop` report zero missing or stale keys
