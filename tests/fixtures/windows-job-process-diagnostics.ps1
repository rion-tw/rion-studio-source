$ErrorActionPreference = "Stop"
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Add-Type -Path @(
  (Join-Path $taskRepository "scripts\windowsJobObjectRunner.cs"),
  (Join-Path $taskRepository "scripts\windowsJobProcessDiagnostics.cs")
)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DiagnosticTestJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job, int informationClass, IntPtr information, uint length, IntPtr returnedLength);
  public static int TotalProcesses(IntPtr job) {
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four LARGE_INTEGER fields,
    // then TotalPageFaultCount and TotalProcesses.
    IntPtr buffer = Marshal.AllocHGlobal(48);
    try {
      if (!QueryInformationJobObject(job, 1, buffer, 48, IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception();
      return Marshal.ReadInt32(buffer, 36);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@
$taskJob = [DiagnosticTestJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($taskJob -eq [IntPtr]::Zero) { throw "Could not create diagnostic test job." }
$taskObserver = $null
$taskChild = $null
try {
  $taskObserver = [RionWindowsJobProcessDiagnostics]::new($taskJob)
  $taskStart = [Diagnostics.ProcessStartInfo]::new()
  $taskStart.FileName = Join-Path $PSHOME "pwsh.exe"
  foreach ($taskArgument in @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[void][Console]::ReadLine(); & $env:ComSpec /d /c exit 0'
  )) { $taskStart.ArgumentList.Add($taskArgument) }
  $taskStart.UseShellExecute = $false
  $taskStart.CreateNoWindow = $true
  $taskStart.RedirectStandardInput = $true
  $taskStart.RedirectStandardOutput = $true
  $taskStart.RedirectStandardError = $true
  $taskStart.Environment.Clear()
  foreach ($taskName in @(
    'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATH', 'TEMP', 'TMP',
    'ProgramData', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'
  )) {
    $taskStart.Environment[$taskName] = [Environment]::GetEnvironmentVariable($taskName)
  }
  $taskChild = [Diagnostics.Process]::Start($taskStart)
  if (-not [DiagnosticTestJob]::AssignProcessToJobObject($taskJob, $taskChild.Handle)) {
    throw "Could not bind the diagnostic test process to its exact job."
  }
  $taskChild.StandardInput.WriteLine('continue')
  $taskChild.StandardInput.Close()
  if (-not $taskChild.WaitForExit(5000)) { throw "Diagnostic test child did not finish." }
  if ($taskChild.ExitCode -ne 0) { throw $taskChild.StandardError.ReadToEnd() }
  $taskObserver.Dispose()
  [ordered]@{
    platform = 'win32'
    rootProcessId = $taskChild.Id
    rootImagePath = $taskStart.FileName
    totalProcesses = [DiagnosticTestJob]::TotalProcesses($taskJob)
    notificationError = $taskObserver.NotificationError
    truncated = $taskObserver.Truncated
    observations = @($taskObserver.Snapshot())
  } | ConvertTo-Json -Depth 4 -Compress
} finally {
  [void][DiagnosticTestJob]::TerminateJobObject($taskJob, 1)
  if ($null -ne $taskChild) {
    if (-not $taskChild.HasExited) { $taskChild.Kill($true); $taskChild.WaitForExit() }
    $taskChild.Dispose()
  }
  if ($null -ne $taskObserver) { $taskObserver.Dispose() }
  [void][DiagnosticTestJob]::CloseHandle($taskJob)
}
