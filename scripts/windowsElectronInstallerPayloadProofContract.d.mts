import type { PortablePackagedElectronPackageManifest } from
  "./packagedElectronPackageManifest.mjs";
import type { WindowsIsolatedProfileResult } from
  "./windowsIsolatedProfileResultContract.mjs";

export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME:
  "windows-installer-payload-proof.json";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_KIND:
  "rion-electron-windows-installer-payload-proof";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_ISOLATION_KIND:
  "temporary-local-windows-user-profile-v1";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_INSTALL_MODE:
  "nsis-silent-current-user-explicit-directory-v1";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_POLICY:
  "exact-source-tree-plus-single-root-nsis-uninstaller-v1";
export const WINDOWS_ELECTRON_INSTALLER_NAME: "Rion.Studio-win.exe";
export const WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH: "Rion Studio.exe";
export const WINDOWS_ELECTRON_UNINSTALLER_PATH: "Uninstall Rion Studio.exe";

export interface WindowsElectronInstallerPayloadProof {
  readonly comparison: {
    readonly addedPaths: readonly ["Uninstall Rion Studio.exe"];
    readonly changedPaths: readonly [];
    readonly normalizedInstalledManifest: PortablePackagedElectronPackageManifest;
    readonly policy: "exact-source-tree-plus-single-root-nsis-uninstaller-v1";
    readonly removedPaths: readonly [];
    readonly verdict: "identical";
  };
  readonly installedPackage: {
    readonly appVersion: string;
    readonly executable: {
      readonly authenticodeStatus: "NotSigned";
      readonly bytes: number;
      readonly relativePath: "Rion Studio.exe";
      readonly sha256: string;
    };
    readonly manifest: PortablePackagedElectronPackageManifest;
    readonly uninstaller: {
      readonly authenticodeStatus: "NotSigned";
      readonly bytes: number;
      readonly relativePath: "Uninstall Rion Studio.exe";
      readonly sha256: string;
    };
  };
  readonly installer: {
    readonly authenticodeStatus: "NotSigned";
    readonly bytes: number;
    readonly fileName: "Rion.Studio-win.exe";
    readonly sha256: string;
  };
  readonly isolation: {
    readonly applicationLaunchRequested: false;
    readonly installMode: "nsis-silent-current-user-explicit-directory-v1";
    readonly kind: "temporary-local-windows-user-profile-v1";
    readonly runnerResult: WindowsIsolatedProfileResult & {
      readonly expectedTotalProcesses: 3;
      readonly totalProcesses: 3;
    };
  };
  readonly kind: "rion-electron-windows-installer-payload-proof";
  readonly platform: "windows-x86_64";
  readonly schemaVersion: 1;
  readonly sourcePackage: {
    readonly appVersion: string;
    readonly manifest: PortablePackagedElectronPackageManifest;
  };
  readonly sourceSha: string;
  readonly verdict: "passed";
  readonly version: string;
}

export function assertWindowsElectronInstallerPayloadProof(
  value: unknown
): WindowsElectronInstallerPayloadProof;
export function serializeWindowsElectronInstallerPayloadProof(
  proof: WindowsElectronInstallerPayloadProof
): Buffer;
