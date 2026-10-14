param([Parameter(Mandatory = $true)][string] $FixtureRoot)
$ErrorActionPreference = "Stop"
$taskStageClock = [Diagnostics.Stopwatch]::StartNew()
function Write-DiagnosticStage([string] $Stage) {
  # Bounded test-only observations; stages never determine native Job success.
  [Console]::Error.WriteLine(('RION_JOB_DIAGNOSTIC_STAGE=' + ([ordered]@{
    stage = $Stage; milliseconds = $taskStageClock.ElapsedMilliseconds
  } | ConvertTo-Json -Compress)))
}
Write-DiagnosticStage 'powershell-started'
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Add-Type -Path @(
  (Join-Path $taskRepository "scripts\windowsJobObjectRunner.cs"),
  (Join-Path $taskRepository "scripts\windowsJobProcessDiagnostics.cs")
)
Write-DiagnosticStage 'production-types-compiled'
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
  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetInformationJobObject(
    IntPtr job, int informationClass, ref ExtendedLimits information, uint length);
  public static IntPtr CreateOwnedJob() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
      int error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      throw new System.ComponentModel.Win32Exception(error);
    }
    return job;
  }
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
Write-DiagnosticStage 'test-types-compiled'
$taskJob = [IntPtr]::Zero
$taskObserver = $null
$taskChild = $null
$taskSurvivor = $null
$taskCompilerJob = [IntPtr]::Zero
$taskCompilerProcess = $null
$taskTempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$taskFixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
if (-not $taskFixtureRoot.StartsWith($taskTempParent, [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFileName($taskFixtureRoot).StartsWith('rion-job-root-', [StringComparison]::Ordinal)) -or
    -not (Test-Path -LiteralPath $taskFixtureRoot -PathType Container) -or
    ((Get-Item -LiteralPath $taskFixtureRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'Diagnostic fixture setup target is not its owned temporary directory.'
}
try {
  $taskRootExecutable = Join-Path $taskFixtureRoot 'diagnostic-root.exe'
  $taskCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path -LiteralPath $taskCompiler -PathType Leaf)) { throw 'Native fixture compiler unavailable.' }
  # Compilation has its own cleanup Job and never enters the native test Job.
  # Closing the retained PowerShell process also closes this exact owned Job.
  $taskCompilerJob = [DiagnosticTestJob]::CreateOwnedJob()
  $taskCompilerStart = [Diagnostics.ProcessStartInfo]::new()
  $taskCompilerStart.FileName = $taskCompiler
  foreach ($taskArgument in @('/nologo', '/target:winexe', "/out:$taskRootExecutable",
      (Join-Path $PSScriptRoot 'windows-job-diagnostic-root.cs'))) {
    $taskCompilerStart.ArgumentList.Add($taskArgument)
  }
  $taskCompilerStart.UseShellExecute = $false
  $taskCompilerStart.CreateNoWindow = $true
  $taskCompilerStart.RedirectStandardOutput = $true
  $taskCompilerStart.RedirectStandardError = $true
  $taskCompilerProcess = [Diagnostics.Process]::Start($taskCompilerStart)
  if (-not [DiagnosticTestJob]::AssignProcessToJobObject($taskCompilerJob, $taskCompilerProcess.Handle)) {
    throw 'Could not bind the exact fixture compiler to its cleanup Job.'
  }
  $taskCompilerOutput = $taskCompilerProcess.StandardOutput.ReadToEnd()
  $taskCompilerError = $taskCompilerProcess.StandardError.ReadToEnd()
  $taskCompilerProcess.WaitForExit()
  if ($taskCompilerProcess.ExitCode -ne 0) {
    throw ('GUI diagnostic root compilation failed: ' + $taskCompilerOutput + $taskCompilerError)
  }
  $taskCompilerProcess.Dispose()
  $taskCompilerProcess = $null
  [void][DiagnosticTestJob]::CloseHandle($taskCompilerJob)
  $taskCompilerJob = [IntPtr]::Zero
  Write-DiagnosticStage 'gui-root-compiled'
  $taskImage = [IO.File]::ReadAllBytes($taskRootExecutable)
  $taskPeOffset = [BitConverter]::ToInt32($taskImage, 0x3c)
  $taskRootSubsystem = [BitConverter]::ToUInt16($taskImage, $taskPeOffset + 4 + 20 + 68)
  if ($taskRootSubsystem -ne 2) { throw 'Diagnostic root must use the Windows GUI PE subsystem.' }
  # Setup owns compilation only. No native test Job/observer/GUI exists before the
  # same retained parent sends the exact native-behavior token from the test.
  [Console]::Out.WriteLine('RION_JOB_DIAGNOSTIC_SETUP_READY')
  [Console]::Out.Flush()
  $taskRunToken = [Console]::In.ReadLine()
  if ($taskRunToken -cne 'RION_JOB_DIAGNOSTIC_RUN_NATIVE') {
    throw 'Diagnostic fixture did not receive its exact native-behavior token.'
  }
  Write-DiagnosticStage 'native-behavior-started'
  $taskJob = [DiagnosticTestJob]::CreateOwnedJob()
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
  Write-DiagnosticStage 'root-assigned'
  $taskActiveBeforeRelease = @($taskObserver.SnapshotActive())
  $taskActiveSnapshotError = $taskObserver.ActiveSnapshotError
  $taskActiveSnapshotTruncated = $taskObserver.ActiveSnapshotTruncated
  $taskNonConsoleRejected = $null -eq [RionWindowsJobRunner]::DrainSoleConsoleHost($taskJob, 0)
  $taskLiveRootRejected = -not [RionWindowsJobRunner]::CanJoinExitedRootAccounting(
    $taskJob, $taskChild.Handle, $taskChild.Id)
  $taskLiveRootRejected = $taskLiveRootRejected -and -not [RionWindowsJobRunner]::CanJoinExitedRootAccounting(
    $taskJob, $taskChild.Handle, $taskChild.Id, $true, $taskObserver)
  $taskEmptyWaitRejected = $false
  try { $taskObserver.WaitForEmptyNotification(0) } catch {
    if ($_.Exception.InnerException -isnot [TimeoutException]) { throw }
    $taskEmptyWaitRejected = $true
  }
  $taskChild.StandardInput.WriteLine('continue')
  $taskChild.StandardInput.Close()
  if (-not $taskChild.WaitForExit(5000)) { throw "Diagnostic test child did not finish." }
  if ($taskChild.ExitCode -ne 0) { throw $taskChild.StandardError.ReadToEnd() }
  Write-DiagnosticStage 'root-exited'
  $taskObserver.WaitForEmptyNotification(5000)
  Write-DiagnosticStage 'empty-notification-received'
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
  $taskOtherMemberRejected = $taskOtherMemberRejected -and -not [RionWindowsJobRunner]::CanJoinExitedRootAccounting(
    $taskJob, $taskChild.Handle, $taskChild.Id, $true, $taskObserver)
  $taskSurvivor.StandardInput.WriteLine('continue')
  $taskSurvivor.StandardInput.Close()
  if (-not $taskSurvivor.WaitForExit(5000)) { throw "Accounting-fence survivor did not finish." }
  if ($taskSurvivor.ExitCode -ne 0) { throw $taskSurvivor.StandardError.ReadToEnd() }
  Write-DiagnosticStage 'survivor-exited'
  $taskObserver.Dispose()
  Write-DiagnosticStage 'observer-disposed'
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
  if ($taskCompilerJob -ne [IntPtr]::Zero) {
    [void][DiagnosticTestJob]::TerminateJobObject($taskCompilerJob, 1)
  }
  if ($null -ne $taskCompilerProcess) {
    if (-not $taskCompilerProcess.HasExited) {
      $taskCompilerProcess.Kill($true)
      $taskCompilerProcess.WaitForExit()
    }
    $taskCompilerProcess.Dispose()
  }
  if ($taskCompilerJob -ne [IntPtr]::Zero) {
    [void][DiagnosticTestJob]::CloseHandle($taskCompilerJob)
  }
  if ($taskJob -ne [IntPtr]::Zero) { [void][DiagnosticTestJob]::TerminateJobObject($taskJob, 1) }
  if ($null -ne $taskSurvivor) {
    if (-not $taskSurvivor.HasExited) { $taskSurvivor.Kill($true); $taskSurvivor.WaitForExit() }
    $taskSurvivor.Dispose()
  }
  if ($null -ne $taskChild) {
    if (-not $taskChild.HasExited) { $taskChild.Kill($true); $taskChild.WaitForExit() }
    $taskChild.Dispose()
  }
  if ($null -ne $taskObserver) { $taskObserver.Dispose() }
  if ($taskJob -ne [IntPtr]::Zero) { [void][DiagnosticTestJob]::CloseHandle($taskJob) }
  if (Test-Path -LiteralPath $taskFixtureRoot) {
    $taskResolvedFixtureRoot = (Resolve-Path -LiteralPath $taskFixtureRoot).ProviderPath
    if (-not $taskResolvedFixtureRoot.StartsWith($taskTempParent, [StringComparison]::OrdinalIgnoreCase) -or
        -not [String]::Equals($taskResolvedFixtureRoot, $taskFixtureRoot, [StringComparison]::OrdinalIgnoreCase) -or
        ((Get-Item -LiteralPath $taskFixtureRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Diagnostic fixture cleanup target changed.'
    }
    Remove-Item -LiteralPath $taskResolvedFixtureRoot -Recurse -Force
  }
  Write-DiagnosticStage 'cleanup-complete'
}
