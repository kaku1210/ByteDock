import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

import {
  applyUiControlCommand,
  clearUiNotification,
  getPluginSlotSnapshot,
  handleControlPlaneStreamPayload,
  isSafeInternalRoutePath,
  openByteDockModal,
  registerByteDockModalHost,
  registerUiNavigateHandler,
  resetPluginSlotStoreForTest,
} from "./PluginSlotStore";

describe("PluginSlotStore real-time ByteDock UI control bus", () => {
  beforeEach(() => {
    resetPluginSlotStoreForTest();
  });

  it("opens and closes Control Center modal tabs and deduplicates commandIds", () => {
    const first = applyUiControlCommand({
      commandId: "cmd-open-1",
      action: "open_control_center",
      tab: "import",
    });
    expect(first.applied).toBe(true);
    expect(getPluginSlotSnapshot().modalOpen).toBe(true);
    expect(getPluginSlotSnapshot().modalTab).toBe("import");

    const dup = applyUiControlCommand({
      commandId: "cmd-open-1",
      action: "open_control_center",
      tab: "plugins",
    });
    expect(dup.applied).toBe(false);
    expect(dup.reason).toBe("duplicate-command");
    expect(getPluginSlotSnapshot().modalTab).toBe("import");

    const closed = applyUiControlCommand({
      commandId: "cmd-close-1",
      action: "close_control_center",
    });
    expect(closed.applied).toBe(true);
    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
  });

  it("opens and closes right plugin dock panels with validated JsonNode trees", () => {
    const card: JsonNode = {
      t: "Card",
      p: { titleI18n: "Host Diagnostics" },
      c: [{ t: "Text", p: { i18n: "All systems operational" } }],
    };
    const opened = applyUiControlCommand({
      commandId: "cmd-dock-1",
      action: "open_dock_panel",
      pluginId: "builtin.egress-guard",
      node: card,
    });
    expect(opened.applied).toBe(true);
    expect(getPluginSlotSnapshot().activeDockPluginId).toBe("builtin.egress-guard");
    expect(getPluginSlotSnapshot().activeDockTree).toEqual(card);

    const invalid = applyUiControlCommand({
      commandId: "cmd-dock-bad",
      action: "open_dock_panel",
      pluginId: "builtin.egress-guard",
      node: "not-an-object",
    });
    expect(invalid.applied).toBe(false);

    const closed = applyUiControlCommand({
      commandId: "cmd-dock-close",
      action: "close_dock_panel",
    });
    expect(closed.applied).toBe(true);
    expect(getPluginSlotSnapshot().activeDockPluginId).toBeNull();
  });

  it("navigates strictly to safe internal '/' routes and rejects external/script URLs", () => {
    expect(isSafeInternalRoutePath("/settings/general")).toBe(true);
    expect(isSafeInternalRoutePath("/env-1/thread-2?tab=diff")).toBe(true);
    expect(isSafeInternalRoutePath("https://evil.example/phish")).toBe(false);
    expect(isSafeInternalRoutePath("//evil.example/phish")).toBe(false);
    expect(isSafeInternalRoutePath("javascript:alert(1)")).toBe(false);
    expect(isSafeInternalRoutePath("data:text/html,hi")).toBe(false);
    expect(isSafeInternalRoutePath("settings/general")).toBe(false);

    const visited: Array<string> = [];
    const unregister = registerUiNavigateHandler((safePath) => {
      visited.push(safePath);
    });

    const ok = applyUiControlCommand({
      commandId: "cmd-nav-1",
      action: "navigate",
      path: "/settings/general",
    });
    expect(ok.applied).toBe(true);
    expect(visited).toEqual(["/settings/general"]);

    const badHttps = applyUiControlCommand({
      commandId: "cmd-nav-2",
      action: "navigate",
      path: "https://example.com",
    });
    expect(badHttps.applied).toBe(false);
    expect(badHttps.reason).toBe("unsafe-navigation-path");

    const badJs = applyUiControlCommand({
      commandId: "cmd-nav-3",
      action: "navigate",
      path: "javascript:alert(1)",
    });
    expect(badJs.applied).toBe(false);
    expect(visited).toEqual(["/settings/general"]);

    unregister();
  });

  it("handles notification banners and real-time approval badge deltas from stream events", () => {
    handleControlPlaneStreamPayload({
      kind: "ui-command",
      command: {
        commandId: "cmd-notify-1",
        action: "notify",
        message: "ByteDock settings updated",
        level: "success",
        issuedAt: "2026-11-27T00:00:00Z",
      },
    });
    expect(getPluginSlotSnapshot().activeNotification?.message).toBe("ByteDock settings updated");
    expect(getPluginSlotSnapshot().activeNotification?.level).toBe("success");

    clearUiNotification();
    expect(getPluginSlotSnapshot().activeNotification).toBeNull();

    handleControlPlaneStreamPayload({ kind: "approval-created", requestId: "req-1" });
    handleControlPlaneStreamPayload({ kind: "approval-created", requestId: "req-2" });
    expect(getPluginSlotSnapshot().pendingApprovalCount).toBe(2);

    handleControlPlaneStreamPayload({ kind: "approval-resolved", requestId: "req-1" });
    expect(getPluginSlotSnapshot().pendingApprovalCount).toBe(1);

    handleControlPlaneStreamPayload({ kind: "approval-resolved", requestId: "req-2" });
    handleControlPlaneStreamPayload({ kind: "approval-resolved", requestId: "req-3" });
    expect(getPluginSlotSnapshot().pendingApprovalCount).toBe(0);
  });

  it("clears stale open state when Settings unmounts and routes subsequent AI open_control_center commands to Chat", () => {
    const unregisterChat = registerByteDockModalHost("chat");
    const unregisterSettings = registerByteDockModalHost("settings");

    // While Settings is mounted, AI commands prefer the Settings host so the modal layers above Settings.
    const openInSettings = applyUiControlCommand({
      commandId: "cmd-host-settings-1",
      action: "open_control_center",
      tab: "plugins",
    });
    expect(openInSettings.applied).toBe(true);
    expect(getPluginSlotSnapshot().modalOpen).toBe(true);
    expect(getPluginSlotSnapshot().modalHost).toBe("settings");

    // Leaving Settings without closing the modal resets modalOpen and falls back to the mounted Chat host.
    unregisterSettings();
    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
    expect(getPluginSlotSnapshot().modalHost).toBe("chat");

    // After leaving Settings, AI commands must open on the live Chat host rather than stale "settings".
    const openInChat = applyUiControlCommand({
      commandId: "cmd-host-chat-1",
      action: "open_control_center",
      tab: "import",
    });
    expect(openInChat.applied).toBe(true);
    expect(getPluginSlotSnapshot().modalOpen).toBe(true);
    expect(getPluginSlotSnapshot().modalHost).toBe("chat");
    expect(getPluginSlotSnapshot().modalTab).toBe("import");

    // Re-opening from Settings, closing, and exiting Settings also leaves modalHost on Chat.
    const unregisterSettingsAgain = registerByteDockModalHost("settings");
    openByteDockModal("plugins", "settings");
    expect(getPluginSlotSnapshot().modalHost).toBe("settings");
    const closeCmd = applyUiControlCommand({
      commandId: "cmd-host-close-1",
      action: "close_control_center",
    });
    expect(closeCmd.applied).toBe(true);
    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
    unregisterSettingsAgain();
    expect(getPluginSlotSnapshot().modalHost).toBe("chat");

    unregisterChat();
  });
});
