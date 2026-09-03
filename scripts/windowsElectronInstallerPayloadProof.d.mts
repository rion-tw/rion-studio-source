import type {
  PackagedElectronPackageManifestSummary,
  PortablePackagedElectronPackageManifest
} from "./packagedElectronPackageManifest.mjs";
import type { WindowsElectronInstallerPayloadProof } from
  "./windowsElectronInstallerPayloadProofContract.mjs";
import type { WindowsIsolatedProfileResult } from
  "./windowsIsolatedProfileResultContract.mjs";

export interface StableRegularFileArtifact {
  readonly bytes: number;
  readonly fileName: string;
  readonly sha256: string;
}

export interface WindowsInstallerPayloadBlackBoxBinding {
  readonly appAsar: {
    readonly fileName: "app.asar";
    readonly sha256: string;
  };
  readonly appVersion: string;
  readonly executable: {
    readonly fileName: string;
    readonly sha256: string;
  };
  readonly nativeAddon: {
    readonly fileName: "rion-core.node";
    readonly sha256: string;
  };
  readonly packageManifest: PackagedElectronPackageManifestSummary;
}

export function createWindowsElectronInstallerPayloadProof(input: {
  attemptNonce: string;
  commandPath: string;
  commandScriptPath: string;
  environment?: NodeJS.ProcessEnv;
  forbiddenSourceFileListPath: string;
  gateRootPath: string;
  installedApplicationPath: string;
  installerPath: string;
  isolationResultPath: string;
  outputPath: string;
  sourceApplicationPath: string;
  sourceSha: string;
  version: string;
}): Promise<{
  identity: StableRegularFileArtifact;
  proof: WindowsElectronInstallerPayloadProof;
}>;

export function buildWindowsElectronInstallerPayloadProof(input: {
  installedAppVersion: string;
  installedManifest: PortablePackagedElectronPackageManifest;
  installer: StableRegularFileArtifact;
  installerAuthenticodeStatus: string;
  isolationResult: WindowsIsolatedProfileResult;
  mainAuthenticodeStatus: string;
  sourceAppVersion: string;
  sourceManifest: PortablePackagedElectronPackageManifest;
  sourceSha: string;
  uninstallerAuthenticodeStatus: string;
  version: string;
}): WindowsElectronInstallerPayloadProof;

export function readAndVerifyWindowsElectronInstallerPayloadProof(input: {
  blackBoxEvidence?: WindowsInstallerPayloadBlackBoxBinding;
  installerPath?: string;
  proofPath: string;
  sourceApplicationPath?: string;
  sourceSha?: string;
  version?: string;
}): Promise<{
  identity: StableRegularFileArtifact;
  proof: WindowsElectronInstallerPayloadProof;
  source: Buffer;
}>;

export function assertWindowsInstallerPayloadProofMatchesBlackBox(
  proof: WindowsElectronInstallerPayloadProof,
  blackBoxEvidence: WindowsInstallerPayloadBlackBoxBinding
): WindowsElectronInstallerPayloadProof;

export function captureStableRegularFileArtifact(
  filePath: string,
  maximumBytes?: number,
  label?: string
): Promise<StableRegularFileArtifact>;

export function writeWindowsForbiddenSourcePathList(input: {
  outputPath: string;
  sourceApplicationPath: string;
}): Promise<{
  identity: StableRegularFileArtifact;
  paths: readonly string[];
}>;

export function readAndVerifyWindowsForbiddenSourcePathList(input: {
  listPath: string;
  sourceApplicationPath: string;
}): Promise<{
  identity: StableRegularFileArtifact;
  paths: readonly string[];
}>;

export function readAndVerifyWindowsIsolatedProfileResult(
  resultPath: string,
  expectedBinding: {
    readonly attemptNonce: string;
    readonly attestedInputs: WindowsIsolatedProfileResult["attestedInputs"];
    readonly commandInvocationSha256: string;
  }
): Promise<WindowsIsolatedProfileResult>;
