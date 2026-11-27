import type { OrchestrationV2CommandOutputFrame } from "@t3tools/contracts";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";

/** One command row's output as a client holds it. */
export interface CommandOutputView {
  readonly output: TerminalOutputState;
  /** False once the command settled and `output` is final. */
  readonly running: boolean;
  /** Epoch milliseconds of the last frame that added or changed output text. */
  readonly lastOutputAtMs: number | null;
}

export const EMPTY_COMMAND_OUTPUT: CommandOutputView = {
  output: EMPTY_TERMINAL_OUTPUT,
  running: true,
  lastOutputAtMs: null,
};

/**
 * Applies one server frame. A `replace` carries the whole bounded tail (the
 * first frame, a viewer that fell behind, or the final output); an `append`
 * is raw terminal text normalized with the same rules the server uses.
 */
export function applyCommandOutputFrame(
  view: CommandOutputView,
  frame: OrchestrationV2CommandOutputFrame,
  nowMs: number,
): CommandOutputView {
  const base = frame.kind === "replace" ? EMPTY_TERMINAL_OUTPUT : view.output;
  const output = appendTerminalOutput(
    { ...base, truncated: base.truncated || frame.truncated },
    frame.text,
  );
  const hasNewOutput =
    frame.text.length > 0 &&
    (frame.kind === "append" || view.lastOutputAtMs === null || output.text !== view.output.text);
  return {
    output,
    running: frame.running,
    lastOutputAtMs: hasNewOutput ? nowMs : view.lastOutputAtMs,
  };
}

const ANSI_ESCAPE_PATTERN =
  /\u001b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/gu;

/** Last non-empty plain-text line from normalized command output, bounded for one-line previews. */
export function latestCommandOutputLine(text: string, maxLength = 140): string | null {
  let end = text.length;
  while (end > 0) {
    const newline = text.lastIndexOf("\n", end - 1);
    const cleaned = text
      .slice(newline + 1, end)
      .replace(ANSI_ESCAPE_PATTERN, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (cleaned.length > 0) {
      if (cleaned.length <= maxLength) return cleaned;
      return `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
    }
    end = newline;
  }
  return null;
}
