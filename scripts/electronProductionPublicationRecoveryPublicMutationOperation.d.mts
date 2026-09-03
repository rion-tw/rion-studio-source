import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestLeaseReleaseOperation
} from "./electronProductionPublicLatestLeaseReleaseOperation.mjs";
import type {
  ElectronProductionPublicLatestRecoveryObservation,
  ElectronProductionPublicLatestRecoveryRollback
} from "./electronProductionPublicLatestRecovery.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicationRecoveryLeaseRelease,
  ElectronProductionPublicationRecoveryMutation,
  ElectronProductionPublicationRecoveryObservation,
  ElectronProductionPublicationRecoveryOperation,
  ElectronProductionPublicationRecoveryRunIdentity
} from "./electronProductionPublicationRecovery.mjs";
import type {
  ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE:
  "electron-production-publication-recovery-public-mutation-operation.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_OPERATION_BYTES:
  number;

export type ElectronProductionPublicationRecoveryPublicMutationOperationMode =
  | "actual-transport"
  | "marker-reconciliation"
  | "precondition-rejected";

export interface ElectronProductionPublicationRecoveryPublicMutationObservation {
  readonly kind:
    "rion-electron-production-public-latest-recovery-observation";
  readonly sha256: string;
  readonly receipt: Readonly<ElectronProductionPublicLatestRecoveryObservation>;
}

export type ElectronProductionPublicationRecoveryPublicMutationTransport =
  | Readonly<{
      kind:
        "rion-electron-production-public-latest-recovery-rollback-operation";
      sha256: string;
      receipt: Readonly<ElectronProductionPublicLatestRecoveryRollback>;
    }>
  | Readonly<{
      kind:
        "rion-electron-production-public-latest-lease-release-operation";
      sha256: string;
      receipt: Readonly<ElectronProductionPublicLatestLeaseReleaseOperation>;
    }>;

export interface ElectronProductionPublicationRecoveryPublicMutationSuccessor {
  readonly lease: Readonly<ElectronProductionPublicLatestLease>;
  readonly eventSha256: string;
  readonly bytes: number;
  readonly fileSha256: string;
  readonly blobSha: string;
}

export interface ElectronProductionPublicationRecoveryPublicMutationOperationReceipt {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-public-mutation-operation";
  readonly status: "closed-marker-bound-public-mutation-observation";
  readonly transactionId: string;
  readonly operation: "rollback-public-latest" | "release-held-lease";
  readonly mode:
    ElectronProductionPublicationRecoveryPublicMutationOperationMode;
  readonly authority: Readonly<{
    readonly attemptSha256: string;
    readonly authorizationSha256: string;
    readonly attemptPath: string;
    readonly previousOutcomeSha256: string | null;
    readonly reservedAt: string;
    readonly currentRun: Readonly<
      ElectronProductionPublicationRecoveryRunIdentity & {
        readonly startedAt: string;
      }
    >;
  }>;
  readonly before:
    Readonly<ElectronProductionPublicationRecoveryPublicMutationObservation>;
  readonly final:
    Readonly<ElectronProductionPublicationRecoveryPublicMutationObservation>;
  readonly transport:
    Readonly<ElectronProductionPublicationRecoveryPublicMutationTransport> | null;
  readonly successor:
    Readonly<ElectronProductionPublicationRecoveryPublicMutationSuccessor> | null;
  readonly result: Readonly<{
    readonly mutation: ElectronProductionPublicationRecoveryMutation;
    readonly leaseRelease: ElectronProductionPublicationRecoveryLeaseRelease;
  }>;
  readonly resolvedAt: string;
}

export interface ElectronProductionPublicationRecoveryPublicMutationOperationFile {
  readonly value:
    Readonly<ElectronProductionPublicationRecoveryPublicMutationOperationReceipt>;
  readonly valueIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName:
      "electron-production-publication-recovery-public-mutation-operation.json";
    readonly sha256: string;
  }>;
  readonly valuePath: string;
}

export interface ElectronProductionPublicationRecoveryPublicMutationOperationInput {
  readonly authorization:
    ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization;
  readonly authorizationSha256: string;
  readonly beforeObservation:
    ElectronProductionPublicLatestRecoveryObservation;
  readonly beforeObservationSha256: string;
  readonly finalObservation:
    ElectronProductionPublicLatestRecoveryObservation;
  readonly finalObservationSha256: string;
  readonly heldLease: ElectronProductionPublicLatestLease;
  readonly heldLeaseFileSha256: string;
  readonly mode:
    ElectronProductionPublicationRecoveryPublicMutationOperationMode;
  readonly resolvedAt: string;
  readonly sourceSnapshot: ElectronProductionPublicLatestSnapshot;
  readonly sourceSnapshotFileSha256: string;
  readonly successor:
    ElectronProductionPublicationRecoveryPublicMutationSuccessor | null;
  readonly targetSnapshot: ElectronProductionPublicLatestSnapshot;
  readonly targetSnapshotFileSha256: string;
  readonly transportOperation:
    | ElectronProductionPublicLatestRecoveryRollback
    | ElectronProductionPublicLatestLeaseReleaseOperation
    | null;
  readonly transportOperationSha256: string | null;
}

export function createElectronProductionPublicationRecoveryPublicMutationOperation(
  input: Readonly<
    ElectronProductionPublicationRecoveryPublicMutationOperationInput
  >
): Readonly<ElectronProductionPublicationRecoveryPublicMutationOperationReceipt>;

export function assertElectronProductionPublicationRecoveryPublicMutationOperation(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryPublicMutationOperationReceipt>;

export function assertElectronProductionPublicationRecoveryPublicMutationOperationBindings(
  input: Readonly<{
    authorization:
      ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization;
    authorizationSha256: string;
    heldLease: ElectronProductionPublicLatestLease;
    heldLeaseFileSha256: string;
    operation: unknown;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionPublicationRecoveryPublicMutationOperationReceipt>;

export function assertElectronProductionPublicationRecoveryPublicMutationAuthorizationBindings(
  input: Readonly<{
    authorization:
      ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization;
    authorizationSha256: string;
    heldLease: ElectronProductionPublicLatestLease;
    heldLeaseFileSha256: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<
  ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
>;

export function electronProductionPublicationRecoveryPublicMutationOperationOutcomeEvidence(
  input: Readonly<{
    authorization:
      ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization;
    authorizationSha256: string;
    heldLease: ElectronProductionPublicLatestLease;
    heldLeaseFileSha256: string;
    operation: unknown;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<{
  beforeMutation: Readonly<ElectronProductionPublicationRecoveryObservation>;
  finalObservation: Readonly<ElectronProductionPublicationRecoveryObservation>;
  mutation: ElectronProductionPublicationRecoveryMutation;
  leaseRelease: ElectronProductionPublicationRecoveryLeaseRelease;
  recoveryOperation: Extract<
    ElectronProductionPublicationRecoveryOperation,
    Readonly<{
      kind:
        "rion-electron-production-publication-recovery-public-mutation-operation";
    }>
  >;
}>;

export function serializeElectronProductionPublicationRecoveryPublicMutationOperation(
  value: unknown
): Buffer;

export function electronProductionPublicationRecoveryPublicMutationOperationSha256(
  value: unknown
): string;

export function writeElectronProductionPublicationRecoveryPublicMutationOperation(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryPublicMutationOperationReceipt;
  }>
): Promise<Readonly<ElectronProductionPublicationRecoveryPublicMutationOperationFile>>;

export function readElectronProductionPublicationRecoveryPublicMutationOperation(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<ElectronProductionPublicationRecoveryPublicMutationOperationFile>>;
