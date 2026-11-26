import { useEffect, useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import {
  AuthDiagnosticsReadScope,
  UsageDay,
  type ScopedThreadRef,
  type UsageBucket,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { useQuietThreadProjection } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useUiLanguage } from "../../i18n/useUiLanguage";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { Button } from "../ui/button";
import { useThreadDetailsPreferences } from "./threadDetailsPreferences";

const duration = (ms: number) =>
  `${Math.floor(ms / 3600000)}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const tokenCount = (bucket: UsageBucket) =>
  bucket.totals.uncachedInputTokens +
  bucket.totals.cachedInputTokens +
  bucket.totals.cacheCreationTokens +
  bucket.totals.outputTokens;

export function ThreadUsageSummary({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { text } = useUiLanguage();
  const thread = useQuietThreadProjection(threadRef);
  const [currentOnly, setCurrentOnly] = useState(false);
  const collapsed = useThreadDetailsPreferences((state) => state.usageCollapsed);
  const canRead = useEnvironmentScope(threadRef.environmentId, AuthDiagnosticsReadScope);
  if (!thread) return null;
  const projection = thread.projection;
  const latestRun = projection.runs.at(-1)?.id ?? null;
  const runId = currentOnly ? latestRun : null;
  const active = projection.runs.some((run) => run.startedAt !== null && run.completedAt === null);
  const revision = JSON.stringify(
    projection.providerTurns.map((turn) => [turn.id, turn.status, turn.turnTokenUsage]),
  );
  const input: UsageSummaryInput = {
    threadId: threadRef.threadId,
    ...(runId === null ? {} : { runId }),
    // Thread requests derive the complete time window on the server.
    sinceDay: UsageDay.make(DateTime.formatIso(projection.thread.createdAt).slice(0, 10)),
    untilDay: UsageDay.make(DateTime.formatIso(projection.thread.createdAt).slice(0, 10)),
    timeZone: "UTC",
    apiEquivalent: true,
  };
  return (
    <ThreadDetailsSection
      headingId="thread-session-usage"
      title={text("Thread usage")}
      collapsed={collapsed}
      onToggle={() => useThreadDetailsPreferences.getState().setUsageCollapsed(!collapsed)}
      actions={
        <Button size="xs" variant="ghost" onClick={() => setCurrentOnly(!currentOnly)}>
          {text(currentOnly ? "This turn" : "Entire thread")}
        </Button>
      }
    >
      <div className="space-y-2 px-2.5 text-xs" data-thread-usage>
        {collapsed ? null : canRead ? (
          <PricedThreadUsage
            environmentId={threadRef.environmentId}
            input={input}
            active={active}
            revision={revision}
          />
        ) : (
          <p className="text-muted-foreground">{text("Usage permission required")}</p>
        )}
      </div>
    </ThreadDetailsSection>
  );
}

function PricedThreadUsage({
  environmentId,
  input,
  active,
  revision,
}: {
  environmentId: ScopedThreadRef["environmentId"];
  input: UsageSummaryInput;
  active: boolean;
  revision: string;
}) {
  const { text } = useUiLanguage();
  const atom = serverEnvironment.usageSummary({ environmentId, input });
  const refresh = useAtomRefresh(atom);
  const result = useAtomValue(atom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidates server-owned usage on provider completion and while native logs are growing
  useEffect(() => {
    refresh();
    if (!active) return;
    const timer = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Final provider counters can arrive after completion and must invalidate the server summary.
  }, [refresh, active, revision]);
  const response = AsyncResult.getOrElse(result, () => null);
  // Older servers ignore unknown filters; never display their environment-wide total as this thread.
  const summary =
    response?.apiEquivalent === true &&
    response.threadUsage?.threadId === input.threadId &&
    response.threadUsage?.runId === (input.runId ?? null)
      ? response
      : null;
  if (!summary)
    return (
      <p className="text-muted-foreground">
        {text(result.waiting ? "Loading usage…" : "Thread usage unavailable on this server")}
      </p>
    );
  const stats = summary.threadUsage!;
  const groups = new Map<
    string,
    {
      model: string;
      provider: string;
      tokens: number;
      cost: number;
      missing: number;
      input: number;
      output: number;
      read: number;
      write: number;
      reasoning: number;
    }
  >();
  for (const bucket of summary.buckets) {
    const key = `${bucket.provider}:${bucket.model}`;
    const group = groups.get(key) ?? {
      model: bucket.model,
      provider: bucket.provider,
      tokens: 0,
      cost: 0,
      missing: 0,
      input: 0,
      output: 0,
      read: 0,
      write: 0,
      reasoning: 0,
    };
    group.tokens += tokenCount(bucket);
    group.cost += bucket.costUsd;
    group.missing += bucket.unpricedRecords;
    group.input += bucket.totals.uncachedInputTokens;
    group.output += bucket.totals.outputTokens;
    group.read += bucket.totals.cachedInputTokens;
    group.write += bucket.totals.cacheCreationTokens;
    group.reasoning += bucket.totals.reasoningTokens;
    groups.set(key, group);
  }
  const rows = [...groups.values()];
  const missing = rows.some((row) => row.missing > 0);
  const partial =
    missing ||
    summary.sources.some(
      (source) =>
        summary.sessionScopes?.some((scope) => scope.provider === source.fingerprint.provider) &&
        (source.status !== "ok" || source.refreshing),
    );
  const amount = rows.reduce((sum, row) => sum + row.cost, 0);
  return (
    <>
      <dl className="grid grid-cols-2 gap-2">
        <dt>{text("Recorded turn tokens")}</dt>
        <dd className="text-right tabular-nums">
          {stats.hasUsage
            ? `${stats.tokens.toLocaleString()}${stats.incomplete ? "+" : ""}`
            : text("Not provided")}
        </dd>
        <dt>{text("Running time")}</dt>
        <dd className="text-right tabular-nums">{duration(stats.runtimeMs)}</dd>
        <dt>{text("Thinking time (estimated)")}</dt>
        <dd className="text-right tabular-nums">
          {stats.reasoningMs === null ? text("Not provided") : duration(stats.reasoningMs)}
        </dd>
        {stats.waitingMs > 0 ? (
          <>
            <dt>{text("Waiting for input")}</dt>
            <dd className="text-right tabular-nums">{duration(stats.waitingMs)}</dd>
          </>
        ) : null}
      </dl>
      <dl className="grid grid-cols-2 gap-2">
        <dt>{text("Transcript tokens")}</dt>
        <dd className="text-right tabular-nums">
          {rows.length
            ? rows.reduce((sum, row) => sum + row.tokens, 0).toLocaleString()
            : text("Not provided")}
        </dd>
        <dt>{text("API equivalent (estimated)")}</dt>
        <dd className="text-right tabular-nums">
          {summary.buckets.some((bucket) => bucket.records > bucket.unpricedRecords)
            ? `$${amount.toFixed(4)}${partial ? "+" : ""}`
            : text("Not provided")}
        </dd>
      </dl>
      {missing ? (
        <p className="text-muted-foreground">
          {text("Some models have no price; total is incomplete")}
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer">{text("Usage by model")}</summary>
        <div className="space-y-3 py-2">
          {rows.map((row) => (
            <div key={`${row.provider}:${row.model}`} className="space-y-1">
              <div className="flex justify-between gap-2">
                <span className="break-all font-medium">{row.model}</span>
                <span>{row.missing ? text("Unpriced") : `$${row.cost.toFixed(4)}`}</span>
              </div>
              <div className="text-muted-foreground">
                {row.provider} · {row.tokens.toLocaleString()} tokens
              </div>
              <dl className="grid grid-cols-2 gap-x-2">
                {(
                  [
                    ["Input", row.input],
                    ["Output", row.output],
                    ["Cache read", row.read],
                    ["Cache write", row.write],
                    ["Reasoning tokens (included in output)", row.reasoning],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt>{text(String(label))}</dt>
                    <dd className="text-right tabular-nums">{value.toLocaleString()}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <p className="text-muted-foreground">
            {text(
              "API value is not a bill. Based on attributable transcript records; each record keeps its first available price. May include native subagent work.",
            )}
          </p>
          <p className="break-all text-muted-foreground">
            {text("Price source")}: {summary.pricing.source} · {text(summary.pricing.status)}
          </p>
        </div>
      </details>
    </>
  );
}
