import { toServerClock } from "@t3tools/client-runtime/clock";
import {
  latestCommandOutputLine,
  type CommandOutputView,
} from "@t3tools/client-runtime/state/command-output";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { useGT, useMessages } from "gt-react";

import { tickTextContent } from "~/lib/tickTextContent";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useCommandOutputStreaming } from "./CommandOutputPanel";
import type { TurnItemSource } from "./timelineRowContext";

const SILENCE_NOTICE_THRESHOLD_MS = 15_000;

/**
 * One-line live activity summary for a running background command: shows the
 * latest output line and, once output has been silent for at least 15s, ticks
 * the silence duration via DOM mutation so it never re-renders the composer.
 */
export function BackgroundCommandActivity(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly startedAtMs: number | null;
  readonly source?: TurnItemSource["commandOutput"] | undefined;
}) {
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  if (!streamsOutput && !props.source) return null;
  return <BackgroundCommandActivityLive {...props} />;
}

function BackgroundCommandActivityLive(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly startedAtMs: number | null;
  readonly source?: TurnItemSource["commandOutput"] | undefined;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const input = { threadId: props.threadId, itemId: props.itemId };
  const { data, error } = useEnvironmentQuery<CommandOutputView, unknown>(
    props.source
      ? props.source(input)
      : orchestrationEnvironment.v2.commandOutput({ environmentId: props.environmentId, input }),
  );
  if (error) return null;

  const latestLine = latestCommandOutputLine(data?.output.text ?? "");
  const running = data?.running ?? true;
  const lastOutputAtMs = data?.lastOutputAtMs ?? null;
  const quietSinceMs = lastOutputAtMs ?? props.startedAtMs;
  const usingServerClock = lastOutputAtMs === null;
  const currentTimeMs = (nowMs: number) =>
    usingServerClock ? toServerClock(props.environmentId, nowMs) : nowMs;

  if (latestLine !== null) {
    return (
      <>
        <span className="font-mono">{latestLine}</span>
        {quietSinceMs !== null && running ? (
          <span
            ref={tickTextContent((nowMs) => {
              const quietMs = currentTimeMs(nowMs) - quietSinceMs;
              if (quietMs < SILENCE_NOTICE_THRESHOLD_MS) return "";
              return ` · ${gt("no new output for {duration}", {
                duration: formatDuration(quietMs, resolve),
                $context: "shown after a running command's latest output line when it is quiet",
              })}`;
            }, true)}
            className="tabular-nums"
          />
        ) : null}
      </>
    );
  }

  if (quietSinceMs === null || !running) return null;
  return (
    <span
      ref={tickTextContent((nowMs) => {
        const quietMs = currentTimeMs(nowMs) - quietSinceMs;
        if (quietMs < SILENCE_NOTICE_THRESHOLD_MS) return "";
        return gt("No output for {duration}", {
          duration: formatDuration(quietMs, resolve),
          $context: "shown for a running background command that has not produced output yet",
        });
      }, true)}
      className="tabular-nums"
    />
  );
}
