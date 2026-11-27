import { useSyncExternalStore } from "react";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

export type ByteDockModalTab = "plugins" | "import";

export interface PluginTimelineCardEntry {
  readonly rowId: string;
  readonly pluginId: string;
  readonly node: JsonNode;
}

export interface PluginSlotState {
  readonly modalOpen: boolean;
  readonly modalTab: ByteDockModalTab;
  readonly modalHost: "settings" | "chat";
  readonly activeDockPluginId: string | null;
  readonly activeDockTree: JsonNode | null;
  readonly timelineCards: Readonly<Record<string, PluginTimelineCardEntry>>;
  readonly pendingApprovalCount: number;
}

let state: PluginSlotState = {
  modalOpen: false,
  modalTab: "plugins",
  modalHost: "chat",
  activeDockPluginId: null,
  activeDockTree: null,
  timelineCards: {},
  pendingApprovalCount: 0,
};

const listeners = new Set<() => void>();

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

export function openByteDockModal(
  tab: ByteDockModalTab = "plugins",
  host: "settings" | "chat" = "chat",
) {
  state = { ...state, modalOpen: true, modalTab: tab, modalHost: host };
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

export function usePluginSlotState(): PluginSlotState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
