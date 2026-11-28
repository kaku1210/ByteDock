import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";

import { act, render } from "../../../test/render";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { ByteDockControlCenterModal } from "./ByteDockControlCenterModal";
import {
  applyUiControlCommand,
  getPluginSlotSnapshot,
  openByteDockModal,
  resetPluginSlotStoreForTest,
} from "./PluginSlotStore";

const MODAL_NAME = "ByteDock Plugins & Data Importer";

function pluginSlotStoreScope(): Disposable {
  resetPluginSlotStoreForTest();
  return {
    [Symbol.dispose]() {
      resetPluginSlotStoreForTest();
    },
  };
}

function SettingsAndChatHarness({
  initialShowSettings = true,
  onOuterSettingsOpenChange,
}: {
  readonly initialShowSettings?: boolean;
  readonly onOuterSettingsOpenChange?: (open: boolean) => void;
}) {
  const [showSettings, setShowSettings] = useState(initialShowSettings);
  return (
    <div data-testid="app-shell">
      <div data-testid="chat-entry">
        <button type="button" onClick={() => openByteDockModal("plugins", "chat")}>
          Open from Chat
        </button>
        <ByteDockControlCenterModal host="chat" />
      </div>

      {showSettings ? (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            onOuterSettingsOpenChange?.(nextOpen);
            if (!nextOpen) setShowSettings(false);
          }}
        >
          <DialogPopup aria-label="Settings">
            <DialogTitle>Settings</DialogTitle>
            <div style={{ display: "flex", width: "900px", height: "500px" }}>
              <nav
                data-testid="settings-sidebar"
                style={{
                  width: "240px",
                  flexShrink: 0,
                  overflow: "hidden",
                }}
              >
                <ScrollArea
                  hideScrollbars
                  scrollFade
                  scrollFadePadding={false}
                  style={{ height: "100%" }}
                >
                  <button type="button" onClick={() => openByteDockModal("plugins", "settings")}>
                    Plugins &amp; Guard
                  </button>
                  <button type="button" onClick={() => openByteDockModal("import", "settings")}>
                    Import T3 Data
                  </button>
                  <ByteDockControlCenterModal host="settings" />
                </ScrollArea>
              </nav>
              <main data-testid="settings-general" style={{ flex: 1 }}>
                <button type="button" onClick={() => setShowSettings(false)}>
                  Exit Settings
                </button>
              </main>
            </div>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}

describe("ByteDockControlCenterModal", () => {
  it("portals out of the masked Settings sidebar ScrollArea and closes without dismissing Settings", async () => {
    using _store = pluginSlotStoreScope();
    await page.viewport(1280, 900);
    const onOuterSettingsOpenChange = vi.fn();
    await using _screen = await render(
      <SettingsAndChatHarness onOuterSettingsOpenChange={onOuterSettingsOpenChange} />,
    );

    const sidebar = page.getByTestId("settings-sidebar");
    await expect.element(sidebar).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Plugins & Guard" }));

    const modal = page.getByRole("dialog", { name: MODAL_NAME });
    await expect.element(modal).toBeVisible();

    const modalEl = modal.element() as HTMLElement;
    const sidebarEl = sidebar.element() as HTMLElement;
    expect(modalEl.dataset.bytedockModalHost).toBe("settings");
    // Must render via DialogPortal outside the 240px scrollFade sidebar so mask-image cannot clip it.
    expect(sidebarEl.contains(modalEl)).toBe(false);
    const modalRect = modalEl.getBoundingClientRect();
    const sidebarRect = sidebarEl.getBoundingClientRect();
    expect(modalRect.width).toBeGreaterThan(500);
    expect(modalRect.right).toBeGreaterThan(sidebarRect.right);

    // Switching tabs inside the modal works while nested above Settings.
    await userEvent.click(modal.getByRole("button", { name: /Import T3 Code/i }));
    expect(getPluginSlotSnapshot().modalTab).toBe("import");

    // Closing via Escape closes only the ByteDock Control Center, leaving outer Settings intact.
    await userEvent.keyboard("{Escape}");
    await expect.element(modal).not.toBeInTheDocument();
    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
    expect(onOuterSettingsOpenChange).not.toHaveBeenCalled();
    await expect.element(sidebar).toBeVisible();

    // Re-open and close via the built-in DialogPopup Close button.
    await userEvent.click(page.getByRole("button", { name: "Import T3 Data" }));
    await expect.element(modal).toBeVisible();
    await userEvent.click(modal.getByRole("button", { name: "Close" }));
    await expect.element(modal).not.toBeInTheDocument();
    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
    expect(onOuterSettingsOpenChange).not.toHaveBeenCalled();
  });

  it("opens and closes cleanly from the Chat entry", async () => {
    using _store = pluginSlotStoreScope();
    await page.viewport(1280, 900);
    await using _screen = await render(<SettingsAndChatHarness initialShowSettings={false} />);

    await userEvent.click(page.getByRole("button", { name: "Open from Chat" }));

    const modal = page.getByRole("dialog", { name: MODAL_NAME });
    await expect.element(modal).toBeVisible();
    expect((modal.element() as HTMLElement).dataset.bytedockModalHost).toBe("chat");

    await userEvent.click(modal.getByRole("button", { name: "Close" }));
    await expect.element(modal).not.toBeInTheDocument();
    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
  });

  it("resets stale Settings host state on exit so AI open_control_center opens in Chat", async () => {
    using _store = pluginSlotStoreScope();
    await page.viewport(1280, 900);
    await using screen = await render(<SettingsAndChatHarness />);

    // Open from Settings, close, then exit Settings.
    await userEvent.click(page.getByRole("button", { name: "Plugins & Guard" }));
    const modal = page.getByRole("dialog", { name: MODAL_NAME });
    await expect.element(modal).toBeVisible();
    expect((modal.element() as HTMLElement).dataset.bytedockModalHost).toBe("settings");

    await userEvent.click(modal.getByRole("button", { name: "Close" }));
    await expect.element(modal).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Exit Settings" }));
    await expect.element(page.getByTestId("settings-sidebar")).not.toBeInTheDocument();

    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
    expect(getPluginSlotSnapshot().modalHost).toBe("chat");

    // AI control-plane command must now target the mounted Chat host and open visibly.
    await act(() => {
      const result = applyUiControlCommand({
        commandId: "ai-open-after-settings-exit",
        action: "open_control_center",
        tab: "import",
      });
      expect(result.applied).toBe(true);
    });

    await expect.element(modal).toBeVisible();
    expect((modal.element() as HTMLElement).dataset.bytedockModalHost).toBe("chat");
    expect(getPluginSlotSnapshot().modalTab).toBe("import");

    await userEvent.keyboard("{Escape}");
    await expect.element(modal).not.toBeInTheDocument();

    // Unmounting Settings while the control center is still open must clear modalOpen and fall back to Chat.
    await screen.rerender(<SettingsAndChatHarness key="reopen-settings" initialShowSettings />);
    await userEvent.click(page.getByRole("button", { name: "Plugins & Guard" }));
    await expect.element(modal).toBeVisible();
    expect((modal.element() as HTMLElement).dataset.bytedockModalHost).toBe("settings");

    await screen.rerender(
      <SettingsAndChatHarness key="unmount-settings" initialShowSettings={false} />,
    );
    await expect.element(modal).not.toBeInTheDocument();
    expect(getPluginSlotSnapshot().modalOpen).toBe(false);
    expect(getPluginSlotSnapshot().modalHost).toBe("chat");

    await act(() => {
      const result = applyUiControlCommand({
        commandId: "ai-open-after-forced-settings-unmount",
        action: "open_control_center",
        tab: "plugins",
      });
      expect(result.applied).toBe(true);
    });

    await expect.element(modal).toBeVisible();
    expect((modal.element() as HTMLElement).dataset.bytedockModalHost).toBe("chat");
  });
});
