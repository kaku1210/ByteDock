import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { readAntigravityKeyringToken } from "./antigravityKeyring.ts";

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    readonly service: string;
    readonly username: string;

    constructor(service: string, username: string) {
      this.service = service;
      this.username = username;
    }

    async getPassword() {
      return this.service === "gemini" && this.username === "antigravity"
        ? '{"access_token":"fixture-token"}'
        : undefined;
    }
  },
}));

it.effect("reads the CLI's service and account on macOS and Linux", () =>
  Effect.gen(function* () {
    for (const platform of ["darwin", "linux"] as const) {
      const token = yield* readAntigravityKeyringToken().pipe(
        Effect.provideService(HostProcess.Platform, platform),
      );
      expect(token, platform).toBe('{"access_token":"fixture-token"}');
    }
  }),
);
