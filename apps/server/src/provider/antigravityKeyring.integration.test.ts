import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readWindowsKeyringToken } from "./antigravityKeyring.ts";

it.effect("preserves an existing Windows credential when opening it for quota reads", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-quota-keyring-" });
    const { AsyncEntry } = yield* Effect.promise(() => import("@napi-rs/keyring"));
    const service = "t3-antigravity-quota-test";
    const account = path.basename(directory);
    const target = `${account}.${service}`;
    const original = new AsyncEntry(service, account);
    const payload = Buffer.from('{"access_token":"fixture-token"}', "utf8");
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => original.deleteCredential()).pipe(Effect.asVoid),
    );
    yield* Effect.promise(() => original.setSecret(payload));

    for (let read = 0; read < 2; read++) {
      expect(yield* readWindowsKeyringToken(target)).toBe(payload.toString("utf8"));
    }
    expect(yield* readWindowsKeyringToken(`${target}-missing`)).toBeUndefined();
    const preserved = yield* Effect.promise(() => original.getSecret());
    expect(preserved && Buffer.from(preserved)).toEqual(payload);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
