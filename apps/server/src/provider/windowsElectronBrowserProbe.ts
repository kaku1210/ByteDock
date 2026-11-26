import { windowsPowerShellPath } from "@t3tools/shared/windowsSystem";
import * as ChildProcess from "effect/process/ChildProcess";

// Electron's process handle and pipe EOF can remain unsignaled on Windows well after its
// exit code is available. Read exactly the bytes left in each pipe once HasExited is true.
const probeScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -Namespace T3 -Name ProbePipe -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool PeekNamedPipe(Microsoft.Win32.SafeHandles.SafeFileHandle handle,
    [System.Runtime.InteropServices.Out] byte[] buffer, uint size, out uint read, out uint available, IntPtr left);
'@
} catch { exit 125 }
function Read-ProbeOutput($stream) {
  [uint32]$available = 0
  [uint32]$read = 0
  $buffer = New-Object byte[] 4096
  if (-not [T3.ProbePipe]::PeekNamedPipe($stream.SafeFileHandle, $buffer, $buffer.Length, [ref]$read, [ref]$available, [IntPtr]::Zero)) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 109 -or $code -eq 233) { return ,([byte[]]@()) }
    throw "Cannot inspect browser helper output (Win32 $code)"
  }
  if ($read -ne $available) { throw 'Incomplete browser helper output' }
  $result = New-Object byte[] $read
  [Array]::Copy($buffer, $result, [int]$read)
  return ,$result
}
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $env:T3_BROWSER_PROBE_EXECUTABLE
$info.Arguments = $env:T3_BROWSER_PROBE_ARGUMENTS
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.EnvironmentVariables['TEMP'] = $env:T3_BROWSER_PROBE_CHILD_TEMP
$info.EnvironmentVariables['TMP'] = $env:T3_BROWSER_PROBE_CHILD_TEMP
$child = [Diagnostics.Process]::Start($info)
try {
  $limit = [Diagnostics.Stopwatch]::StartNew()
  while (-not $child.HasExited) {
    if ($limit.Elapsed.TotalSeconds -ge 25) { throw 'Browser helper did not exit' }
    Start-Sleep -Milliseconds 50
    $child.Refresh()
  }
  $exitCode = $child.ExitCode
  if ($exitCode -eq 125) { $exitCode = 1 }
  if ($exitCode -eq 0) {
    [byte[]]$stdout = Read-ProbeOutput $child.StandardOutput.BaseStream
    if ($stdout.Length -gt 0) { throw 'Unexpected browser helper stdout' }
    [IO.File]::WriteAllBytes($env:T3_BROWSER_PROBE_RESULT, (Read-ProbeOutput $child.StandardError.BaseStream))
  }
} finally {
  if (-not $child.HasExited) { $child.Kill() }
  $child.Dispose()
}
exit $exitCode
`;

/** Record the real helper's stderr only after a successful exit with empty stdout. */
export function windowsElectronBrowserProbe(
  executable: string,
  source: string,
  url: string,
  resultPath: string,
  environment: NodeJS.ProcessEnv,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  // ProcessStartInfo on Windows PowerShell 5.1 accepts a single Windows command line.
  const escapedSource = source.replace(/(\\*)"/g, '$1$1\\"');
  return ChildProcess.make(
    windowsPowerShellPath(hostEnvironment),
    ["-NoProfile", "-NonInteractive", "-Command", probeScript],
    {
      env: {
        ...environment,
        // The Windows PowerShell compiler uses TEMP before the profile directory exists.
        TEMP: hostEnvironment.TEMP,
        TMP: hostEnvironment.TMP,
        T3_BROWSER_PROBE_CHILD_TEMP: environment.TEMP,
        T3_BROWSER_PROBE_EXECUTABLE: executable,
        T3_BROWSER_PROBE_ARGUMENTS: `-e "${escapedSource}" -- "${url}"`,
        T3_BROWSER_PROBE_RESULT: resultPath,
      },
      extendEnv: false,
      shell: false,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
}
