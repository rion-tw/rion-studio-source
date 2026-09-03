export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_KIND:
  "rion-production-updater-data-preservation-before";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_KIND:
  "rion-production-updater-data-preservation-observation";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE:
  "data-preservation-before.json";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE:
  "data-preservation-observation.json";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE:
  ".rion-production-updater-evidence-challenge";

export type ElectronProductionUpdaterDataPreservationPlatform =
  | "darwin-aarch64"
  | "windows-x86_64";
export type ElectronProductionUpdaterDataPreservationTransition =
  | "tauri-v22-to-electron-v23"
  | "electron-v23-to-electron-v23";

export interface ElectronProductionUpdaterDataPreservationChallenge {
  readonly expiresAt: string;
  readonly id: string;
  readonly issuedAt: string;
  readonly nonceSha256: string;
}

export interface ElectronProductionUpdaterDataPreservationTarget {
  readonly artifactName: string;
  readonly artifactSha256: string;
  readonly candidateReceiptSha256: string;
  readonly embeddedUpdaterEndpoint: string;
  readonly manifestName: "latest.json";
  readonly runtime: "electron-v23";
  readonly servedManifestSha256: string;
  readonly signatureName: string;
  readonly signatureSha256: string;
  readonly sourceSha: string;
  readonly version: string;
}

export interface ElectronProductionUpdaterDataPreservationContext {
  readonly challenge:
    Readonly<ElectronProductionUpdaterDataPreservationChallenge>;
  readonly evidenceAttemptId: string;
  readonly platform: ElectronProductionUpdaterDataPreservationPlatform;
  readonly transitionKind:
    ElectronProductionUpdaterDataPreservationTransition;
  readonly sourceInstallAttemptId: string;
  readonly target: Readonly<ElectronProductionUpdaterDataPreservationTarget>;
}

export interface ElectronProductionUpdaterDataPreservationBefore {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-data-preservation-before";
  readonly challengeNonceSha256: string;
  readonly userDataDirectoryIdentity: Readonly<{
    readonly dev: string;
    readonly ino: string;
  }>;
  readonly sentinel: Readonly<{
    readonly bytes: 32;
    readonly dev: string;
    readonly fileName:
      ".rion-production-updater-evidence-challenge";
    readonly ino: string;
    readonly sha256: string;
  }>;
}

export interface ElectronProductionUpdaterDataPreservationObservation extends
  ElectronProductionUpdaterDataPreservationContext {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-production-updater-data-preservation-observation";
  readonly observedAt: string;
  readonly preservation: Readonly<{
    readonly afterChallengeSha256: string;
    readonly beforeChallengeSha256: string;
    readonly preserved: true;
    readonly userDataIdentitySha256: string;
  }>;
}

export interface ElectronProductionUpdaterDataPreservationBeforeFile {
  readonly before:
    Readonly<ElectronProductionUpdaterDataPreservationBefore>;
  readonly beforeIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName: "data-preservation-before.json";
    readonly sha256: string;
  }>;
  readonly beforePath: string;
}

export interface ElectronProductionUpdaterDataPreservationPrepared extends
  ElectronProductionUpdaterDataPreservationBeforeFile {
  readonly sentinel: Readonly<{
    readonly bytes: 32;
    readonly fileName:
      ".rion-production-updater-evidence-challenge";
    readonly sha256: string;
  }>;
}

export interface ElectronProductionUpdaterDataPreservationObservationFile {
  readonly observation:
    Readonly<ElectronProductionUpdaterDataPreservationObservation>;
  readonly observationIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName: "data-preservation-observation.json";
    readonly sha256: string;
  }>;
  readonly observationPath: string;
}

export function prepareElectronProductionUpdaterDataPreservation(
  input: Readonly<{
    beforeReceiptPath: string;
    challengeNoncePath: string;
    expectedChallengeSha256: string;
    userDataDirectory: string;
  }>
): Promise<Readonly<ElectronProductionUpdaterDataPreservationPrepared>>;

export function finalizeElectronProductionUpdaterDataPreservation(
  input: Readonly<{
    beforeReceiptPath: string;
    contextPath: string;
    expectedBeforeReceiptSha256: string;
    expectedContextSha256: string;
    observationPath: string;
    userDataDirectory: string;
  }>,
  dependencyOverrides?: Readonly<{ now?: () => Date }>
): Promise<Readonly<ElectronProductionUpdaterDataPreservationObservationFile>>;

export function assertElectronProductionUpdaterDataPreservationBefore(
  value: unknown
): Readonly<ElectronProductionUpdaterDataPreservationBefore>;

export function assertElectronProductionUpdaterDataPreservationObservation(
  value: unknown
): Readonly<ElectronProductionUpdaterDataPreservationObservation>;

export function readElectronProductionUpdaterDataPreservationBefore(
  input: Readonly<{
    beforeReceiptPath: string;
    expectedBeforeReceiptSha256: string;
  }>
): Promise<Readonly<ElectronProductionUpdaterDataPreservationBeforeFile>>;

export function readElectronProductionUpdaterDataPreservationObservation(
  input: Readonly<{
    expectedObservationSha256: string;
    observationPath: string;
  }>
): Promise<Readonly<ElectronProductionUpdaterDataPreservationObservationFile>>;
