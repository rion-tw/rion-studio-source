$ErrorActionPreference = 'Stop'
$taskRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskSource = Join-Path $taskRepository 'scripts\invokeWindowsIsolatedProfileCommand.ps1'
$taskAst = [Management.Automation.Language.Parser]::ParseFile($taskSource, [ref] $null, [ref] $null)
$taskFunction = $taskAst.Find({ param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
  $node.Name -eq 'Get-IsolatedPowerShellFileInvocation'
}, $false).Extent.Text
if (-not $taskFunction) { throw 'The actual invocation parser must be present.' }
# Execute the production parser and final invocation block. The isolated-SID
# prelude remains covered by the hosted profile gate, not forged in this fixture.
. ([ScriptBlock]::Create($taskFunction))
$taskSourceText = Get-Content -LiteralPath $taskSource -Raw
$taskBody = $taskSourceText.Substring($taskSourceText.IndexOf('Push-Location -LiteralPath $envelope.workingDirectory'))
Add-Type -Path @(
  (Join-Path $taskRepository 'scripts\windowsJobObjectRunner.cs'),
  (Join-Path $taskRepository 'scripts\windowsJobProcessDiagnostics.cs'),
  (Join-Path $PSScriptRoot 'windows-inline-powershell-job.cs')
)
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('rion-inline-powershell-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($taskRoot)
try {
  $taskScript = Join-Path $taskRoot 'literal harness.ps1'
  Set-Content -LiteralPath $taskScript -Value @'
param([string] $Marker, [string] $Literal, [string] $Empty, [string] $Code)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText($Marker, (@{literal=$Literal;empty=$Empty;code=$Code} | ConvertTo-Json -Compress))
if ($Code -eq 'throw') { throw 'exact-script-failure' }
& $env:ComSpec /d /c exit $Code
exit $LASTEXITCODE
'@
  $taskExecutable = Join-Path $PSHOME 'pwsh.exe'
  $taskLiteral = 'space '' apostrophe " double ; $([IO.File]::WriteAllText("injected","bad")) ` tick'
  $taskResults = @()
  foreach ($taskCode in @('0', '7', 'throw')) {
    $taskMarker = Join-Path $taskRoot "$taskCode.json"
    $taskErrorPath = Join-Path $taskRoot "$taskCode.error.txt"
    $taskArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $taskScript,
      '-Marker', $taskMarker, '-Literal', $taskLiteral, '-Empty', '', '-Code', $taskCode)
    $taskEnvelope = @{commandPath=$taskExecutable; arguments=$taskArguments;
      invokePowerShellFileInProcess=$true; workingDirectory=$taskRoot} | ConvertTo-Json -Compress
    $taskTrap = "trap { [IO.File]::WriteAllText('" + $taskErrorPath.Replace("'", "''") + "', (`$_ | Out-String)); exit 1 }; "
    $taskCommand = $taskTrap + '$ErrorActionPreference = "Stop"; ' + $taskFunction +
      '; $envelope = ConvertFrom-Json -InputObject ''' + $taskEnvelope.Replace("'", "''") + "'; " + $taskBody
    $taskEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskCommand))
    $taskJob = [InlinePowerShellTestJob]::CreateJobObject([IntPtr]::Zero, $null)
    if ($taskJob -eq [IntPtr]::Zero) { throw 'Fixture Job creation failed.' }
    $taskObserver = [RionWindowsJobProcessDiagnostics]::new($taskJob)
    try {
      $taskResult = [InlinePowerShellTestJob]::Run($taskJob, $taskExecutable, $taskEncoded, $taskRoot, $taskObserver)
      $taskObserver.Dispose()
      $taskResults += @{code=$taskCode;exitCode=$taskResult[0];rootPid=$taskResult[1];
        totalProcesses=$taskResult[2];activeAfterConsoleDrain=$taskResult[3];
        activeAtRootExit=$taskResult[4];drainedConsoleHostProcessId=$taskResult[5];
        marker=(Get-Content -LiteralPath $taskMarker -Raw | ConvertFrom-Json);
        error=$(if (Test-Path -LiteralPath $taskErrorPath) {Get-Content -LiteralPath $taskErrorPath -Raw} else {$null});
        observations=@($taskObserver.Snapshot());notificationError=$taskObserver.NotificationError;
        truncated=$taskObserver.Truncated}
    } finally { $taskObserver.Dispose(); [void][InlinePowerShellTestJob]::CloseHandle($taskJob) }
  }
  $taskRejected = @()
  foreach ($taskCase in @('host','options','pairs','duplicate','parameter','file')) {
    $taskHost = $taskExecutable
    $taskArgs = @('-NoLogo','-NoProfile','-NonInteractive','-File',$taskScript,'-Literal','value')
    switch ($taskCase) {
      'host' { $taskHost = $env:ComSpec }
      'options' { $taskArgs[3] = '-EncodedCommand' }
      'pairs' { $taskArgs += '-Empty' }
      'duplicate' { $taskArgs += @('-literal','duplicate') }
      'parameter' { $taskArgs[5] = '-Literal;throw' }
      'file' { $taskArgs[4] = $taskRoot }
    }
    try { [void](Get-IsolatedPowerShellFileInvocation -CommandPath $taskHost -CommandArguments $taskArgs) }
    catch { $taskRejected += $taskCase }
  }
  @{platform='win32';cases=$taskResults;literal=$taskLiteral;rejected=$taskRejected;
    injected=(Test-Path -LiteralPath (Join-Path $taskRoot 'injected'))} | ConvertTo-Json -Depth 6 -Compress
} finally {
  $taskResolvedRoot = [IO.Path]::GetFullPath($taskRoot)
  $taskTemporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $taskResolvedRoot.StartsWith($taskTemporaryParent, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Fixture cleanup escaped its temporary parent.'
  }
  Remove-Item -LiteralPath $taskResolvedRoot -Recurse -Force
}
