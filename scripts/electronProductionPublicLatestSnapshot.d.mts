export const ELECTRON_PRODUCTION_PUBLIC_LATEST_SNAPSHOT_KIND:
  "rion-electron-production-public-latest-snapshot";
export const ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY:
  "rion-tw/rion-studio";
export const ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES:
  readonly string[];

export interface ElectronProductionPublicReleaseAssetMetadata {
  readonly bytes: number;
  readonly contentType: string;
  readonly digest: `sha256:${string}`;
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface ElectronProductionPublicLatestSnapshot {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-public-latest-snapshot";
  readonly observationKind:
    | "observed-release"
    | "expected-latest-projection"
    | "expected-tauri-v22-latest-projection";
  readonly repository: "rion-tw/rion-studio";
  readonly release: Readonly<{
    draft: false;
    id: string;
    isLatest: boolean;
    prerelease: false;
    tag: string;
    targetCommitish: string;
  }>;
  readonly assets: readonly ElectronProductionPublicReleaseAssetMetadata[];
  readonly latestJson: Readonly<{
    bytes: number;
    platforms: Readonly<Record<
      "darwin-aarch64" | "windows-x86_64",
      Readonly<{
        artifactName: string;
        artifactSha256: string;
        signatureFileName: string;
        signatureFileSha256: string;
        url: string;
      }>
    >>;
    publishedAt: string;
    sha256: string;
    version: string;
  }>;
  readonly candidateReceipt: null | Readonly<{
    assets: Readonly<Record<string, string>>;
    bytes: number;
    fileName: "electron-production-candidate-receipt.json";
    publicKeySha256: string;
    sha256: string;
    sourceSha: string;
    updaterBaseUrl: string;
    updaterEndpoint: string;
    version: string;
  }>;
  readonly stateSha256: string;
  readonly snapshotSha256: string;
}

export interface ElectronProductionPublicReleaseMetadata {
  readonly assets: readonly ElectronProductionPublicReleaseAssetMetadata[];
  readonly draft: false;
  readonly id: string;
  readonly isLatest: boolean;
  readonly prerelease: false;
  readonly repository: "rion-tw/rion-studio";
  readonly tag: string;
  readonly targetCommitish: string;
}

export function createElectronProductionPublicLatestSnapshot(input: Readonly<{
  assetDirectory: string;
  candidateReceiptPath?: string | null;
  candidateReceiptSha256?: string | null;
  candidateReceiptSummary?:
    ElectronProductionPublicLatestSnapshot["candidateReceipt"];
  release: ElectronProductionPublicReleaseMetadata;
}>): Promise<ElectronProductionPublicLatestSnapshot>;

export function assertElectronProductionPublicLatestSnapshot(
  value: unknown
): ElectronProductionPublicLatestSnapshot;

export function deriveElectronProductionExpectedLatestState(
  stagedObserved: unknown
): ElectronProductionPublicLatestSnapshot;

export function deriveTauriV22ExpectedLatestState(
  stagedObserved: unknown
): ElectronProductionPublicLatestSnapshot;

export function assertElectronProductionRestorableSourceRelease(input: Readonly<{
  observed: unknown;
  source: unknown;
}>): ElectronProductionPublicLatestSnapshot;

export function serializeElectronProductionPublicLatestSnapshot(
  value: unknown
): Buffer;

export function writeElectronProductionPublicLatestSnapshot(input: Readonly<{
  outputPath: string;
  snapshot: ElectronProductionPublicLatestSnapshot;
}>): Promise<Readonly<{
  file: Readonly<{ bytes: number; sha256: string }>;
  snapshot: ElectronProductionPublicLatestSnapshot;
}>>;

export function readElectronProductionPublicLatestSnapshot(input: Readonly<{
  expectedFileSha256?: string;
  snapshotPath: string;
}>): Promise<Readonly<{
  file: Readonly<{ bytes: number; sha256: string }>;
  snapshot: ElectronProductionPublicLatestSnapshot;
}>>;

export function classifyElectronProductionPublicLatestSnapshot(input: Readonly<{
  observed: unknown;
  source: unknown;
  target: unknown;
}>): "source" | "target" | "foreign";
