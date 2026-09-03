param(
  [Parameter(Mandatory = $true)]
  [string] $ApplicationPath,

  [Parameter(Mandatory = $true)]
  [string] $ArtifactPath,

  [Parameter(Mandatory = $true)]
  [string] $OutputPath,

  [Parameter(Mandatory = $true)]
  [string] $RepositoryRoot,

  [Parameter(Mandatory = $true)]
  [string] $SourceSha,

  [Parameter(Mandatory = $true)]
  [string] $Version,

  [Parameter()]
  [string] $UnsignedInputRoot
)

$ErrorActionPreference = "Stop"

if (
  -not $IsWindows -or
  $env:CI -ne "true" -or
  $env:GITHUB_ACTIONS -ne "true" -or
  $env:RION_WINDOWS_PROFILE_ISOLATION_ALLOWED -ne "true"
) {
  throw "The Electron NSIS payload proof is restricted to an explicit GitHub-hosted Windows runner."
}
if (@(Get-ChildItem Env: | Where-Object {
  $_.Name.StartsWith("TAURI_SIGNING_", [StringComparison]::OrdinalIgnoreCase) -or
  $_.Name.StartsWith("RION_STUDIO_UPDATER_PRIVATE_", [StringComparison]::OrdinalIgnoreCase)
}).Count -ne 0) {
  throw "The Electron NSIS payload proof must run before updater private-key scope."
}
if ($SourceSha -notmatch '^[0-9a-f]{40}$') {
  throw "The Electron NSIS payload proof requires an exact lowercase source SHA."
}

$repository = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
if ($repository -ne $workspace) {
  throw "The Electron NSIS payload proof repository must equal the checked-out workspace."
}
$application = (Resolve-Path -LiteralPath $ApplicationPath).Path
$artifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$expectedInputRoot = Join-Path $repository "release\electron"
if ($UnsignedInputRoot) {
  $runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
  $expectedUnsignedInputRoot = (Resolve-Path -LiteralPath $UnsignedInputRoot).Path
  $unsignedRootItem = Get-Item -LiteralPath $expectedUnsignedInputRoot -Force
  $unsignedRootRelative = [IO.Path]::GetRelativePath(
    $runnerTemp,
    $expectedUnsignedInputRoot
  )
  if (
    -not $unsignedRootItem.PSIsContainer -or
    ($unsignedRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $unsignedRootRelative -eq "." -or
    [IO.Path]::IsPathFullyQualified($unsignedRootRelative) -or
    $unsignedRootRelative -eq ".." -or
    $unsignedRootRelative.StartsWith("..\", [StringComparison]::Ordinal)
  ) {
    throw "The Electron NSIS payload proof unsigned input root must be a real RUNNER_TEMP child."
  }
  $expectedInputRoot = Join-Path $expectedUnsignedInputRoot "release\electron"
}
foreach ($inputDirectory in @(
  (Split-Path -Parent $expectedInputRoot),
  $expectedInputRoot
)) {
  $inputDirectoryItem = Get-Item -LiteralPath $inputDirectory -Force -ErrorAction Stop
  if (
    -not $inputDirectoryItem.PSIsContainer -or
    ($inputDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The Electron NSIS payload proof input boundary must contain only real directories."
  }
}
if ($application -ne (Join-Path $expectedInputRoot "win-unpacked")) {
  throw "The Electron NSIS payload proof application must be the exact packaged win-unpacked directory."
}
if ($artifact -ne (Join-Path $expectedInputRoot "Rion.Studio-win.exe")) {
  throw "The Electron NSIS payload proof artifact must be the exact packaged NSIS path."
}

$outputParent = Split-Path -Parent $OutputPath
$resolvedOutputParent = (Resolve-Path -LiteralPath $outputParent).Path
$expectedOutput = Join-Path $resolvedOutputParent "windows-installer-payload-proof.json"
if ([IO.Path]::GetFullPath($OutputPath) -ne $expectedOutput) {
  throw "The Electron NSIS payload proof output must use its fixed filename."
}
if (Test-Path -LiteralPath $expectedOutput) {
  throw "The Electron NSIS payload proof output must be create-new."
}
$outputParentItem = Get-Item -LiteralPath $resolvedOutputParent -Force
if (
  -not $outputParentItem.PSIsContainer -or
  ($outputParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The Electron NSIS payload proof output parent must be a real directory."
}

function Protect-ProofDirectory {
  param([Parameter(Mandatory = $true)][string] $Path)

  $parentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in @($parentSid, "S-1-5-18", "S-1-5-32-544")) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier] $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-NoAlternateDataStreams {
  param([Parameter(Mandatory = $true)][string[]] $Paths)

  foreach ($path in $Paths) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    $streams = @(Get-Item -LiteralPath $path -Stream * -ErrorAction Stop)
    $valid = if ($item.PSIsContainer) {
      $streams.Count -eq 0
    } else {
      $streams.Count -eq 1 -and $streams[0].Stream -eq ':$DATA'
    }
    if (-not $valid) {
      throw "The Electron NSIS payload proof input contains an alternate data stream: $path"
    }
  }
}

function Assert-MatchingFileIdentity {
  param(
    [Parameter(Mandatory = $true)][string] $ExpectedPath,
    [Parameter(Mandatory = $true)][string] $ObservedPath
  )

  $expectedItem = Get-Item -LiteralPath $ExpectedPath -Force
  $observedItem = Get-Item -LiteralPath $ObservedPath -Force
  $expectedSha256 = (Get-FileHash -LiteralPath $ExpectedPath -Algorithm SHA256).Hash
  $observedSha256 = (Get-FileHash -LiteralPath $ObservedPath -Algorithm SHA256).Hash
  if (
    $expectedItem -isnot [IO.FileInfo] -or
    $observedItem -isnot [IO.FileInfo] -or
    $expectedItem.Length -ne $observedItem.Length -or
    $expectedSha256 -ne $observedSha256
  ) {
    throw "The staged Electron NSIS installer differs from the packaged artifact."
  }
}

$proofRoot = Join-Path $env:RUNNER_TEMP "rion-electron-installer-payload-$([Guid]::NewGuid().ToString('N'))"
$inputRoot = Join-Path $proofRoot "input"
$gateRoot = Join-Path $proofRoot "gate"
$installDirectory = Join-Path $gateRoot "application"
$isolationResultPath = Join-Path $gateRoot "windows-isolated-profile-result.json"
$stagedArtifact = Join-Path $inputRoot "Rion.Studio-win.exe"
$stagedHarness = Join-Path $inputRoot "installWindowsElectronPayloadForProof.ps1"
$forbiddenSourceFileList = Join-Path $inputRoot "forbidden-source-files.json"
$attemptNonce = ([Convert]::ToHexString(
  [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
)).ToLowerInvariant()
$primaryError = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()
try {
  New-Item -ItemType Directory -Path $proofRoot | Out-Null
  Protect-ProofDirectory -Path $proofRoot
  New-Item -ItemType Directory -Path @($inputRoot, $gateRoot) | Out-Null

  $sourceEntries = @(
    Get-Item -LiteralPath $application -Force
    Get-ChildItem -LiteralPath $application -Recurse -Force
  )
  if (@($sourceEntries | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  }).Count -ne 0) {
    throw "The packaged Windows application contains a reparse point."
  }
  $sourceFiles = @($sourceEntries | Where-Object {
    $_ -is [IO.FileInfo]
  } | Sort-Object -Property FullName)
  if ($sourceFiles.Count -eq 0) {
    throw "The packaged Windows application contains no regular files."
  }
  Assert-NoAlternateDataStreams -Paths @($sourceEntries.FullName)
  Assert-NoAlternateDataStreams -Paths @($artifact)

  [IO.File]::Copy($artifact, $stagedArtifact, $false)
  [IO.File]::Copy(
    (Join-Path $repository "scripts\installWindowsElectronPayloadForProof.ps1"),
    $stagedHarness,
    $false
  )
  foreach ($stagedPath in @($stagedArtifact, $stagedHarness)) {
    $stream = [IO.FileStream]::new(
      $stagedPath,
      [IO.FileMode]::Open,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None
    )
    try {
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
  }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  & $node `
    (Join-Path $repository "scripts\windowsElectronInstallerPayloadProof.mjs") `
    write-forbidden-source-list `
    --source-application $application `
    --output $forbiddenSourceFileList
  if ($LASTEXITCODE -ne 0) {
    throw "The Electron NSIS forbidden source-path list did not verify."
  }
  Assert-MatchingFileIdentity -ExpectedPath $artifact -ObservedPath $stagedArtifact

  $pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
  $isolatedArguments = @(
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-File", $stagedHarness,
    "-ArtifactPath", $stagedArtifact,
    "-AttemptNonce", $attemptNonce,
    "-ForbiddenSourceFileListPath", $forbiddenSourceFileList,
    "-GateRoot", $gateRoot,
    "-InstallDirectory", $installDirectory,
    "-Version", $Version
  )
  ./scripts/runWindowsIsolatedProfile.ps1 `
    -RepositoryRoot $repository `
    -RepositoryAccess None `
    -WorkingDirectory $gateRoot `
    -ToolHomeAccess None `
    -AdditionalReadablePaths @($inputRoot) `
    -AdditionalWritablePaths @($gateRoot) `
    -AdditionalDeniedPaths @($application) `
    -CommandPath $pwsh `
    -CommandArguments $isolatedArguments `
    -CommandTimeoutSeconds 300 `
    -ExpectedTotalProcesses 3 `
    -ResultPath $isolationResultPath `
    -AttemptNonce $attemptNonce `
    -ResultCommandHarnessPath $stagedHarness `
    -ResultInstallerPath $stagedArtifact `
    -ResultForbiddenSourceListPath $forbiddenSourceFileList

  Assert-MatchingFileIdentity -ExpectedPath $artifact -ObservedPath $stagedArtifact

  & $node `
    (Join-Path $repository "scripts\windowsElectronInstallerPayloadProof.mjs") `
    create `
    --source-application $application `
    --installed-application $installDirectory `
    --installer $stagedArtifact `
    --isolation-result $isolationResultPath `
    --attempt-nonce $attemptNonce `
    --command-path $pwsh `
    --command-script $stagedHarness `
    --forbidden-source-file-list $forbiddenSourceFileList `
    --gate-root $gateRoot `
    --source-sha $SourceSha `
    --version $Version `
    --output $expectedOutput
  if ($LASTEXITCODE -ne 0) {
    throw "The Electron NSIS installed payload proof did not verify."
  }
  Assert-MatchingFileIdentity -ExpectedPath $artifact -ObservedPath $stagedArtifact
} catch {
  $primaryError = $_
} finally {
  try {
    if (Test-Path -LiteralPath $proofRoot) {
      Remove-Item -LiteralPath $proofRoot -Recurse -Force -ErrorAction Stop
    }
  } catch {
    $cleanupErrors.Add("proof root ${proofRoot}: $($_.Exception.Message)")
  }
  try {
    if (Test-Path -LiteralPath $proofRoot) {
      throw "The Electron NSIS payload proof root still exists."
    }
  } catch {
    $cleanupErrors.Add("proof root verification ${proofRoot}: $($_.Exception.Message)")
  }
}

if ($null -ne $primaryError -and $cleanupErrors.Count -eq 0) {
  throw $primaryError
}
$failures = [Collections.Generic.List[string]]::new()
if ($null -ne $primaryError) {
  $failures.Add("primary proof: $($primaryError.Exception.Message)")
}
if ($cleanupErrors.Count -gt 0) {
  $failures.Add("cleanup: $($cleanupErrors -join '; ')")
}
if ($failures.Count -gt 0) {
  throw "The Electron NSIS payload proof failed: $($failures -join '; ')"
}
