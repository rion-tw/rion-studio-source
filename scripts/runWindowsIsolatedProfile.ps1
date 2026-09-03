param(
  [Parameter(Mandatory = $true)]
  [string] $CommandPath,

  [Parameter()]
  [string[]] $CommandArguments = @(),

  [Parameter(Mandatory = $true)]
  [string] $RepositoryRoot,

  [Parameter()]
  [ValidateSet("M", "RX", "None")]
  [string] $RepositoryAccess = "M",

  [Parameter()]
  [string] $WorkingDirectory,

  [Parameter()]
  [ValidateSet("M", "RX", "None")]
  [string] $ToolHomeAccess = "M",

  [Parameter()]
  [string[]] $AdditionalWritablePaths = @(),

  [Parameter()]
  [string[]] $AdditionalReadablePaths = @(),

  [Parameter()]
  [string[]] $AdditionalDeniedPaths = @(),

  [Parameter()]
  [string] $ProtectedSiblingParent,

  [Parameter()]
  [switch] $AllowEphemeralUpdaterSigningEnvironment,

  [Parameter()]
  [ValidateRange(60, 3600)]
  [int] $CommandTimeoutSeconds = 900,

  [Parameter()]
  [ValidateRange(0, 100000)]
  [int] $ExpectedTotalProcesses = 0,

  [Parameter()]
  [string] $ResultPath,

  [Parameter()]
  [string] $AttemptNonce,

  [Parameter()]
  [string] $ResultCommandHarnessPath,

  [Parameter()]
  [string] $ResultInstallerPath,

  [Parameter()]
  [string] $ResultForbiddenSourceListPath
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "The temporary Windows profile runner requires Windows."
}
if (
  $env:CI -ne "true" -or
  $env:GITHUB_ACTIONS -ne "true" -or
  $env:RION_WINDOWS_PROFILE_ISOLATION_ALLOWED -ne "true"
) {
  throw "Temporary Windows users are allowed only on an explicit GitHub-hosted runner."
}
$principal = [Security.Principal.WindowsPrincipal]::new(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "The GitHub-hosted Windows profile runner must be elevated."
}

$resolvedRepository = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$resolvedWorkspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
if ($resolvedRepository -ne $resolvedWorkspace) {
  throw "RepositoryRoot must equal the checked-out GitHub workspace."
}
$resolvedCommand = (Resolve-Path -LiteralPath $CommandPath).Path
$resolvedWorkingDirectory = if ($WorkingDirectory) {
  (Resolve-Path -LiteralPath $WorkingDirectory).Path
} else {
  $resolvedRepository
}
$workingDirectoryItem = Get-Item -LiteralPath $resolvedWorkingDirectory -Force
if (
  -not $workingDirectoryItem.PSIsContainer -or
  ($workingDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The Windows isolated-profile working directory must be a real directory."
}
$resolvedResultPath = $null
$resolvedResultCommandHarness = $null
$resolvedResultInstaller = $null
$resolvedResultForbiddenSourceList = $null
$resolvedProtectedSiblingParent = $null
if ($ProtectedSiblingParent) {
  $resolvedProtectedSiblingParent = (
    Resolve-Path -LiteralPath $ProtectedSiblingParent
  ).Path
  $protectedSiblingItem = Get-Item -LiteralPath $resolvedProtectedSiblingParent -Force
  if (
    -not $protectedSiblingItem.PSIsContainer -or
    ($protectedSiblingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The protected sibling parent must be one real directory."
  }
  $resolvedWritableChildren = @($AdditionalWritablePaths | ForEach-Object {
    (Resolve-Path -LiteralPath $_).Path
  })
  if (
    $resolvedWritableChildren.Count -eq 0 -or
    @($resolvedWritableChildren | Where-Object {
      (Split-Path -Parent $_) -ne $resolvedProtectedSiblingParent
    }).Count -ne 0
  ) {
    throw "Every writable root must be a direct protected sibling child."
  }
}
if ($ResultPath) {
  if (
    $AttemptNonce -notmatch '^[a-f0-9]{32}$' -or
    -not $ResultCommandHarnessPath -or
    -not $ResultInstallerPath -or
    -not $ResultForbiddenSourceListPath
  ) {
    throw "The Windows isolated-profile result requires its fresh nonce and attested inputs."
  }
  $resolvedResultCommandHarness = (Resolve-Path -LiteralPath $ResultCommandHarnessPath).Path
  $resolvedResultInstaller = (Resolve-Path -LiteralPath $ResultInstallerPath).Path
  $resolvedResultForbiddenSourceList = (
    Resolve-Path -LiteralPath $ResultForbiddenSourceListPath
  ).Path
  $resultParentSource = Split-Path -Parent $ResultPath
  $resultLeaf = Split-Path -Leaf $ResultPath
  if (-not $resultParentSource -or -not $resultLeaf -or $resultLeaf.Contains(':')) {
    throw "The Windows isolated-profile result path is invalid."
  }
  $resolvedResultParent = (Resolve-Path -LiteralPath $resultParentSource).Path
  $resultParentItem = Get-Item -LiteralPath $resolvedResultParent -Force
  if (
    -not $resultParentItem.PSIsContainer -or
    ($resultParentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The Windows isolated-profile result parent must be a real directory."
  }
  $resolvedResultPath = Join-Path $resolvedResultParent $resultLeaf
  if (
    [IO.Path]::GetFullPath($ResultPath) -ne $resolvedResultPath -or
    (Test-Path -LiteralPath $resolvedResultPath)
  ) {
    throw "The Windows isolated-profile result path must be create-new."
  }
  if (
    $resolvedProtectedSiblingParent -and
    (Split-Path -Parent $resolvedResultParent) -ne $resolvedProtectedSiblingParent
  ) {
    throw "The isolated result root must share the protected sibling parent."
  }
} elseif (
  $AttemptNonce -or
  $ResultCommandHarnessPath -or
  $ResultInstallerPath -or
  $ResultForbiddenSourceListPath
) {
  throw "Windows isolated-profile result bindings require ResultPath."
}
$ephemeralPrivateKeyForChild = $null
$ephemeralPrivateKeyPasswordForChild = $null
if ($AllowEphemeralUpdaterSigningEnvironment) {
  $ephemeralFixtureRoot = (
    Resolve-Path -LiteralPath $env:RION_UPDATER_CI_FIXTURE_ROOT
  ).Path
  $ephemeralPrivateKey = (
    Resolve-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY_PATH
  ).Path
  $ephemeralPrivateKeyItem = Get-Item -LiteralPath $ephemeralPrivateKey -Force
  $writableFixtureMatches = @($AdditionalWritablePaths | Where-Object {
    (Resolve-Path -LiteralPath $_).Path -eq $ephemeralFixtureRoot
  })
  if (
    $writableFixtureMatches.Count -ne 1 -or
    (Split-Path -Parent $ephemeralPrivateKey) -ne $ephemeralFixtureRoot -or
    (Split-Path -Leaf $ephemeralPrivateKey) -ne "ephemeral-updater.key" -or
    $ephemeralPrivateKeyItem -isnot [IO.FileInfo] -or
    ($ephemeralPrivateKeyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    -not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  ) {
    throw "The opted-in ephemeral updater signing environment is not fixture-bound."
  }
  $ephemeralPrivateKeyForChild = $ephemeralPrivateKey
  $ephemeralPrivateKeyPasswordForChild = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
$parentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$parentSid = $parentIdentity.User.Value
$userName = "rionci-$([Guid]::NewGuid().ToString('N').Substring(0, 10))"
$plainPassword = "Rion!7-$([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)))"
$securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
$profilesDirectoryTemplate = Get-ItemPropertyValue `
  -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList" `
  -Name "ProfilesDirectory"
$profilesDirectory = [IO.Path]::GetFullPath(
  [Environment]::ExpandEnvironmentVariables($profilesDirectoryTemplate)
)
$expectedProfileDirectory = Join-Path $profilesDirectory $userName
if (Test-Path -LiteralPath $expectedProfileDirectory) {
  throw "The create-new temporary Windows profile directory already exists."
}
$runRoot = Join-Path $env:RUNNER_TEMP "rion-windows-profile-$([Guid]::NewGuid().ToString('N'))"
$commandEnvelope = Join-Path $runRoot "command.json"
$grantedPaths = [Collections.Generic.List[string]]::new()
$deniedPaths = [Collections.Generic.List[string]]::new()
$mutationDeniedPaths = [Collections.Generic.List[string]]::new()
$profileSid = $null
$accountCreated = $false
$desktopLease = $null
$commandExitCode = $null
$activeProcessesAfterRootExit = $null
$totalProcesses = $null
$commandInvocationSha256 = $null
$attestedInputs = $null
$profileDirectoriesToVerify = [Collections.Generic.List[string]]::new()
$profileDirectoriesToVerify.Add($expectedProfileDirectory)
$primaryError = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()

function Invoke-Icacls {
  param([string[]] $Arguments)
  & "$env:SystemRoot\System32\icacls.exe" @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "icacls failed with exit code $LASTEXITCODE."
  }
}

function Grant-PathAccess {
  param(
    [string] $Path,
    [ValidateSet("M", "RX")]
    [string] $Access
  )
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $metadata = Get-Item -LiteralPath $resolved
  $inheritance = if ($metadata.PSIsContainer) { "(OI)(CI)" } else { "" }
  Invoke-Icacls @($resolved, "/grant:r", "*${profileSid}:${inheritance}${Access}", "/Q")
  $grantedPaths.Add($resolved)
}

function Protect-EphemeralDirectory {
  param([Parameter(Mandatory = $true)][string] $Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $metadata = Get-Item -LiteralPath $resolved -Force
  if (
    -not $metadata.PSIsContainer -or
    ($metadata.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The Windows isolated-profile ephemeral path must be a real directory."
  }
  $acl = Get-Acl -LiteralPath $resolved
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
  Set-Acl -LiteralPath $resolved -AclObject $acl
}

function Deny-PathAccessRecursively {
  param([Parameter(Mandatory = $true)][string] $Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $entries = @(
    Get-Item -LiteralPath $resolved -Force
    Get-ChildItem -LiteralPath $resolved -Recurse -Force
  )
  if (@($entries | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  }).Count -ne 0) {
    throw "The Windows isolated-profile denied tree contains a reparse point."
  }
  $deniedPaths.Add($resolved)
  Invoke-Icacls @(
    $resolved,
    "/deny",
    "*${profileSid}:(OI)(CI)F",
    "/T",
    "/Q"
  )
}

function Deny-PathMutationRecursively {
  param([Parameter(Mandatory = $true)][string] $Path)

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $item = Get-Item -LiteralPath $resolved -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "The Windows isolated-profile read-only root must not be a reparse point."
  }
  $mutationDeniedPaths.Add($resolved)
  $inheritance = if ($item.PSIsContainer) { "(OI)(CI)" } else { "" }
  $arguments = @(
    $resolved,
    "/deny",
    "*${profileSid}:${inheritance}(WD,AD,WEA,WA,DE,DC,WDAC,WO)"
  )
  if ($item.PSIsContainer) {
    $arguments += "/T"
  }
  $arguments += @("/L", "/Q")
  Invoke-Icacls $arguments
}

function Get-AttestedArtifactIdentity {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][string] $Label
  )

  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $item = Get-Item -LiteralPath $resolved -Force
  if (
    $item -isnot [IO.FileInfo] -or
    $item.Length -le 0 -or
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The Windows isolated-profile $Label must be a nonempty regular file."
  }
  $hardLinks = @(& "$env:SystemRoot\System32\fsutil.exe" hardlink list $resolved)
  if ($LASTEXITCODE -ne 0 -or $hardLinks.Count -ne 1) {
    throw "The Windows isolated-profile $Label must have exactly one hard link."
  }
  [ordered]@{
    bytes = [int64] $item.Length
    fileName = $item.Name
    sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Get-CommandInvocationSha256 {
  $parts = @(
    "rion-windows-isolated-command-invocation-v1"
    $resolvedCommand
    $resolvedWorkingDirectory
    $CommandArguments
  )
  if (@($parts | Where-Object { ([string] $_).Contains([char] 0) }).Count -ne 0) {
    throw "The Windows isolated-profile command invocation contains NUL."
  }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(
    ([string[]] $parts) -join [char] 0
  )
  ([Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($bytes)
  )).ToLowerInvariant()
}

function Write-IsolatedProfileResult {
  param([Parameter(Mandatory = $true)][string] $Path)

  $source = ([ordered]@{
    activeProcessesAfterRootExit = $activeProcessesAfterRootExit
    attemptNonce = $AttemptNonce
    attestedInputs = $attestedInputs
    cleanupVerified = $true
    commandExitCode = $commandExitCode
    commandInvocationSha256 = $commandInvocationSha256
    expectedTotalProcesses = $ExpectedTotalProcesses
    isolationKind = "temporary-local-windows-user-profile-v1"
    kind = "rion-windows-isolated-profile-result"
    schemaVersion = 1
    totalProcesses = $totalProcesses
  } | ConvertTo-Json -Depth 4).Replace("`r`n", "`n").Replace("`r", "`n")
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes("${source}`n")
  $stream = [IO.FileStream]::new(
    $Path,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  $resultItem = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (
    $resultItem -isnot [IO.FileInfo] -or
    $resultItem.Length -ne $bytes.Length -or
    ($resultItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The Windows isolated-profile result was not written as an exact regular file."
  }
}

if (-not ("RionInteractiveDesktopAccess" -as [type])) {
  Add-Type -Path (Join-Path $resolvedRepository "scripts\windowsInteractiveDesktopAccess.cs")
}
if (-not ("RionWindowsJobRunner" -as [type])) {
  Add-Type -Path (Join-Path $resolvedRepository "scripts\windowsJobObjectRunner.cs")
}

try {
  New-Item -ItemType Directory -Path $runRoot | Out-Null
  Protect-EphemeralDirectory -Path $runRoot
  $innerScriptSource = Join-Path `
    $resolvedRepository `
    "scripts\invokeWindowsIsolatedProfileCommand.ps1"
  $innerScript = Join-Path $runRoot "invokeWindowsIsolatedProfileCommand.ps1"
  [IO.File]::Copy($innerScriptSource, $innerScript, $false)
  $innerScriptStream = [IO.FileStream]::new(
    $innerScript,
    [IO.FileMode]::Open,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
  try {
    $innerScriptStream.Flush($true)
  } finally {
    $innerScriptStream.Dispose()
  }
  $localUser = New-LocalUser `
    -Name $userName `
    -Password $securePassword `
    -AccountNeverExpires `
    -PasswordNeverExpires `
    -UserMayNotChangePassword
  $accountCreated = $true
  $profileSid = $localUser.SID.Value
  $usersGroup = Get-LocalGroup -SID (
    [Security.Principal.SecurityIdentifier] "S-1-5-32-545"
  )
  Add-LocalGroupMember -Group $usersGroup -Member $localUser

  if ($resolvedProtectedSiblingParent) {
    Protect-EphemeralDirectory -Path $resolvedProtectedSiblingParent
    Grant-PathAccess $resolvedProtectedSiblingParent "RX"
  }
  if ($RepositoryAccess -ne "None") {
    Grant-PathAccess $resolvedRepository $RepositoryAccess
    if ($RepositoryAccess -eq "RX") {
      Deny-PathMutationRecursively $resolvedRepository
    }
  }
  Grant-PathAccess $runRoot "M"
  foreach ($path in $AdditionalWritablePaths) {
    Grant-PathAccess $path "M"
  }
  foreach ($path in $AdditionalReadablePaths) {
    Grant-PathAccess $path "RX"
    Deny-PathMutationRecursively $path
  }
  foreach ($path in $AdditionalDeniedPaths) {
    Deny-PathAccessRecursively $path
  }
  if ($ToolHomeAccess -ne "None") {
    $parentProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $toolHomes = [ordered]@{
      CARGO_HOME = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $parentProfile ".cargo" }
      RUSTUP_HOME = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $parentProfile ".rustup" }
      PNPM_HOME = $env:PNPM_HOME
    }
    foreach ($name in $toolHomes.Keys) {
      $path = $toolHomes[$name]
      if ($path -and (Test-Path -LiteralPath $path)) {
        [Environment]::SetEnvironmentVariable($name, $path, "Process")
        Grant-PathAccess $path $ToolHomeAccess
        if ($ToolHomeAccess -eq "RX") {
          Deny-PathMutationRecursively $path
        }
      }
    }
  }
  $commandParent = Split-Path -Parent $resolvedCommand
  Grant-PathAccess $commandParent "RX"
  Deny-PathMutationRecursively $commandParent

  if ($resolvedResultPath) {
    $attestedInputs = [ordered]@{
      commandExecutable = Get-AttestedArtifactIdentity `
        -Path $resolvedCommand `
        -Label "command executable"
      commandHarness = Get-AttestedArtifactIdentity `
        -Path $resolvedResultCommandHarness `
        -Label "command harness"
      forbiddenSourceList = Get-AttestedArtifactIdentity `
        -Path $resolvedResultForbiddenSourceList `
        -Label "forbidden source list"
      installer = Get-AttestedArtifactIdentity `
        -Path $resolvedResultInstaller `
        -Label "installer"
    }
    $commandInvocationSha256 = Get-CommandInvocationSha256
  }

  [ordered]@{
    allowEphemeralUpdaterSigningEnvironment = [bool] $AllowEphemeralUpdaterSigningEnvironment
    arguments = @($CommandArguments)
    commandPath = $resolvedCommand
    expectedSid = $profileSid
    parentSid = $parentSid
    workingDirectory = $resolvedWorkingDirectory
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $commandEnvelope -Encoding utf8NoBOM

  $desktopLease = [RionInteractiveDesktopAccess]::Grant($profileSid)
  $escapedInnerScript = $innerScript.Replace("'", "''")
  $escapedEnvelope = $commandEnvelope.Replace("'", "''")
  $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(
    "& '$escapedInnerScript' -CommandEnvelope '$escapedEnvelope'"
  ))
  $pwshExecutable = Join-Path $PSHOME "pwsh.exe"
  try {
    $jobResult = [RionWindowsJobRunner]::Run(
      $userName,
      $env:COMPUTERNAME,
      $plainPassword,
      $pwshExecutable,
      "`"$pwshExecutable`" -NoLogo -NoProfile -NonInteractive -EncodedCommand $encodedCommand",
      $resolvedWorkingDirectory,
      $CommandTimeoutSeconds * 1000,
      $ephemeralPrivateKeyForChild,
      $ephemeralPrivateKeyPasswordForChild
    )
  } finally {
    $ephemeralPrivateKeyForChild = $null
    $ephemeralPrivateKeyPasswordForChild = $null
  }
  $commandExitCode = [int] $jobResult.ExitCode
  $activeProcessesAfterRootExit = [int] $jobResult.ActiveProcessesAfterRootExit
  $totalProcesses = [int] $jobResult.TotalProcesses
  if ($resolvedResultPath) {
    $attestedInputsAfter = [ordered]@{
      commandExecutable = Get-AttestedArtifactIdentity `
        -Path $resolvedCommand `
        -Label "command executable"
      commandHarness = Get-AttestedArtifactIdentity `
        -Path $resolvedResultCommandHarness `
        -Label "command harness"
      forbiddenSourceList = Get-AttestedArtifactIdentity `
        -Path $resolvedResultForbiddenSourceList `
        -Label "forbidden source list"
      installer = Get-AttestedArtifactIdentity `
        -Path $resolvedResultInstaller `
        -Label "installer"
    }
    if (
      ($attestedInputs | ConvertTo-Json -Compress -Depth 4) -ne
      ($attestedInputsAfter | ConvertTo-Json -Compress -Depth 4)
    ) {
      throw "The Windows isolated-profile attested inputs changed during execution."
    }
  }
} catch {
  $primaryError = $_
} finally {
  if ($null -ne $desktopLease) {
    try {
      [RionInteractiveDesktopAccess]::Restore($desktopLease)
    } catch {
      $cleanupErrors.Add("interactive desktop ACL: $($_.Exception.Message)")
    }
  }
  foreach ($path in @($deniedPaths | Select-Object -Unique)) {
    try {
      Invoke-Icacls @($path, "/remove:d", "*$profileSid", "/T", "/Q")
    } catch {
      $cleanupErrors.Add("deny ACL $path`: $($_.Exception.Message)")
    }
  }
  foreach ($path in @($mutationDeniedPaths | Select-Object -Unique)) {
    try {
      $cleanupArguments = @($path, "/remove:d", "*$profileSid")
      if ((Get-Item -LiteralPath $path -Force).PSIsContainer) {
        $cleanupArguments += "/T"
      }
      $cleanupArguments += @("/L", "/Q")
      Invoke-Icacls $cleanupArguments
    } catch {
      $cleanupErrors.Add("mutation-deny ACL $path`: $($_.Exception.Message)")
    }
  }
  foreach ($path in @($grantedPaths | Select-Object -Unique)) {
    try {
      Invoke-Icacls @($path, "/remove:g", "*$profileSid", "/Q")
    } catch {
      $cleanupErrors.Add("ACL $path`: $($_.Exception.Message)")
    }
  }
  if ($profileSid) {
    try {
      $profileRegistryPath = (
        "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$profileSid"
      )
      if (Test-Path -LiteralPath $profileRegistryPath) {
        $registeredDirectory = Get-ItemPropertyValue `
          -LiteralPath $profileRegistryPath `
          -Name "ProfileImagePath"
        $profileDirectoriesToVerify.Add([IO.Path]::GetFullPath(
          [Environment]::ExpandEnvironmentVariables($registeredDirectory)
        ))
      }
    } catch {
      $cleanupErrors.Add("profile path ${profileSid}: $($_.Exception.Message)")
    }
    try {
      $profiles = @(Get-CimInstance Win32_UserProfile |
        Where-Object { $_.SID -eq $profileSid })
      foreach ($profile in $profiles) {
        $profileDirectoriesToVerify.Add([IO.Path]::GetFullPath($profile.LocalPath))
        if ($profile.Loaded) {
          throw "The temporary Windows user profile remained loaded."
        }
        $profile | Remove-CimInstance
      }
    } catch {
      $cleanupErrors.Add("profile ${profileSid}: $($_.Exception.Message)")
    }
    try {
      $remainingProfiles = @(Get-CimInstance Win32_UserProfile |
        Where-Object { $_.SID -eq $profileSid })
      if ($remainingProfiles.Count -ne 0) {
        throw "The temporary Windows profile registration still exists."
      }
      foreach ($profileDirectory in @($profileDirectoriesToVerify | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $profileDirectory) {
          throw "The temporary Windows profile directory still exists: $profileDirectory"
        }
      }
    } catch {
      $cleanupErrors.Add("profile verification ${profileSid}: $($_.Exception.Message)")
    }
  }
  if ($accountCreated) {
    try {
      Remove-LocalUser -Name $userName
    } catch {
      $cleanupErrors.Add("account ${userName}: $($_.Exception.Message)")
    }
    try {
      $remainingNamedUsers = @(Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)
      $remainingSidUsers = if ($profileSid) {
        @(Get-LocalUser -SID (
          [Security.Principal.SecurityIdentifier] $profileSid
        ) -ErrorAction SilentlyContinue)
      } else {
        @()
      }
      if ($remainingNamedUsers.Count -ne 0 -or $remainingSidUsers.Count -ne 0) {
        throw "The temporary Windows account still exists."
      }
    } catch {
      $cleanupErrors.Add("account verification ${userName}: $($_.Exception.Message)")
    }
  }
  try {
    if (Test-Path -LiteralPath $runRoot) {
      Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction Stop
    }
  } catch {
    $cleanupErrors.Add("run root ${runRoot}: $($_.Exception.Message)")
  }
  try {
    if (Test-Path -LiteralPath $runRoot) {
      throw "The temporary Windows run root still exists."
    }
  } catch {
    $cleanupErrors.Add("run root verification ${runRoot}: $($_.Exception.Message)")
  }
  $plainPassword = $null
  $securePassword = $null
}

if ($null -ne $primaryError -and $cleanupErrors.Count -eq 0) {
  throw $primaryError
}
$failures = [Collections.Generic.List[string]]::new()
if ($null -ne $primaryError) {
  $failures.Add("primary command: $($primaryError.Exception.Message)")
}
if ($cleanupErrors.Count -gt 0) {
  $failures.Add("cleanup: $($cleanupErrors -join '; ')")
}
if ($null -eq $primaryError) {
  if ($null -eq $activeProcessesAfterRootExit -or $activeProcessesAfterRootExit -ne 0) {
    $failures.Add(
      "Job Object retained $activeProcessesAfterRootExit process(es) after the root command exited"
    )
  }
  if ($null -eq $commandExitCode -or $commandExitCode -ne 0) {
    $failures.Add("isolated command exit code: $commandExitCode")
  }
  if (
    $ExpectedTotalProcesses -ne 0 -and
    ($null -eq $totalProcesses -or $totalProcesses -ne $ExpectedTotalProcesses)
  ) {
    $failures.Add(
      "Job Object observed $totalProcesses total process(es); expected $ExpectedTotalProcesses"
    )
  }
}
if ($failures.Count -gt 0) {
  throw "Temporary Windows profile runner failed: $($failures -join '; ')"
}
if ($resolvedResultPath) {
  Write-IsolatedProfileResult -Path $resolvedResultPath
}
