import { useSyncExternalStore } from "react";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

export type ByteDockModalTab = "plugins" | "xray" | "bots" | "import";
export type ByteDockModalHost = "settings" | "chat";

export interface TokenOptimizerRuntimeConfig {
  readonly enabled: boolean;
  readonly cacheGuardActive: boolean;
  readonly steadyStateTargetPct: number;
  readonly xrayHonestyMode: "strict-no-fabrication";
  readonly showStatusBarMetrics: boolean;
  readonly watchdogEnabled: boolean;
  readonly watchdogWarnAfterSec: number;
  readonly watchdogCriticalAfterSec: number;
}

export const DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG: TokenOptimizerRuntimeConfig = {
  enabled: true,
  cacheGuardActive: true,
  steadyStateTargetPct: 90,
  xrayHonestyMode: "strict-no-fabrication",
  showStatusBarMetrics: true,
  watchdogEnabled: true,
  watchdogWarnAfterSec: 45,
  watchdogCriticalAfterSec: 120,
};

export interface PluginTimelineCardEntry {
  readonly rowId: string;
  readonly pluginId: string;
  readonly node: JsonNode;
}

export interface ByteDockUiNotification {
  readonly id: string;
  readonly message: string;
  readonly level: "info" | "success" | "warning" | "error";
  readonly issuedAt: string;
}

export interface ByteDockUiControlCommand {
  readonly commandId?: string | undefined;
  readonly action:
    | "open_control_center"
    | "close_control_center"
    | "open_dock_panel"
    | "close_dock_panel"
    | "navigate"
    | "notify";
  readonly tab?: ByteDockModalTab | undefined;
  readonly pluginId?: string | undefined;
  readonly node?: unknown;
  readonly path?: string | undefined;
  readonly message?: string | undefined;
  readonly level?: "info" | "success" | "warning" | "error" | undefined;
  readonly issuedAt?: string | undefined;
}

export interface PluginSlotState {
  readonly modalOpen: boolean;
  readonly modalTab: ByteDockModalTab;
  readonly modalHost: ByteDockModalHost;
  readonly activeThreadId: string | null;
  readonly activeDockPluginId: string | null;
  readonly activeDockTree: JsonNode | null;
  readonly timelineCards: Readonly<Record<string, PluginTimelineCardEntry>>;
  readonly pendingApprovalCount: number;
  readonly pendingDecisionGateCount: number;
  readonly activeNotification: ByteDockUiNotification | null;
  readonly tokenOptimizerConfig: TokenOptimizerRuntimeConfig;
  readonly configRevision: number;
  readonly botsRevision: number;
}

let state: PluginSlotState = {
  modalOpen: false,
  modalTab: "plugins",
  modalHost: "chat",
  activeThreadId: null,
  activeDockPluginId: null,
  activeDockTree: null,
  timelineCards: {},
  pendingApprovalCount: 0,
  pendingDecisionGateCount: 0,
  activeNotification: null,
  tokenOptimizerConfig: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
  configRevision: 0,
  botsRevision: 0,
};

const listeners = new Set<() => void>();
const processedCommandIds = new Set<string>();
const navigateHandlers: Array<(safePath: string) => void> = [];
const mountedModalHosts: Record<ByteDockModalHost, number> = {
  settings: 0,
  chat: 0,
};

function resolvePreferredModalHost(): ByteDockModalHost {
  if (mountedModalHosts.settings > 0) return "settings";
  if (mountedModalHosts.chat > 0) return "chat";
  return state.modalHost;
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PluginSlotState {
  return state;
}

/** Validates that an AI-requested navigation target stays strictly on an internal relative route. */
export function isSafeInternalRoutePath(rawPath: string): boolean {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return false;
  if (trimmed.includes("://") || trimmed.includes("\\")) return false;
  if (/[\r\n\0]/.test(trimmed)) return false;
  if (/^\s*(javascript|data|vbscript):/i.test(trimmed)) return false;
  return true;
}

function isJsonNodeLike(value: unknown): value is JsonNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { readonly t?: unknown };
  return typeof candidate.t === "string" && candidate.t.length > 0;
}

export function registerUiNavigateHandler(handler: (safePath: string) => void): () => void {
  navigateHandlers.push(handler);
  return () => {
    const idx = navigateHandlers.lastIndexOf(handler);
    if (idx >= 0) {
      navigateHandlers.splice(idx, 1);
    }
  };
}

export function registerByteDockModalHost(host: ByteDockModalHost): () => void {
  mountedModalHosts[host] += 1;
  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    mountedModalHosts[host] = Math.max(0, mountedModalHosts[host] - 1);
    if (mountedModalHosts[host] === 0 && state.modalHost === host) {
      const fallbackHost: ByteDockModalHost = mountedModalHosts.settings > 0 ? "settings" : "chat";
      if (state.modalOpen || state.modalHost !== fallbackHost) {
        state = { ...state, modalOpen: false, modalHost: fallbackHost };
        emit();
      }
    }
  };
}

export function openByteDockModal(
  tab: ByteDockModalTab = "plugins",
  host?: ByteDockModalHost,
  threadId?: string | null,
) {
  const targetHost = host ?? resolvePreferredModalHost();
  state = {
    ...state,
    modalOpen: true,
    modalTab: tab,
    modalHost: targetHost,
    ...(threadId !== undefined ? { activeThreadId: threadId } : {}),
  };
  emit();
}

export function setActiveObservabilityThreadId(threadId: string | null) {
  if (state.activeThreadId === threadId) return;
  state = { ...state, activeThreadId: threadId };
  emit();
}

export function setTokenOptimizerRuntimeConfig(config: TokenOptimizerRuntimeConfig) {
  const prev = state.tokenOptimizerConfig;
  if (
    prev.enabled === config.enabled &&
    prev.cacheGuardActive === config.cacheGuardActive &&
    prev.steadyStateTargetPct === config.steadyStateTargetPct &&
    prev.xrayHonestyMode === config.xrayHonestyMode &&
    prev.showStatusBarMetrics === config.showStatusBarMetrics &&
    prev.watchdogEnabled === config.watchdogEnabled &&
    prev.watchdogWarnAfterSec === config.watchdogWarnAfterSec &&
    prev.watchdogCriticalAfterSec === config.watchdogCriticalAfterSec
  ) {
    return;
  }
  state = { ...state, tokenOptimizerConfig: config };
  emit();
}

export function closeByteDockModal() {
  if (!state.modalOpen) return;
  state = { ...state, modalOpen: false };
  emit();
}

export function setByteDockModalTab(tab: ByteDockModalTab) {
  if (state.modalTab === tab) return;
  state = { ...state, modalTab: tab };
  emit();
}

function setActivePluginDockPanel(pluginId: string, node: JsonNode) {
  state = { ...state, activeDockPluginId: pluginId, activeDockTree: node };
  emit();
}

export function clearActivePluginDockPanel() {
  if (state.activeDockPluginId === null) return;
  state = { ...state, activeDockPluginId: null, activeDockTree: null };
  emit();
}

export function setPendingApprovalCount(count: number) {
  const normalized = Math.max(0, Math.trunc(count));
  if (state.pendingApprovalCount === normalized) return;
  state = { ...state, pendingApprovalCount: normalized };
  emit();
}

export function setPendingDecisionGateCount(count: number) {
  const normalized = Math.max(0, Math.trunc(count));
  if (state.pendingDecisionGateCount === normalized) return;
  state = { ...state, pendingDecisionGateCount: normalized };
  emit();
}

function adjustPendingApprovalCount(delta: number) {
  setPendingApprovalCount(state.pendingApprovalCount + delta);
}

function setUiNotification(notification: ByteDockUiNotification) {
  state = { ...state, activeNotification: notification };
  emit();
}

export function clearUiNotification() {
  if (state.activeNotification === null) return;
  state = { ...state, activeNotification: null };
  emit();
}

/** Applies a real-time ByteDock UI control command from MCP/control-plane safely. */
export function applyUiControlCommand(
  command: ByteDockUiControlCommand,
  navigateFn?: (safePath: string) => void,
): { readonly applied: boolean; readonly reason?: string | undefined } {
  if (command.commandId) {
    if (processedCommandIds.has(command.commandId)) {
      return { applied: false, reason: "duplicate-command" };
    }
    processedCommandIds.add(command.commandId);
    if (processedCommandIds.size > 256) {
      const oldest = processedCommandIds.values().next().value;
      if (oldest !== undefined) processedCommandIds.delete(oldest);
    }
  }

  if (command.action === "open_control_center") {
    const tab: ByteDockModalTab =
      command.tab === "import"
        ? "import"
        : command.tab === "xray"
          ? "xray"
          : command.tab === "bots"
            ? "bots"
            : "plugins";
    openByteDockModal(tab, resolvePreferredModalHost());
    return { applied: true };
  }

  if (command.action === "close_control_center") {
    closeByteDockModal();
    return { applied: true };
  }

  if (command.action === "open_dock_panel") {
    if (!command.pluginId || !isJsonNodeLike(command.node)) {
      return { applied: false, reason: "invalid-dock-panel-payload" };
    }
    setActivePluginDockPanel(command.pluginId, command.node);
    return { applied: true };
  }

  if (command.action === "close_dock_panel") {
    clearActivePluginDockPanel();
    return { applied: true };
  }

  if (command.action === "navigate") {
    const targetPath = typeof command.path === "string" ? command.path.trim() : "";
    if (!isSafeInternalRoutePath(targetPath)) {
      return { applied: false, reason: "unsafe-navigation-path" };
    }
    const nav = navigateFn ?? navigateHandlers[navigateHandlers.length - 1];
    if (nav) {
      nav(targetPath);
    }
    return { applied: true };
  }

  if (command.action === "notify") {
    const message = typeof command.message === "string" ? command.message.trim() : "";
    if (!message) {
      return { applied: false, reason: "empty-notification" };
    }
    setUiNotification({
      id: command.commandId ?? `notify-${message.length}`,
      message,
      level: command.level ?? "info",
      issuedAt: command.issuedAt ?? "",
    });
    return { applied: true };
  }

  return { applied: false, reason: "unknown-action" };
}

/** Handles one PluginsStreamEvent from builtin.control-plane/events. */
export function handleControlPlaneStreamPayload(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  if (record.kind === "ui-command" && record.command && typeof record.command === "object") {
    applyUiControlCommand(record.command as ByteDockUiControlCommand);
    return;
  }
  if (record.kind === "approval-created") {
    adjustPendingApprovalCount(1);
    return;
  }
  if (record.kind === "approval-resolved") {
    adjustPendingApprovalCount(-1);
    return;
  }
  if (record.kind === "decision-gate-created") {
    const nextPending =
      typeof record.pendingDecisionGates === "number"
        ? Math.max(0, Math.trunc(record.pendingDecisionGates))
        : state.pendingDecisionGateCount + 1;
    state = {
      ...state,
      pendingDecisionGateCount: nextPending,
      botsRevision: state.botsRevision + 1,
    };
    emit();
    return;
  }
  if (record.kind === "decision-gate-resolved") {
    const nextPending =
      typeof record.pendingDecisionGates === "number"
        ? Math.max(0, Math.trunc(record.pendingDecisionGates))
        : Math.max(0, state.pendingDecisionGateCount - 1);
    state = {
      ...state,
      pendingDecisionGateCount: nextPending,
      botsRevision: state.botsRevision + 1,
    };
    emit();
    return;
  }
  if (record.kind === "bots-updated" || record.kind === "napcat-event") {
    const nextPending =
      typeof record.pendingDecisionGates === "number"
        ? Math.max(0, Math.trunc(record.pendingDecisionGates))
        : state.pendingDecisionGateCount;
    state = {
      ...state,
      pendingDecisionGateCount: nextPending,
      botsRevision: state.botsRevision + 1,
    };
    emit();
    return;
  }
  if (
    record.kind === "state-updated" ||
    record.kind === "config-changed" ||
    record.kind === "plugin-enabled-changed" ||
    record.kind === "reloaded"
  ) {
    state = {
      ...state,
      configRevision: state.configRevision + 1,
      botsRevision: state.botsRevision + 1,
    };
    emit();
  }
}

export function resetPluginSlotStoreForTest() {
  processedCommandIds.clear();
  navigateHandlers.length = 0;
  mountedModalHosts.settings = 0;
  mountedModalHosts.chat = 0;
  state = {
    modalOpen: false,
    modalTab: "plugins",
    modalHost: "chat",
    activeThreadId: null,
    activeDockPluginId: null,
    activeDockTree: null,
    timelineCards: {},
    pendingApprovalCount: 0,
    pendingDecisionGateCount: 0,
    activeNotification: null,
    tokenOptimizerConfig: DEFAULT_TOKEN_OPTIMIZER_RUNTIME_CONFIG,
    configRevision: 0,
    botsRevision: 0,
  };
  emit();
}

export function getPluginSlotSnapshot(): PluginSlotState {
  return getSnapshot();
}

export function usePluginSlotState(): PluginSlotState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
