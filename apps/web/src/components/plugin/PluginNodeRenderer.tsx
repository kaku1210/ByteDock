import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type {
  CardKpiItem,
  JsonNode,
  SemanticSize,
  SemanticTone,
} from "@bytedock/plugin-ui-renderer/protocol";

import type { StreamLogHost, StreamLogSnapshot } from "./StreamLogHost";

export interface PluginActionEvent {
  readonly action: string;
  readonly ns?: string | undefined;
  readonly value?: string | number | boolean | undefined;
}

export interface PluginNodeRendererProps {
  readonly node: JsonNode;
  readonly translate?: ((key: string, args?: ReadonlyArray<unknown>) => string) | undefined;
  readonly onAction?: ((event: PluginActionEvent) => void) | undefined;
  readonly resolveStreamHost?: ((sinkId: string) => StreamLogHost | undefined) | undefined;
  readonly renderTerminal?: ((threadId: string, openOnMount: boolean) => ReactNode) | undefined;
}

const GAP_CLASSES: Readonly<Record<SemanticSize, string>> = {
  sm: "gap-1.5",
  md: "gap-3",
  lg: "gap-5",
};

const JUSTIFY_CLASSES = {
  start: "justify-start",
  between: "justify-between",
  center: "justify-center",
} as const;

const TEXT_SIZE_CLASSES: Readonly<Record<SemanticSize, string>> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base font-medium",
};

const TEXT_TONE_CLASSES: Readonly<Record<SemanticTone, string>> = {
  neutral: "text-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
};

const BADGE_TONE_CLASSES: Readonly<Record<SemanticTone, string>> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "bg-info/10 text-info border-info/20",
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning-surface text-warning border-warning/20",
  error: "bg-error-surface text-error border-error/20",
};

const PROGRESS_TONE_CLASSES: Readonly<Record<SemanticTone, string>> = {
  neutral: "bg-foreground/70",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
};

const KPI_GRID_CLASSES = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
} as const;

const EMPTY_SUBSCRIBE = () => () => {};

function defaultTranslate(key: string, args?: ReadonlyArray<unknown>): string {
  if (!args || args.length === 0) return key;
  return args.reduce<string>((acc, val, idx) => acc.replaceAll(`{${idx}}`, String(val)), key);
}

function StreamLogPrimitive({
  sinkId,
  host,
  translate,
}: {
  readonly sinkId: string;
  readonly host: StreamLogHost | undefined;
  readonly translate: (key: string, args?: ReadonlyArray<unknown>) => string;
}) {
  const emptySnapshot: StreamLogSnapshot = {
    sinkId,
    items: [],
    droppedOldest: 0,
    lastSeq: 0,
  };
  const snapshot = useSyncExternalStore(
    host ? host.subscribe : EMPTY_SUBSCRIBE,
    host ? host.getSnapshot : () => emptySnapshot,
    host ? host.getSnapshot : () => emptySnapshot,
  );

  return (
    <div
      data-plugin-primitive="StreamLog"
      data-sink-id={sinkId}
      className="flex max-h-64 flex-col gap-1 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs"
    >
      {snapshot.droppedOldest > 0 ? (
        <div
          data-plugin-stream-sentinel="dropped"
          className="rounded bg-warning-surface px-2 py-0.5 text-warning"
        >
          {translate("… {0} earlier entries truncated (ring capacity 4096)", [
            snapshot.droppedOldest,
          ])}
        </div>
      ) : null}
      {snapshot.items.map((entry) => (
        <div key={entry.id} className="whitespace-pre-wrap break-all">
          {entry.text ?? JSON.stringify(entry.record ?? {})}
        </div>
      ))}
    </div>
  );
}

function CardKpiGrid({
  items,
  columns,
  t,
}: {
  readonly items: ReadonlyArray<CardKpiItem>;
  readonly columns: 1 | 2 | 4;
  readonly t: (key: string, args?: ReadonlyArray<unknown>) => string;
}) {
  return (
    <div data-plugin-card-kpi="true" className={`grid gap-2.5 ${KPI_GRID_CLASSES[columns]}`}>
      {items.map((item) => {
        const tone = item.tone ?? "neutral";
        const pct =
          item.progressPct !== undefined ? Math.max(0, Math.min(100, item.progressPct)) : undefined;
        return (
          <div
            key={`${item.labelI18n}:${item.detailI18n ?? ""}`}
            data-plugin-kpi-item="true"
            className="flex flex-col gap-1.5 rounded-md border border-border/70 bg-background/60 p-2.5"
          >
            <span className="text-xs text-muted-foreground">{t(item.labelI18n)}</span>
            {item.value !== undefined ? (
              <span className={`text-lg font-semibold tabular-nums ${TEXT_TONE_CLASSES[tone]}`}>
                {String(item.value)}
              </span>
            ) : null}
            {pct !== undefined ? (
              <div
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={`h-full transition-all ${PROGRESS_TONE_CLASSES[tone]}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            ) : null}
            {item.detailI18n ? (
              <span className="text-xs text-muted-foreground">{t(item.detailI18n)}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function childNodeKey(child: JsonNode): string {
  if (child.k) return child.k;
  const discriminator =
    child.p.i18n ??
    child.p.labelI18n ??
    child.p.titleI18n ??
    child.p.sinkId ??
    child.p.terminalThreadId ??
    (child.p.on ? `${child.p.on.ns ?? ""}:${child.p.on.action}` : "");
  return `${child.t}:${discriminator}`;
}

/**
 * Host-owned declarative UI renderer for ByteDock plugins (ADR-09).
 * Closed 12-branch switch with static theme classes and zero className passthrough.
 */
export function PluginNodeRenderer({
  node,
  translate = defaultTranslate,
  onAction,
  resolveStreamHost,
  renderTerminal,
}: PluginNodeRendererProps): ReactNode {
  const renderChildren = () =>
    node.c?.map((child) => (
      <PluginNodeRenderer
        key={childNodeKey(child)}
        node={child}
        translate={translate}
        onAction={onAction}
        resolveStreamHost={resolveStreamHost}
        renderTerminal={renderTerminal}
      />
    ));

  switch (node.t) {
    case "Stack": {
      const gap = GAP_CLASSES[node.p.gap ?? "md"];
      return (
        <div data-plugin-primitive="Stack" className={`flex flex-col ${gap}`}>
          {renderChildren()}
        </div>
      );
    }

    case "Row": {
      const gap = GAP_CLASSES[node.p.gap ?? "sm"];
      const justify = JUSTIFY_CLASSES[node.p.justify ?? "start"];
      return (
        <div data-plugin-primitive="Row" className={`flex flex-row items-center ${gap} ${justify}`}>
          {renderChildren()}
        </div>
      );
    }

    case "Card": {
      const cols = node.p.kpiColumns ?? 2;
      return (
        <section
          data-plugin-primitive="Card"
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-xs"
        >
          {node.p.titleI18n ? (
            <h3 className="text-sm font-semibold tracking-tight">
              {translate(node.p.titleI18n, node.p.i18nArgs)}
            </h3>
          ) : null}
          {node.p.kpi && node.p.kpi.length > 0 ? (
            <CardKpiGrid items={node.p.kpi} columns={cols} t={translate} />
          ) : null}
          {renderChildren()}
        </section>
      );
    }

    case "Text": {
      const size = TEXT_SIZE_CLASSES[node.p.size ?? "md"];
      const tone = TEXT_TONE_CLASSES[node.p.tone ?? "neutral"];
      const label = node.p.i18n ? translate(node.p.i18n, node.p.i18nArgs) : "";
      return (
        <span data-plugin-primitive="Text" className={`${size} ${tone}`}>
          {label}
        </span>
      );
    }

    case "Badge": {
      const tone = BADGE_TONE_CLASSES[node.p.tone ?? "neutral"];
      const label = node.p.i18n ? translate(node.p.i18n, node.p.i18nArgs) : "";
      return (
        <span
          data-plugin-primitive="Badge"
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}
        >
          {label}
        </span>
      );
    }

    case "Tabs": {
      const activeValue = typeof node.p.value === "string" ? node.p.value : "";
      const options = node.p.options ?? [];
      return (
        <div data-plugin-primitive="Tabs" className="flex flex-col gap-2">
          <div
            role="tablist"
            className="inline-flex gap-1 rounded-md border border-border bg-muted p-0.5"
          >
            {options.map((opt) => {
              const selected = opt.value === activeValue;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() =>
                    node.p.on &&
                    onAction?.({ action: node.p.on.action, ns: node.p.on.ns, value: opt.value })
                  }
                  className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                    selected
                      ? "bg-background text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {translate(opt.labelI18n)}
                </button>
              );
            })}
          </div>
          {renderChildren()}
        </div>
      );
    }

    case "Button": {
      const label = node.p.labelI18n
        ? translate(node.p.labelI18n, node.p.i18nArgs)
        : node.p.i18n
          ? translate(node.p.i18n, node.p.i18nArgs)
          : "";
      return (
        <button
          type="button"
          data-plugin-primitive="Button"
          onClick={() => node.p.on && onAction?.({ action: node.p.on.action, ns: node.p.on.ns })}
          className="inline-flex items-center justify-center rounded-md border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80"
        >
          {label}
        </button>
      );
    }

    case "Toggle": {
      const checked = Boolean(node.p.value);
      const label = node.p.labelI18n ? translate(node.p.labelI18n, node.p.i18nArgs) : "";
      return (
        <label
          data-plugin-primitive="Toggle"
          className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium"
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) =>
              node.p.on &&
              onAction?.({
                action: node.p.on.action,
                ns: node.p.on.ns,
                value: e.target.checked,
              })
            }
            className="h-4 w-4 rounded border-border accent-primary"
          />
          <span>{label}</span>
        </label>
      );
    }

    case "Select": {
      const value = typeof node.p.value === "string" ? node.p.value : "";
      const options = node.p.options ?? [];
      return (
        <select
          data-plugin-primitive="Select"
          value={value}
          onChange={(e) =>
            node.p.on &&
            onAction?.({
              action: node.p.on.action,
              ns: node.p.on.ns,
              value: e.target.value,
            })
          }
          className="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {translate(opt.labelI18n)}
            </option>
          ))}
        </select>
      );
    }

    case "Progress": {
      const pct = Math.max(0, Math.min(100, Number(node.p.value ?? 0)));
      const tone = PROGRESS_TONE_CLASSES[node.p.tone ?? "info"];
      return (
        <div
          data-plugin-primitive="Progress"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div className={`h-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      );
    }

    case "StreamLog": {
      const sinkId = node.p.sinkId ?? "default";
      return (
        <StreamLogPrimitive
          sinkId={sinkId}
          host={resolveStreamHost?.(sinkId)}
          translate={translate}
        />
      );
    }

    case "TerminalView": {
      const threadId = node.p.terminalThreadId ?? "";
      const openOnMount = node.p.openOnMount ?? false;
      return (
        <div
          data-plugin-primitive="TerminalView"
          data-terminal-thread-id={threadId}
          className="overflow-hidden rounded-md border border-border bg-background"
        >
          {renderTerminal ? (
            renderTerminal(threadId, openOnMount)
          ) : (
            <div className="p-2 font-mono text-xs text-muted-foreground">
              {translate("TerminalView({0})", [threadId])}
            </div>
          )}
        </div>
      );
    }
  }
}
