import type { PackagedElectronPackageManifestSummary } from
  "./packagedElectronPackageManifest.mjs";

export const ELECTRON_UPDATER_MACOS_PACKAGE_VERIFICATION_KIND:
  "rion-electron-updater-macos-package-verification";

export interface ElectronUpdaterMacosPackageVerification {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-updater-macos-package-verification";
  readonly verificationKind:
    "safe-tar-extraction-production-electron-package-v1";
  readonly applicationBundle: "Rion Studio.app";
  readonly expectedVersion: string;
  readonly artifact: {
    readonly fileName: "Rion.Studio-mac.app.tar.gz";
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly packageManifest: PackagedElectronPackageManifestSummary;
}

export function verifyElectronUpdaterMacosPackage(
  input: Readonly<{
    artifactPath: string;
    expectedArtifact: Readonly<{
      bytes: number;
      path: string;
      sha256: string;
    }>;
    expectedVersion: string;
    referenceApplicationPath: string;
    packageVerifier?: (
      applicationPath: string
    ) => Promise<Readonly<{ resourcesPath: string }>>;
  }>
): Promise<ElectronUpdaterMacosPackageVerification>;

export function assertElectronUpdaterMacosPackageVerification(
  value: unknown,
  expected: Readonly<{
    artifact: Readonly<{ bytes: number; sha256: string }>;
    version: string;
  }>
): ElectronUpdaterMacosPackageVerification;
