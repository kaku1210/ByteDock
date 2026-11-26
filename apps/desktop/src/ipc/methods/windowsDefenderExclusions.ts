import { DesktopWindowsDefenderExclusionsStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWindowsDefenderExclusions from "../../app/DesktopWindowsDefenderExclusions.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getWindowsDefenderExclusionsState = makeIpcMethod({
  channel: IpcChannels.WINDOWS_DEFENDER_EXCLUSIONS_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowsDefenderExclusionsStateSchema,
  handler: Effect.fn("desktop.ipc.windowsDefenderExclusions.getState")(function* () {
    return yield* (yield* DesktopWindowsDefenderExclusions.DesktopWindowsDefenderExclusions).state;
  }),
});

export const applyWindowsDefenderExclusions = makeIpcMethod({
  channel: IpcChannels.WINDOWS_DEFENDER_EXCLUSIONS_APPLY_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowsDefenderExclusionsStateSchema,
  handler: Effect.fn("desktop.ipc.windowsDefenderExclusions.apply")(function* () {
    return yield* (yield* DesktopWindowsDefenderExclusions.DesktopWindowsDefenderExclusions).apply;
  }),
});

export const dismissWindowsDefenderExclusionsPrompt = makeIpcMethod({
  channel: IpcChannels.WINDOWS_DEFENDER_EXCLUSIONS_DISMISS_PROMPT_CHANNEL,
  payload: Schema.Void,
  result: DesktopWindowsDefenderExclusionsStateSchema,
  handler: Effect.fn("desktop.ipc.windowsDefenderExclusions.dismissPrompt")(function* () {
    return yield* (yield* DesktopWindowsDefenderExclusions.DesktopWindowsDefenderExclusions)
      .dismissPrompt;
  }),
});
