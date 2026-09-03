param(
  [Parameter(Mandatory = $true)]
  [string] $CommandEnvelope
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "The isolated profile command requires Windows."
}

$envelope = Get-Content -LiteralPath $CommandEnvelope -Raw | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.User.Value -ne $envelope.expectedSid) {
  throw "The isolated command did not start under the expected temporary SID."
}
if ($identity.User.Value -eq $envelope.parentSid) {
  throw "The isolated command retained the parent runner identity."
}

if (-not ("RionWindowsKnownFolders" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class RionWindowsKnownFolders {
    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath(
        [MarshalAs(UnmanagedType.LPStruct)] Guid rfid,
        uint flags,
        IntPtr token,
        out IntPtr path);

    public static string Get(Guid id) {
        IntPtr path;
        int result = SHGetKnownFolderPath(id, 0x00008000, IntPtr.Zero, out path);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        try {
            return Marshal.PtrToStringUni(path);
        } finally {
            Marshal.FreeCoTaskMem(path);
        }
    }
}
'@
}

$profileRoot = [RionWindowsKnownFolders]::Get(
  [Guid] "5E6C858F-0E22-4760-9AFE-EA3317B67173"
)
$roamingAppData = [RionWindowsKnownFolders]::Get(
  [Guid] "3EB685DB-65F9-4CF6-A03A-E3EF65729F3D"
)
$localAppData = [RionWindowsKnownFolders]::Get(
  [Guid] "F1B32785-6FBA-4FCF-9D55-7B8E7F157091"
)
$userProgramFiles = [RionWindowsKnownFolders]::Get(
  [Guid] "5CD7AEE2-2219-4A67-B85D-6C9CE15660CB"
)

$expectedRoaming = Join-Path $profileRoot "AppData\Roaming"
$expectedLocal = Join-Path $profileRoot "AppData\Local"
$expectedPrograms = Join-Path $expectedLocal "Programs"
if (
  -not $profileRoot -or
  $roamingAppData -ne $expectedRoaming -or
  $localAppData -ne $expectedLocal -or
  $userProgramFiles -ne $expectedPrograms
) {
  throw "Windows Known Folder resolution escaped the temporary user profile."
}

$allowedEnvironmentNames = [Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)
foreach ($name in @(
  "AR",
  "CARGO_HOME",
  "CARGO_TARGET_DIR",
  "CC",
  "CI",
  "COMSPEC",
  "CXX",
  "GITHUB_ACTIONS",
  "INCLUDE",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LIB",
  "LIBPATH",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "RANLIB",
  "RION_STUDIO_E2E_ARTIFACT_ROOT",
  "RION_STUDIO_ELECTRON_PACKAGE_VERSION",
  "RION_STUDIO_UPDATER_ENDPOINT",
  "RION_STUDIO_UPDATER_PUBLIC_KEY",
  "RION_UPDATER_CI_FIXTURE_ROOT",
  "RION_UPDATER_PREPARED_INPUT_ROOT",
  "RION_UPDATER_PREVIOUS_TAURI_V22_INSTALLER",
  "RION_UPDATER_PREVIOUS_TAURI_V22_VERSION",
  "RION_UPDATER_PREVIOUS_V23_INSTALLER",
  "RION_UPDATER_PREVIOUS_V23_VERSION",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "UCRTVERSION",
  "UNIVERSALCRTSDKDIR",
  "VCINSTALLDIR",
  "VCTOOLSINSTALLDIR",
  "VSINSTALLDIR",
  "WINDIR",
  "WINDOWSSDKDIR",
  "WINDOWSSDKVERSION"
)) {
  [void] $allowedEnvironmentNames.Add($name)
}
if ($envelope.allowEphemeralUpdaterSigningEnvironment -eq $true) {
  [void] $allowedEnvironmentNames.Add("TAURI_SIGNING_PRIVATE_KEY_PATH")
  [void] $allowedEnvironmentNames.Add("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
}
$closedEnvironment = [ordered]@{}
foreach ($entry in @(Get-ChildItem Env:)) {
  if ($allowedEnvironmentNames.Contains($entry.Name)) {
    $closedEnvironment[$entry.Name] = $entry.Value
  }
}
foreach ($entry in @(Get-ChildItem Env:)) {
  Remove-Item -LiteralPath "Env:$($entry.Name)" -ErrorAction Stop
}
foreach ($entry in $closedEnvironment.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
}
$env:PSModulePath = Join-Path $PSHOME "Modules"

$temporaryDirectory = Join-Path $localAppData "Temp"
New-Item -ItemType Directory -Force -Path @(
  $roamingAppData,
  $localAppData,
  $userProgramFiles,
  $temporaryDirectory
) | Out-Null

$env:APPDATA = $roamingAppData
$env:HOME = $profileRoot
$env:HOMEDRIVE = [IO.Path]::GetPathRoot($profileRoot).TrimEnd("\")
$env:HOMEPATH = $profileRoot.Substring($env:HOMEDRIVE.Length)
$env:LOCALAPPDATA = $localAppData
$env:TEMP = $temporaryDirectory
$env:TMP = $temporaryDirectory
$env:USERNAME = $identity.Name.Substring($identity.Name.IndexOf("\") + 1)
$env:USERDOMAIN = $env:COMPUTERNAME
$env:USERPROFILE = $profileRoot
$env:RION_WINDOWS_ISOLATED_PROFILE_KIND = "temporary-local-windows-user-profile-v1"
$env:RION_WINDOWS_ISOLATED_PROFILE_SID = $identity.User.Value
$env:RION_WINDOWS_ISOLATED_PROFILE_PARENT_SID = $envelope.parentSid
$env:RION_WINDOWS_ISOLATED_PROFILE_ROOT = $profileRoot
$env:RION_WINDOWS_ISOLATED_PROFILE_ROAMING_APP_DATA = $roamingAppData
$env:RION_WINDOWS_ISOLATED_PROFILE_LOCAL_APP_DATA = $localAppData
$env:RION_WINDOWS_ISOLATED_PROFILE_USER_PROGRAM_FILES = $userProgramFiles

Push-Location -LiteralPath $envelope.workingDirectory
try {
  & $envelope.commandPath @($envelope.arguments)
  $commandExitCode = $LASTEXITCODE
  if ($null -eq $commandExitCode) {
    $commandExitCode = 0
  }
} finally {
  Pop-Location
}
exit $commandExitCode
