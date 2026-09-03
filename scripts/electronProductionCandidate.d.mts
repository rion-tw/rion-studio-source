import type { PackagedElectronPackageManifestSummary } from
  "./packagedElectronPackageManifest.mjs";
import type { ElectronMacosPackageBindingEvidence } from
  "./electronProductionMacosPackageBinding.mjs";

export {
  createMacosPackageBindingEvidence,
  ELECTRON_MACOS_PACKAGE_BINDING_KIND
} from "./electronProductionMacosPackageBinding.mjs";

export const ELECTRON_PRODUCTION_CANDIDATE_APPROVAL: string;
export const ELECTRON_PRODUCTION_ENVIRONMENT: string;
export const ELECTRON_PLATFORM_RECEIPT_NAME: string;
export const ELECTRON_CANDIDATE_RECEIPT_NAME: string;
export const ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME: string;
export const ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME: string;
export const ELECTRON_WINDOWS_INSTALLER_PAYLOAD_PROOF_NAME: string;

export interface ElectronPackagedBlackBoxEvidence {
  appAsar: { fileName: "app.asar"; sha256: string };
  application: { path: string };
  appVersion: string;
  executable: { fileName: string; sha256: string };
  exitCode: 0;
  isolationKind: "fixed-macos-home" | "temporary-local-windows-user-profile-v1";
  kind: "rion-packaged-electron-black-box-smoke";
  nativeAddon: { fileName: "rion-core.node"; sha256: string };
  nativeHostKind: "appkit-chromium" | "bundled-chromium";
  packageManifest: PackagedElectronPackageManifestSummary;
  remoteDebugging: false;
  report: { bytes: number; fileName: string; sha256: string };
  screenshot: { bytes: number; fileName: string; sha256: string };
  runtimePlatform: "darwin" | "win32";
  runtimeTarget: "chromium-v23-macos-appkit" | "chromium-v23-windows";
  schemaVersion: 1;
  verdict: "passed";
}

export interface ElectronProductionCandidateInput {
  ownerApproval: string;
  publicKey: string;
  publishedAt: string;
  sourceSha: string;
  updaterBaseUrl: string;
  version: string;
}

export interface ValidatedElectronProductionCandidateInput {
  baseUrl: string;
  publicKeySha256: string;
  publishedAt: string;
  sourceSha: string;
  updaterEndpoint: string;
  version: string;
}

export function validateElectronProductionCandidateInputs(
  input: ElectronProductionCandidateInput
): ValidatedElectronProductionCandidateInput;

export function normalizeUpdaterPublicKey(value: string): {
  canonicalBase64: string;
  keyBytes: Buffer;
  keyId: Buffer;
  sha256: string;
};

export function verifyMinisignArtifact(
  artifactPath: string,
  signaturePath: string,
  publicKeySource: string
): Promise<{
  artifactBytes: number;
  artifactSha256: string;
  publicKeySha256: string;
  signatureBytes: number;
  signatureSha256: string;
}>;

export function verifyPackagedBlackBoxReport(input: {
  applicationPath: string;
  platform: "darwin-aarch64" | "windows-x86_64";
  reportPath: string;
  version: string;
}): Promise<{
  evidence: ElectronPackagedBlackBoxEvidence;
  reportSource: Buffer;
  screenshotSourcePath: string;
}>;

export function stageElectronProductionPlatformCandidate(
  input: ElectronProductionCandidateInput & {
    applicationPath: string;
    artifactPath: string;
    blackBoxReportPath: string;
    distributionPath?: string;
    macosPackageBinding?: ElectronMacosPackageBindingEvidence;
    outputDirectory: string;
    platform: "darwin-aarch64" | "windows-x86_64";
    windowsInstallerPayloadProofPath?: string;
  }
): Promise<Record<string, unknown>>;

export function assembleElectronProductionCandidate(
  input: ElectronProductionCandidateInput & {
    macDirectory: string;
    outputDirectory: string;
    receiptPath: string;
    windowsDirectory: string;
  }
): Promise<Record<string, unknown>>;
