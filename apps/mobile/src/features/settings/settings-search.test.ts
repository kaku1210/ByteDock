import { describe, expect, it } from "vite-plus/test";

import { filterSettingsSections } from "./settings-search";

const SECTIONS = [
  { rows: [{ id: "usage", label: "Usage" }] },
  {
    title: "Connections",
    rows: [
      { id: "account", label: "T3 Account" },
      { id: "SettingsEnvironments", label: "Environments" },
    ],
  },
  {
    title: "Interface",
    rows: [
      { id: "SettingsAppearance", label: "Appearance" },
      { id: "SettingsKeyboard", label: "Keyboard" },
      { id: "SettingsVoice", label: "Voice" },
    ],
  },
  {
    title: "Server settings",
    rows: [
      { id: "SettingsProviderAccounts", label: "Provider accounts" },
      { id: "SettingsEnvironmentSourceControl", label: "Source control & issues" },
    ],
  },
];

function visible(query: string) {
  return filterSettingsSections(SECTIONS, query).map((section) => [
    section.title ?? null,
    section.rows.map((row) => row.label),
  ]);
}

describe("filterSettingsSections", () => {
  it.each([
    {
      query: "",
      expected: SECTIONS.map((section) => [
        section.title ?? null,
        section.rows.map((row) => row.label),
      ]),
    },
    { query: "   ", expected: visible("") },
    { query: "appear", expected: [["Interface", ["Appearance"]]] },
    { query: "KEYBOARD", expected: [["Interface", ["Keyboard"]]] },
    { query: "dark mode", expected: [["Interface", ["Appearance"]]] },
    { query: "microphone", expected: [["Interface", ["Voice"]]] },
    { query: "agent credits", expected: [["Server settings", ["Source control & issues"]]] },
    {
      query: "server settings",
      expected: [["Server settings", ["Provider accounts", "Source control & issues"]]],
    },
    {
      query: "accounts",
      expected: [["Server settings", ["Provider accounts"]]],
    },
    { query: "usage", expected: [[null, ["Usage"]]] },
    { query: "zzzz", expected: [] },
  ])("$query", ({ query, expected }) => {
    expect(visible(query)).toEqual(expected);
  });

  it("drops sections that start empty", () => {
    expect(filterSettingsSections([{ rows: [] }, ...SECTIONS], "").length).toBe(SECTIONS.length);
  });

  it("finds translated page labels and the suggestion settings while preserving row identities", () => {
    const zhMap: Record<string, string> = {
      Appearance: "外观",
      "next prompt suggestions": "下一步建议",
      "input placeholder": "输入框提示文案",
    };
    const resolveZh = ((message: string) => zhMap[message] ?? message) as Parameters<
      typeof filterSettingsSections
    >[2];
    const appearanceSection = {
      rows: [{ id: "SettingsAppearance", label: "外观" }],
    };
    expect(
      filterSettingsSections([appearanceSection], "外观", resolveZh)
        .flatMap((section) => section.rows)
        .map((row) => row.id),
    ).toEqual(["SettingsAppearance"]);
    const chat = { rows: [{ id: "SettingsFollowUp", label: "Chat" }] };
    expect(filterSettingsSections([chat], "next prompt suggestions")).toEqual([chat]);
    expect(filterSettingsSections([chat], "input placeholder")).toEqual([chat]);
  });
});
