import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { FROZEN_PRIMITIVE_NAMES, type JsonNode } from "@bytedock/plugin-ui-renderer/protocol";

import { PluginNodeRenderer } from "./PluginNodeRenderer";
import { StreamLogHost } from "./StreamLogHost";

/**
 * W1-4 No-Go Meltdown Probe #2 (ADR-09):
 * Proves that the frozen 12 host-owned primitives (specifically Card.kpi + 1/2/4-col grid +
 * Progress + StreamLog 4096 ring buffer) cleanly express a real 4-card KPI `plugin-usage-hub`
 * dashboard without arbitrary className passthrough or Tailwind @source breaches.
 */
describe("W1-4 Probe #2: Host-owned 12 primitives & Card.kpi dashboard", () => {
  it("renders a 4-card KPI plugin-usage-hub dashboard cleanly via Card.kpi and static Tailwind classes", () => {
    const dictionary: Record<string, string> = {
      "usage.title": "Token & Quota Hub",
      "usage.claude": "Claude 5h Window",
      "usage.codex": "Codex Daily Quota",
      "usage.cacheHit": "Prompt Cache Hit",
      "usage.blocked": "Telemetry Blocked",
      "usage.detail.ok": "Healthy",
      "usage.detail.warn": "Approaching limit",
      "usage.refresh": "Refresh Quota",
    };

    const dashboardTree: JsonNode = {
      t: "Stack",
      p: { gap: "md" },
      c: [
        {
          t: "Card",
          p: {
            titleI18n: "usage.title",
            kpiColumns: 4,
            kpi: [
              {
                labelI18n: "usage.claude",
                value: "38%",
                progressPct: 38,
                tone: "success",
                detailI18n: "usage.detail.ok",
              },
              {
                labelI18n: "usage.codex",
                value: "82%",
                progressPct: 82,
                tone: "warning",
                detailI18n: "usage.detail.warn",
              },
              { labelI18n: "usage.cacheHit", value: "94.2%", progressPct: 94.2, tone: "info" },
              { labelI18n: "usage.blocked", value: 0, tone: "success" },
            ],
          },
          c: [
            {
              t: "Row",
              p: { justify: "between", gap: "sm" },
              c: [
                { t: "Badge", p: { i18n: "usage.detail.ok", tone: "success" } },
                { t: "Button", p: { labelI18n: "usage.refresh", on: { action: "refresh" } } },
              ],
            },
          ],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <PluginNodeRenderer node={dashboardTree} translate={(key) => dictionary[key] ?? key} />,
    );

    expect(html).toContain("Token &amp; Quota Hub");
    expect(html).toContain('data-plugin-card-kpi="true"');
    expect(html).toContain("lg:grid-cols-4");
    expect(html).toContain("Claude 5h Window");
    expect(html).toContain("38%");
    expect(html).toContain("Codex Daily Quota");
    expect(html).toContain("82%");
    expect(html).toContain("Prompt Cache Hit");
    expect(html).toContain("94.2%");
    expect(html).toContain("Telemetry Blocked");
    expect(html).toContain("Refresh Quota");
    expect((html.match(/data-plugin-kpi-item="true"/g) ?? []).length).toBe(4);
  });

  it("renders all 12 frozen primitives exhaustively without error", () => {
    const host = new StreamLogHost("egress-log");
    host.pushFrame({
      sinkId: "egress-log",
      seq: 1,
      chunks: [{ ts: 1, text: "[DENY] us.i.posthog.com" }],
    });

    const allPrimitives: JsonNode = {
      t: "Stack",
      p: { gap: "sm" },
      c: [
        {
          t: "Row",
          p: { gap: "sm" },
          c: [
            { t: "Text", p: { i18n: "hello" } },
            { t: "Badge", p: { i18n: "ok", tone: "info" } },
          ],
        },
        { t: "Card", p: { titleI18n: "card" } },
        { t: "Tabs", p: { value: "a", options: [{ value: "a", labelI18n: "tab.a" }] } },
        { t: "Button", p: { labelI18n: "btn" } },
        { t: "Toggle", p: { labelI18n: "tog", value: true } },
        { t: "Select", p: { value: "x", options: [{ value: "x", labelI18n: "opt.x" }] } },
        { t: "Progress", p: { value: 65, tone: "info" } },
        { t: "StreamLog", p: { sinkId: "egress-log" } },
        { t: "TerminalView", p: { terminalThreadId: "thread-1", openOnMount: false } },
      ],
    };

    const html = renderToStaticMarkup(
      <PluginNodeRenderer
        node={allPrimitives}
        resolveStreamHost={(id) => (id === "egress-log" ? host : undefined)}
      />,
    );

    for (const primitive of FROZEN_PRIMITIVE_NAMES) {
      expect(html).toContain(`data-plugin-primitive="${primitive}"`);
    }
    expect(html).toContain("[DENY] us.i.posthog.com");
    host.dispose();
  });

  it("enforces StreamLogHost 4096 ring buffer FIFO eviction and tracks droppedOldest sentinel", () => {
    const host = new StreamLogHost("audit-stream");
    const batch = Array.from({ length: 5000 }, (_, i) => ({
      ts: i + 1,
      text: `line-${i + 1}`,
    }));
    host.pushFrame({ sinkId: "audit-stream", seq: 1, chunks: batch });

    const snap = host.getSnapshot();
    expect(snap.items.length).toBe(4096);
    expect(snap.droppedOldest).toBe(904);
    expect(snap.items[0]?.text).toBe("line-905");
    expect(snap.items[4095]?.text).toBe("line-5000");

    const html = renderToStaticMarkup(
      <PluginNodeRenderer
        node={{ t: "StreamLog", p: { sinkId: "audit-stream" } }}
        resolveStreamHost={() => host}
      />,
    );
    expect(html).toContain('data-plugin-stream-sentinel="dropped"');
    expect(html).toContain("904 earlier entries truncated");
    host.dispose();
  });
});
