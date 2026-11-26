import type {
  DesktopWindowsDefenderExclusionEntry,
  DesktopWindowsDefenderExclusionKind,
  DesktopWindowsDefenderExclusionsState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-windows-defender-exclusions");

const PROBE_TIMEOUT = Duration.seconds(10);
const APPLY_TIMEOUT = Duration.seconds(120);
const STATE_FILE_NAME = "windows-defender-exclusions.json";

export class DesktopWindowsDefenderExclusionsError extends Schema.TaggedError<DesktopWindowsDefenderExclusionsError>()(
  "DesktopWindowsDefenderExclusionsError",
  { message: Schema.String },
) {}

export interface WindowsDefenderTargetEntry {
  readonly kind: DesktopWindowsDefenderExclusionKind;
  readonly path: string;
}

export interface WindowsDefenderProbeResult {
  readonly realTimeProtectionEnabled: boolean | null;
  readonly canReadExclusions: boolean;
  readonly excludedPaths: readonly string[];
}

const PersistedWindowsDefenderExclusionsSchema = Schema.Struct({
  verifiedExcludedPaths: Schema.Array(Schema.String),
  lastVerifiedAt: Schema.NullOr(Schema.String),
  dismissedMissingPaths: Schema.Array(Schema.String),
});
type PersistedWindowsDefenderExclusions = typeof PersistedWindowsDefenderExclusionsSchema.Type;
const PersistedWindowsDefenderExclusionsJson = Schema.fromJsonString(
  PersistedWindowsDefenderExclusionsSchema,
);
const decodePersistedWindowsDefenderExclusions = Schema.decodeEffect(
  PersistedWindowsDefenderExclusionsJson,
);
const encodePersistedWindowsDefenderExclusions = Schema.encodeEffect(
  PersistedWindowsDefenderExclusionsJson,
);

const EMPTY_PERSISTED_STATE: PersistedWindowsDefenderExclusions = {
  verifiedExcludedPaths: [],
  lastVerifiedAt: null,
  dismissedMissingPaths: [],
};

const ProbePayloadSchema = Schema.Struct({
  realTimeProtectionEnabled: Schema.NullOr(Schema.Boolean),
  canReadExclusions: Schema.Boolean,
  excludedPaths: Schema.Array(Schema.String),
});
const decodeProbePayloadOption = Schema.decodeUnknownOption(ProbePayloadSchema);

const ApplyInputJson = Schema.fromJsonString(
  Schema.Struct({
    paths: Schema.Array(Schema.String),
  }),
);
const encodeApplyInput = Schema.encodeEffect(ApplyInputJson);

const ApplyResultSchema = Schema.Struct({
  ok: Schema.Boolean,
  excludedPaths: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String),
});
const ApplyResultJson = Schema.fromJsonString(ApplyResultSchema);
const decodeApplyResult = Schema.decodeEffect(ApplyResultJson);

// Reads real-time protection status and, when permitted, live ExclusionPath entries.
// Output is UTF-8 JSON encoded in Base64 to avoid Windows console codepage corruption.
const WINDOWS_DEFENDER_PROBE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$rtp = $null
try {
  $status = Get-MpComputerStatus -ErrorAction Stop
  if ($null -ne $status -and $null -ne $status.RealTimeProtectionEnabled) {
    $rtp = [bool]$status.RealTimeProtectionEnabled
  }
} catch {}
$isAdmin = $false
try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
$paths = @()
$canReadExclusions = $false
try {
  $pref = Get-MpPreference -ErrorAction Stop
  if ($null -ne $pref) {
    $raw = @()
    if ($null -ne $pref.ExclusionPath) {
      $raw = @($pref.ExclusionPath | Where-Object { $_ -is [string] -and $_.Trim().Length -gt 0 })
    }
    $hasNa = $false
    foreach ($item in $raw) {
      if ($item.Trim() -like 'N/A:*') {
        $hasNa = $true
      }
    }
    if (-not $hasNa -and ($isAdmin -or $raw.Count -gt 0)) {
      $paths = $raw
      $canReadExclusions = $true
    }
  }
} catch {}
$payload = [ordered]@{
  realTimeProtectionEnabled = $rtp
  canReadExclusions = $canReadExclusions
  excludedPaths = @($paths)
} | ConvertTo-Json -Compress -Depth 3
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)))
`;

// Runs inside an elevated PowerShell child process so Add-MpPreference and Get-MpPreference
// verification both execute under Administrator privileges.
const WINDOWS_DEFENDER_APPLY_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
$result = [ordered]@{
  ok = $false
  excludedPaths = @()
  error = $null
}
try {
  $rawInput = [System.IO.File]::ReadAllText($InputPath, [System.Text.Encoding]::UTF8)
  $parsed = $rawInput | ConvertFrom-Json
  $paths = @($parsed.paths | Where-Object { $_ -is [string] -and $_.Trim().Length -gt 0 })
  if ($paths.Count -gt 0) {
    Add-MpPreference -ExclusionPath $paths -ErrorAction Stop
  }
  $pref = Get-MpPreference -ErrorAction Stop
  $excluded = @()
  if ($null -ne $pref -and $null -ne $pref.ExclusionPath) {
    $excluded = @($pref.ExclusionPath | Where-Object { $_ -is [string] -and $_.Trim().Length -gt 0 -and $_.Trim() -notlike 'N/A:*' })
  }
  $result.ok = $true
  $result.excludedPaths = @($excluded)
} catch {
  $result.error = $_.Exception.Message
}
$json = $result | ConvertTo-Json -Compress -Depth 4
[System.IO.File]::WriteAllText($ResultPath, $json, [System.Text.UTF8Encoding]::new($false))
if (-not $result.ok) { exit 1 }
`;

// Launches the apply script via UAC elevation and waits for completion.
const WINDOWS_DEFENDER_ELEVATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$quote = { param([string]$v) '"' + ($v -replace '"', '\\"') + '"' }
$argList = @(
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', (& $quote $env:T3_DEFENDER_SCRIPT),
  '-InputPath', (& $quote $env:T3_DEFENDER_INPUT),
  '-ResultPath', (& $quote $env:T3_DEFENDER_RESULT)
)
try {
  $proc = Start-Process -FilePath $env:T3_DEFENDER_PS -ArgumentList $argList -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($null -eq $proc) { exit 1 }
  exit $proc.ExitCode
} catch [System.ComponentModel.Win32Exception] {
  if ($_.Exception.NativeErrorCode -eq 1223) {
    [Console]::Error.WriteLine('T3_UAC_CANCELLED')
    exit 1223
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} catch {
  if ($_.Exception.InnerException -is [System.ComponentModel.Win32Exception] -and $_.Exception.InnerException.NativeErrorCode -eq 1223) {
    [Console]::Error.WriteLine('T3_UAC_CANCELLED')
    exit 1223
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function normalizeWindowsPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\//g, "\\");
  if (trimmed.length === 0) return "";
  if (/^[a-zA-Z]:\\*$/.test(trimmed)) {
    return `${trimmed.slice(0, 2).toLowerCase()}\\`;
  }
  return trimmed.replace(/\\+$/, "").toLowerCase();
}

function joinWindowsPath(base: string, ...segments: readonly string[]): string {
  const cleanedBase = base.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  const cleanedSegments = segments
    .map((segment) =>
      segment
        .trim()
        .replace(/\//g, "\\")
        .replace(/^\\+|\\+$/g, ""),
    )
    .filter((segment) => segment.length > 0);
  if (cleanedBase.length === 0) {
    return cleanedSegments.join("\\");
  }
  if (cleanedSegments.length === 0) {
    return /^[a-zA-Z]:$/.test(cleanedBase) ? `${cleanedBase}\\` : cleanedBase;
  }
  return [cleanedBase, ...cleanedSegments].join("\\");
}

function dirnameWindowsPath(filePath: string): string | null {
  const cleaned = filePath.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  if (cleaned.length === 0) return null;
  const lastSlash = cleaned.lastIndexOf("\\");
  if (lastSlash <= 0) return null;
  const dir = cleaned.slice(0, lastSlash);
  if (/^[a-zA-Z]:$/.test(dir)) {
    return `${dir}\\`;
  }
  return dir;
}

export function resolveWindowsDefenderTargetEntries(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly executablePath: string;
}): readonly WindowsDefenderTargetEntry[] {
  if (input.platform !== "win32") {
    return [];
  }

  const candidates: WindowsDefenderTargetEntry[] = [
    {
      kind: "antigravity-tools",
      path: joinWindowsPath(input.baseDir, "tools", "antigravity-acp"),
    },
    {
      kind: "antigravity-temp",
      path: joinWindowsPath(input.stateDir, "antigravity-tmp"),
    },
  ];

  if (input.isPackaged) {
    const installDir = dirnameWindowsPath(input.executablePath);
    if (installDir !== null) {
      candidates.push({
        kind: "app-install",
        path: installDir,
      });
    }
  }

  const seen = new Set<string>();
  const unique: WindowsDefenderTargetEntry[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeWindowsPath(candidate.path);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(candidate);
  }
  return unique;
}

export function isWindowsPathExcluded(
  targetPath: string,
  excludedPaths: readonly string[],
): boolean {
  const normalizedTarget = normalizeWindowsPath(targetPath);
  if (normalizedTarget.length === 0) return false;

  for (const rawEntry of excludedPaths) {
    const trimmed = rawEntry.trim();
    if (trimmed.length === 0 || trimmed.toLowerCase().startsWith("n/a:")) {
      continue;
    }
    const normalizedExcluded = normalizeWindowsPath(trimmed);
    if (normalizedExcluded.length === 0) {
      continue;
    }
    if (normalizedTarget === normalizedExcluded) {
      return true;
    }
    if (normalizedExcluded.endsWith("\\")) {
      if (normalizedTarget.startsWith(normalizedExcluded)) {
        return true;
      }
    } else if (normalizedTarget.startsWith(`${normalizedExcluded}\\`)) {
      return true;
    }
  }
  return false;
}

export function buildManualPowerShellCommand(paths: readonly string[]): string | null {
  const filtered = paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (filtered.length === 0) {
    return null;
  }
  const escaped = filtered.map((entry) => `'${entry.replace(/'/g, "''")}'`).join(", ");
  return `Add-MpPreference -ExclusionPath @(${escaped})`;
}

function parseWindowsDefenderProbeOutput(base64Stdout: string): WindowsDefenderProbeResult | null {
  const trimmed = base64Stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    const validated = decodeProbePayloadOption(parsed);
    if (Option.isNone(validated)) {
      return null;
    }
    const filteredPaths = validated.value.excludedPaths.filter(
      (entry) => entry.trim().length > 0 && !entry.trim().toLowerCase().startsWith("n/a:"),
    );
    return {
      realTimeProtectionEnabled: validated.value.realTimeProtectionEnabled,
      canReadExclusions: validated.value.canReadExclusions,
      excludedPaths: filteredPaths,
    };
  } catch {
    return null;
  }
}

function computeWindowsDefenderExclusionsState(input: {
  readonly targetEntries: readonly WindowsDefenderTargetEntry[];
  readonly probe: WindowsDefenderProbeResult | null;
  readonly persisted: PersistedWindowsDefenderExclusions;
}): DesktopWindowsDefenderExclusionsState {
  if (input.targetEntries.length === 0) {
    return {
      supported: false,
      realTimeProtectionEnabled: null,
      verificationSource: "unsupported",
      allExcluded: false,
      entries: [],
      manualCommand: null,
      promptDismissed: false,
      lastVerifiedAt: null,
    };
  }

  const hasLiveExclusions = input.probe?.canReadExclusions === true;
  const effectiveExcludedPaths = hasLiveExclusions
    ? input.probe.excludedPaths
    : input.persisted.verifiedExcludedPaths;
  const verificationSource: DesktopWindowsDefenderExclusionsState["verificationSource"] =
    hasLiveExclusions
      ? "live"
      : input.persisted.verifiedExcludedPaths.length > 0 || input.persisted.lastVerifiedAt !== null
        ? "verified-cache"
        : "unverified";

  const entries: DesktopWindowsDefenderExclusionEntry[] = input.targetEntries.map((entry) => ({
    kind: entry.kind,
    path: entry.path,
    excluded: isWindowsPathExcluded(entry.path, effectiveExcludedPaths),
  }));

  const allExcluded = entries.every((entry) => entry.excluded);
  const missingNormalized = entries
    .filter((entry) => !entry.excluded)
    .map((entry) => normalizeWindowsPath(entry.path));
  const dismissedSet = new Set(
    input.persisted.dismissedMissingPaths.map((entry) => normalizeWindowsPath(entry)),
  );
  const promptDismissed =
    missingNormalized.length > 0 && missingNormalized.every((entry) => dismissedSet.has(entry));

  return {
    supported: true,
    realTimeProtectionEnabled: input.probe?.realTimeProtectionEnabled ?? null,
    verificationSource,
    allExcluded,
    entries,
    manualCommand: buildManualPowerShellCommand(input.targetEntries.map((entry) => entry.path)),
    promptDismissed,
    lastVerifiedAt: input.persisted.lastVerifiedAt,
  };
}

export class DesktopWindowsDefenderExclusions extends Context.Service<
  DesktopWindowsDefenderExclusions,
  {
    readonly state: Effect.Effect<DesktopWindowsDefenderExclusionsState>;
    readonly apply: Effect.Effect<
      DesktopWindowsDefenderExclusionsState,
      DesktopWindowsDefenderExclusionsError
    >;
    readonly dismissPrompt: Effect.Effect<DesktopWindowsDefenderExclusionsState>;
  }
>()("@t3tools/desktop/app/DesktopWindowsDefenderExclusions") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = yield* HostProcess.Environment;
  const executablePath = yield* HostProcess.ExecutablePath;
  const path = environment.path;
  const statePath = path.join(environment.stateDir, STATE_FILE_NAME);
  const applyPermit = yield* Semaphore.make(1);

  const fail = (message: string) => new DesktopWindowsDefenderExclusionsError({ message });

  const targetEntries = () =>
    resolveWindowsDefenderTargetEntries({
      platform: environment.platform,
      isPackaged: environment.isPackaged,
      baseDir: environment.baseDir,
      stateDir: environment.stateDir,
      executablePath,
    });

  const readPersistedState = Effect.gen(function* () {
    const raw = yield* fs.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw)) {
      return EMPTY_PERSISTED_STATE;
    }
    return yield* decodePersistedWindowsDefenderExclusions(raw.value).pipe(
      Effect.orElseSucceed(() => EMPTY_PERSISTED_STATE),
    );
  });

  const writePersistedState = Effect.fn("DesktopWindowsDefenderExclusions.writePersistedState")(
    function* (next: PersistedWindowsDefenderExclusions) {
      yield* fs.makeDirectory(environment.stateDir, { recursive: true });
      const staging = `${statePath}.${yield* Random.nextIntBetween(0, 0xffffff)}.tmp`;
      const serialized = `${yield* encodePersistedWindowsDefenderExclusions(next)}\n`;
      yield* fs
        .writeFileString(staging, serialized)
        .pipe(
          Effect.andThen(
            fs
              .rename(staging, statePath)
              .pipe(Effect.tapError(() => fs.remove(staging).pipe(Effect.ignore))),
          ),
        );
    },
  );

  const runPowerShell = (
    script: string,
    options?: {
      readonly env?: Record<string, string>;
      readonly timeout?: Duration.Duration;
    },
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            windowsPowerShellPath(env),
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
            {
              stdin: "ignore",
              ...(options?.env ? { env: options.env, extendEnv: true } : {}),
            },
          ),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode };
      }),
    ).pipe(
      Effect.timeoutOption(options?.timeout ?? PROBE_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("PowerShell command timed out.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const probeDefender = Effect.gen(function* () {
    const result = yield* runPowerShell(WINDOWS_DEFENDER_PROBE_SCRIPT, {
      timeout: PROBE_TIMEOUT,
    });
    if (result.exitCode !== 0) {
      return null;
    }
    return parseWindowsDefenderProbeOutput(result.stdout);
  }).pipe(Effect.orElseSucceed(() => null));

  const state: DesktopWindowsDefenderExclusions["Service"]["state"] = Effect.gen(function* () {
    const targets = targetEntries();
    if (targets.length === 0) {
      return computeWindowsDefenderExclusionsState({
        targetEntries: [],
        probe: null,
        persisted: EMPTY_PERSISTED_STATE,
      });
    }

    const [persisted, probe] = yield* Effect.all([readPersistedState, probeDefender], {
      concurrency: "unbounded",
    });

    let effectivePersisted = persisted;
    if (probe?.canReadExclusions === true) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      effectivePersisted = {
        ...persisted,
        verifiedExcludedPaths: [...probe.excludedPaths],
        lastVerifiedAt: nowIso,
      };
      yield* writePersistedState(effectivePersisted).pipe(Effect.ignore);
    }

    return computeWindowsDefenderExclusionsState({
      targetEntries: targets,
      probe,
      persisted: effectivePersisted,
    });
  }).pipe(
    Effect.orElseSucceed(() =>
      computeWindowsDefenderExclusionsState({
        targetEntries: [],
        probe: null,
        persisted: EMPTY_PERSISTED_STATE,
      }),
    ),
    Effect.withSpan("desktop.windowsDefenderExclusions.state"),
  );

  const apply: DesktopWindowsDefenderExclusions["Service"]["apply"] = Effect.gen(function* () {
    const targets = targetEntries();
    if (targets.length === 0) {
      return yield* fail("Windows Defender exclusions are only supported on Windows.");
    }

    const targetPaths = targets.map((entry) => entry.path);
    const applyResult = yield* Effect.scoped(
      Effect.gen(function* () {
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-defender-" })
          .pipe(
            Effect.mapError(() => fail("Could not prepare temporary Windows Defender script.")),
          );
        const inputPath = path.join(tempDir, "input.json");
        const resultPath = path.join(tempDir, "result.json");
        const scriptPath = path.join(tempDir, "apply.ps1");

        const encodedInput = yield* encodeApplyInput({
          paths: targetPaths,
        }).pipe(Effect.mapError(() => fail("Could not encode Windows Defender exclusion paths.")));

        yield* Effect.all([
          fs.writeFileString(inputPath, encodedInput),
          // UTF-8 with BOM ensures Windows PowerShell 5.1 parses the script cleanly.
          fs.writeFileString(scriptPath, `\uFEFF${WINDOWS_DEFENDER_APPLY_SCRIPT}`),
        ]).pipe(Effect.mapError(() => fail("Could not write temporary Windows Defender script.")));

        const elevated = yield* runPowerShell(WINDOWS_DEFENDER_ELEVATE_SCRIPT, {
          timeout: APPLY_TIMEOUT,
          env: {
            T3_DEFENDER_PS: windowsPowerShellPath(env),
            T3_DEFENDER_SCRIPT: scriptPath,
            T3_DEFENDER_INPUT: inputPath,
            T3_DEFENDER_RESULT: resultPath,
          },
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "DesktopWindowsDefenderExclusionsError"
              ? error
              : fail("Failed to launch elevated Windows PowerShell."),
          ),
        );

        if (
          elevated.exitCode === 1223 ||
          elevated.stderr.includes("T3_UAC_CANCELLED") ||
          /canceled by the user/i.test(elevated.stderr)
        ) {
          return yield* fail("Administrator permission was cancelled.");
        }

        const rawResult = yield* fs.readFileString(resultPath).pipe(Effect.option);
        if (Option.isNone(rawResult)) {
          const detail = elevated.stderr.trim();
          return yield* fail(
            detail.length > 0
              ? `Windows Defender update failed: ${detail}`
              : "Windows Defender update did not return a verification result.",
          );
        }

        const parsedResult = yield* decodeApplyResult(rawResult.value).pipe(
          Effect.mapError(() => fail("Windows Defender verification output could not be parsed.")),
        );

        if (!parsedResult.ok) {
          return yield* fail(
            parsedResult.error?.trim() || "Failed to add Windows Defender exclusions.",
          );
        }

        return parsedResult;
      }),
    );

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const verifiedPaths = applyResult.excludedPaths.filter(
      (entry) => entry.trim().length > 0 && !entry.trim().toLowerCase().startsWith("n/a:"),
    );

    const missingAfterApply = targets.filter(
      (entry) => !isWindowsPathExcluded(entry.path, verifiedPaths),
    );

    const nextPersisted: PersistedWindowsDefenderExclusions = {
      verifiedExcludedPaths: verifiedPaths,
      lastVerifiedAt: nowIso,
      dismissedMissingPaths: missingAfterApply.length === 0 ? [] : [],
    };
    yield* writePersistedState(nextPersisted).pipe(
      Effect.tapError((error) =>
        logWarning("failed to persist verified Windows Defender exclusions", {
          error: String(error),
        }),
      ),
      Effect.ignore,
    );

    if (missingAfterApply.length > 0) {
      yield* logWarning("Windows Defender exclusions could not be confirmed for all folders", {
        missing: missingAfterApply.map((entry) => entry.path),
      });
      return yield* fail(
        "Windows Defender exclusions could not be confirmed for all folders. Your device policy or Tamper Protection may manage exclusions.",
      );
    }

    yield* logInfo("added and verified Windows Defender exclusions", {
      count: targets.length,
    });

    const probe = yield* probeDefender;
    return computeWindowsDefenderExclusionsState({
      targetEntries: targets,
      probe: {
        realTimeProtectionEnabled: probe?.realTimeProtectionEnabled ?? null,
        canReadExclusions: true,
        excludedPaths: verifiedPaths,
      },
      persisted: nextPersisted,
    });
  }).pipe(applyPermit.withPermits(1), Effect.withSpan("desktop.windowsDefenderExclusions.apply"));

  const dismissPrompt: DesktopWindowsDefenderExclusions["Service"]["dismissPrompt"] = Effect.gen(
    function* () {
      const current = yield* state;
      if (!current.supported) {
        return current;
      }
      const persisted = yield* readPersistedState;
      const missingNormalized = current.entries
        .filter((entry) => !entry.excluded)
        .map((entry) => normalizeWindowsPath(entry.path));
      const mergedDismissed = Array.from(
        new Set([
          ...persisted.dismissedMissingPaths.map((entry) => normalizeWindowsPath(entry)),
          ...missingNormalized,
        ]),
      ).filter((entry) => entry.length > 0);
      const nextPersisted: PersistedWindowsDefenderExclusions = {
        ...persisted,
        dismissedMissingPaths: mergedDismissed,
      };
      yield* writePersistedState(nextPersisted).pipe(Effect.ignore);
      return {
        ...current,
        promptDismissed: missingNormalized.length > 0,
      };
    },
  ).pipe(Effect.withSpan("desktop.windowsDefenderExclusions.dismissPrompt"));

  return DesktopWindowsDefenderExclusions.of({
    state,
    apply,
    dismissPrompt,
  });
});

export const layer = Layer.effect(DesktopWindowsDefenderExclusions, make);
