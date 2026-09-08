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
    return AccountingCount(job, 36);
  }
  public static int ActiveProcesses(IntPtr job) {
    return AccountingCount(job, 40);
  }
  private static int AccountingCount(IntPtr job, int offset) {
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four LARGE_INTEGER fields,
    // then TotalPageFaultCount and TotalProcesses.
    IntPtr buffer = Marshal.AllocHGlobal(48);
    try {
      if (!QueryInformationJobObject(job, 1, buffer, 48, IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception();
      return Marshal.ReadInt32(buffer, offset);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@
$taskJob = [DiagnosticTestJob]::CreateJobObject([IntPtr]::Zero, $null)
if ($taskJob -eq [IntPtr]::Zero) { throw "Could not create diagnostic test job." }
$taskObserver = $null
$taskChild = $null
$taskSurvivor = $null
$taskTempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$taskFixtureRoot = [IO.Path]::GetFullPath((Join-Path $taskTempParent ('rion-job-root-' + [Guid]::NewGuid().ToString('N'))))
try {
  [void][IO.Directory]::CreateDirectory($taskFixtureRoot)
  $taskRootExecutable = Join-Path $taskFixtureRoot 'diagnostic-root.exe'
  $taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $taskCompiler -PathType Leaf)) { throw 'Native fixture compiler unavailable.' }
  & $taskCompiler /nologo /target:winexe "/out:$taskRootExecutable" (Join-Path $PSScriptRoot 'windows-job-diagnostic-root.cs')
  if ($LASTEXITCODE -ne 0) { throw 'GUI diagnostic root compilation failed.' }
  $taskImage = [IO.File]::ReadAllBytes($taskRootExecutable)
  $taskPeOffset = [BitConverter]::ToInt32($taskImage, 0x3c)
  $taskRootSubsystem = [BitConverter]::ToUInt16($taskImage, $taskPeOffset + 4 + 20 + 68)
  if ($taskRootSubsystem -ne 2) { throw 'Diagnostic root must use the Windows GUI PE subsystem.' }
  $taskObserver = [RionWindowsJobProcessDiagnostics]::new($taskJob)
  $taskStart = [Diagnostics.ProcessStartInfo]::new()
  $taskStart.FileName = $taskRootExecutable
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
  $taskActiveBeforeRelease = @($taskObserver.SnapshotActive())
  $taskActiveSnapshotError = $taskObserver.ActiveSnapshotError
  $taskActiveSnapshotTruncated = $taskObserver.ActiveSnapshotTruncated
  $taskNonConsoleRejected = $null -eq [RionWindowsJobRunner]::DrainSoleConsoleHost($taskJob, 0)
  $taskLiveRootRejected = -not [RionWindowsJobRunner]::CanJoinExitedRootAccounting(
    $taskJob, $taskChild.Handle, $taskChild.Id)
  $taskEmptyWaitRejected = $false
  try { $taskObserver.WaitForEmptyNotification(0) } catch {
    if ($_.Exception.InnerException -isnot [TimeoutException]) { throw }
    $taskEmptyWaitRejected = $true
  }
  $taskChild.StandardInput.WriteLine('continue')
  $taskChild.StandardInput.Close()
  if (-not $taskChild.WaitForExit(5000)) { throw "Diagnostic test child did not finish." }
  if ($taskChild.ExitCode -ne 0) { throw $taskChild.StandardError.ReadToEnd() }
  $taskObserver.WaitForEmptyNotification(5000)
  $taskFinalActive = [DiagnosticTestJob]::ActiveProcesses($taskJob)
  $taskExitedRootCanJoin = [RionWindowsJobRunner]::CanJoinExitedRootAccounting(
    $taskJob, $taskChild.Handle, $taskChild.Id)
  # A prior empty notification must not authorize a different live Job member.
  # The survivor needs only an exact native process blocked on stdin, not a
  # second PowerShell runtime startup inside the test's unchanged deadline.
  $taskSurvivorStart = [Diagnostics.ProcessStartInfo]::new()
  $taskSurvivorStart.FileName = $env:ComSpec
  foreach ($taskArgument in @('/d', '/q', '/c', 'set /p rion_fixture_input= & exit /b 0')) {
    $taskSurvivorStart.ArgumentList.Add($taskArgument)
  }
  $taskSurvivorStart.UseShellExecute = $false
  $taskSurvivorStart.CreateNoWindow = $true
  $taskSurvivorStart.RedirectStandardInput = $true
  $taskSurvivorStart.RedirectStandardOutput = $true
  $taskSurvivorStart.RedirectStandardError = $true
  $taskSurvivorStart.Environment.Clear()
  foreach ($taskName in $taskStart.Environment.Keys) {
    $taskSurvivorStart.Environment[$taskName] = $taskStart.Environment[$taskName]
  }
  $taskSurvivor = [Diagnostics.Process]::Start($taskSurvivorStart)
  if (-not [DiagnosticTestJob]::AssignProcessToJobObject($taskJob, $taskSurvivor.Handle)) {
    throw "Could not bind the accounting-fence survivor to its exact job."
  }
  $taskOtherMemberRejected = -not [RionWindowsJobRunner]::CanJoinExitedRootAccounting(
    $taskJob, $taskChild.Handle, $taskChild.Id)
  $taskSurvivor.StandardInput.WriteLine('continue')
  $taskSurvivor.StandardInput.Close()
  if (-not $taskSurvivor.WaitForExit(5000)) { throw "Accounting-fence survivor did not finish." }
  if ($taskSurvivor.ExitCode -ne 0) { throw $taskSurvivor.StandardError.ReadToEnd() }
  $taskObserver.Dispose()
  [ordered]@{
    platform = 'win32'
    rootProcessId = $taskChild.Id
    rootImagePath = $taskStart.FileName
    rootSubsystem = $taskRootSubsystem
    totalProcesses = [DiagnosticTestJob]::TotalProcesses($taskJob)
    notificationError = $taskObserver.NotificationError
    truncated = $taskObserver.Truncated
    observations = @($taskObserver.Snapshot())
    activeBeforeRelease = $taskActiveBeforeRelease
    activeSnapshotError = $taskActiveSnapshotError
    activeSnapshotTruncated = $taskActiveSnapshotTruncated
    nonConsoleSurvivorRejected = $taskNonConsoleRejected
    liveRootAccountingRejected = $taskLiveRootRejected
    missingEmptyNotificationRejected = $taskEmptyWaitRejected
    finalActiveProcesses = $taskFinalActive
    exitedRootAccountingEligible = $taskExitedRootCanJoin
    otherLiveMemberRejected = $taskOtherMemberRejected
  } | ConvertTo-Json -Depth 4 -Compress
} finally {
  [void][DiagnosticTestJob]::TerminateJobObject($taskJob, 1)
  if ($null -ne $taskSurvivor) {
    if (-not $taskSurvivor.HasExited) { $taskSurvivor.Kill($true); $taskSurvivor.WaitForExit() }
    $taskSurvivor.Dispose()
  }
  if ($null -ne $taskChild) {
    if (-not $taskChild.HasExited) { $taskChild.Kill($true); $taskChild.WaitForExit() }
    $taskChild.Dispose()
  }
  if ($null -ne $taskObserver) { $taskObserver.Dispose() }
  [void][DiagnosticTestJob]::CloseHandle($taskJob)
  if (Test-Path -LiteralPath $taskFixtureRoot) {
    $taskResolvedFixtureRoot = (Resolve-Path -LiteralPath $taskFixtureRoot).ProviderPath
    if (-not $taskResolvedFixtureRoot.StartsWith($taskTempParent, [StringComparison]::OrdinalIgnoreCase) -or
        -not [String]::Equals($taskResolvedFixtureRoot, $taskFixtureRoot, [StringComparison]::OrdinalIgnoreCase) -or
        ((Get-Item -LiteralPath $taskFixtureRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Diagnostic fixture cleanup target changed.'
    }
    Remove-Item -LiteralPath $taskResolvedFixtureRoot -Recurse -Force
  }
}
