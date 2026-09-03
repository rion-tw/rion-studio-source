import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicLatestRecoveryObservation
} from "./electronProductionPublicLatestRecovery.mjs";
import type {
  ElectronProductionPublicationRecoveryDiscoveryTarget
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import type {
  ElectronProductionPublicationRecoveryLeaseReleaseAuthorization
} from "./electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import type {
  ElectronProductionPublicationRecoveryRunIdentity
} from "./electronProductionPublicationRecovery.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteOperationReceipt,
  ElectronProductionRecoveryStoreRemoteReadOperationReceipt
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_KIND:
  "rion-electron-production-publication-recovery-public-mutation-attempt";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_KIND:
  "rion-electron-production-publication-recovery-public-mutation-attempt-authorization";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_KIND:
  "rion-electron-production-publication-recovery-public-mutation-attempt-history";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE:
  "electron-production-publication-recovery-public-mutation-attempt-authorization.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE:
  "electron-production-publication-recovery-public-mutation-attempt-history.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_BYTES:
  number;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_BYTES:
  number;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_HISTORY_BYTES:
  number;

export type ElectronProductionPublicationRecoveryPublicMutationOperation =
  | "rollback-public-latest"
  | "release-held-lease";

export interface ElectronProductionPublicationRecoveryPublicMutationAttempt {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-public-mutation-attempt";
  readonly status: "durable-one-shot-public-mutation-reservation";
  readonly transactionId: string;
  readonly operation:
    ElectronProductionPublicationRecoveryPublicMutationOperation;
  readonly reservedAt: string;
  readonly currentRun: Readonly<
    ElectronProductionPublicationRecoveryRunIdentity & {
      readonly startedAt: string;
    }
  >;
  readonly authority: Readonly<{
    readonly authorizationSha256: string;
    readonly intentSha256: string;
    readonly chainProofSha256: string;
    readonly heldLease: Readonly<{
      readonly leaseId: string;
      readonly generation: number;
      readonly revision: number;
      readonly eventSha256: string;
      readonly fileSha256: string;
      readonly sourceStateSha256: string;
      readonly targetStateSha256: string;
    }>;
    readonly foundation: Readonly<{
      readonly storeSealSha256: string;
      readonly sourceSnapshotSha256: string;
      readonly targetSnapshotSha256: string;
    }>;
    readonly predecessor: Readonly<{
      readonly path: string;
      readonly fileName: string;
      readonly sha256: string;
      readonly bytes: number;
      readonly blobSha: string;
      readonly determinedAt: string;
    }> | null;
  }>;
  readonly privateStore: Readonly<{
    readonly target:
      Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
    readonly path: string;
    readonly expectedHeadCommitSha: string;
  }>;
  readonly publicMutation: Readonly<{
    readonly requiredBeforeObservation: "source" | "target";
    readonly requiredAfterObservation: "source";
    readonly observation: Readonly<{
      readonly kind:
        "rion-electron-production-public-latest-recovery-observation";
      readonly receipt:
        Readonly<ElectronProductionPublicLatestRecoveryObservation>;
      readonly sha256: string;
      readonly observedAt: string;
      readonly classification: "source" | "target";
      readonly stateSha256: string;
    }>;
    readonly source: Readonly<{
      readonly releaseId: string;
      readonly releaseTag: string;
      readonly stateSha256: string;
    }>;
    readonly target: Readonly<{
      readonly releaseId: string;
      readonly releaseTag: string;
      readonly stateSha256: string;
    }>;
  }>;
}

export interface ElectronProductionPublicationRecoveryPublicMutationAttemptHistory {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-public-mutation-attempt-history";
  readonly status: "verified-exact-create-and-reachable-path-history";
  readonly target:
    Readonly<ElectronProductionPublicationRecoveryDiscoveryTarget>;
  readonly path: string;
  readonly initialHeadCommitSha: string;
  readonly attemptCommit: Readonly<{
    readonly commitSha: string;
    readonly treeSha: string;
    readonly parentCommitSha: string;
    readonly blobSha: string;
  }>;
  readonly currentObservation: Readonly<{
    readonly headCommitSha: string;
    readonly treeSha: string;
    readonly parentCommitShas: readonly string[];
  }>;
  readonly pathHistory: Readonly<{
    readonly reachableFromHeadCommitSha: string;
    readonly commitSha: string;
    readonly resultCount: 1;
    readonly nextPage: false;
  }>;
  readonly observedAt: string;
}

export interface ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-public-mutation-attempt-authorization";
  readonly status: "verified-durable-one-shot-public-mutation-authority";
  readonly transactionId: string;
  readonly operation:
    ElectronProductionPublicationRecoveryPublicMutationOperation;
  readonly currentRun: Readonly<
    ElectronProductionPublicationRecoveryRunIdentity & {
      readonly startedAt: string;
    }
  >;
  readonly authority: Readonly<{
    readonly attempt:
      Readonly<ElectronProductionPublicationRecoveryPublicMutationAttempt>;
    readonly sha256: string;
  }>;
  readonly evidence: Readonly<{
    readonly preMarkerAuthorization: Readonly<{
      readonly value:
        Readonly<ElectronProductionPublicationRecoveryLeaseReleaseAuthorization>;
      readonly sha256: string;
    }> | null;
    readonly createOperation: Readonly<{
      readonly receipt:
        Readonly<ElectronProductionRecoveryStoreRemoteOperationReceipt>;
      readonly sha256: string;
    }> | null;
    readonly attemptHistoryProof: Readonly<{
      readonly receipt:
        Readonly<ElectronProductionPublicationRecoveryPublicMutationAttemptHistory>;
      readonly sha256: string;
    }> | null;
    readonly attemptReadOperation: Readonly<{
      readonly receipt:
        Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;
      readonly sha256: string;
    }>;
    readonly postMarkerAuthorization: Readonly<{
      readonly value:
        Readonly<ElectronProductionPublicationRecoveryLeaseReleaseAuthorization>;
      readonly sha256: string;
    }>;
  }>;
  readonly headTransition: Readonly<{
    readonly mode: "created-now" | "resumed-existing";
    readonly initialHeadCommitSha: string;
    readonly currentHeadCommitSha: string;
    readonly attemptCommitSha: string | null;
    readonly treeSha: string;
    readonly parentCommitShas: readonly string[];
    readonly attemptBlobSha: string;
  }>;
  readonly verifiedAt: string;
}

export interface ElectronProductionPublicationRecoveryPublicMutationContractFile<
  Value
> {
  readonly value: Readonly<Value>;
  readonly valueIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName: string;
    readonly sha256: string;
  }>;
  readonly valuePath: string;
}

export function electronProductionPublicationRecoveryPublicMutationAttemptFileName(
  input: Readonly<{ previousOutcomeSha256: string | null }>
): string;

export function electronProductionPublicationRecoveryPublicMutationAttemptPath(
  input: Readonly<{
    previousOutcomeSha256: string | null;
    transactionId: string;
  }>
): string;

export function createElectronProductionPublicationRecoveryPublicMutationAttempt(
  input: Readonly<{
    authorization:
      ElectronProductionPublicationRecoveryLeaseReleaseAuthorization;
    authorizationSha256: string;
    operation: ElectronProductionPublicationRecoveryPublicMutationOperation;
    publicObservation: ElectronProductionPublicLatestRecoveryObservation;
    publicObservationSha256: string;
    reservedAt: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
  }>
): Readonly<ElectronProductionPublicationRecoveryPublicMutationAttempt>;

export function assertElectronProductionPublicationRecoveryPublicMutationAttempt(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryPublicMutationAttempt>;

export function createElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input: Readonly<{
    attemptBlobSha: string;
    attemptCommitSha: string;
    attemptTreeSha: string;
    currentObservation: Readonly<{
      headCommitSha: string;
      treeSha: string;
      parentCommitShas: readonly string[];
    }>;
    initialHeadCommitSha: string;
    observedAt: string;
    path: string;
    pathHistory: Readonly<{
      reachableFromHeadCommitSha: string;
      commitSha: string;
      resultCount: 1;
      nextPage: false;
    }>;
    target: ElectronProductionPublicationRecoveryDiscoveryTarget;
  }>
): Readonly<ElectronProductionPublicationRecoveryPublicMutationAttemptHistory>;

export function assertElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryPublicMutationAttemptHistory>;

export function createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  input: Readonly<{
    attempt: ElectronProductionPublicationRecoveryPublicMutationAttempt;
    attemptHistoryProof:
      ElectronProductionPublicationRecoveryPublicMutationAttemptHistory | null;
    attemptHistoryProofSha256: string | null;
    attemptReadOperation:
      ElectronProductionRecoveryStoreRemoteReadOperationReceipt;
    attemptReadOperationSha256: string;
    attemptSha256: string;
    createOperation:
      ElectronProductionRecoveryStoreRemoteOperationReceipt | null;
    createOperationSha256: string | null;
    postMarkerAuthorization:
      ElectronProductionPublicationRecoveryLeaseReleaseAuthorization;
    postMarkerAuthorizationSha256: string;
    preMarkerAuthorization:
      ElectronProductionPublicationRecoveryLeaseReleaseAuthorization | null;
    preMarkerAuthorizationSha256: string | null;
    verifiedAt: string;
  }>
): Readonly<
  ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
>;

export function assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  value: unknown
): Readonly<
  ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
>;

export function serializeElectronProductionPublicationRecoveryPublicMutationAttempt(
  value: unknown
): Buffer;
export function serializeElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  value: unknown
): Buffer;
export function serializeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  value: unknown
): Buffer;
export function electronProductionPublicationRecoveryPublicMutationAttemptSha256(
  value: unknown
): string;
export function electronProductionPublicationRecoveryPublicMutationAttemptHistorySha256(
  value: unknown
): string;
export function electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256(
  value: unknown
): string;

export function writeElectronProductionPublicationRecoveryPublicMutationAttempt(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryPublicMutationAttempt;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationContractFile<
    ElectronProductionPublicationRecoveryPublicMutationAttempt
  >
>>;
export function readElectronProductionPublicationRecoveryPublicMutationAttempt(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationContractFile<
    ElectronProductionPublicationRecoveryPublicMutationAttempt
  >
>>;
export function writeElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryPublicMutationAttemptHistory;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationContractFile<
    ElectronProductionPublicationRecoveryPublicMutationAttemptHistory
  >
>>;
export function readElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationContractFile<
    ElectronProductionPublicationRecoveryPublicMutationAttemptHistory
  >
>>;
export function writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  input: Readonly<{
    outputPath: string;
    value: ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization;
  }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationContractFile<
    ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
  >
>>;
export function readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationContractFile<
    ElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
  >
>>;
