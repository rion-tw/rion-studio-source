export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_KIND:
  "rion-electron-production-public-latest-lease";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE:
  "electron-production-public-latest-lease.json";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_REPOSITORY:
  "rion-tw/rion-studio-source";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_HOLDER_WORKFLOWS: Readonly<{
  "electron-v23-provisional-publication":
    ".github/workflows/electron-production-provisional-publish.yml";
  "tauri-v22-publication": ".github/workflows/publish-public-release.yml";
  "tauri-v22-latest-restore": ".github/workflows/restore-public-latest.yml";
}>;

export type ElectronProductionPublicLatestLeasePurpose =
  | "electron-v23-provisional-publication"
  | "tauri-v22-publication"
  | "tauri-v22-latest-restore";

export interface ElectronProductionPublicLatestLeaseHolder {
  readonly repository: "rion-tw/rion-studio-source";
  readonly workflow:
    | ".github/workflows/electron-production-provisional-publish.yml"
    | ".github/workflows/publish-public-release.yml"
    | ".github/workflows/restore-public-latest.yml";
  readonly runId: string;
  readonly runAttempt: number;
  readonly headSha: string;
}

export interface ElectronProductionPublicLatestLeaseState {
  readonly runtime: "tauri-v22" | "electron-v23";
  readonly version: string;
  readonly stateSha256: string;
}

export interface ElectronProductionPublicLatestLease {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-public-latest-lease";
  readonly transactionId: string;
  readonly leaseId: string;
  readonly vacantGeneration: number;
  readonly generation: number;
  readonly status: "held" | "released";
  readonly purpose: ElectronProductionPublicLatestLeasePurpose;
  readonly holder: Readonly<ElectronProductionPublicLatestLeaseHolder>;
  readonly source: Readonly<ElectronProductionPublicLatestLeaseState>;
  readonly target: Readonly<ElectronProductionPublicLatestLeaseState>;
  readonly revision: number;
  readonly acquiredFromEventSha256: string | null;
  readonly previousEventSha256: string | null;
  readonly acquiredAt: string;
  readonly recordedAt: string;
}

export interface ElectronProductionPublicLatestLeaseFile {
  readonly lease: Readonly<ElectronProductionPublicLatestLease>;
  readonly leaseIdentity: Readonly<{
    bytes: number;
    fileName: "electron-production-public-latest-lease.json";
    sha256: string;
  }>;
  readonly leasePath: string;
}

export function acquireElectronProductionPublicLatestLease(input: Readonly<{
  holder: ElectronProductionPublicLatestLeaseHolder;
  leaseId: string;
  previous: unknown | null;
  purpose: ElectronProductionPublicLatestLeasePurpose;
  recordedAt: string;
  source: Readonly<ElectronProductionPublicLatestLeaseState>;
  target: ElectronProductionPublicLatestLeaseState;
  transactionId: string;
  vacantGeneration: number;
}>): Readonly<ElectronProductionPublicLatestLease>;

export function releaseElectronProductionPublicLatestLease(
  previousValue: unknown,
  input: Readonly<{
    generation: number;
    leaseId: string;
    recordedAt: string;
    sourceStateSha256: string;
    targetStateSha256: string;
    transactionId: string;
  }>
): Readonly<ElectronProductionPublicLatestLease>;

export function assertElectronProductionPublicLatestLeaseHeldObservation(
  input: Readonly<{ expected: unknown; observed: unknown }>
): Readonly<ElectronProductionPublicLatestLease>;

export function assertElectronProductionPublicLatestLeaseSuccessor(
  input: Readonly<{ next: unknown; previous: unknown }>
): Readonly<ElectronProductionPublicLatestLease>;

export function assertElectronProductionPublicLatestLease(
  value: unknown
): Readonly<ElectronProductionPublicLatestLease>;

export function electronProductionPublicLatestLeaseEventSha256(
  value: unknown
): string;

export function serializeElectronProductionPublicLatestLease(
  value: unknown
): Buffer;

export function writeElectronProductionPublicLatestLease(input: Readonly<{
  lease: unknown;
  outputPath: string;
}>): Promise<Readonly<ElectronProductionPublicLatestLeaseFile>>;

export function readElectronProductionPublicLatestLease(input: Readonly<{
  expectedSha256: string;
  leasePath: string;
}>): Promise<Readonly<ElectronProductionPublicLatestLeaseFile>>;
