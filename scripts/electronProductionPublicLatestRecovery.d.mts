import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND:
  "rion-electron-production-public-latest-recovery-observation";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND:
  "rion-electron-production-public-latest-recovery-rollback-operation";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE:
  "electron-production-public-latest-recovery-observation.json";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE:
  "electron-production-public-latest-recovery-rollback-operation.json";

export interface ElectronProductionPublicLatestRecoverySnapshotIdentity {
  readonly releaseId: string;
  readonly stateSha256: string;
  readonly snapshotSha256: string;
  readonly fileSha256: string;
}

export interface ElectronProductionPublicLatestRecoveryBasis {
  readonly source: Readonly<ElectronProductionPublicLatestRecoverySnapshotIdentity>;
  readonly target: Readonly<ElectronProductionPublicLatestRecoverySnapshotIdentity>;
}

export interface ElectronProductionPublicLatestRecoveryLatestIdentity {
  readonly releaseId: string;
  readonly updatedAt: string;
}

export type ElectronProductionPublicLatestRecoveryObservationTransport =
  | Readonly<{
      outcome: "observed";
      reason: null;
      httpStatus: 200;
    }>
  | Readonly<{
      outcome: "rejected";
      reason:
        | "github-rejected"
        | "malformed-record"
        | "repository-policy-mismatch"
        | "snapshot-mismatch";
      httpStatus: number | null;
    }>
  | Readonly<{
      outcome: "indeterminate";
      reason: "server-error" | "transport" | "unexpected-response";
      httpStatus: number | null;
    }>;

export interface ElectronProductionPublicLatestRecoveryObservation {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-public-latest-recovery-observation";
  readonly operation: "observe-latest";
  readonly repository: "rion-tw/rion-studio";
  readonly basis: Readonly<ElectronProductionPublicLatestRecoveryBasis>;
  readonly observedAt: string;
  readonly latest:
    Readonly<ElectronProductionPublicLatestRecoveryLatestIdentity> | null;
  readonly observation: Readonly<{
    classification: "source" | "target" | "foreign" | "unknown";
    snapshot:
      Readonly<ElectronProductionPublicLatestRecoverySnapshotIdentity> | null;
  }>;
  readonly transport: ElectronProductionPublicLatestRecoveryObservationTransport;
}

export interface ElectronProductionPublicLatestRecoveryObservationResultObserved {
  readonly outcome: "observed";
  readonly latest: Readonly<ElectronProductionPublicLatestRecoveryLatestIdentity>;
  readonly snapshot: ElectronProductionPublicLatestSnapshot | null;
}

export interface ElectronProductionPublicLatestRecoveryObservationResultFailure {
  readonly outcome: "rejected" | "indeterminate";
  readonly reason:
    | "github-rejected"
    | "malformed-record"
    | "repository-policy-mismatch"
    | "snapshot-mismatch"
    | "server-error"
    | "transport"
    | "unexpected-response";
  readonly status: number | null;
  readonly latest:
    Readonly<ElectronProductionPublicLatestRecoveryLatestIdentity> | null;
}

export type ElectronProductionPublicLatestRecoveryObservationResult =
  | Readonly<ElectronProductionPublicLatestRecoveryObservationResultObserved>
  | Readonly<ElectronProductionPublicLatestRecoveryObservationResultFailure>;

export interface ElectronProductionPublicLatestRecoveryObservationReference {
  readonly observationSha256: string;
  readonly observedAt: string;
  readonly latest:
    Readonly<ElectronProductionPublicLatestRecoveryLatestIdentity> | null;
  readonly classification: "source" | "target" | "foreign" | "unknown";
  readonly snapshot:
    Readonly<ElectronProductionPublicLatestRecoverySnapshotIdentity> | null;
  readonly transport: ElectronProductionPublicLatestRecoveryObservationTransport;
}

export interface ElectronProductionPublicLatestRecoveryRollbackMutation {
  readonly submitted: true;
  readonly releaseId: string;
  readonly makeLatest: true;
  readonly acknowledgement: "confirmed" | "rejected" | "unknown";
  readonly submittedAt: string;
  readonly resultRecordedAt: string;
  readonly reason:
    | "applied-response"
    | "github-rejected"
    | "server-error"
    | "transport"
    | "unexpected-response";
  readonly httpStatus: number | null;
}

export interface ElectronProductionPublicLatestRecoveryRollback {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-public-latest-recovery-rollback-operation";
  readonly status: "rollback-attempt-recorded";
  readonly operation: "rollback-public-latest";
  readonly repository: "rion-tw/rion-studio";
  readonly transactionId: string;
  readonly lease: Readonly<{
    id: string;
    generation: number;
    eventSha256: string;
  }>;
  readonly basis: Readonly<ElectronProductionPublicLatestRecoveryBasis>;
  readonly before:
    Readonly<ElectronProductionPublicLatestRecoveryObservationReference>;
  readonly mutation:
    Readonly<ElectronProductionPublicLatestRecoveryRollbackMutation>;
  readonly final:
    Readonly<ElectronProductionPublicLatestRecoveryObservationReference>;
}

export interface ElectronProductionPublicLatestRecoveryReceiptFile<Receipt> {
  readonly receipt: Readonly<Receipt>;
  readonly receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  readonly receiptPath: string;
}

export function createElectronProductionPublicLatestRecoveryObservation(
  input: Readonly<{
    observedAt: string;
    result: ElectronProductionPublicLatestRecoveryObservationResult;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionPublicLatestRecoveryObservation>;

export function assertElectronProductionPublicLatestRecoveryObservation(
  value: unknown
): Readonly<ElectronProductionPublicLatestRecoveryObservation>;

export function assertElectronProductionPublicLatestRecoveryObservationBindings(
  input: Readonly<{
    observation: unknown;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionPublicLatestRecoveryObservation>;

export function createElectronProductionPublicLatestRecoveryRollback(
  input: Readonly<{
    finalObservation: ElectronProductionPublicLatestRecoveryObservation;
    finalObservationSha256: string;
    heldLease: ElectronProductionPublicLatestLease;
    mutation: ElectronProductionPublicLatestRecoveryRollbackMutation;
    preObservation: ElectronProductionPublicLatestRecoveryObservation;
    preObservationSha256: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionPublicLatestRecoveryRollback>;

export function assertElectronProductionPublicLatestRecoveryRollback(
  value: unknown
): Readonly<ElectronProductionPublicLatestRecoveryRollback>;

export function assertElectronProductionPublicLatestRecoveryRollbackBindings(
  input: Readonly<{
    finalObservation: ElectronProductionPublicLatestRecoveryObservation;
    finalObservationSha256: string;
    heldLease: ElectronProductionPublicLatestLease;
    preObservation: ElectronProductionPublicLatestRecoveryObservation;
    preObservationSha256: string;
    rollback: unknown;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionPublicLatestRecoveryRollback>;

export function assertElectronProductionPublicLatestRecoveryRollbackFoundationBindings(
  input: Readonly<{
    heldLease: ElectronProductionPublicLatestLease;
    rollback: unknown;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionPublicLatestRecoveryRollback>;

export function electronProductionPublicLatestRecoveryObservationSha256(
  value: unknown
): string;

export function electronProductionPublicLatestRecoveryRollbackSha256(
  value: unknown
): string;

export function serializeElectronProductionPublicLatestRecoveryObservation(
  value: unknown
): Buffer;

export function serializeElectronProductionPublicLatestRecoveryRollback(
  value: unknown
): Buffer;

export function writeElectronProductionPublicLatestRecoveryObservation(
  input: Readonly<{
    outputPath: string;
    receipt: ElectronProductionPublicLatestRecoveryObservation;
  }>
): Promise<Readonly<ElectronProductionPublicLatestRecoveryReceiptFile<
  ElectronProductionPublicLatestRecoveryObservation
>>>;

export function readElectronProductionPublicLatestRecoveryObservation(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<ElectronProductionPublicLatestRecoveryReceiptFile<
  ElectronProductionPublicLatestRecoveryObservation
>>>;

export function writeElectronProductionPublicLatestRecoveryRollback(
  input: Readonly<{
    outputPath: string;
    receipt: ElectronProductionPublicLatestRecoveryRollback;
  }>
): Promise<Readonly<ElectronProductionPublicLatestRecoveryReceiptFile<
  ElectronProductionPublicLatestRecoveryRollback
>>>;

export function readElectronProductionPublicLatestRecoveryRollback(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<ElectronProductionPublicLatestRecoveryReceiptFile<
  ElectronProductionPublicLatestRecoveryRollback
>>>;
