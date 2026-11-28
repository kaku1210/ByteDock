import "~/index.css";

import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { ByteDockControlCenterModal } from "./ByteDockControlCenterModal";
import {
  applyUiControlCommand,
  getPluginSlotSnapshot,
  handleControlPlaneStreamPayload,
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

describe("ByteDockControlCenterModal Bots & QQ tab", () => {
  it("opens Bots & QQ tab via AI command, renders declarative KPI card and NapCatQQ secret/simulator controls, and reacts to Decision Gate events", async () => {
    using _store = pluginSlotStoreScope();
    await page.viewport(1280, 900);
    await using _screen = await render(<ByteDockControlCenterModal host="chat" />);

    await act(() => {
      handleControlPlaneStreamPayload({
        kind: "decision-gate-created",
        gateId: "gate-demo-1",
        pendingDecisionGates: 2,
      });
      const res = applyUiControlCommand({
        commandId: "ai-open-bots-tab",
        action: "open_control_center",
        tab: "bots",
      });
      expect(res.applied).toBe(true);
    });

    const modal = page.getByRole("dialog", { name: MODAL_NAME });
    await expect.element(modal).toBeVisible();
    expect(getPluginSlotSnapshot().modalTab).toBe("bots");

    // Verify declarative 4-KPI card, masked secret input, and simulator controls render.
    await expect.element(modal.getByText("Bots Core & NapCatQQ Loop")).toBeVisible();
    await expect
      .element(modal.getByText("NapCatQQ OneBot v11 Channel (Loopback-Only)"))
      .toBeVisible();
    const secretField = modal.getByLabelText("NapCatQQ Token Secret");
    await expect.element(secretField).toBeVisible();
    expect((secretField.element() as HTMLInputElement).type).toBe("password");

    const simInput = modal.getByLabelText("Simulation Message");
    await expect.element(simInput).toBeVisible();

    // Pending Decision Gate badge updates live on stream resolution.
    await act(() => {
      handleControlPlaneStreamPayload({
        kind: "decision-gate-resolved",
        gateId: "gate-demo-1",
        pendingDecisionGates: 0,
      });
    });
    expect(getPluginSlotSnapshot().pendingDecisionGateCount).toBe(0);

    // Switching tabs back to Plugins and closing works cleanly.
    await userEvent.click(modal.getByRole("button", { name: /Plugins & Egress Guard/i }));
    expect(getPluginSlotSnapshot().modalTab).toBe("plugins");
    await userEvent.keyboard("{Escape}");
    await expect.element(modal).not.toBeInTheDocument();
  });
});
