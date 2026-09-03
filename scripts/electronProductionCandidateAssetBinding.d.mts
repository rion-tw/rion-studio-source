export const MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES: number;
export const MAX_ELECTRON_CANDIDATE_SIGNATURE_BYTES: number;

export interface ElectronCandidateArtifactIdentity {
  bytes: number;
  fileName: string;
  sha256: string;
  signatureBytes: number;
  signatureFileName: string;
  signatureSha256: string;
}

export interface ElectronCandidateDistributionIdentity {
  bytes: number;
  fileName: string;
  sha256: string;
}

export interface ElectronCandidatePlatformAssetReceipt {
  artifact: ElectronCandidateArtifactIdentity;
  distribution?: ElectronCandidateDistributionIdentity;
}

export function assertCopiedPlatformAssetsMatchReceipts(
  outputDirectory: string,
  macReceipt: ElectronCandidatePlatformAssetReceipt & {
    distribution: ElectronCandidateDistributionIdentity;
  },
  windowsReceipt: ElectronCandidatePlatformAssetReceipt
): Promise<void>;

export function assertCandidateAssetDigestsMatchPlatformReceipts(
  assetSha256: Record<string, string>,
  macReceipt: ElectronCandidatePlatformAssetReceipt & {
    distribution: ElectronCandidateDistributionIdentity;
  },
  windowsReceipt: ElectronCandidatePlatformAssetReceipt
): void;

export function captureStableBoundedFileIdentity(
  filePath: string,
  maximumBytes: number,
  label: string
): Promise<Readonly<{ bytes: number; sha256: string }>>;
