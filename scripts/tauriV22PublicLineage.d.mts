export type TauriV22PublicLineagePlatform =
  | "darwin-aarch64"
  | "windows-x86_64";

export type TauriV22RunningExecutableDerivation =
  | "macos-exact-archive-member"
  | "windows-isolated-current-user-nsis-install";

export interface TauriV22VerifiedInputReceipt {
  artifactBytes: number;
  artifactName: string;
  artifactSha256: string;
  checksumName: "SHA256SUMS.txt";
  checksumSha256: string;
  evidenceKind: "tauri-v22-published-input";
  manifestName: "latest.json";
  manifestSha256: string;
  platform: TauriV22PublicLineagePlatform;
  releaseTag: string;
  releaseVersion: string;
  repository: "rion-tw/rion-studio";
  runtime: "tauri-v22";
  schemaVersion: 2;
  signatureName: string;
  signatureSha256: string;
  sourceSha: string;
  targetSha: string;
  updaterPublicKeySha256: string;
}

export interface TauriV22PublicReleaseAssetMetadata {
  bytes: number;
  id: string;
  name: string;
}

export interface TauriV22PublicReleaseMetadata {
  assets: {
    artifact: TauriV22PublicReleaseAssetMetadata;
    checksums: TauriV22PublicReleaseAssetMetadata;
    manifest: TauriV22PublicReleaseAssetMetadata;
    signature: TauriV22PublicReleaseAssetMetadata;
  };
  draft: false;
  id: string;
  observedAt: string;
  prerelease: false;
  publishedAt: string;
  repository: "rion-tw/rion-studio";
  tagName: string;
  version: string;
  wasLatestAtCapture: true;
}

export interface TauriV22SourceTagMetadata {
  observedAt: string;
  peeledCommitSha: string;
  refObjectSha: string;
  refObjectType: "commit" | "tag";
  releaseTag: string;
  repository: "rion-tw/rion-studio-source";
}

export interface TauriV22LineageProducerProvenance {
  artifactName: string;
  event: "workflow_dispatch";
  headSha: string;
  producedAt: string;
  repository: "rion-tw/rion-studio-source";
  runAttempt: number;
  runId: string;
  workflow: ".github/workflows/electron-updater-tauri-v22-compatibility.yml";
}

export interface TauriV22RunningExecutableInput {
  derivation: TauriV22RunningExecutableDerivation;
  path: string;
}

export interface TauriV22PublicLineageBuildInput {
  assetDirectory: string;
  outputPath: string;
  producer: TauriV22LineageProducerProvenance;
  publicRelease: TauriV22PublicReleaseMetadata;
  runningExecutable: TauriV22RunningExecutableInput;
  sourceTag: TauriV22SourceTagMetadata;
  verifiedInputReceiptPath: string;
}

export interface TauriV22PublicLineageVerificationInput
  extends Omit<TauriV22PublicLineageBuildInput, "outputPath"> {
  expectedReceiptSha256: string;
  receiptPath: string;
}

export interface TauriV22PublicLineageReceiptInput {
  expectedReceiptSha256: string;
  receiptPath: string;
}

export interface TauriV22PublicLineageAsset {
  bytes: number;
  id: string;
  name: string;
  sha256: string;
}

export interface TauriV22PublicLineageReceipt {
  schemaVersion: 1;
  kind: "rion-tauri-v22-public-source-lineage";
  status: "verified-public-source-lineage";
  cutoverEligible: false;
  runtime: "tauri-v22";
  platform: TauriV22PublicLineagePlatform;
  release: {
    repository: "rion-tw/rion-studio";
    id: string;
    tag: string;
    version: string;
    draft: false;
    prerelease: false;
    wasLatestAtCapture: true;
    publishedAt: string;
    observedAt: string;
  };
  sourceTag: TauriV22SourceTagMetadata;
  targetSourceSha: string;
  trust: {
    updaterPublicKeySha256: string;
  };
  verifiedInputReceipt: {
    fileName: "verified-input-receipt.json";
    sha256: string;
  };
  assets: {
    artifact: TauriV22PublicLineageAsset;
    checksums: TauriV22PublicLineageAsset;
    manifest: TauriV22PublicLineageAsset;
    signature: TauriV22PublicLineageAsset;
  };
  runningExecutable: {
    derivation: TauriV22RunningExecutableDerivation;
    relativePath: string;
    fileName: string;
    bytes: number;
    sha256: string;
    derivedFromArtifactSha256: string;
  };
  producer: TauriV22LineageProducerProvenance;
  verifiedAt: string;
}

export const TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME:
  "tauri-v22-public-lineage-receipt.json";
export const TAURI_V22_PUBLIC_LINEAGE_KIND:
  "rion-tauri-v22-public-source-lineage";
export const TAURI_V22_COMPATIBILITY_WORKFLOW:
  ".github/workflows/electron-updater-tauri-v22-compatibility.yml";

export function createTauriV22PublicLineage(
  input: TauriV22PublicLineageBuildInput
): Promise<Readonly<TauriV22PublicLineageReceipt>>;

export function verifyTauriV22PublicLineage(
  input: TauriV22PublicLineageVerificationInput
): Promise<Readonly<TauriV22PublicLineageReceipt>>;

export function readTauriV22PublicLineageReceipt(
  input: TauriV22PublicLineageReceiptInput
): Promise<Readonly<TauriV22PublicLineageReceipt>>;

export function assertTauriV22PublicLineagePair(input: {
  macos: TauriV22PublicLineageReceipt;
  windows: TauriV22PublicLineageReceipt;
}): Readonly<{
  macos: TauriV22PublicLineageReceipt;
  windows: TauriV22PublicLineageReceipt;
}>;
