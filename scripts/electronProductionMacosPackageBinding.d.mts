import type { PackagedElectronPackageManifestSummary } from
  "./packagedElectronPackageManifest.mjs";

export const ELECTRON_MACOS_PACKAGE_BINDING_KIND:
  "rion-electron-macos-package-binding";

export interface ElectronMacosPackageBindingFileIdentity {
  bytes: number;
  fileName: string;
  sha256: string;
}

export interface ElectronMacosPackageBindingEvidence {
  applicationBundle: "Rion Studio.app";
  artifact: ElectronMacosPackageBindingFileIdentity;
  distribution: ElectronMacosPackageBindingFileIdentity;
  kind: "rion-electron-macos-package-binding";
  packageManifest: PackagedElectronPackageManifestSummary;
  schemaVersion: 1;
  verificationKind: "safe-tar-extraction-and-read-only-dmg-mount-v2";
}

export function createMacosPackageBindingEvidence(input: {
  artifact: ElectronMacosPackageBindingFileIdentity;
  distribution: ElectronMacosPackageBindingFileIdentity;
  packageManifest: PackagedElectronPackageManifestSummary;
}): ElectronMacosPackageBindingEvidence;

export function assertMacosPackageBindingEvidence(
  binding: unknown,
  blackBoxEvidence: { packageManifest: PackagedElectronPackageManifestSummary },
  artifactIdentity: ElectronMacosPackageBindingFileIdentity,
  distributionIdentity: ElectronMacosPackageBindingFileIdentity
): ElectronMacosPackageBindingEvidence;

export function assertPackagedApplicationVersion(
  resourcesPath: string,
  expectedVersion: string
): Promise<void>;

export function verifyMacosUpdaterArchive(input: {
  artifactPath: string;
  environment: NodeJS.ProcessEnv;
  expectedPackageManifest: PackagedElectronPackageManifestSummary;
  expectedVersion: string;
  packageVerifier: (applicationPath: string) => Promise<{ resourcesPath: string }>;
}): Promise<void>;

export function verifyMacosDistributionPackage(input: {
  distributionPath: string;
  environment: NodeJS.ProcessEnv;
  expectedPackageManifest: PackagedElectronPackageManifestSummary;
  expectedVersion: string;
  packageVerifier: (applicationPath: string) => Promise<{ resourcesPath: string }>;
}): Promise<void>;

export function createVerifiedMacosPackageBinding(input: {
  artifactPath: string;
  distributionPath: string;
  environment: NodeJS.ProcessEnv;
  expectedPackageManifest: PackagedElectronPackageManifestSummary;
  expectedVersion: string;
  packageVerifier: (applicationPath: string) => Promise<{ resourcesPath: string }>;
}): Promise<ElectronMacosPackageBindingEvidence>;
