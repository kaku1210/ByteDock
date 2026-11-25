import { decodeOptions } from "gt-react";
import { describe, expect, it } from "vite-plus/test";

import type { MessageResolver } from "../i18n/messages";
import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("keeps the same action IDs and targets across languages", () => {
    const zhMap: Record<string, string> = {
      "Un-settle thread": "取消收起会话",
      "Custom…": "自定义…",
    };
    const labels = buildThreadActionMenuItems({ ...baseState, isSettled: true }, ((
      message: unknown,
    ) => {
      const source =
        typeof message === "string"
          ? (decodeOptions(message)?.$_source ?? message)
          : String(message);
      return zhMap[String(source)] ?? String(source);
    }) as MessageResolver);
    const original = buildThreadActionMenuItems({ ...baseState, isSettled: true });
    expect(labels.map(({ id }) => id)).toEqual(original.map(({ id }) => id));
    expect(labels.find(({ id }) => id === "unsettle")?.label).toBe("取消收起会话");
    expect(
      labels.find(({ id }) => id === "snooze")?.children?.find(({ id }) => id === "snooze:custom")
        ?.label,
    ).toBe("自定义…");
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
      moveToProjectTargets: [{ projectId: "project-a" as never, label: "Project A" }],
      canMoveToNoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "move-to-project")?.disabled).toBe(true);
    expect(
      items
        .find((item) => item.id === "move-to-project")
        ?.children?.every((child) => child.disabled),
    ).toBe(true);
    expect(items.find((item) => item.id === "move-to-no-project")?.disabled).toBe(true);
  });

  it("includes move-to-project submenu and move-to-no-project action when enabled", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      moveToProjectTargets: [
        { projectId: "project-a" as never, label: "Project A" },
        { projectId: "project-b" as never, label: "Project B" },
      ],
      canMoveToNoProject: true,
    });
    const moveToProject = items.find((item) => item.id === "move-to-project");
    expect(moveToProject).toMatchObject({
      id: "move-to-project",
      label: "Move to project",
      icon: "folder-input",
      disabled: false,
      children: [
        { id: "move-to-project:project-a", label: "Project A", disabled: false },
        { id: "move-to-project:project-b", label: "Project B", disabled: false },
      ],
    });
    expect(items.find((item) => item.id === "move-to-no-project")).toMatchObject({
      id: "move-to-no-project",
      label: "Move to No project",
      icon: "folder-output",
      disabled: false,
    });
  });

  it("disables move actions when the user cannot operate", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      moveWithinFamilyTargets: [{ projectId: "child-a" as never, label: "Child A" }],
      moveToProjectTargets: [{ projectId: "project-a" as never, label: "Project A" }],
      canMoveToNoProject: true,
    });
    expect(items.find((item) => item.id === "move-within-family")?.disabled).toBe(true);
    expect(
      items
        .find((item) => item.id === "move-within-family")
        ?.children?.every((child) => child.disabled),
    ).toBe(true);
    expect(items.find((item) => item.id === "move-to-project")?.disabled).toBe(true);
    expect(
      items
        .find((item) => item.id === "move-to-project")
        ?.children?.every((child) => child.disabled),
    ).toBe(true);
    expect(items.find((item) => item.id === "move-to-no-project")?.disabled).toBe(true);
  });

  it("keeps move-within-family enabled even while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      moveWithinFamilyTargets: [
        { projectId: "parent-game" as never, label: "Game", isParent: true },
        { projectId: "child-client" as never, label: "Client" },
      ],
      moveToProjectTargets: [{ projectId: "project-other" as never, label: "Other" }],
    });
    const moveWithinFamily = items.find((item) => item.id === "move-within-family");
    expect(moveWithinFamily).toMatchObject({
      id: "move-within-family",
      label: "Move to…",
      icon: "folder-input",
      children: [
        { id: "move-within-family:parent-game", label: "Game", icon: "folder-tree" },
        { id: "move-within-family:child-client", label: "Client", icon: "folder" },
      ],
    });
    expect(moveWithinFamily?.disabled).not.toBe(true);
    expect(moveWithinFamily?.children?.every((child) => child.disabled !== true)).toBe(true);
    expect(items.find((item) => item.id === "move-to-project")?.disabled).toBe(true);
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });
});
