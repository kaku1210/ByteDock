import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

class RendererExitError extends Schema.TaggedError<RendererExitError>()("RendererExitError", {
  cause: Schema.Defect(),
}) {}

/** The renderer journals pending deletions before awaiting any environment. */
export const prepareRendererExit = Effect.fn("desktop.window.prepareRendererExit")(function (
  window: Pick<Electron.BrowserWindow, "isDestroyed" | "webContents">,
) {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return Effect.void;
  return Effect.tryPromise({
    try: () =>
      window.webContents.executeJavaScript(`
    new Promise(resolve => {
      const event = new CustomEvent("t3:prepare-exit", { detail: resolve, cancelable: true });
      if (window.dispatchEvent(event)) resolve();
    })
  `),
    catch: (cause) => new RendererExitError({ cause }),
  }).pipe(
    Effect.timeout("3 seconds"),
    Effect.catchCause((cause) =>
      Effect.logWarning("Renderer exit cleanup deferred to next launch", { cause }),
    ),
    Effect.asVoid,
  );
});
