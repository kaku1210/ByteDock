import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";
import { AsyncResult } from "effect/reactivity";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { PluginNodeRenderer } from "./PluginNodeRenderer";
import { setPendingDecisionGateCount, usePluginSlotState } from "./PluginSlotStore";

const botsInvokeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bytedock:bots-napcat:invoke",
  tag: WS_METHODS.pluginsInvoke,
});

interface BotDetailView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly boundProjectId: string | null;
  readonly boundThreadId: string | null;
  readonly soulPrefixHash: string;
  readonly soulMarkdown: string;
  readonly memoryTail: string;
  readonly memoryLineCount: number;
}

interface BotDecisionGate {
  readonly gateId: string;
  readonly botId: string;
  readonly threadId: string | null;
  readonly title: string;
  readonly summary: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly createdAt: string;
  readonly createdBy: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly resolvedVia?: string;
}

interface BotsCoreStatePayload {
  readonly botsDir: string;
  readonly bots: ReadonlyArray<BotDetailView>;
  readonly decisionGates: ReadonlyArray<BotDecisionGate>;
  readonly pendingDecisionGates: number;
}

interface BindableThreadItem {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly updatedAt: string;
}

interface NapCatActivityEntry {
  readonly id: string;
  readonly at: string;
  readonly direction: "inbound" | "outbound" | "diagnostic";
  readonly kind: string;
  readonly summary: string;
  readonly ok: boolean;
}

interface NapCatStatusPayload {
  readonly endpointMode: "loopback-only";
  readonly oneBotBaseUrl: string;
  readonly webhookRoute: string;
  readonly webhookAuthMode: "onebot-hmac" | "hmac-and-bearer";
  readonly rateLimitPerMin: number;
  readonly tokenSecretRef: string;
  readonly secretConfigured: boolean;
  readonly secretStoreAvailable: boolean;
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly allowedGroupIds: ReadonlyArray<string>;
  readonly requireAtInGroup: boolean;
  readonly allowlistConfigured: boolean;
  readonly threadBridgeReady: boolean;
  readonly recentActivity: ReadonlyArray<NapCatActivityEntry>;
}

interface ConnectionTestResult {
  readonly ok: boolean;
  readonly url: string;
  readonly status?: number;
  readonly error?: string;
}

interface SimulationResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly replyText?: string;
}

function parseCommaIds(raw: string): ReadonlyArray<string> {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function resolveWebhookDisplayUrl(routePath: string): string {
  try {
    return resolvePrimaryEnvironmentHttpUrl(routePath);
  } catch {
    return routePath;
  }
}

function buildBotsOverviewCard(
  botsState: BotsCoreStatePayload | null,
  napcatStatus: NapCatStatusPayload | null,
  napcatUnavailable: boolean,
  gt: ReturnType<typeof useGT>,
): JsonNode {
  const activeBots = botsState ? botsState.bots.filter((b) => b.enabled).length : 0;
  const totalBots = botsState ? botsState.bots.length : 0;
  const pendingGates = botsState?.pendingDecisionGates ?? 0;
  const channelReady =
    Boolean(napcatStatus?.secretConfigured) && Boolean(napcatStatus?.allowlistConfigured);
  const channelLabel = napcatUnavailable
    ? gt("Disabled")
    : !napcatStatus
      ? gt("Loading")
      : channelReady
        ? gt("Ready")
        : !napcatStatus.secretConfigured
          ? gt("No Secret")
          : gt("Fail-Closed");

  return {
    k: "bytedock-bots-napcat-overview",
    t: "Card",
    p: {
      titleI18n: gt("Bots Core & NapCatQQ Loop"),
      kpiColumns: 4,
      kpi: [
        {
          labelI18n: gt("Active Bots"),
          value: `${activeBots}/${totalBots}`,
          tone: activeBots > 0 ? "success" : "neutral",
          detailI18n: gt("Isolated SOUL & MEMORY"),
        },
        {
          labelI18n: gt("NapCatQQ"),
          value: channelLabel,
          tone: channelReady ? "success" : "warning",
          detailI18n: napcatStatus?.webhookAuthMode ?? "onebot-hmac",
        },
        {
          labelI18n: gt("Decision Gates"),
          value: pendingGates,
          tone: pendingGates > 0 ? "warning" : "success",
          detailI18n: gt("Pending confirmations"),
        },
        {
          labelI18n: gt("Egress Policy"),
          value: napcatStatus?.endpointMode ?? "loopback-only",
          tone: "info",
          detailI18n: gt("Audited via Egress L1"),
        },
      ],
    },
  };
}

export function BotsNapCatPanel({
  environmentId,
  configMtimeMs,
  onConfigSaved,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly configMtimeMs: number | undefined;
  readonly onConfigSaved: () => void;
}) {
  const gt = useGT();
  const slotState = usePluginSlotState();
  const runInvoke = useAtomCommand(botsInvokeCommand);

  const [botsState, setBotsState] = useState<BotsCoreStatePayload | null>(null);
  const [threads, setThreads] = useState<ReadonlyArray<BindableThreadItem>>([]);
  const [napcatStatus, setNapcatStatus] = useState<NapCatStatusPayload | null>(null);
  const [napcatUnavailable, setNapcatUnavailable] = useState(false);
  const loadSeqRef = useRef(0);
  const [selectedBotId, setSelectedBotId] = useState<string>("default");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Bot profile, SOUL, MEMORY drafts
  const [soulDraftByBot, setSoulDraftByBot] = useState<Readonly<Record<string, string>>>({});
  const [bindingDraftByBot, setBindingDraftByBot] = useState<Readonly<Record<string, string>>>({});
  const [memoryEntry, setMemoryEntry] = useState("");
  const [newBotId, setNewBotId] = useState("");
  const [newBotName, setNewBotName] = useState("");

  // Decision gate creation draft
  const [gateTitle, setGateTitle] = useState("");
  const [gateSummary, setGateSummary] = useState("");

  // NapCatQQ config drafts
  const [napcatDraft, setNapcatDraft] = useState<{
    readonly oneBotBaseUrl?: string;
    readonly webhookAuthMode?: "onebot-hmac" | "hmac-and-bearer";
    readonly allowedUserIds?: string;
    readonly allowedGroupIds?: string;
    readonly rateLimitPerMin?: string;
    readonly requireAtInGroup?: boolean;
  }>({});
  const [secretInput, setSecretInput] = useState("");
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const [connResult, setConnResult] = useState<ConnectionTestResult | null>(null);

  // Local simulation form
  const [simChatType, setSimChatType] = useState<"private" | "group">("private");
  const [simUserId, setSimUserId] = useState("10001");
  const [simGroupId, setSimGroupId] = useState("88888");
  const [simText, setSimText] = useState("/status");
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);

  const loadAll = async (envId: EnvironmentId) => {
    const seq = ++loadSeqRef.current;
    const [botsRes, threadsRes, napcatRes] = await Promise.all([
      runInvoke({
        environmentId: envId,
        input: { pluginId: "builtin.bots-core", method: "getState", payload: {} },
      }),
      runInvoke({
        environmentId: envId,
        input: { pluginId: "builtin.bots-core", method: "listThreads", payload: {} },
      }),
      runInvoke({
        environmentId: envId,
        input: { pluginId: "community.napcat-qq", method: "status", payload: {} },
      }),
    ]);
    if (seq !== loadSeqRef.current) return;

    if (AsyncResult.isSuccess(botsRes) && botsRes.value.result) {
      const nextBots = botsRes.value.result as BotsCoreStatePayload;
      setBotsState(nextBots);
      setPendingDecisionGateCount(nextBots.pendingDecisionGates);
    } else if (AsyncResult.isFailure(botsRes)) {
      setBotsState(null);
      setPendingDecisionGateCount(0);
    }
    if (AsyncResult.isSuccess(threadsRes) && threadsRes.value.result) {
      const payload = threadsRes.value.result as {
        readonly threads?: ReadonlyArray<BindableThreadItem>;
      };
      setThreads(payload.threads ?? []);
    } else if (AsyncResult.isFailure(threadsRes)) {
      setThreads([]);
    }
    if (AsyncResult.isSuccess(napcatRes) && napcatRes.value.result) {
      setNapcatUnavailable(false);
      setNapcatStatus(napcatRes.value.result as NapCatStatusPayload);
    } else if (AsyncResult.isFailure(napcatRes)) {
      setNapcatStatus(null);
      setNapcatUnavailable(true);
    }
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads live bots, decision gates, bindable threads, and NapCatQQ status when the Bots & QQ tab opens or stream events update state
  useEffect(() => {
    if (!environmentId) return;
    let cancelled = false;
    const seq = ++loadSeqRef.current;
    const rev = slotState.botsRevision;
    void (async () => {
      const [botsRes, threadsRes, napcatRes] = await Promise.all([
        runInvoke({
          environmentId,
          input: { pluginId: "builtin.bots-core", method: "getState", payload: { rev } },
        }),
        runInvoke({
          environmentId,
          input: { pluginId: "builtin.bots-core", method: "listThreads", payload: {} },
        }),
        runInvoke({
          environmentId,
          input: { pluginId: "community.napcat-qq", method: "status", payload: {} },
        }),
      ]);
      if (cancelled || seq !== loadSeqRef.current) return;
      if (AsyncResult.isSuccess(botsRes) && botsRes.value.result) {
        const nextBots = botsRes.value.result as BotsCoreStatePayload;
        setBotsState(nextBots);
        setPendingDecisionGateCount(nextBots.pendingDecisionGates);
      } else if (AsyncResult.isFailure(botsRes)) {
        setBotsState(null);
        setPendingDecisionGateCount(0);
      }
      if (AsyncResult.isSuccess(threadsRes) && threadsRes.value.result) {
        const payload = threadsRes.value.result as {
          readonly threads?: ReadonlyArray<BindableThreadItem>;
        };
        setThreads(payload.threads ?? []);
      } else if (AsyncResult.isFailure(threadsRes)) {
        setThreads([]);
      }
      if (AsyncResult.isSuccess(napcatRes) && napcatRes.value.result) {
        setNapcatUnavailable(false);
        setNapcatStatus(napcatRes.value.result as NapCatStatusPayload);
      } else if (AsyncResult.isFailure(napcatRes)) {
        setNapcatStatus(null);
        setNapcatUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, runInvoke, slotState.botsRevision]);

  const activeBot =
    botsState?.bots.find((b) => b.id === selectedBotId) ?? botsState?.bots[0] ?? null;
  const activeSoulValue = activeBot ? (soulDraftByBot[activeBot.id] ?? activeBot.soulMarkdown) : "";
  const activeBindingValue = activeBot
    ? (bindingDraftByBot[activeBot.id] ??
      (activeBot.boundThreadId && activeBot.boundProjectId
        ? `${activeBot.boundProjectId}::${activeBot.boundThreadId}`
        : ""))
    : "";

  const draftBaseUrl =
    napcatDraft.oneBotBaseUrl ?? napcatStatus?.oneBotBaseUrl ?? "http://127.0.0.1:3000";
  const draftAuthMode =
    napcatDraft.webhookAuthMode ?? napcatStatus?.webhookAuthMode ?? "onebot-hmac";
  const draftAllowedUsers =
    napcatDraft.allowedUserIds ?? napcatStatus?.allowedUserIds.join(", ") ?? "";
  const draftAllowedGroups =
    napcatDraft.allowedGroupIds ?? napcatStatus?.allowedGroupIds.join(", ") ?? "";
  const draftRateLimit = napcatDraft.rateLimitPerMin ?? String(napcatStatus?.rateLimitPerMin ?? 50);
  const draftRequireAt = napcatDraft.requireAtInGroup ?? napcatStatus?.requireAtInGroup ?? true;

  const webhookDisplayUrl = resolveWebhookDisplayUrl(
    napcatStatus?.webhookRoute ?? "/api/plugins/community.napcat-qq/onebot/event",
  );

  const handleCreateBot = async () => {
    if (!environmentId || !newBotId.trim() || !newBotName.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.bots-core",
        method: "upsertBot",
        payload: { id: newBotId.trim(), name: newBotName.trim(), enabled: true },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setSelectedBotId(newBotId.trim());
      setNewBotId("");
      setNewBotName("");
      setStatusMessage(gt("Bot profile created."));
      await loadAll(environmentId);
    } else {
      setErrorMessage(
        gt("Failed to create bot profile. Use lowercase letters, numbers, '.', '_' or '-'."),
      );
    }
    setBusy(false);
  };

  const handleSaveSoul = async () => {
    if (!environmentId || !activeBot) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.bots-core",
        method: "updateSoul",
        payload: { botId: activeBot.id, soulMarkdown: activeSoulValue },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setSoulDraftByBot((prev) => {
        const next = { ...prev };
        delete next[activeBot.id];
        return next;
      });
      setStatusMessage(gt("SOUL.md saved and SHA-256 prefix hash updated."));
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to save SOUL.md."));
    }
    setBusy(false);
  };

  const handleSaveThreadBinding = async () => {
    if (!environmentId || !activeBot) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const [projectId, threadId] = activeBindingValue.includes("::")
      ? activeBindingValue.split("::")
      : [null, null];
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.bots-core",
        method: "upsertBot",
        payload: {
          id: activeBot.id,
          name: activeBot.name,
          enabled: activeBot.enabled,
          boundProjectId: projectId,
          boundThreadId: threadId,
        },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setBindingDraftByBot((prev) => {
        const next = { ...prev };
        delete next[activeBot.id];
        return next;
      });
      setStatusMessage(
        threadId ? gt("Bot bound to ByteDock thread.") : gt("Bot thread binding cleared."),
      );
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to update bot thread binding."));
    }
    setBusy(false);
  };

  const handleAppendMemory = async () => {
    if (!environmentId || !activeBot || !memoryEntry.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.bots-core",
        method: "appendMemory",
        payload: { botId: activeBot.id, entry: memoryEntry.trim(), source: "control-center" },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setMemoryEntry("");
      setStatusMessage(gt("Appended entry to MEMORY.md."));
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to append MEMORY.md entry."));
    }
    setBusy(false);
  };

  const handleOpenGate = async () => {
    if (!environmentId || !activeBot || !gateTitle.trim() || !gateSummary.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.bots-core",
        method: "openGate",
        payload: {
          botId: activeBot.id,
          threadId: activeBot.boundThreadId ?? undefined,
          title: gateTitle.trim(),
          summary: gateSummary.trim(),
        },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setGateTitle("");
      setGateSummary("");
      setStatusMessage(gt("Decision Gate opened."));
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to open Decision Gate."));
    }
    setBusy(false);
  };

  const handleResolveGate = async (gateId: string, decision: "approved" | "rejected") => {
    if (!environmentId) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.bots-core",
        method: "resolveGate",
        payload: { gateId, decision },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setStatusMessage(
        decision === "approved" ? gt("Decision Gate approved.") : gt("Decision Gate rejected."),
      );
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to resolve Decision Gate."));
    }
    setBusy(false);
  };

  const handleSaveNapCatConfig = async () => {
    if (!environmentId) return;
    const rate = Number.parseInt(draftRateLimit, 10);
    if (!Number.isFinite(rate) || rate < 1 || rate > 600) {
      setErrorMessage(gt("Rate limit must be an integer between 1 and 600 requests/min."));
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "builtin.control-plane",
        method: "patchConfig",
        payload: {
          pluginId: "community.napcat-qq",
          expectedMtimeMs: configMtimeMs,
          patch: {
            oneBotBaseUrl: draftBaseUrl.trim(),
            webhookAuthMode: draftAuthMode,
            allowedUserIds: parseCommaIds(draftAllowedUsers),
            allowedGroupIds: parseCommaIds(draftAllowedGroups),
            rateLimitPerMin: rate,
            requireAtInGroup: draftRequireAt,
          },
        },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setNapcatDraft({});
      setStatusMessage(gt("NapCatQQ channel configuration saved and hot-reloaded."));
      onConfigSaved();
      await loadAll(environmentId);
    } else {
      setErrorMessage(
        gt(
          "Failed to save NapCatQQ config. Ensure OneBot URL is loopback-only and QQ IDs are positive numbers.",
        ),
      );
      onConfigSaved();
    }
    setBusy(false);
  };

  const handleSaveSecret = async () => {
    if (!environmentId || !secretInput.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const value = secretInput.trim();
    setSecretInput("");
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "community.napcat-qq",
        method: "setTokenSecret",
        payload: { token: value },
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setStatusMessage(gt("NapCatQQ secret stored securely in ServerSecretStore."));
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to store NapCatQQ secret."));
    }
    setBusy(false);
  };

  const handleClearSecret = async () => {
    if (!environmentId) return;
    setBusy(true);
    setErrorMessage(null);
    setStatusMessage(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "community.napcat-qq",
        method: "clearTokenSecret",
        payload: {},
      },
    });
    if (AsyncResult.isSuccess(res)) {
      setStatusMessage(gt("NapCatQQ secret cleared from ServerSecretStore."));
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to clear NapCatQQ secret."));
    }
    setBusy(false);
  };

  const handleTestConnection = async () => {
    if (!environmentId) return;
    setBusy(true);
    setErrorMessage(null);
    setConnResult(null);
    const res = await runInvoke({
      environmentId,
      input: { pluginId: "community.napcat-qq", method: "testConnection", payload: {} },
    });
    if (AsyncResult.isSuccess(res) && res.value.result) {
      setConnResult(res.value.result as ConnectionTestResult);
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Failed to invoke NapCatQQ connection probe."));
    }
    setBusy(false);
  };

  const handleSimulateInbound = async () => {
    if (!environmentId || !simText.trim()) return;
    setBusy(true);
    setErrorMessage(null);
    setSimResult(null);
    const res = await runInvoke({
      environmentId,
      input: {
        pluginId: "community.napcat-qq",
        method: "simulateInbound",
        payload: {
          chatType: simChatType,
          userId: simUserId.trim(),
          ...(simChatType === "group" ? { groupId: simGroupId.trim(), mentionedBot: true } : {}),
          text: simText.trim(),
          botId: activeBot?.id,
        },
      },
    });
    if (AsyncResult.isSuccess(res) && res.value.result) {
      setSimResult(res.value.result as SimulationResult);
      await loadAll(environmentId);
    } else {
      setErrorMessage(gt("Local QQ inbound simulation failed."));
    }
    setBusy(false);
  };

  const handleCopyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(webhookDisplayUrl);
      setCopiedWebhook(true);
      window.setTimeout(() => setCopiedWebhook(false), 1_500);
    } catch {
      // Ignore clipboard permission errors in headless test runners.
    }
  };

  const overviewCard = buildBotsOverviewCard(botsState, napcatStatus, napcatUnavailable, gt);
  const gates = botsState?.decisionGates ?? [];
  const recentActivity = napcatStatus?.recentActivity ?? [];
  const secretBadgeLabel = napcatStatus?.secretConfigured ? gt("Configured") : gt("Not configured");

  return (
    <div data-bytedock-bots-panel="true" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BotIcon className="size-4 text-primary" />
          <span>
            <T>
              Manage isolated SOUL.md, append-only MEMORY.md, Decision Gates, and loopback NapCatQQ.
            </T>
          </span>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy || !environmentId}
          onClick={() => {
            if (environmentId) void loadAll(environmentId);
          }}
        >
          <RefreshCwIcon className="size-3.5" />
          <T>Refresh</T>
        </Button>
      </div>

      <PluginNodeRenderer node={overviewCard} />

      {errorMessage ? (
        <div className="rounded-md border border-error/30 bg-error-surface px-3 py-2 text-xs text-error">
          {errorMessage}
        </div>
      ) : null}
      {statusMessage ? (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
          {statusMessage}
        </div>
      ) : null}

      {napcatStatus && !napcatStatus.allowlistConfigured ? (
        <div
          data-bytedock-napcat-fail-closed="true"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <T>
              NapCatQQ webhook is in fail-closed mode: add at least one allowed QQ User ID below
              before live webhooks are accepted.
            </T>
          </span>
        </div>
      ) : null}

      {/* Bot profile, SOUL.md, MEMORY.md, Thread binding */}
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BotIcon className="size-4 text-primary" />
            <h4 className="text-xs font-semibold text-foreground">
              <T>Bot Profile, SOUL.md &amp; Append-Only MEMORY.md</T>
            </h4>
          </div>
          {botsState?.botsDir ? (
            <span className="font-mono text-3xs text-muted-foreground">{botsState.botsDir}</span>
          ) : null}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              <T>Active Bot Profile</T>
            </span>
            <select
              aria-label={gt("Active Bot Profile")}
              value={activeBot?.id ?? "default"}
              onChange={(e) => setSelectedBotId(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
            >
              {(botsState?.bots ?? []).map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {`${bot.name} (${bot.id})`}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              <T>Create Additional Bot</T>
            </span>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={newBotId}
                onChange={(e) => setNewBotId(e.target.value)}
                placeholder={gt("bot-id")}
                className="w-28 rounded-md border border-input bg-background px-2 py-1 text-xs font-mono text-foreground"
              />
              <input
                type="text"
                value={newBotName}
                onChange={(e) => setNewBotName(e.target.value)}
                placeholder={gt("Display name")}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy || !newBotId.trim() || !newBotName.trim()}
                onClick={() => void handleCreateBot()}
              >
                <T>Create</T>
              </Button>
            </div>
          </div>
        </div>

        {activeBot ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
                <span className="text-muted-foreground">
                  <T>Bound ByteDock Thread</T>
                </span>
                <select
                  aria-label={gt("Bound ByteDock Thread")}
                  value={activeBindingValue}
                  onChange={(e) =>
                    setBindingDraftByBot((prev) => ({
                      ...prev,
                      [activeBot.id]: e.target.value,
                    }))
                  }
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground"
                >
                  <option value="">{gt("Unbound (no automatic thread dispatch)")}</option>
                  {activeBot.boundProjectId &&
                  activeBot.boundThreadId &&
                  !threads.some(
                    (t) =>
                      t.projectId === activeBot.boundProjectId &&
                      t.threadId === activeBot.boundThreadId,
                  ) ? (
                    <option value={`${activeBot.boundProjectId}::${activeBot.boundThreadId}`}>
                      {activeBot.boundThreadId}
                    </option>
                  ) : null}
                  {threads.map((item) => (
                    <option
                      key={`${item.projectId}::${item.threadId}`}
                      value={`${item.projectId}::${item.threadId}`}
                    >
                      {`${item.title || item.threadId} (${item.threadId.slice(0, 12)})`}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void handleSaveThreadBinding()}
              >
                <T>Save Binding</T>
              </Button>
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium text-foreground">
                  <T>SOUL.md (Deterministic Prefix)</T>
                </span>
                <span
                  data-bytedock-soul-hash={activeBot.soulPrefixHash}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground"
                >
                  {`sha256: ${activeBot.soulPrefixHash.slice(0, 16)}`}
                </span>
              </div>
              <textarea
                aria-label={gt("SOUL.md Editor")}
                value={activeSoulValue}
                onChange={(e) =>
                  setSoulDraftByBot((prev) => ({
                    ...prev,
                    [activeBot.id]: e.target.value,
                  }))
                }
                rows={4}
                className="w-full rounded-md border border-input bg-background p-2 font-mono text-2xs text-foreground"
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={busy}
                  onClick={() => void handleSaveSoul()}
                >
                  <T>Save SOUL.md</T>
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground">
                  <T>
                    MEMORY.md (Append-Only, <Var>{activeBot.memoryLineCount}</Var> lines)
                  </T>
                </span>
              </div>
              <pre className="max-h-28 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-3xs whitespace-pre-wrap text-foreground">
                {activeBot.memoryTail || gt("(empty)")}
              </pre>
              <div className="flex gap-2">
                <input
                  type="text"
                  aria-label={gt("Append Memory Entry")}
                  value={memoryEntry}
                  onChange={(e) => setMemoryEntry(e.target.value)}
                  placeholder={gt("Append a durable note to MEMORY.md...")}
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground"
                />
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={busy || !memoryEntry.trim()}
                  onClick={() => void handleAppendMemory()}
                >
                  <T>Append</T>
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </section>

      {/* Decision Gates */}
      <section
        data-bytedock-decision-gates="true"
        className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-primary" />
            <h4 className="text-xs font-semibold text-foreground">
              <T>Bot Decision Gates</T>
            </h4>
          </div>
          <span className="font-mono text-3xs text-muted-foreground">
            <T>
              <Var>{botsState?.pendingDecisionGates ?? 0}</Var> pending
            </T>
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <input
            type="text"
            aria-label={gt("Gate Title")}
            value={gateTitle}
            onChange={(e) => setGateTitle(e.target.value)}
            placeholder={gt("Gate title (e.g. Deploy staging)")}
            className="w-44 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
          />
          <input
            type="text"
            aria-label={gt("Gate Summary")}
            value={gateSummary}
            onChange={(e) => setGateSummary(e.target.value)}
            placeholder={gt("Confirmation summary...")}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
          />
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy || !gateTitle.trim() || !gateSummary.trim()}
            onClick={() => void handleOpenGate()}
          >
            <T>Open Gate</T>
          </Button>
        </div>

        {gates.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            <T>No Bot Decision Gates recorded yet.</T>
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {gates.slice(0, 12).map((gate) => (
              <div
                key={gate.gateId}
                data-bytedock-gate-id={gate.gateId}
                className="flex flex-col gap-1.5 rounded-md border border-border bg-background/70 p-2 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                      {gate.gateId}
                    </span>
                    <span className="truncate font-medium text-foreground">{gate.title}</span>
                  </div>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs uppercase text-muted-foreground">
                    {gate.status}
                  </span>
                </div>
                <p className="text-2xs text-muted-foreground">{gate.summary}</p>
                {gate.status === "pending" ? (
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void handleResolveGate(gate.gateId, "rejected")}
                    >
                      <T>Reject</T>
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      disabled={busy}
                      onClick={() => void handleResolveGate(gate.gateId, "approved")}
                    >
                      <CheckIcon className="size-3.5" />
                      <T>Approve</T>
                    </Button>
                  </div>
                ) : (
                  <span className="font-mono text-3xs text-muted-foreground">
                    {`${gate.resolvedBy ?? "-"} · ${gate.resolvedVia ?? "-"}`}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* NapCatQQ Channel Config, Secret Store, Diagnostics & Simulator */}
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquareIcon className="size-4 text-primary" />
            <h4 className="text-xs font-semibold text-foreground">
              <T>NapCatQQ OneBot v11 Channel (Loopback-Only)</T>
            </h4>
          </div>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
            {secretBadgeLabel}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs">
          <span className="text-muted-foreground">
            <T>Webhook URL:</T>
          </span>
          <code className="min-w-0 flex-1 truncate font-mono text-2xs text-foreground">
            {webhookDisplayUrl}
          </code>
          <Button type="button" size="xs" variant="ghost" onClick={() => void handleCopyWebhook()}>
            <CopyIcon className="size-3.5" />
            {copiedWebhook ? <T>Copied</T> : <T>Copy</T>}
          </Button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              <T>OneBot v11 Base URL (loopback only)</T>
            </span>
            <input
              type="text"
              value={draftBaseUrl}
              onChange={(e) =>
                setNapcatDraft((prev) => ({ ...prev, oneBotBaseUrl: e.target.value }))
              }
              className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              <T>Webhook Auth Mode</T>
            </span>
            <select
              value={draftAuthMode}
              onChange={(e) =>
                setNapcatDraft((prev) => ({
                  ...prev,
                  webhookAuthMode:
                    e.target.value === "hmac-and-bearer" ? "hmac-and-bearer" : "onebot-hmac",
                }))
              }
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
            >
              <option value="onebot-hmac">{gt("OneBot v11 Raw-Body HMAC (Standard)")}</option>
              <option value="hmac-and-bearer">{gt("HMAC + Bearer Token (Strict)")}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              <T>Allowed QQ User IDs (comma-separated)</T>
            </span>
            <input
              type="text"
              value={draftAllowedUsers}
              onChange={(e) =>
                setNapcatDraft((prev) => ({ ...prev, allowedUserIds: e.target.value }))
              }
              placeholder={gt("e.g. 10001, 20002")}
              className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              <T>Allowed QQ Group IDs (comma-separated)</T>
            </span>
            <input
              type="text"
              value={draftAllowedGroups}
              onChange={(e) =>
                setNapcatDraft((prev) => ({ ...prev, allowedGroupIds: e.target.value }))
              }
              placeholder={gt("e.g. 88888")}
              className="rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={draftRequireAt}
                onChange={(e) =>
                  setNapcatDraft((prev) => ({ ...prev, requireAtInGroup: e.target.checked }))
                }
              />
              <span>
                <T>Require @bot in groups</T>
              </span>
            </label>
            <label className="inline-flex items-center gap-1.5">
              <span className="text-muted-foreground">
                <T>Rate limit/min:</T>
              </span>
              <input
                type="number"
                min={1}
                max={600}
                value={draftRateLimit}
                onChange={(e) =>
                  setNapcatDraft((prev) => ({ ...prev, rateLimitPerMin: e.target.value }))
                }
                className="w-16 rounded-md border border-input bg-background px-2 py-0.5 font-mono text-xs text-foreground"
              />
            </label>
          </div>
          <Button
            type="button"
            size="xs"
            variant="default"
            disabled={busy}
            onClick={() => void handleSaveNapCatConfig()}
          >
            <T>Save Channel Config</T>
          </Button>
        </div>

        {/* Secret token via ServerSecretStore */}
        <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <KeyRoundIcon className="size-3.5 text-primary" />
              <T>Webhook &amp; API Token (ServerSecretStore)</T>
            </span>
            <span className="font-mono text-3xs text-muted-foreground">
              {napcatStatus?.tokenSecretRef ?? "bytedock.napcat.webhook_token"}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <input
              type="password"
              aria-label={gt("NapCatQQ Token Secret")}
              autoComplete="new-password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder={gt("Enter OneBot secret token (never saved to plugins.yml)")}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground"
            />
            <Button
              type="button"
              size="xs"
              variant="default"
              disabled={busy || !secretInput.trim()}
              onClick={() => void handleSaveSecret()}
            >
              <T>Save Secret</T>
            </Button>
            {napcatStatus?.secretConfigured ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void handleClearSecret()}
              >
                <Trash2Icon className="size-3.5" />
                <T>Clear</T>
              </Button>
            ) : null}
          </div>
        </div>

        {/* Diagnostics & Local Simulator */}
        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              <T>Connection Probe &amp; Local QQ Simulator</T>
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void handleTestConnection()}
            >
              <T>Test Connection</T>
            </Button>
          </div>
          {connResult ? (
            <div
              className={`rounded-md border px-2.5 py-1.5 font-mono text-2xs ${
                connResult.ok
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-error/30 bg-error-surface text-error"
              }`}
            >
              {connResult.ok
                ? gt("OK ({status}) {url}", {
                    status: connResult.status ?? 200,
                    url: connResult.url,
                  })
                : gt("FAILED: {error} ({url})", {
                    error: connResult.error ?? gt("unreachable"),
                    url: connResult.url,
                  })}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            <select
              aria-label={gt("Simulation Chat Type")}
              value={simChatType}
              onChange={(e) => setSimChatType(e.target.value === "group" ? "group" : "private")}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
            >
              <option value="private">{gt("Private")}</option>
              <option value="group">{gt("Group")}</option>
            </select>
            <input
              type="text"
              aria-label={gt("Simulation User ID")}
              value={simUserId}
              onChange={(e) => setSimUserId(e.target.value)}
              placeholder={gt("QQ User ID")}
              className="w-24 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground"
            />
            {simChatType === "group" ? (
              <input
                type="text"
                aria-label={gt("Simulation Group ID")}
                value={simGroupId}
                onChange={(e) => setSimGroupId(e.target.value)}
                placeholder={gt("Group ID")}
                className="w-24 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground"
              />
            ) : null}
            <input
              type="text"
              aria-label={gt("Simulation Message")}
              value={simText}
              onChange={(e) => setSimText(e.target.value)}
              placeholder={gt("/status or prompt text")}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
            />
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy || !simText.trim()}
              onClick={() => void handleSimulateInbound()}
            >
              <PlayIcon className="size-3.5" />
              <T>Simulate</T>
            </Button>
          </div>
          {simResult ? (
            <pre
              data-bytedock-sim-result="true"
              className="max-h-24 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-3xs whitespace-pre-wrap text-foreground"
            >
              {`${simResult.accepted ? "ACCEPTED" : "REJECTED"} (${simResult.reason})${simResult.replyText ? `\n${simResult.replyText}` : ""}`}
            </pre>
          ) : null}
        </div>

        {recentActivity.length > 0 ? (
          <div className="flex flex-col gap-1 border-t border-border pt-2">
            <span className="text-2xs font-medium text-muted-foreground">
              <T>Recent Channel Activity</T>
            </span>
            <div className="flex max-h-28 flex-col gap-1 overflow-auto font-mono text-3xs">
              {recentActivity.slice(0, 10).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1"
                >
                  <span className="truncate text-foreground">{`[${item.direction}/${item.kind}] ${item.summary}`}</span>
                  <span className={item.ok ? "text-success" : "text-warning"}>
                    {item.ok ? gt("OK") : gt("DENY")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
