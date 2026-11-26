import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWindowsDefenderExclusions from "./DesktopWindowsDefenderExclusions.ts";

const makeEnvironment = (
  path: Path.Path,
  input: {
    readonly platform: NodeJS.Platform;
    readonly isPackaged: boolean;
    readonly baseDir: string;
    readonly stateDir: string;
  },
) =>
  DesktopEnvironment.DesktopEnvironment.of({
    path,
    platform: input.platform,
    isPackaged: input.isPackaged,
    baseDir: input.baseDir,
    stateDir: input.stateDir,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const encodeProbe = (payload: {
  readonly realTimeProtectionEnabled: boolean | null;
  readonly canReadExclusions: boolean;
  readonly excludedPaths: readonly string[];
}) => Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

const makeFakeDefenderSpawner = (options: {
  probe: () => {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  };
  apply?: (input: {
    readonly fs: FileSystem.FileSystem;
    readonly inputPath: string;
    readonly resultPath: string;
  }) => Effect.Effect<
    { readonly exitCode: number; readonly stderr?: string },
    PlatformError.PlatformError
  >;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const calls = { probe: 0, apply: 0 };
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const { options: cmdOptions } = command as unknown as {
          readonly options: { readonly env?: Record<string, string> };
        };
        const cmdEnv = cmdOptions.env ?? {};
        let exitCode = 0;
        let stdout = "";
        let stderr = "";

        if (cmdEnv.T3_DEFENDER_INPUT && cmdEnv.T3_DEFENDER_RESULT) {
          calls.apply += 1;
          if (options.apply) {
            const res = yield* options
              .apply({
                fs,
                inputPath: cmdEnv.T3_DEFENDER_INPUT,
                resultPath: cmdEnv.T3_DEFENDER_RESULT,
              })
              .pipe(Effect.orDie);
            exitCode = res.exitCode;
            stderr = res.stderr ?? "";
          }
        } else {
          calls.probe += 1;
          const res = options.probe();
          exitCode = res.exitCode ?? 0;
          stdout = res.stdout ?? "";
          stderr = res.stderr ?? "";
        }

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.make(new TextEncoder().encode(stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    return { calls, spawner };
  });

const makeService = (input: {
  readonly platform?: NodeJS.Platform;
  readonly isPackaged?: boolean;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly executablePath?: string;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* DesktopWindowsDefenderExclusions.make.pipe(
      Effect.provideService(
        DesktopEnvironment.DesktopEnvironment,
        makeEnvironment(path, {
          platform: input.platform ?? "win32",
          isPackaged: input.isPackaged ?? true,
          baseDir: input.baseDir,
          stateDir: input.stateDir,
        }),
      ),
      Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
      Effect.provideService(
        HostProcess.ExecutablePath,
        input.executablePath ?? "D:\\AI Program Files\\T3 Code Plus\\T3 Code Plus.exe",
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    );
  });

it.layer(NodeServices.layer)("DesktopWindowsDefenderExclusions", (it) => {
  it("resolves dynamic Windows target folders and matches parent exclusions case-insensitively", () => {
    const packagedTargets = DesktopWindowsDefenderExclusions.resolveWindowsDefenderTargetEntries({
      platform: "win32",
      isPackaged: true,
      baseDir: "C:\\Users\\demo\\.t3-plus",
      stateDir: "C:\\Users\\demo\\.t3-plus\\userdata",
      executablePath: "D:\\AI Program Files\\T3 Code Plus\\T3 Code Plus.exe",
    });
    expect(packagedTargets).toEqual([
      { kind: "antigravity-tools", path: "C:\\Users\\demo\\.t3-plus\\tools\\antigravity-acp" },
      { kind: "antigravity-temp", path: "C:\\Users\\demo\\.t3-plus\\userdata\\antigravity-tmp" },
      { kind: "app-install", path: "D:\\AI Program Files\\T3 Code Plus" },
    ]);

    const devTargets = DesktopWindowsDefenderExclusions.resolveWindowsDefenderTargetEntries({
      platform: "win32",
      isPackaged: false,
      baseDir: "C:\\Users\\demo\\.t3-plus",
      stateDir: "C:\\Users\\demo\\.t3-plus\\userdata-dev",
      executablePath: "C:\\repo\\node_modules\\electron\\dist\\electron.exe",
    });
    expect(devTargets.map((entry) => entry.kind)).toEqual([
      "antigravity-tools",
      "antigravity-temp",
    ]);

    expect(
      DesktopWindowsDefenderExclusions.resolveWindowsDefenderTargetEntries({
        platform: "darwin",
        isPackaged: true,
        baseDir: "/Users/demo/.t3",
        stateDir: "/Users/demo/.t3/userdata",
        executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
      }),
    ).toEqual([]);

    expect(
      DesktopWindowsDefenderExclusions.isWindowsPathExcluded(
        "C:\\Users\\Demo\\.t3-plus\\tools\\antigravity-acp",
        ["N/A: Must be an administrator to view exclusions", "c:\\users\\demo\\.t3-plus\\"],
      ),
    ).toBe(true);

    expect(
      DesktopWindowsDefenderExclusions.isWindowsPathExcluded("D:\\AI Program Files\\T3 Code Plus", [
        "D:\\AI Program Files\\T3 Code Plus2",
      ]),
    ).toBe(false);

    expect(
      DesktopWindowsDefenderExclusions.buildManualPowerShellCommand([
        "C:\\Users\\O'Brien\\.t3-plus\\tools\\antigravity-acp",
        "D:\\AI Program Files\\T3 Code Plus",
      ]),
    ).toBe(
      "Add-MpPreference -ExclusionPath @('C:\\Users\\O''Brien\\.t3-plus\\tools\\antigravity-acp', 'D:\\AI Program Files\\T3 Code Plus')",
    );
  });

  it.effect("returns unsupported on non-Windows platforms without spawning PowerShell", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-def-macos-" });
      const { calls, spawner } = yield* makeFakeDefenderSpawner({
        probe: () => ({ stdout: "" }),
      });

      const service = yield* makeService({
        platform: "darwin",
        baseDir,
        stateDir: path.join(baseDir, "userdata"),
        spawner,
      });

      const current = yield* service.state;
      expect(current).toEqual({
        supported: false,
        realTimeProtectionEnabled: null,
        verificationSource: "unsupported",
        allExcluded: false,
        entries: [],
        manualCommand: null,
        promptDismissed: false,
        lastVerifiedAt: null,
      });
      expect(calls.probe).toBe(0);
    }),
  );

  it.effect(
    "applies via elevated script, verifies exclusions, and falls back to verified cache on non-admin reads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-def-apply-" });
        const stateDir = path.join(baseDir, "userdata");
        yield* fs.makeDirectory(stateDir, { recursive: true });

        const capturedPaths: string[] = [];
        const { calls, spawner } = yield* makeFakeDefenderSpawner({
          // Non-admin Windows 11 probe: RTP is readable, ExclusionPath is blocked.
          probe: () => ({
            stdout: encodeProbe({
              realTimeProtectionEnabled: true,
              canReadExclusions: false,
              excludedPaths: [],
            }),
          }),
          apply: ({ fs: innerFs, inputPath, resultPath }) =>
            Effect.gen(function* () {
              const raw = yield* innerFs.readFileString(inputPath);
              const parsed = JSON.parse(raw) as { paths: string[] };
              capturedPaths.push(...parsed.paths);
              yield* innerFs.writeFileString(
                resultPath,
                JSON.stringify({
                  ok: true,
                  excludedPaths: parsed.paths,
                  error: null,
                }),
              );
              return { exitCode: 0 };
            }),
        });

        const service = yield* makeService({
          platform: "win32",
          isPackaged: true,
          baseDir,
          stateDir,
          executablePath: "D:\\AI Program Files\\T3 Code Plus\\T3 Code Plus.exe",
          spawner,
        });

        const initial = yield* service.state;
        expect(initial.supported).toBe(true);
        expect(initial.realTimeProtectionEnabled).toBe(true);
        expect(initial.verificationSource).toBe("unverified");
        expect(initial.allExcluded).toBe(false);
        expect(initial.entries.length).toBe(3);
        expect(initial.entries.every((entry) => !entry.excluded)).toBe(true);

        const applied = yield* service.apply;
        expect(calls.apply).toBe(1);
        expect(capturedPaths.length).toBe(3);
        expect(applied.allExcluded).toBe(true);
        expect(applied.verificationSource).toBe("live");
        expect(applied.entries.every((entry) => entry.excluded)).toBe(true);
        expect(applied.lastVerifiedAt).not.toBeNull();

        // Subsequent non-admin state read uses the persisted verified cache.
        const reloaded = yield* service.state;
        expect(reloaded.allExcluded).toBe(true);
        expect(reloaded.verificationSource).toBe("verified-cache");
        expect(reloaded.entries.every((entry) => entry.excluded)).toBe(true);
      }),
  );

  it.effect("surfaces a clear error when UAC elevation is cancelled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-def-uac-" });
      const stateDir = path.join(baseDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });

      const { spawner } = yield* makeFakeDefenderSpawner({
        probe: () => ({
          stdout: encodeProbe({
            realTimeProtectionEnabled: true,
            canReadExclusions: false,
            excludedPaths: [],
          }),
        }),
        apply: () => Effect.succeed({ exitCode: 1223, stderr: "T3_UAC_CANCELLED\n" }),
      });

      const service = yield* makeService({
        platform: "win32",
        baseDir,
        stateDir,
        spawner,
      });

      const exit = yield* Effect.exit(service.apply);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toContain("Administrator permission was cancelled.");
      }
    }),
  );

  it.effect(
    "persists prompt dismissal for current missing paths and re-prompts if the install path changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-def-dismiss-" });
        const stateDir = path.join(baseDir, "userdata");
        yield* fs.makeDirectory(stateDir, { recursive: true });

        const { spawner } = yield* makeFakeDefenderSpawner({
          probe: () => ({
            stdout: encodeProbe({
              realTimeProtectionEnabled: true,
              canReadExclusions: false,
              excludedPaths: [],
            }),
          }),
        });

        const serviceA = yield* makeService({
          platform: "win32",
          isPackaged: true,
          baseDir,
          stateDir,
          executablePath: "D:\\Apps\\T3-v1\\T3 Code Plus.exe",
          spawner,
        });

        expect((yield* serviceA.state).promptDismissed).toBe(false);
        const afterDismiss = yield* serviceA.dismissPrompt;
        expect(afterDismiss.promptDismissed).toBe(true);
        expect((yield* serviceA.state).promptDismissed).toBe(true);

        // Moving the app to a new install directory introduces a new missing path.
        const serviceB = yield* makeService({
          platform: "win32",
          isPackaged: true,
          baseDir,
          stateDir,
          executablePath: "D:\\Apps\\T3-v2\\T3 Code Plus.exe",
          spawner,
        });
        expect((yield* serviceB.state).promptDismissed).toBe(false);
      }),
  );
});
