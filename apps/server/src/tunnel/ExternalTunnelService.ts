// Node fs/child_process/os/path and Web fetch/timers are used by the standalone
// OS process manager, GitHub release downloader, and HTTP health prober.
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import {
  DEFAULT_EXTERNAL_TUNNEL_SETTINGS,
  ExternalTunnelOperationError,
  type ExternalTunnelActionInput,
  type ExternalTunnelAlert,
  type ExternalTunnelAlertCode,
  type ExternalTunnelBundleExportInput,
  type ExternalTunnelBundleExportResult,
  type ExternalTunnelBundleImportInput,
  type ExternalTunnelCandidate,
  type ExternalTunnelCandidateKind,
  type ExternalTunnelHealthState,
  type ExternalTunnelInstallEvent,
  type ExternalTunnelInstallInput,
  type ExternalTunnelInstalledTool,
  type ExternalTunnelMode,
  type ExternalTunnelScanEvent,
  type ExternalTunnelScanInput,
  type ExternalTunnelSettings,
  type ExternalTunnelStatus,
  type ExternalTunnelToolName,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const isExternalTunnelOperationError = Schema.is(ExternalTunnelOperationError);

interface PersistedRuntimeState {
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly entryPath: string;
  readonly logPath: string;
}

interface PortableTunnelBundle {
  readonly version: 1;
  readonly targetHostName: string;
  readonly serverAddress?: string;
  readonly sni?: string;
  readonly hy2Auth?: string;
  readonly frpToken?: string;
  readonly remotePort: number;
  readonly localPort?: number;
  readonly sshTarget?: string;
  readonly healthUrl?: string;
  readonly mode?: ExternalTunnelMode;
}

interface MonitorRuntimeState {
  readonly status: ExternalTunnelStatus;
  readonly consecutiveHealthFailures: number;
  readonly acknowledgedAlertId: string | null;
  readonly lastObservedAlertCode: ExternalTunnelAlertCode | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
}

export class ExternalTunnelService extends Context.Service<
  ExternalTunnelService,
  {
    readonly getStatus: Effect.Effect<ExternalTunnelStatus, ExternalTunnelOperationError>;
    readonly subscribe: Effect.Effect<{
      readonly initial: ExternalTunnelStatus;
      readonly changes: Stream.Stream<ExternalTunnelStatus>;
    }>;
    readonly action: (
      input: ExternalTunnelActionInput,
    ) => Effect.Effect<ExternalTunnelStatus, ExternalTunnelOperationError>;
    readonly scan: (
      input: ExternalTunnelScanInput,
    ) => Stream.Stream<ExternalTunnelScanEvent, ExternalTunnelOperationError>;
    readonly install: (
      input: ExternalTunnelInstallInput,
    ) => Stream.Stream<ExternalTunnelInstallEvent, ExternalTunnelOperationError>;
    readonly exportBundle: (
      input: ExternalTunnelBundleExportInput,
    ) => Effect.Effect<ExternalTunnelBundleExportResult, ExternalTunnelOperationError>;
    readonly importBundle: (
      input: ExternalTunnelBundleImportInput,
    ) => Stream.Stream<ExternalTunnelInstallEvent, ExternalTunnelOperationError>;
  }
>()("t3/tunnel/ExternalTunnelService") {}

const HYSTERIA_DEFAULT_VERSION = "2.14.0";
const FRP_DEFAULT_VERSION = "0.72.0";
const MAX_SCAN_DIRS = 4000;
const MAX_SCAN_CANDIDATES = 60;
const SCAN_YIELD_EVERY_DIRS = 25;
const HEALTH_TIMEOUT_MS = 8_000;
const RECENT_LOG_LINES = 80;

const SKIP_SCAN_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "windows",
  "system32",
  "winsxs",
  "$recycle.bin",
  "system volume information",
  "perflogs",
  "recovery",
  ".cache",
  "caches",
  "temp",
  "tmp",
  "dist",
  "build",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".pnpm-store",
  ".npm",
]);

function expandUserPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return NodeOS.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function defaultTunnelDir(): string {
  return NodePath.join(NodeOS.homedir(), ".t3", "tunnel");
}

export function parseCommandArgs(rawArgs: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = 0; i < rawArgs.length; i += 1) {
    const ch = rawArgs[i]!;
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote === '"') {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

function isProcessAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

export function classifyTunnelCandidate(filePath: string): {
  readonly kind: ExternalTunnelCandidateKind;
  readonly label: string;
  readonly confidence: "high" | "medium" | "low";
} | null {
  const base = NodePath.basename(filePath).toLowerCase();
  const ext = NodePath.extname(base);
  const isScript = ext === ".ps1" || ext === ".cmd" || ext === ".bat" || ext === ".sh";
  const isExe = ext === ".exe" || ext === "";

  if (
    base === "t3-tunnel.ps1" ||
    base === "t3-tunnel.cmd" ||
    base === "t3-tunnel.sh" ||
    base === "t3-tunnel.bat"
  ) {
    return {
      kind: "launcher",
      label: `T3 Tunnel Launcher (${NodePath.basename(filePath)})`,
      confidence: "high",
    };
  }
  if (
    (base === "hysteria.exe" ||
      base === "hysteria" ||
      base === "hysteria2.exe" ||
      base === "hysteria2") &&
    isExe
  ) {
    return {
      kind: "hysteria",
      label: `Hysteria2 Client (${NodePath.basename(filePath)})`,
      confidence: "high",
    };
  }
  if ((base === "frpc.exe" || base === "frpc") && isExe) {
    return {
      kind: "frpc",
      label: `FRP Client (${NodePath.basename(filePath)})`,
      confidence: "high",
    };
  }
  if ((base === "cloudflared.exe" || base === "cloudflared") && isExe) {
    return {
      kind: "cloudflared",
      label: `Cloudflared (${NodePath.basename(filePath)})`,
      confidence: "high",
    };
  }
  if (isScript && /t3.*tunnel|tunnel.*t3|hy2.*tunnel|frp.*tunnel/.test(base)) {
    return {
      kind: "launcher",
      label: `Tunnel Script (${NodePath.basename(filePath)})`,
      confidence: "high",
    };
  }
  if (isScript && /(autossh|ssh.*tunnel|tunnel.*ssh|vps.*tunnel|reverse.*ssh)/.test(base)) {
    return {
      kind: "ssh_script",
      label: `SSH Tunnel Script (${NodePath.basename(filePath)})`,
      confidence: "medium",
    };
  }
  if (isScript && /tunnel|frpc|hysteria/.test(base)) {
    return {
      kind: "other",
      label: `External Script (${NodePath.basename(filePath)})`,
      confidence: "low",
    };
  }
  return null;
}

export interface LogDiagnosis {
  readonly code: ExternalTunnelAlertCode;
  readonly severity: "error" | "warning";
  readonly title: string;
  readonly detail: string;
  readonly hint: string;
}

export function diagnoseTunnelLogs(lines: ReadonlyArray<string>): LogDiagnosis | null {
  if (lines.length === 0) return null;
  // Inspect only the tail window so recovered older logs don't trigger stale alerts
  // if a newer healthy marker appeared after them.
  let startIdx = Math.max(0, lines.length - 40);
  for (let i = lines.length - 1; i >= startIdx; i -= 1) {
    const lower = lines[i]!.toLowerCase();
    if (
      lower.includes("connected to server") ||
      lower.includes("start proxy success") ||
      lower.includes("tunnel healthy") ||
      lower.includes("hy2 connected")
    ) {
      startIdx = i + 1;
      break;
    }
  }
  const relevant = lines.slice(startIdx);
  if (relevant.length === 0) return null;
  const joined = relevant.join("\n");

  if (
    /pua:win32\/frproxy|operation did not complete successfully because the file contains a virus|unwanted software|frpc.*access is denied|access is denied.*frpc|eacces.*frpc/i.test(
      joined,
    )
  ) {
    return {
      code: "av_blocked",
      severity: "error",
      title: "Tunnel binary blocked by antivirus (Windows Defender)",
      detail: extractLastMatchingLine(relevant, /pua|virus|unwanted|access is denied|eacces/i),
      hint: "Windows Defender often flags frpc.exe as PUA:Win32/FRProxy. Either switch tunnel mode to SSH-over-Hysteria2 (auto/ssh) or add the tunnel bin folder to Defender exclusions.",
    };
  }

  if (
    /(authentication failed|auth.*failed|invalid.*password|status code 40[134]|failed to connect to server.*quic|tls:.*certificate|x509:|handshake.*timeout|failed to dial.*443|hysteria.*fatal|no recent network activity)/i.test(
      joined,
    )
  ) {
    return {
      code: "hy2_auth_or_handshake",
      severity: "error",
      title: "Hysteria2 connection or authentication failed",
      detail: extractLastMatchingLine(
        relevant,
        /auth|password|40[134]|quic|tls|x509|handshake|443|fatal|failed to connect/i,
      ),
      hint: "If you changed the VPS hy2.service password, port, or TLS domain/certificate, update local config/hysteria.yaml to match and click Restart.",
    };
  }

  if (
    /(token in login doesn't match|authorization failed|login to server failed|connect to server error|dial tcp.*10873|socks5.*connection refused|frpc.*error|proxy.*already exists)/i.test(
      joined,
    )
  ) {
    return {
      code: "frp_auth_or_connect",
      severity: "error",
      title: "FRP tunnel authentication or upstream connection failed",
      detail: extractLastMatchingLine(
        relevant,
        /token|authorization|login to server|connect to server|10873|socks5|already exists|frpc/i,
      ),
      hint: "Verify config/frpc.toml auth.token matches VPS /etc/frp/frps.toml, port is not occupied, and local Hysteria2 socks5 (127.0.0.1:10873) is running.",
    };
  }

  return null;
}

function extractLastMatchingLine(lines: ReadonlyArray<string>, pattern: RegExp): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (pattern.test(lines[i]!)) {
      return lines[i]!.trim().slice(0, 320);
    }
  }
  return (lines[lines.length - 1] ?? "").trim().slice(0, 320);
}

async function readRecentLogLines(logPath: string, maxLines = RECENT_LOG_LINES): Promise<string[]> {
  const expanded = expandUserPath(logPath);
  if (!expanded) return [];
  try {
    const stat = await NodeFSP.stat(expanded);
    if (!stat.isFile()) return [];
    const readSize = Math.min(stat.size, 64 * 1024);
    const fh = await NodeFSP.open(expanded, "r");
    try {
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, stat.size - readSize);
      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      return lines.slice(-maxLines);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

function defaultLogPathForEntry(entryPath: string): string {
  const expanded = expandUserPath(entryPath);
  if (!expanded) {
    return NodePath.join(defaultTunnelDir(), "logs", "t3-tunnel.log");
  }
  const dir = NodePath.dirname(expanded);
  const candidateLogsDir =
    NodePath.basename(dir).toLowerCase() === "bin"
      ? NodePath.join(NodePath.dirname(dir), "logs")
      : NodePath.join(dir, "logs");
  return NodePath.join(candidateLogsDir, "t3-tunnel.log");
}

function resolveLaunchCommand(
  entryPath: string,
  rawArgs: string,
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: string[] } {
  const parsedArgs = parseCommandArgs(rawArgs);
  const ext = NodePath.extname(entryPath).toLowerCase();
  if (platform === "win32") {
    if (ext === ".ps1") {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", entryPath, ...parsedArgs],
      };
    }
    if (ext === ".cmd" || ext === ".bat") {
      return {
        command: "cmd.exe",
        args: ["/d", "/c", entryPath, ...parsedArgs],
      };
    }
    return { command: entryPath, args: parsedArgs };
  }
  if (ext === ".sh") {
    return { command: "/bin/sh", args: [entryPath, ...parsedArgs] };
  }
  return { command: entryPath, args: parsedArgs };
}

async function terminateProcessTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (!isProcessAlive(pid)) return;
  if (platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = NodeChildProcess.spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => {
        try {
          process.kill(pid);
        } catch {
          // ignore
        }
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
}

async function probeHealthUrl(url: string): Promise<{
  readonly ok: boolean;
  readonly statusCode: number | null;
  readonly latencyMs: number | null;
  readonly errorMessage: string | null;
}> {
  const trimmed = url.trim();
  if (!trimmed) {
    return { ok: false, statusCode: null, latencyMs: null, errorMessage: null };
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(trimmed, {
      method: "GET",
      signal: controller.signal,
      headers: { "cache-control": "no-cache" },
    });
    const latencyMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 400;
    return {
      ok,
      statusCode: response.status,
      latencyMs,
      errorMessage: ok ? null : `HTTP ${response.status} ${response.statusText}`.trim(),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      statusCode: null,
      latencyMs,
      errorMessage: msg.includes("aborted")
        ? `Request timed out after ${HEALTH_TIMEOUT_MS}ms`
        : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatIsoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function makeAlert(
  prev: ExternalTunnelAlert | null,
  acknowledgedAlertId: string | null,
  diagnosis: LogDiagnosis,
): ExternalTunnelAlert {
  if (prev !== null && prev.code === diagnosis.code) {
    return {
      ...prev,
      severity: diagnosis.severity,
      title: diagnosis.title,
      detail: diagnosis.detail || prev.detail,
      hint: diagnosis.hint,
      acknowledgedAt:
        prev.acknowledgedAt ?? (acknowledgedAlertId === prev.id ? new Date().toISOString() : null),
    };
  }
  const now = new Date().toISOString();
  return {
    id: `${diagnosis.code}:${Date.now()}`,
    severity: diagnosis.severity,
    code: diagnosis.code,
    title: diagnosis.title,
    detail: diagnosis.detail,
    hint: diagnosis.hint,
    detectedAt: now,
    acknowledgedAt: null,
  };
}

function buildHysteriaAssetInfo(
  version: string,
  platform: NodeJS.Platform,
  hostArch: NodeJS.Architecture,
): {
  readonly url: string;
  readonly fileName: string;
  readonly binaryName: string;
  readonly archive: "none";
} {
  const arch = hostArch === "arm64" ? "arm64" : "amd64";
  if (platform === "win32") {
    const fileName = `hysteria-windows-${arch}.exe`;
    return {
      url: `https://github.com/apernet/hysteria/releases/download/app%2Fv${version}/${fileName}`,
      fileName,
      binaryName: "hysteria.exe",
      archive: "none",
    };
  }
  if (platform === "darwin") {
    const fileName = `hysteria-darwin-${arch}`;
    return {
      url: `https://github.com/apernet/hysteria/releases/download/app%2Fv${version}/${fileName}`,
      fileName,
      binaryName: "hysteria",
      archive: "none",
    };
  }
  const fileName = `hysteria-linux-${arch}`;
  return {
    url: `https://github.com/apernet/hysteria/releases/download/app%2Fv${version}/${fileName}`,
    fileName,
    binaryName: "hysteria",
    archive: "none",
  };
}

function buildFrpcAssetInfo(
  version: string,
  platform: NodeJS.Platform,
  hostArch: NodeJS.Architecture,
): {
  readonly url: string;
  readonly fileName: string;
  readonly binaryName: string;
  readonly archive: "zip" | "targz";
} {
  const arch = hostArch === "arm64" ? "arm64" : "amd64";
  if (platform === "win32") {
    const fileName = `frp_${version}_windows_${arch}.zip`;
    return {
      url: `https://github.com/fatedier/frp/releases/download/v${version}/${fileName}`,
      fileName,
      binaryName: "frpc.exe",
      archive: "zip",
    };
  }
  const osName = platform === "darwin" ? "darwin" : "linux";
  const fileName = `frp_${version}_${osName}_${arch}.tar.gz`;
  return {
    url: `https://github.com/fatedier/frp/releases/download/v${version}/${fileName}`,
    fileName,
    binaryName: "frpc",
    archive: "targz",
  };
}

async function downloadFileWithProgress(
  url: string,
  destPath: string,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void,
): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  const totalBytes =
    contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader)
      ? Number.parseInt(contentLengthHeader, 10)
      : null;

  await NodeFSP.mkdir(NodePath.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.downloading`;
  const writer = NodeFS.createWriteStream(tempPath);
  let loaded = 0;
  let lastReportAt = 0;

  const reader = response.body.getReader();
  const readable = new NodeStream.Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        loaded += value.byteLength;
        const now = Date.now();
        if (now - lastReportAt >= 120) {
          lastReportAt = now;
          onProgress(loaded, totalBytes);
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  try {
    await NodeStreamPromises.pipeline(readable, writer);
    onProgress(loaded, totalBytes);
    await NodeFSP.rename(tempPath, destPath);
  } catch (err) {
    await NodeFSP.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function extractFrpcBinary(
  archivePath: string,
  archiveType: "zip" | "targz",
  binDir: string,
  binaryName: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const tmpExtractDir = NodePath.join(binDir, `_extract_${Date.now()}`);
  await NodeFSP.mkdir(tmpExtractDir, { recursive: true });
  try {
    if (archiveType === "zip") {
      await execSimple("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${tmpExtractDir.replace(/'/g, "''")}' -Force`,
      ]);
    } else {
      await execSimple("tar", ["-xzf", archivePath, "-C", tmpExtractDir]);
    }
    const found = await findFileRecursive(tmpExtractDir, binaryName);
    if (!found) {
      throw new Error(`Could not find ${binaryName} inside ${archivePath}`);
    }
    const targetPath = NodePath.join(binDir, binaryName);
    await NodeFSP.copyFile(found, targetPath);
    if (platform !== "win32") {
      await NodeFSP.chmod(targetPath, 0o755);
    }
    return targetPath;
  } finally {
    await NodeFSP.rm(tmpExtractDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findFileRecursive(rootDir: string, targetName: string): Promise<string | null> {
  const entries = await NodeFSP.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = NodePath.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === targetName.toLowerCase()) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(full, targetName);
      if (nested) return nested;
    }
  }
  return null;
}

function execSimple(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`Command timed out: ${command}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function probeBinaryVersion(
  tool: ExternalTunnelToolName,
  binaryPath: string,
): Promise<{
  readonly version: string | null;
  readonly blockedByAv: boolean;
  readonly note?: string;
}> {
  const versionArg = tool === "hysteria" ? "version" : "--version";
  try {
    const result = await execSimple(binaryPath, [versionArg], 10_000);
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    const versionMatch = combined.match(/v?\d+\.\d+\.\d+/);
    return {
      version: versionMatch ? versionMatch[0] : (combined.split(/\r?\n/)[0]?.slice(0, 64) ?? null),
      blockedByAv: false,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    const message = err?.message ?? String(error);
    const isAv =
      err?.code === "EACCES" ||
      err?.code === "EPERM" ||
      /access is denied|virus|unwanted|pua/i.test(message);
    return {
      version: null,
      blockedByAv: isAv,
      note: isAv
        ? "Blocked by antivirus / Windows Defender (e.g. PUA:Win32/FRProxy). Launcher will automatically fall back to SSH over Hysteria2 unless you add an exclusion."
        : message,
    };
  }
}

function generateWindowsLauncherScript(options: {
  readonly installDir: string;
  readonly mode: ExternalTunnelMode;
  readonly sshTarget: string;
  readonly remotePort: number;
  readonly localPort: number;
}): string {
  const escapedDir = options.installDir.replace(/'/g, "''");
  const escapedSshTarget = options.sshTarget.replace(/'/g, "''");
  return `# T3 Code External Tunnel Launcher (Hysteria2 QUIC + FRP / SSH auto-fallback)
param(
  [ValidateSet("auto", "frp", "ssh")]
  [string]$Mode = "${options.mode}",
  [int]$RemotePort = ${options.remotePort},
  [int]$LocalPort = ${options.localPort},
  [string]$SshTarget = '${escapedSshTarget}'
)

$ErrorActionPreference = "Continue"
$RootDir = '${escapedDir}'
$BinDir = Join-Path $RootDir "bin"
$ConfigDir = Join-Path $RootDir "config"
$LogDir = Join-Path $RootDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$LogFile = Join-Path $LogDir "t3-tunnel.log"
$Hy2Bin = Join-Path $BinDir "hysteria.exe"
$Hy2Config = Join-Path $ConfigDir "hysteria.yaml"
$FrpcBin = Join-Path $BinDir "frpc.exe"
$FrpcConfig = Join-Path $ConfigDir "frpc.toml"

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  Write-Output $line
}

function Test-LocalPort([int]$Port) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $ar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(1000, $false)
    if ($ok -and $client.Connected) {
      $client.EndConnect($ar)
      $client.Close()
      return $true
    }
    $client.Close()
    return $false
  } catch {
    return $false
  }
}

function Test-FrpcRunnable() {
  if (-not (Test-Path $FrpcBin) -or -not (Test-Path $FrpcConfig)) { return $false }
  try {
    $p = Start-Process -FilePath $FrpcBin -ArgumentList "--version" -NoNewWindow -Wait -PassThru -ErrorAction Stop
    return ($p.ExitCode -eq 0)
  } catch {
    Write-Log "[warn] frpc.exe could not run ($($_.Exception.Message)); falling back to SSH-over-Hysteria2"
    return $false
  }
}

$hy2Proc = $null
$fwdProc = $null

function Stop-Children() {
  if ($fwdProc -and -not $fwdProc.HasExited) {
    try { Stop-Process -Id $fwdProc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  if ($hy2Proc -and -not $hy2Proc.HasExited) {
    try { Stop-Process -Id $hy2Proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}

Register-EngineEvent PowerShell.Exiting -Action { Stop-Children } | Out-Null

try {
  Write-Log "[info] T3 external tunnel starting (mode=$Mode, remotePort=$RemotePort, localPort=$LocalPort)"
  while ($true) {
    if (-not $hy2Proc -or $hy2Proc.HasExited) {
      if (-not (Test-Path $Hy2Bin) -or -not (Test-Path $Hy2Config)) {
        Write-Log "[error] Missing hysteria.exe or config/hysteria.yaml in $RootDir"
        Start-Sleep -Seconds 10
        continue
      }
      Write-Log "[info] Starting hysteria.exe with $Hy2Config"
      $hy2Out = Join-Path $LogDir "hysteria.log"
      $hy2Err = Join-Path $LogDir "hysteria.err.log"
      $hy2Proc = Start-Process -FilePath $Hy2Bin -ArgumentList @("-c", $Hy2Config) -WindowStyle Hidden -RedirectStandardOutput $hy2Out -RedirectStandardError $hy2Err -PassThru
      $ready = $false
      for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 500
        if ($hy2Proc.HasExited) { break }
        if (Test-LocalPort 10873 -or (Test-LocalPort 10222)) {
          $ready = $true
          break
        }
      }
      if ($hy2Proc.HasExited) {
        $tail = ""
        if (Test-Path $hy2Err) { $tail = (Get-Content -Path $hy2Err -Tail 6 -ErrorAction SilentlyContinue) -join " | " }
        if (-not $tail -and (Test-Path $hy2Out)) { $tail = (Get-Content -Path $hy2Out -Tail 6 -ErrorAction SilentlyContinue) -join " | " }
        Write-Log "[error] hysteria.exe exited immediately (code=$($hy2Proc.ExitCode)): $tail"
        Start-Sleep -Seconds 5
        continue
      }
      if ($ready) {
        Write-Log "[info] hy2 connected (local forwarders ready)"
      }
    }

    if (-not $fwdProc -or $fwdProc.HasExited) {
      $useFrp = $false
      if ($Mode -eq "frp") {
        $useFrp = $true
      } elseif ($Mode -eq "auto") {
        $useFrp = Test-FrpcRunnable
      }

      if ($useFrp) {
        Write-Log "[info] Starting frpc.exe over socks5://127.0.0.1:10873"
        $frpOut = Join-Path $LogDir "frpc.log"
        $frpErr = Join-Path $LogDir "frpc.err.log"
        try {
          $fwdProc = Start-Process -FilePath $FrpcBin -ArgumentList @("-c", $FrpcConfig) -WindowStyle Hidden -RedirectStandardOutput $frpOut -RedirectStandardError $frpErr -PassThru -ErrorAction Stop
          Start-Sleep -Seconds 2
          if ($fwdProc.HasExited) {
            $tail = ""
            if (Test-Path $frpErr) { $tail = (Get-Content -Path $frpErr -Tail 6 -ErrorAction SilentlyContinue) -join " | " }
            if (-not $tail -and (Test-Path $frpOut)) { $tail = (Get-Content -Path $frpOut -Tail 6 -ErrorAction SilentlyContinue) -join " | " }
            Write-Log "[error] frpc.exe exited (code=$($fwdProc.ExitCode)): $tail"
          } else {
            Write-Log "[info] start proxy success (frpc pid=$($fwdProc.Id))"
          }
        } catch {
          Write-Log "[error] frpc.exe launch failed: $($_.Exception.Message)"
        }
      } else {
        Write-Log "[info] Starting ssh reverse tunnel over Hysteria2 TCP forward 127.0.0.1:10222 -> remote 127.0.0.1:$RemotePort"
        $sshOut = Join-Path $LogDir "ssh-fwd.log"
        $sshErr = Join-Path $LogDir "ssh-fwd.err.log"
        $sshArgs = @(
          "-N",
          "-o", "HostName=127.0.0.1",
          "-o", "Port=10222",
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=NUL",
          "-o", "ExitOnForwardFailure=yes",
          "-o", "ServerAliveInterval=15",
          "-o", "ServerAliveCountMax=3",
          "-o", "TCPKeepAlive=yes",
          "-R", "127.0.0.1:\${RemotePort}:127.0.0.1:\${LocalPort}",
          $SshTarget
        )
        $fwdProc = Start-Process -FilePath "ssh.exe" -ArgumentList $sshArgs -WindowStyle Hidden -RedirectStandardOutput $sshOut -RedirectStandardError $sshErr -PassThru
        Start-Sleep -Seconds 2
        if ($fwdProc.HasExited) {
          $tail = ""
          if (Test-Path $sshErr) { $tail = (Get-Content -Path $sshErr -Tail 6 -ErrorAction SilentlyContinue) -join " | " }
          Write-Log "[error] ssh tunnel exited (code=$($fwdProc.ExitCode)): $tail"
        } else {
          Write-Log "[info] tunnel healthy (ssh-over-hy2 pid=$($fwdProc.Id), 127.0.0.1:$RemotePort -> 127.0.0.1:$LocalPort)"
        }
      }
    }

    Start-Sleep -Seconds 5
  }
} finally {
  Stop-Children
}
`;
}

function generatePosixLauncherScript(options: {
  readonly installDir: string;
  readonly mode: ExternalTunnelMode;
  readonly sshTarget: string;
  readonly remotePort: number;
  readonly localPort: number;
}): string {
  return `#!/bin/sh
set -eu
ROOT_DIR="${options.installDir}"
BIN_DIR="$ROOT_DIR/bin"
CONFIG_DIR="$ROOT_DIR/config"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/t3-tunnel.log"
MODE="\${1:-${options.mode}}"
REMOTE_PORT="${options.remotePort}"
LOCAL_PORT="${options.localPort}"
SSH_TARGET="${options.sshTarget}"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_FILE"
}

cleanup() {
  [ -n "\${FWD_PID:-}" ] && kill "$FWD_PID" 2>/dev/null || true
  [ -n "\${HY2_PID:-}" ] && kill "$HY2_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

log "[info] T3 external tunnel starting (mode=$MODE, remotePort=$REMOTE_PORT, localPort=$LOCAL_PORT)"
while true; do
  if [ -z "\${HY2_PID:-}" ] || ! kill -0 "$HY2_PID" 2>/dev/null; then
    "$BIN_DIR/hysteria" -c "$CONFIG_DIR/hysteria.yaml" >>"$LOG_DIR/hysteria.log" 2>&1 &
    HY2_PID=$!
    sleep 2
    if ! kill -0 "$HY2_PID" 2>/dev/null; then
      log "[error] hysteria exited immediately; check $LOG_DIR/hysteria.log"
      sleep 5
      continue
    fi
    log "[info] hy2 connected (pid=$HY2_PID)"
  fi

  if [ -z "\${FWD_PID:-}" ] || ! kill -0 "$FWD_PID" 2>/dev/null; then
    if [ "$MODE" = "frp" ] || { [ "$MODE" = "auto" ] && [ -x "$BIN_DIR/frpc" ] && [ -f "$CONFIG_DIR/frpc.toml" ]; }; then
      "$BIN_DIR/frpc" -c "$CONFIG_DIR/frpc.toml" >>"$LOG_DIR/frpc.log" 2>&1 &
      FWD_PID=$!
      sleep 2
      log "[info] start proxy success (frpc pid=$FWD_PID)"
    else
      ssh -N -o HostName=127.0.0.1 -o Port=10222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
        -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \\
        -R "127.0.0.1:\${REMOTE_PORT}:127.0.0.1:\${LOCAL_PORT}" "$SSH_TARGET" >>"$LOG_DIR/ssh-fwd.log" 2>&1 &
      FWD_PID=$!
      sleep 2
      log "[info] tunnel healthy (ssh-over-hy2 pid=$FWD_PID)"
    fi
  fi
  sleep 5
done
`;
}

function buildHysteriaYaml(options: {
  readonly serverAddress: string;
  readonly sni: string;
  readonly hy2Auth: string;
}): string {
  const server = options.serverAddress.includes(":")
    ? options.serverAddress
    : `${options.serverAddress}:443`;
  return `server: ${server}
auth: ${options.hy2Auth}

tls:
  sni: ${options.sni}

bandwidth:
  up: 100 mbps
  down: 500 mbps

socks5:
  listen: 127.0.0.1:10873

tcpForwarding:
  - listen: 127.0.0.1:10222
    remote: 127.0.0.1:22
`;
}

function buildFrpcToml(options: {
  readonly frpToken: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly proxyName: string;
}): string {
  return `serverAddr = "127.0.0.1"
serverPort = 7000

auth.method = "token"
auth.token = "${options.frpToken}"

transport.proxyURL = "socks5://127.0.0.1:10873"
transport.tls.enable = true
transport.heartbeatInterval = 15
transport.heartbeatTimeout = 45
transport.tcpMux = true
transport.tcpMuxKeepaliveInterval = 20

loginFailExit = false

[[proxies]]
name = "${options.proxyName}"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${options.localPort}
remotePort = ${options.remotePort}
`;
}

function buildCaddySnippet(domain: string, remotePort: number): string {
  return `${domain} {
\treverse_proxy 127.0.0.1:${remotePort} {
\t\tflush_interval -1
\t\thealth_uri /.well-known/t3/environment
\t\thealth_interval 30s
\t\thealth_timeout 8s
\t\thealth_fails 3
\t\thealth_passes 1
\t\ttransport http {
\t\t\tdial_timeout 3s
\t\t\tresponse_header_timeout 9s
\t\t}
\t}
}`;
}

function parseSimpleConfigValue(text: string, regex: RegExp): string | undefined {
  const match = text.match(regex);
  return match?.[1]?.trim();
}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArch = yield* HostProcess.Architecture;
  const pubsub = yield* PubSub.unbounded<ExternalTunnelStatus>();

  const stateFilePath = NodePath.join(serverConfig.baseDir, "external-tunnel-state.json");

  const loadPersistedRuntime = (): PersistedRuntimeState => {
    try {
      const raw = NodeFS.readFileSync(stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedRuntimeState>;
      return {
        pid: typeof parsed.pid === "number" ? parsed.pid : null,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
        entryPath: typeof parsed.entryPath === "string" ? parsed.entryPath : "",
        logPath: typeof parsed.logPath === "string" ? parsed.logPath : "",
      };
    } catch {
      return { pid: null, startedAt: null, entryPath: "", logPath: "" };
    }
  };

  const savePersistedRuntime = (next: PersistedRuntimeState): void => {
    try {
      NodeFS.mkdirSync(NodePath.dirname(stateFilePath), { recursive: true });
      NodeFS.writeFileSync(stateFilePath, JSON.stringify(next, null, 2), "utf8");
    } catch {
      // Best-effort persistence; never fail tunnel operations on state file write error.
    }
  };

  const initialSettings = yield* serverSettings.getSettings.pipe(
    Effect.map((s) => s.externalTunnel),
    Effect.orElseSucceed(() => DEFAULT_EXTERNAL_TUNNEL_SETTINGS),
  );
  const persisted = loadPersistedRuntime();
  const initialPid = isProcessAlive(persisted.pid) ? persisted.pid : null;

  const initialStatus: ExternalTunnelStatus = {
    configured:
      initialSettings.entryPath.trim().length > 0 || initialSettings.healthUrl.trim().length > 0,
    running: initialPid !== null,
    pid: initialPid,
    startedAt: initialPid !== null ? persisted.startedAt : null,
    entryPath: initialSettings.entryPath,
    healthUrl: initialSettings.healthUrl,
    logPath:
      initialSettings.logPath ||
      (initialSettings.entryPath ? defaultLogPathForEntry(initialSettings.entryPath) : ""),
    healthState: "unknown",
    healthLatencyMs: null,
    healthStatusCode: null,
    lastCheckedAt: null,
    alert: null,
    recentLogs: [],
  };

  const stateRef = yield* Ref.make<MonitorRuntimeState>({
    status: initialStatus,
    consecutiveHealthFailures: 0,
    acknowledgedAlertId: null,
    lastObservedAlertCode: null,
    pid: initialPid,
    startedAt: initialPid !== null ? persisted.startedAt : null,
  });

  const publishStatus = (status: ExternalTunnelStatus) =>
    PubSub.publish(pubsub, status).pipe(Effect.as(status));

  const readTunnelSettings = serverSettings.getSettings.pipe(
    Effect.map((s) => s.externalTunnel),
    Effect.orElseSucceed(() => DEFAULT_EXTERNAL_TUNNEL_SETTINGS),
  );

  const refreshStatus = Effect.fn("ExternalTunnelService.refreshStatus")(function* (options?: {
    readonly runHealthProbe?: boolean;
  }) {
    const settings = yield* readTunnelSettings;
    const current = yield* Ref.get(stateRef);
    const entryPath = settings.entryPath.trim();
    const healthUrl = settings.healthUrl.trim();
    const effectiveLogPath =
      settings.logPath.trim() || (entryPath ? defaultLogPathForEntry(entryPath) : "");
    const configured = entryPath.length > 0 || healthUrl.length > 0;

    const wasRunning = current.pid !== null;
    const alive = isProcessAlive(current.pid);
    const pid = alive ? current.pid : null;
    const startedAt = alive ? current.startedAt : null;

    if (wasRunning && !alive) {
      savePersistedRuntime({ pid: null, startedAt: null, entryPath, logPath: effectiveLogPath });
    }

    const recentLogs = yield* Effect.promise(() => readRecentLogLines(effectiveLogPath));
    const logDiagnosis = diagnoseTunnelLogs(recentLogs);

    let healthState: ExternalTunnelHealthState = current.status.healthState;
    let healthLatencyMs = current.status.healthLatencyMs;
    let healthStatusCode = current.status.healthStatusCode;
    let lastCheckedAt = current.status.lastCheckedAt;
    let consecutiveHealthFailures = current.consecutiveHealthFailures;
    let healthErrorMessage: string | null = null;

    if (healthUrl.length > 0 && (options?.runHealthProbe ?? true)) {
      const probe = yield* Effect.promise(() => probeHealthUrl(healthUrl));
      healthLatencyMs = probe.latencyMs;
      healthStatusCode = probe.statusCode;
      const nowMs = yield* Clock.currentTimeMillis;
      lastCheckedAt = formatIsoFromMs(nowMs);
      if (probe.ok) {
        healthState = "healthy";
        consecutiveHealthFailures = 0;
      } else {
        consecutiveHealthFailures += 1;
        healthErrorMessage = probe.errorMessage;
        healthState = consecutiveHealthFailures >= 2 || !alive ? "unhealthy" : "degraded";
      }
    } else if (healthUrl.length === 0) {
      healthState = alive ? "healthy" : configured ? "unknown" : "unknown";
      healthLatencyMs = null;
      healthStatusCode = null;
    }

    let nextAlert: ExternalTunnelAlert | null = current.status.alert;
    if (!settings.alertOnFailure) {
      nextAlert = null;
    } else if (logDiagnosis !== null && healthState !== "healthy") {
      nextAlert = makeAlert(current.status.alert, current.acknowledgedAlertId, logDiagnosis);
    } else if (wasRunning && !alive && settings.enabled) {
      nextAlert = makeAlert(current.status.alert, current.acknowledgedAlertId, {
        code: "process_exited",
        severity: "error",
        title: "External tunnel process exited unexpectedly",
        detail:
          recentLogs[recentLogs.length - 1] ??
          `Managed process (PID ${current.pid}) stopped unexpectedly.`,
        hint: "Check the recent tunnel logs below, verify VPS credentials/ports, or click Restart.",
      });
    } else if (healthUrl.length > 0 && healthState === "unhealthy") {
      nextAlert = makeAlert(current.status.alert, current.acknowledgedAlertId, {
        code: logDiagnosis?.code ?? "health_check_failed",
        severity: "error",
        title: logDiagnosis?.title ?? "External tunnel health check failed",
        detail:
          logDiagnosis?.detail ??
          `Health probe to ${healthUrl} failed (${healthErrorMessage ?? "unreachable"}).`,
        hint:
          logDiagnosis?.hint ??
          "Verify the tunnel is running, VPS hy2/frps/Caddy services are up, and your hy2 password or port has not changed.",
      });
    } else if (healthState === "healthy" && (alive || entryPath.length === 0)) {
      nextAlert = null;
    }

    const nextStatus: ExternalTunnelStatus = {
      configured,
      running: alive,
      pid,
      startedAt,
      entryPath,
      healthUrl,
      logPath: effectiveLogPath,
      healthState,
      healthLatencyMs,
      healthStatusCode,
      lastCheckedAt,
      alert: nextAlert,
      recentLogs,
    };

    yield* Ref.set(stateRef, {
      status: nextStatus,
      consecutiveHealthFailures,
      acknowledgedAlertId:
        nextAlert === null
          ? null
          : nextAlert.acknowledgedAt !== null
            ? nextAlert.id
            : current.acknowledgedAlertId,
      lastObservedAlertCode: nextAlert?.code ?? null,
      pid,
      startedAt,
    });

    return yield* publishStatus(nextStatus);
  });

  const startTunnel: Effect.Effect<ExternalTunnelStatus, ExternalTunnelOperationError> = Effect.gen(
    function* () {
      const settings = yield* readTunnelSettings;
      const entryPath = expandUserPath(settings.entryPath);
      if (!entryPath) {
        return yield* new ExternalTunnelOperationError({
          code: "config_missing",
          message: "Configure an external tunnel entry path first (or run One-Click Install).",
        });
      }

      const exists = yield* Effect.promise(() =>
        NodeFSP.stat(entryPath)
          .then((s) => s.isFile())
          .catch(() => false),
      );
      if (!exists) {
        return yield* new ExternalTunnelOperationError({
          code: "config_missing",
          message: `Tunnel entry file not found: ${entryPath}`,
        });
      }

      const current = yield* Ref.get(stateRef);
      if (isProcessAlive(current.pid)) {
        return yield* refreshStatus({ runHealthProbe: true });
      }

      const effectiveLogPath =
        expandUserPath(settings.logPath) || defaultLogPathForEntry(entryPath);
      const { command, args } = resolveLaunchCommand(entryPath, settings.args, hostPlatform);

      const spawned = yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(NodePath.dirname(effectiveLogPath), { recursive: true });
          const outFd = NodeFS.openSync(effectiveLogPath, "a");
          try {
            const child = NodeChildProcess.spawn(command, args, {
              cwd: NodePath.dirname(entryPath),
              detached: true,
              windowsHide: true,
              stdio: ["ignore", outFd, outFd],
            });
            const spawnError = await new Promise<Error | null>((resolve) => {
              let settled = false;
              const done = (err: Error | null) => {
                if (settled) return;
                settled = true;
                resolve(err);
              };
              child.once("error", (err) => done(err));
              child.once("spawn", () => done(null));
              setTimeout(() => done(null), 150);
            });
            if (spawnError !== null) {
              throw spawnError;
            }
            const pid = child.pid ?? null;
            child.unref();
            return pid;
          } finally {
            NodeFS.closeSync(outFd);
          }
        },
        catch: (error) => {
          const err = error as NodeJS.ErrnoException;
          const isAv =
            err?.code === "EACCES" ||
            err?.code === "EPERM" ||
            /access is denied|virus|unwanted|pua/i.test(err?.message ?? "");
          return new ExternalTunnelOperationError({
            code: isAv ? "av_blocked" : "spawn_failed",
            message: isAv
              ? `Launch blocked by system permissions or antivirus (${err?.message ?? String(error)}).`
              : `Failed to launch tunnel process: ${err?.message ?? String(error)}`,
          });
        },
      });

      const startedAt = formatIsoFromMs(yield* Clock.currentTimeMillis);
      savePersistedRuntime({
        pid: spawned,
        startedAt,
        entryPath,
        logPath: effectiveLogPath,
      });

      yield* Ref.update(stateRef, (s) => ({
        ...s,
        pid: spawned,
        startedAt,
        consecutiveHealthFailures: 0,
      }));

      // Give the launcher a brief moment to detect immediate exit / startup logs.
      yield* Effect.sleep(Duration.millis(600));
      return yield* refreshStatus({ runHealthProbe: true });
    },
  );

  const stopTunnel: Effect.Effect<ExternalTunnelStatus, ExternalTunnelOperationError> = Effect.gen(
    function* () {
      const current = yield* Ref.get(stateRef);
      const pid = current.pid;
      if (pid !== null && isProcessAlive(pid)) {
        yield* Effect.promise(() => terminateProcessTree(pid, hostPlatform));
      }
      savePersistedRuntime({
        pid: null,
        startedAt: null,
        entryPath: current.status.entryPath,
        logPath: current.status.logPath,
      });
      yield* Ref.update(stateRef, (s) => ({
        ...s,
        pid: null,
        startedAt: null,
        consecutiveHealthFailures: 0,
        status: {
          ...s.status,
          running: false,
          pid: null,
          startedAt: null,
          alert: s.status.alert?.code === "process_exited" ? null : s.status.alert,
        },
      }));
      return yield* refreshStatus({ runHealthProbe: false });
    },
  );

  const acknowledgeAlert: Effect.Effect<ExternalTunnelStatus> = Effect.gen(function* () {
    const now = formatIsoFromMs(yield* Clock.currentTimeMillis);
    const updated = yield* Ref.modify(stateRef, (s) => {
      if (s.status.alert === null) {
        return [s.status, s] as const;
      }
      const nextAlert: ExternalTunnelAlert = {
        ...s.status.alert,
        acknowledgedAt: now,
      };
      const nextStatus: ExternalTunnelStatus = {
        ...s.status,
        alert: nextAlert,
      };
      return [
        nextStatus,
        {
          ...s,
          acknowledgedAlertId: nextAlert.id,
          status: nextStatus,
        },
      ] as const;
    });
    return yield* publishStatus(updated);
  });

  // Continuous background monitor fiber (survives individual WS reconnects, stops with server).
  yield* Effect.gen(function* () {
    // Initial gentle delay so server startup completes first.
    yield* Effect.sleep(Duration.seconds(2));
    while (true) {
      const settings = yield* readTunnelSettings;
      const shouldMonitor =
        settings.enabled ||
        settings.healthUrl.trim().length > 0 ||
        (yield* Ref.get(stateRef)).pid !== null;
      if (shouldMonitor) {
        yield* refreshStatus({ runHealthProbe: settings.healthUrl.trim().length > 0 }).pipe(
          Effect.ignore,
        );
      }
      const intervalSec = Math.max(5, Math.min(3600, settings.monitorIntervalSec || 30));
      yield* Effect.sleep(Duration.seconds(intervalSec));
    }
  }).pipe(Effect.forkScoped);

  const scan = (
    input: ExternalTunnelScanInput,
  ): Stream.Stream<ExternalTunnelScanEvent, ExternalTunnelOperationError> =>
    Stream.callback<ExternalTunnelScanEvent, ExternalTunnelOperationError>((queue) => {
      const emit = (event: ExternalTunnelScanEvent) => {
        Queue.offerUnsafe(queue, event);
      };

      return Effect.tryPromise({
        try: async () => {
          const root = expandUserPath(input.searchPath || NodeOS.homedir());
          const stat = await NodeFSP.stat(root).catch(() => null);
          if (!stat) {
            throw new ExternalTunnelOperationError({
              code: "scan_path_not_found",
              message: `Search path does not exist: ${root}`,
            });
          }

          const candidates: ExternalTunnelCandidate[] = [];
          const seenPaths = new Set<string>();
          const maxDepth = Math.max(1, Math.min(8, input.maxDepth ?? 5));

          const addCandidate = async (filePath: string) => {
            const normalized = NodePath.resolve(filePath);
            if (seenPaths.has(normalized)) return;
            const match = classifyTunnelCandidate(normalized);
            if (!match) return;
            seenPaths.add(normalized);
            const candidateLog = defaultLogPathForEntry(normalized);
            const logExists = await NodeFSP.stat(candidateLog)
              .then((s) => s.isFile())
              .catch(() => false);
            candidates.push({
              path: normalized,
              kind: match.kind,
              label: match.label,
              confidence: match.confidence,
              suggestedLogPath: logExists ? candidateLog : null,
            });
          };

          if (stat.isFile()) {
            await addCandidate(root);
            emit({
              type: "complete",
              scannedDirs: 1,
              scannedFiles: 1,
              truncated: false,
              candidates,
            });
            return;
          }

          const dirQueue: Array<{ readonly dir: string; readonly depth: number }> = [
            { dir: NodePath.resolve(root), depth: 0 },
          ];
          let scannedDirs = 0;
          let scannedFiles = 0;
          let truncated = false;
          let lastEmitAt = 0;
          let lastCandidateCount = 0;

          while (dirQueue.length > 0) {
            if (scannedDirs >= MAX_SCAN_DIRS || candidates.length >= MAX_SCAN_CANDIDATES) {
              truncated = true;
              break;
            }
            const next = dirQueue.shift()!;
            scannedDirs += 1;

            let entries: NodeFS.Dirent[];
            try {
              entries = await NodeFSP.readdir(next.dir, { withFileTypes: true });
            } catch {
              continue;
            }

            for (const entry of entries) {
              const fullPath = NodePath.join(next.dir, entry.name);
              if (entry.isFile()) {
                scannedFiles += 1;
                await addCandidate(fullPath);
              } else if (entry.isDirectory() && next.depth < maxDepth) {
                if (!SKIP_SCAN_DIR_NAMES.has(entry.name.toLowerCase())) {
                  dirQueue.push({ dir: fullPath, depth: next.depth + 1 });
                }
              }
            }

            // @effect-diagnostics-next-line globalDateInEffect:off - Wall-clock throttle for scan progress streaming.
            const now = Date.now();
            if (now - lastEmitAt >= 120 || candidates.length !== lastCandidateCount) {
              lastEmitAt = now;
              lastCandidateCount = candidates.length;
              const estTotal = Math.max(scannedDirs + dirQueue.length, 1);
              const percent = Math.min(99, Math.round((scannedDirs / estTotal) * 100));
              emit({
                type: "progress",
                scannedDirs,
                scannedFiles,
                currentDir: next.dir,
                percent,
                candidates: [...candidates],
              });
            }

            // Yield to Node event loop periodically so T3 Server stays completely responsive.
            if (scannedDirs % SCAN_YIELD_EVERY_DIRS === 0) {
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }

          const confidenceRank = { high: 0, medium: 1, low: 2 } as const;
          const kindRank: Record<ExternalTunnelCandidateKind, number> = {
            launcher: 0,
            hysteria: 1,
            frpc: 2,
            ssh_script: 3,
            cloudflared: 4,
            other: 5,
          };
          candidates.sort(
            (a, b) =>
              confidenceRank[a.confidence] - confidenceRank[b.confidence] ||
              kindRank[a.kind] - kindRank[b.kind] ||
              a.path.localeCompare(b.path),
          );

          emit({
            type: "complete",
            scannedDirs,
            scannedFiles,
            truncated,
            candidates,
          });
        },
        catch: (error) =>
          isExternalTunnelOperationError(error)
            ? error
            : new ExternalTunnelOperationError({
                code: "scan_failed",
                message: error instanceof Error ? error.message : String(error),
              }),
      }).pipe(
        Effect.catch((error) => Queue.fail(queue, error).pipe(Effect.ignore)),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkDetach,
      );
    });

  const runInstall = (
    input: ExternalTunnelInstallInput,
  ): Stream.Stream<ExternalTunnelInstallEvent, ExternalTunnelOperationError> =>
    Stream.callback<ExternalTunnelInstallEvent, ExternalTunnelOperationError>((queue) => {
      const emit = (event: ExternalTunnelInstallEvent) => {
        Queue.offerUnsafe(queue, event);
      };
      const emitProgress = async (stage: string, message: string, percent: number) => {
        emit({
          type: "progress",
          stage,
          message,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
        });
      };

      return Effect.gen(function* () {
        const prepared = yield* Effect.tryPromise({
          try: async () => {
            const installDir = NodePath.resolve(
              expandUserPath(input.installDir || defaultTunnelDir()),
            );
            const binDir = NodePath.join(installDir, "bin");
            const configDir = NodePath.join(installDir, "config");
            const logDir = NodePath.join(installDir, "logs");
            const tools: ReadonlyArray<ExternalTunnelToolName> =
              input.tools !== undefined ? input.tools : ["hysteria", "frpc"];
            const mode: ExternalTunnelMode = input.mode ?? "auto";
            const remotePort = input.remotePort ?? 3773;
            const localPort = input.localPort ?? 3773;
            const sshTarget = (input.sshTarget ?? "my-vps").trim() || "my-vps";

            await emitProgress("prepare", `Preparing directories in ${installDir}`, 5);
            await NodeFSP.mkdir(binDir, { recursive: true });
            await NodeFSP.mkdir(configDir, { recursive: true });
            await NodeFSP.mkdir(logDir, { recursive: true });

            const installedTools: ExternalTunnelInstalledTool[] = [];
            const perToolSpan = Math.floor(65 / Math.max(1, tools.length));
            let basePercent = 10;

            for (const tool of tools) {
              if (tool === "hysteria") {
                const asset = buildHysteriaAssetInfo(
                  HYSTERIA_DEFAULT_VERSION,
                  hostPlatform,
                  hostArch,
                );
                const targetPath = NodePath.join(binDir, asset.binaryName);
                const alreadyExists = await NodeFSP.stat(targetPath)
                  .then((s) => s.isFile() && s.size > 1_000_000)
                  .catch(() => false);
                if (!alreadyExists) {
                  await emitProgress(
                    "download_hysteria",
                    `Downloading ${asset.fileName}...`,
                    basePercent,
                  );
                  await downloadFileWithProgress(asset.url, targetPath, (loaded, total) => {
                    const ratio = total && total > 0 ? loaded / total : 0.5;
                    void emitProgress(
                      "download_hysteria",
                      `Downloading hysteria (${(loaded / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ""})`,
                      basePercent + ratio * (perToolSpan - 5),
                    );
                  });
                  if (hostPlatform !== "win32") {
                    await NodeFSP.chmod(targetPath, 0o755);
                  }
                } else {
                  await emitProgress(
                    "download_hysteria",
                    `Reusing existing ${asset.binaryName}`,
                    basePercent + perToolSpan - 5,
                  );
                }
                const probe = await probeBinaryVersion("hysteria", targetPath);
                installedTools.push({
                  tool: "hysteria",
                  path: targetPath,
                  version: probe.version,
                  blockedByAv: probe.blockedByAv,
                  ...(probe.note ? { note: probe.note } : {}),
                });
              } else if (tool === "frpc") {
                const asset = buildFrpcAssetInfo(FRP_DEFAULT_VERSION, hostPlatform, hostArch);
                const targetPath = NodePath.join(binDir, asset.binaryName);
                const alreadyExists = await NodeFSP.stat(targetPath)
                  .then((s) => s.isFile() && s.size > 1_000_000)
                  .catch(() => false);
                if (!alreadyExists) {
                  const archivePath = NodePath.join(binDir, asset.fileName);
                  await emitProgress(
                    "download_frpc",
                    `Downloading ${asset.fileName}...`,
                    basePercent,
                  );
                  await downloadFileWithProgress(asset.url, archivePath, (loaded, total) => {
                    const ratio = total && total > 0 ? loaded / total : 0.5;
                    void emitProgress(
                      "download_frpc",
                      `Downloading frpc (${(loaded / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ""})`,
                      basePercent + ratio * (perToolSpan - 8),
                    );
                  });
                  await emitProgress(
                    "extract_frpc",
                    `Extracting ${asset.binaryName}...`,
                    basePercent + perToolSpan - 6,
                  );
                  await extractFrpcBinary(
                    archivePath,
                    asset.archive,
                    binDir,
                    asset.binaryName,
                    hostPlatform,
                  );
                  await NodeFSP.rm(archivePath, { force: true }).catch(() => {});
                } else {
                  await emitProgress(
                    "download_frpc",
                    `Reusing existing ${asset.binaryName}`,
                    basePercent + perToolSpan - 5,
                  );
                }
                const probe = await probeBinaryVersion("frpc", targetPath);
                installedTools.push({
                  tool: "frpc",
                  path: targetPath,
                  version: probe.version,
                  blockedByAv: probe.blockedByAv,
                  ...(probe.note ? { note: probe.note } : {}),
                });
              }
              basePercent += perToolSpan;
            }

            await emitProgress(
              "configure",
              "Writing tunnel configuration & launcher scripts...",
              82,
            );

            if (input.serverAddress && input.hy2Auth) {
              const sni = (input.sni || input.serverAddress.split(":")[0] || "example.com").trim();
              await NodeFSP.writeFile(
                NodePath.join(configDir, "hysteria.yaml"),
                buildHysteriaYaml({
                  serverAddress: input.serverAddress.trim(),
                  sni,
                  hy2Auth: input.hy2Auth.trim(),
                }),
                "utf8",
              );
            }

            if (input.frpToken) {
              await NodeFSP.writeFile(
                NodePath.join(configDir, "frpc.toml"),
                buildFrpcToml({
                  frpToken: input.frpToken.trim(),
                  remotePort,
                  localPort,
                  proxyName: `t3-${remotePort}`,
                }),
                "utf8",
              );
            }

            let entryPath: string;
            if (hostPlatform === "win32") {
              entryPath = NodePath.join(installDir, "t3-tunnel.ps1");
              await NodeFSP.writeFile(
                entryPath,
                generateWindowsLauncherScript({
                  installDir,
                  mode,
                  sshTarget,
                  remotePort,
                  localPort,
                }),
                "utf8",
              );
              const cmdPath = NodePath.join(installDir, "t3-tunnel.cmd");
              await NodeFSP.writeFile(
                cmdPath,
                `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0t3-tunnel.ps1" %*\r\n`,
                "utf8",
              );
            } else {
              entryPath = NodePath.join(installDir, "t3-tunnel.sh");
              await NodeFSP.writeFile(
                entryPath,
                generatePosixLauncherScript({
                  installDir,
                  mode,
                  sshTarget,
                  remotePort,
                  localPort,
                }),
                "utf8",
              );
              await NodeFSP.chmod(entryPath, 0o755);
            }

            const logPath = NodePath.join(logDir, "t3-tunnel.log");
            return { installDir, entryPath, logPath, installedTools };
          },
          catch: (error) =>
            isExternalTunnelOperationError(error)
              ? error
              : new ExternalTunnelOperationError({
                  code: "install_failed",
                  message: error instanceof Error ? error.message : String(error),
                }),
        });

        emit({
          type: "progress",
          stage: "save_settings",
          message: "Updating T3 Code external tunnel settings...",
          percent: 92,
        });

        const currentSettings = yield* readTunnelSettings;
        const nextSettings: ExternalTunnelSettings = {
          ...currentSettings,
          enabled: true,
          entryPath: prepared.entryPath,
          logPath: prepared.logPath,
          ...(input.healthUrl !== undefined ? { healthUrl: input.healthUrl.trim() } : {}),
        };
        yield* serverSettings.updateSettings({ externalTunnel: nextSettings }).pipe(Effect.ignore);

        let status: ExternalTunnelStatus;
        if (input.autoStart) {
          emit({
            type: "progress",
            stage: "start",
            message: "Starting external tunnel...",
            percent: 96,
          });
          status = yield* startTunnel.pipe(
            Effect.catch(() => refreshStatus({ runHealthProbe: true })),
          );
        } else {
          status = yield* refreshStatus({ runHealthProbe: true });
        }

        emit({
          type: "complete",
          installDir: prepared.installDir,
          entryPath: prepared.entryPath,
          logPath: prepared.logPath,
          installedTools: prepared.installedTools,
          status,
        });
      }).pipe(
        Effect.catch((error) => Queue.fail(queue, error).pipe(Effect.ignore)),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkDetach,
      );
    });

  const exportBundle = Effect.fn("ExternalTunnelService.exportBundle")(function* (
    input: ExternalTunnelBundleExportInput,
  ) {
    const settings = yield* readTunnelSettings;
    const hostSlug =
      input.targetHostName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "host";
    const remotePort = Math.max(1024, Math.min(65535, input.remotePort));

    const baseDir = settings.entryPath.trim()
      ? NodePath.dirname(expandUserPath(settings.entryPath))
      : defaultTunnelDir();
    const hy2Text = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(baseDir, "config", "hysteria.yaml"), "utf8").catch(() => ""),
    );
    const frpText = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(baseDir, "config", "frpc.toml"), "utf8").catch(() => ""),
    );

    const serverAddress =
      parseSimpleConfigValue(hy2Text, /^server:\s*(.+)$/m) ?? "vps.example.com:443";
    const sni = parseSimpleConfigValue(hy2Text, /^\s*sni:\s*(.+)$/m) ?? "example.com";
    const hy2Auth = parseSimpleConfigValue(hy2Text, /^auth:\s*(.+)$/m);
    const frpToken = parseSimpleConfigValue(frpText, /^auth\.token\s*=\s*"([^"]+)"/m);

    const subdomain = input.subdomain?.trim() || `t3-${hostSlug}.${sni.replace(/^www\./, "")}`;
    const includeCreds = input.includeCredentials === true;

    const bundle: PortableTunnelBundle = {
      version: 1,
      targetHostName: input.targetHostName.trim() || hostSlug,
      serverAddress,
      sni,
      ...(includeCreds && hy2Auth ? { hy2Auth } : { hy2Auth: "<REPLACE_WITH_HY2_AUTH>" }),
      ...(includeCreds && frpToken ? { frpToken } : { frpToken: "<REPLACE_WITH_FRP_TOKEN>" }),
      remotePort,
      localPort: 3773,
      healthUrl: `https://${subdomain}/.well-known/t3/environment`,
      mode: "auto",
    };

    const caddySnippet = buildCaddySnippet(subdomain, remotePort);
    const summary = `New host "${bundle.targetHostName}" -> ${subdomain} (VPS 127.0.0.1:${remotePort} -> local 127.0.0.1:3773).`;

    return {
      // @effect-diagnostics-next-line globalJsonInEffect:off - PortableTunnelBundle is a plain serializable record.
      bundleJson: JSON.stringify(bundle, null, 2),
      caddySnippet,
      summary,
    };
  });

  const importBundle = (
    input: ExternalTunnelBundleImportInput,
  ): Stream.Stream<ExternalTunnelInstallEvent, ExternalTunnelOperationError> => {
    let parsed: PortableTunnelBundle;
    try {
      const raw = JSON.parse(input.bundleJson) as Partial<PortableTunnelBundle>;
      if (raw.version !== 1 || typeof raw.remotePort !== "number") {
        return Stream.fail(
          new ExternalTunnelOperationError({
            code: "invalid_bundle",
            message: "Invalid tunnel bundle JSON (expected version: 1 and numeric remotePort).",
          }),
        );
      }
      parsed = raw as PortableTunnelBundle;
    } catch (error) {
      return Stream.fail(
        new ExternalTunnelOperationError({
          code: "invalid_bundle",
          message: `Failed to parse bundle JSON: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    }

    const hy2Auth =
      parsed.hy2Auth && !parsed.hy2Auth.startsWith("<REPLACE_") ? parsed.hy2Auth : undefined;
    const frpToken =
      parsed.frpToken && !parsed.frpToken.startsWith("<REPLACE_") ? parsed.frpToken : undefined;

    return runInstall({
      ...(input.installDir ? { installDir: input.installDir } : {}),
      tools: input.autoInstallTools === false ? [] : ["hysteria", "frpc"],
      ...(parsed.serverAddress ? { serverAddress: parsed.serverAddress } : {}),
      ...(parsed.sni ? { sni: parsed.sni } : {}),
      ...(hy2Auth ? { hy2Auth } : {}),
      ...(frpToken ? { frpToken } : {}),
      remotePort: parsed.remotePort,
      localPort: parsed.localPort ?? 3773,
      ...(parsed.sshTarget ? { sshTarget: parsed.sshTarget } : {}),
      ...(parsed.healthUrl ? { healthUrl: parsed.healthUrl } : {}),
      ...(parsed.mode ? { mode: parsed.mode } : {}),
      autoStart: input.autoStart ?? false,
    });
  };

  return {
    getStatus: refreshStatus({ runHealthProbe: false }),
    subscribe: Effect.gen(function* () {
      const initial = yield* Ref.get(stateRef).pipe(Effect.map((s) => s.status));
      return {
        initial,
        changes: Stream.fromPubSub(pubsub),
      };
    }),
    action: (input) => {
      switch (input.action) {
        case "start":
          return startTunnel;
        case "stop":
          return stopTunnel;
        case "restart":
          return stopTunnel.pipe(
            Effect.andThen(Effect.sleep(Duration.millis(300))),
            Effect.andThen(startTunnel),
          );
        case "check":
          return refreshStatus({ runHealthProbe: true });
        case "acknowledgeAlert":
          return acknowledgeAlert;
      }
    },
    scan,
    install: runInstall,
    exportBundle,
    importBundle,
  } satisfies ExternalTunnelService["Service"];
});

export const layer = Layer.effect(ExternalTunnelService, make);
