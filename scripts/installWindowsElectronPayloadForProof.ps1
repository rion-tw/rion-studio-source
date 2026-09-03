param(
  [Parameter(Mandatory = $true)]
  [string] $ArtifactPath,

  [Parameter(Mandatory = $true)]
  [string] $AttemptNonce,

  [Parameter(Mandatory = $true)]
  [string] $ForbiddenSourceFileListPath,

  [Parameter(Mandatory = $true)]
  [string] $GateRoot,

  [Parameter(Mandatory = $true)]
  [string] $InstallDirectory,

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
  throw "The Electron NSIS payload proof requires the verified temporary-user Windows runner."
}
if (
  -not $env:RION_WINDOWS_ISOLATED_PROFILE_SID -or
  $env:RION_WINDOWS_ISOLATED_PROFILE_SID -eq $env:RION_WINDOWS_ISOLATED_PROFILE_PARENT_SID
) {
  throw "The Electron NSIS payload proof did not retain a distinct isolated user token."
}
if (@(Get-ChildItem Env: | Where-Object {
  $_.Name.StartsWith("TAURI_SIGNING_", [StringComparison]::OrdinalIgnoreCase) -or
  $_.Name.StartsWith("RION_STUDIO_UPDATER_PRIVATE_", [StringComparison]::OrdinalIgnoreCase)
}).Count -ne 0) {
  throw "The Electron NSIS payload proof must complete before updater private-key scope."
}
if ($AttemptNonce -notmatch '^[a-f0-9]{32}$') {
  throw "The Electron NSIS payload proof attempt nonce is invalid."
}
if (Test-Path Env:RION_STUDIO_USER_DATA_DIR) {
  throw "The Electron NSIS payload proof must not enable a product user-data override."
}
$productUserDataDirectory = Join-Path `
  $env:RION_WINDOWS_ISOLATED_PROFILE_ROAMING_APP_DATA `
  "Rion Studio"
if (Test-Path -LiteralPath $productUserDataDirectory) {
  throw "The Electron NSIS payload proof requires create-new product user data."
}
$versionMatch = [Regex]::Match(
  $Version,
  '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'
)
if (-not $versionMatch.Success) {
  throw "The Electron NSIS payload proof requires a strict semantic version."
}
$prerelease = $versionMatch.Groups[4].Value
if ($prerelease) {
  foreach ($identifier in $prerelease.Split('.')) {
    if (
      $identifier -match '^[0-9]+$' -and
      $identifier.Length -gt 1 -and
      $identifier.StartsWith('0', [StringComparison]::Ordinal)
    ) {
      throw "The Electron NSIS payload proof requires a strict semantic version."
    }
  }
}

$artifact = (Resolve-Path -LiteralPath $ArtifactPath).Path
$artifactItem = Get-Item -LiteralPath $artifact -Force
if (
  $artifactItem -isnot [IO.FileInfo] -or
  $artifactItem.Length -le 0 -or
  ($artifactItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The Electron NSIS payload proof requires a nonempty regular installer."
}
if ((Get-AuthenticodeSignature -LiteralPath $artifact).Status -ne "NotSigned") {
  throw "The Electron NSIS payload proof installer must remain Authenticode-unsigned."
}

$forbiddenSourceFileList = (Resolve-Path -LiteralPath $ForbiddenSourceFileListPath).Path
$forbiddenListItem = Get-Item -LiteralPath $forbiddenSourceFileList -Force
if (
  $forbiddenListItem -isnot [IO.FileInfo] -or
  $forbiddenListItem.Length -le 0 -or
  ($forbiddenListItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The Electron NSIS payload proof forbidden-source list is invalid."
}
$forbiddenSourceFiles = @(
  Get-Content -LiteralPath $forbiddenSourceFileList -Raw | ConvertFrom-Json
)
if (
  $forbiddenSourceFiles.Count -eq 0 -or
  @($forbiddenSourceFiles | Sort-Object -Unique).Count -ne $forbiddenSourceFiles.Count
) {
  throw "The Electron NSIS payload proof forbidden-source list is empty or duplicated."
}
if (-not ("RionWindowsPathAccessProbe" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RionWindowsPathAccessProbe
{
    private const uint OpenExisting = 3;
    private const uint ShareReadWriteDelete = 7;
    private const uint FileFlagBackupSemantics = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    public static int TryOpen(string path, uint desiredAccess)
    {
        using (SafeFileHandle handle = CreateFile(
            path,
            desiredAccess,
            ShareReadWriteDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics,
            IntPtr.Zero))
        {
            return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
    }
}
'@
}
$forbiddenAccessMasks = [ordered]@{
  read = [Convert]::ToUInt32("80000000", 16)
  write = [Convert]::ToUInt32("40000000", 16)
  delete = [Convert]::ToUInt32("00010000", 16)
}
foreach ($forbiddenPath in $forbiddenSourceFiles) {
  if (
    $forbiddenPath -isnot [string] -or
    -not [IO.Path]::IsPathFullyQualified($forbiddenPath)
  ) {
    throw "The Electron NSIS payload proof forbidden-source path is invalid."
  }
  foreach ($accessName in $forbiddenAccessMasks.Keys) {
    $errorCode = [RionWindowsPathAccessProbe]::TryOpen(
      $forbiddenPath,
      [uint32] $forbiddenAccessMasks[$accessName]
    )
    if ($errorCode -eq 0) {
      throw "The isolated installer can $accessName a forbidden source-package path."
    }
    if ($errorCode -ne 5) {
      throw (
        "The forbidden source-package $accessName probe failed with Win32 error " +
        "$errorCode instead of access denied."
      )
    }
  }
}

$resolvedGateRoot = (Resolve-Path -LiteralPath $GateRoot).Path
$gateRootItem = Get-Item -LiteralPath $resolvedGateRoot -Force
if (
  -not $gateRootItem.PSIsContainer -or
  ($gateRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The Electron NSIS payload proof gate root must be a real directory."
}
$expectedInstallDirectory = Join-Path $resolvedGateRoot "application"
if (
  [IO.Path]::GetFullPath($InstallDirectory) -ne $expectedInstallDirectory -or
  $expectedInstallDirectory -match '\s'
) {
  throw "The Electron NSIS payload proof install directory is not the exact no-space gate child."
}
if (Test-Path -LiteralPath $expectedInstallDirectory) {
  throw "The Electron NSIS payload proof install directory must be create-new."
}

function Invoke-BoundedInstaller {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [Parameter(Mandatory = $true)][string[]] $ArgumentList
  )
  $process = Start-Process `
    -FilePath $FilePath `
    -ArgumentList $ArgumentList `
    -PassThru `
    -WindowStyle Hidden
  try {
    if (-not $process.WaitForExit(180 * 1000)) {
      try {
        $process.Kill($true)
      } catch {
        Write-Warning "Failed to terminate the timed-out Electron NSIS process tree: $_"
      }
      throw "The Electron NSIS payload proof installation timed out."
    }
    if ($process.ExitCode -ne 0) {
      throw "The Electron NSIS payload proof installation failed with exit code $($process.ExitCode)."
    }
  } finally {
    $process.Dispose()
  }
}

# The pinned assisted NSIS template starts the application only for an explicit
# force-run request. /D must remain the final argument and the target has no spaces.
Invoke-BoundedInstaller -FilePath $artifact -ArgumentList @(
  "/S",
  "/currentuser",
  "/D=$expectedInstallDirectory"
)
if (Test-Path -LiteralPath $productUserDataDirectory) {
  throw "The silent Electron NSIS proof unexpectedly launched or initialized the application."
}

$installItem = Get-Item -LiteralPath $expectedInstallDirectory -Force -ErrorAction Stop
if (
  -not $installItem.PSIsContainer -or
  ($installItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
) {
  throw "The Electron NSIS installer did not create a real application directory."
}
$installedEntries = @(
  $installItem
  Get-ChildItem -LiteralPath $expectedInstallDirectory -Recurse -Force
)
if (@($installedEntries | Where-Object {
  ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}).Count -ne 0) {
  throw "The Electron NSIS installation contains an unexpected reparse point."
}
foreach ($installedEntry in $installedEntries) {
  $streams = @(
    Get-Item -LiteralPath $installedEntry.FullName -Stream * -ErrorAction Stop
  )
  $valid = if ($installedEntry.PSIsContainer) {
    $streams.Count -eq 0
  } else {
    $streams.Count -eq 1 -and $streams[0].Stream -eq ':$DATA'
  }
  if (-not $valid) {
    throw "The Electron NSIS installation contains an alternate data stream."
  }
}

$mainExecutablePath = Join-Path $expectedInstallDirectory "Rion Studio.exe"
$uninstallerPath = Join-Path $expectedInstallDirectory "Uninstall Rion Studio.exe"
foreach ($requiredPath in @($mainExecutablePath, $uninstallerPath)) {
  $requiredItem = Get-Item -LiteralPath $requiredPath -Force -ErrorAction Stop
  if (
    $requiredItem -isnot [IO.FileInfo] -or
    $requiredItem.Length -le 0 -or
    ($requiredItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "The Electron NSIS installation omitted a required nonempty regular executable."
  }
  if ((Get-AuthenticodeSignature -LiteralPath $requiredPath).Status -ne "NotSigned") {
    throw "The Electron NSIS installed executables must remain Authenticode-unsigned."
  }
}

$registryRoot = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
  [Microsoft.Win32.RegistryHive]::CurrentUser,
  [Microsoft.Win32.RegistryView]::Registry64
)
$installRegistry = $registryRoot.OpenSubKey("Software\rionstudio\Rion Studio")
try {
  if ($null -eq $installRegistry) {
    throw "The Electron NSIS installer omitted its current-user install registry key."
  }
  $registryOptions = [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  $registeredInstallDirectory = [string] $installRegistry.GetValue(
    "InstallLocation",
    $null,
    $registryOptions
  )
  if ($registeredInstallDirectory -ne $expectedInstallDirectory) {
    throw "The Electron NSIS current-user registry location does not match the explicit install directory."
  }
} finally {
  if ($null -ne $installRegistry) { $installRegistry.Dispose() }
  $registryRoot.Dispose()
}
