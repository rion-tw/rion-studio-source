param(
  [Parameter(Mandatory = $true)]
  [string] $ArtifactPath,

  [Parameter(Mandatory = $true)]
  [string] $ContractPath,

  [Parameter(Mandatory = $true)]
  [string] $InstallDirectory,

  [Parameter(Mandatory = $true)]
  [string] $RepositoryRoot,

  [Parameter(Mandatory = $true)]
  [string] $Version
)

$ErrorActionPreference = "Stop"

if (
  -not $IsWindows -or
  $env:CI -ne "true" -or
  $env:GITHUB_ACTIONS -ne "true" -or
  $env:RION_WINDOWS_ISOLATED_PROFILE_KIND -ne "temporary-local-windows-user-profile-v1"
) {
  throw "Published Tauri v22 derivation requires the verified temporary-user Windows runner."
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (
  $identity.User.Value -ne $env:RION_WINDOWS_ISOLATED_PROFILE_SID -or
  $identity.User.Value -eq $env:RION_WINDOWS_ISOLATED_PROFILE_PARENT_SID
) {
  throw "Published Tauri v22 derivation did not retain the isolated user token."
}
if (Test-Path Env:RION_STUDIO_USER_DATA_DIR) {
  throw "Published Tauri v22 derivation must not enable a product user-data override."
}
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$') {
  throw "Published Tauri v22 derivation requires a strict semantic version."
}

$repository = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$artifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$artifactItem = Get-Item -LiteralPath $artifact -Force
if (
  $artifactItem -isnot [IO.FileInfo] -or
  ($artifactItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The published Tauri v22 installer must be a regular file."
}
if ((Get-AuthenticodeSignature -LiteralPath $artifact).Status -ne "NotSigned") {
  throw "The published Tauri v22 installer must remain Authenticode-unsigned."
}

$lineageRoot = Split-Path -Parent $ContractPath
$resolvedLineageRoot = (Resolve-Path -LiteralPath $lineageRoot).Path
$expectedInstallDirectory = Join-Path $resolvedLineageRoot "application"
if ($InstallDirectory -ne $expectedInstallDirectory) {
  throw "The published Tauri v22 install directory escaped its writable lineage root."
}
if ($ContractPath -ne (Join-Path $resolvedLineageRoot "tauri-v22-windows-install-contract.json")) {
  throw "The published Tauri v22 contract path escaped its writable lineage root."
}
$rootItem = Get-Item -LiteralPath $resolvedLineageRoot -Force
if (
  -not $rootItem.PSIsContainer -or
  ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The published Tauri v22 lineage root must be a real directory."
}
if (
  (Test-Path -LiteralPath $InstallDirectory) -or
  (Test-Path -LiteralPath $ContractPath)
) {
  throw "The published Tauri v22 derivation outputs must be create-new."
}

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [Parameter(Mandatory = $true)][string[]] $ArgumentList,
    [int] $TimeoutSeconds = 120
  )
  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -PassThru `
    -WindowStyle Hidden
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill($true) } catch { Write-Warning "Failed to terminate timed-out NSIS tree: $_" }
      throw "Published Tauri v22 NSIS installation timed out."
    }
    if ($process.ExitCode -ne 0) {
      throw "Published Tauri v22 NSIS installation failed with exit code $($process.ExitCode)."
    }
  } finally {
    $process.Dispose()
  }
}

Invoke-BoundedProcess -FilePath $artifact -ArgumentList @(
  "/S",
  "/D=$InstallDirectory"
)

$installItem = Get-Item -LiteralPath $InstallDirectory -Force -ErrorAction Stop
if (
  -not $installItem.PSIsContainer -or
  ($installItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The published Tauri v22 installer did not create a real application directory."
}
$installedEntries = @(
  $installItem
  Get-ChildItem -LiteralPath $InstallDirectory -Recurse -Force
)
if (@($installedEntries | Where-Object {
  ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}).Count -ne 0) {
  throw "The published Tauri v22 installation contains an unexpected reparse point."
}
$executables = @(Get-ChildItem `
  -LiteralPath $InstallDirectory `
  -Recurse `
  -Force `
  -File `
  -Filter "rion-tauri.exe")
if ($executables.Count -ne 1) {
  throw "The published Tauri v22 installation must contain exactly one rion-tauri.exe."
}
$executable = $executables[0].FullName
if ($executable -ne (Join-Path $InstallDirectory "rion-tauri.exe")) {
  throw "The published Tauri v22 executable is not at the canonical install root."
}
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($executable).ProductVersion -ne $Version) {
  throw "The published Tauri v22 executable product version does not match the release."
}
if ((Get-AuthenticodeSignature -LiteralPath $executable).Status -ne "NotSigned") {
  throw "The installed Tauri v22 executable must remain Authenticode-unsigned."
}
$uninstaller = Join-Path $InstallDirectory "uninstall.exe"
$uninstallerItem = Get-Item -LiteralPath $uninstaller -Force -ErrorAction Stop

$registryRoot = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
  [Microsoft.Win32.RegistryHive]::CurrentUser,
  [Microsoft.Win32.RegistryView]::Registry32
)
$installRegistryPath = "Software\rionstudio\Rion Studio"
$uninstallRegistryPath = "Software\Microsoft\Windows\CurrentVersion\Uninstall\Rion Studio"
$installRegistry = $registryRoot.OpenSubKey($installRegistryPath)
$uninstallRegistry = $registryRoot.OpenSubKey($uninstallRegistryPath)
try {
  if ($null -eq $installRegistry -or $null -eq $uninstallRegistry) {
    throw "The published Tauri v22 installer omitted its exact currentUser registry keys."
  }
  $registryOptions = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  $contract = [ordered]@{
    displayIcon = [string] $uninstallRegistry.GetValue("DisplayIcon", $null, $registryOptions)
    displayName = [string] $uninstallRegistry.GetValue("DisplayName", $null, $registryOptions)
    displayVersion = [string] $uninstallRegistry.GetValue("DisplayVersion", $null, $registryOptions)
    installLocation = [string] $uninstallRegistry.GetValue("InstallLocation", $null, $registryOptions)
    installRegistryDefault = [string] $installRegistry.GetValue("", $null, $registryOptions)
    installRegistryKey = $installRegistryPath
    mainBinaryName = [string] $uninstallRegistry.GetValue("MainBinaryName", $null, $registryOptions)
    mainBinaryPath = $executable
    mainBinaryRegular = $executables[0] -is [IO.FileInfo]
    mainBinaryReparsePoint = [bool] (
      $executables[0].Attributes -band [IO.FileAttributes]::ReparsePoint
    )
    publisher = [string] $uninstallRegistry.GetValue("Publisher", $null, $registryOptions)
    uninstallRegistryKey = $uninstallRegistryPath
    uninstallerPath = $uninstallerItem.FullName
    uninstallerRegular = $uninstallerItem -is [IO.FileInfo]
    uninstallerReparsePoint = [bool] (
      $uninstallerItem.Attributes -band [IO.FileAttributes]::ReparsePoint
    )
    uninstallString = [string] $uninstallRegistry.GetValue("UninstallString", $null, $registryOptions)
  }
} finally {
  if ($null -ne $uninstallRegistry) { $uninstallRegistry.Dispose() }
  if ($null -ne $installRegistry) { $installRegistry.Dispose() }
  $registryRoot.Dispose()
}

$json = "$($contract | ConvertTo-Json -Depth 3)`n"
$bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
$stream = [IO.File]::Open(
  $ContractPath,
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

$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node `
  (Join-Path $repository "scripts\tauriV22WindowsInstallContract.mjs") `
  --snapshot $ContractPath `
  --install-directory $InstallDirectory `
  --version $Version
if ($LASTEXITCODE -ne 0) {
  throw "The published Tauri v22 currentUser registry/file contract did not verify."
}
