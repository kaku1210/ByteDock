import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

export const readWindowsKeyringToken = Effect.fn("AntigravityKeyring.readWindowsToken")(function* (
  target: string,
) {
  return yield* Effect.promise(async () => {
    const { open, close, load, DataType } = await import("ffi-rs");
    const credentials = "t3-antigravity-credentials";
    const memory = "t3-antigravity-credential-memory";
    open({ library: credentials, path: "advapi32.dll" });
    try {
      open({ library: memory, path: "ntdll.dll" });
      try {
        const out = Buffer.alloc(8);
        const found = load({
          library: credentials,
          funcName: "CredReadW",
          retType: DataType.Boolean,
          paramsType: [DataType.U8Array, DataType.U32, DataType.U32, DataType.U8Array],
          paramsValue: [Buffer.from(`${target}\0`, "utf16le"), 1, 0, out],
        });
        if (!found) return undefined;
        const pointer = out.readBigUInt64LE();
        const copy = (address: bigint, size: number) => {
          const buffer = Buffer.alloc(size);
          load({
            library: memory,
            funcName: "RtlMoveMemory",
            retType: DataType.Void,
            paramsType: [DataType.U8Array, DataType.BigInt, DataType.U64],
            paramsValue: [buffer, address, size],
          });
          return buffer;
        };
        try {
          // CREDENTIALW has the same 64-bit layout on Windows x64 and ARM64.
          const header = copy(pointer, 80);
          const size = header.readUInt32LE(32);
          return size ? copy(header.readBigUInt64LE(40), size).toString("utf8") : undefined;
        } finally {
          load({
            library: credentials,
            funcName: "CredFree",
            retType: DataType.Void,
            paramsType: [DataType.BigInt],
            paramsValue: [pointer],
          });
        }
      } finally {
        close(memory);
      }
    } finally {
      close(credentials);
    }
  });
});

export const readAntigravityKeyringToken = Effect.fn("AntigravityKeyring.readToken")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") {
    // @napi-rs/keyring.withTarget writes an empty credential before reading it on Windows.
    return yield* readWindowsKeyringToken("gemini:antigravity").pipe(
      Effect.catchCause(() => Effect.undefined),
    );
  }
  return yield* Effect.promise(async () => {
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return (await new AsyncEntry("gemini", "antigravity").getPassword()) || undefined;
    } catch {
      return undefined;
    }
  });
});
