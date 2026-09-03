import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import type {
  ElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_KIND:
  "rion-electron-production-publication-recovery-store-seal";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_KIND:
  "rion-electron-production-publication-recovery-outcome";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND:
  "rion-electron-production-publication-recovery-public-mutation-operation";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE:
  "electron-production-publication-recovery-store-seal.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE:
  "electron-production-publication-recovery-outcome.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_ATTEMPT_PREFIX:
  "electron-production-publication-recovery-outcome-run-";

export interface ElectronProductionPublicationRecoveryLeaseFence {
  readonly leaseId: string;
  readonly generation: number;
  readonly eventSha256: string;
}

export interface ElectronProductionPublicationRecoverySourceState {
  readonly runtime: "tauri-v22";
  readonly version: string;
  readonly releaseId: string;
  readonly releaseTag: string;
  readonly sourceSha: string;
  readonly manifestSha256: string;
  readonly stateSha256: string;
  readonly snapshotSha256: string;
}

export interface ElectronProductionPublicationRecoveryTargetState {
  readonly runtime: "electron-v23";
  readonly version: string;
  readonly releaseId: string;
  readonly releaseTag: string;
  readonly sourceSha: string;
  readonly candidateReceiptSha256: string;
  readonly manifestSha256: string;
  readonly stateSha256: string;
  readonly snapshotSha256: string;
}

export interface ElectronProductionPublicationRecoveryRunIdentity {
  readonly repository: string;
  readonly workflow: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly controlSha: string;
}

export interface ElectronProductionPublicationDurableRecoveryStore {
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
  readonly repositoryPolicy: Readonly<{
    defaultBranch: string;
    visibility: "private";
  }>;
  readonly byteLength: number;
  readonly blobSha: string;
  readonly treeSha: string;
  readonly parentCommitSha: string;
  readonly commitSha: string;
  readonly remoteReceiptSha256: string;
  readonly committedAt: string;
}

export interface ElectronProductionPublicationRecoveryStoreSeal {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-publication-recovery-store-seal";
  readonly status: "durably-stored-pre-mutation";
  readonly transactionId: string;
  readonly lease: Readonly<ElectronProductionPublicationRecoveryLeaseFence>;
  readonly source: Readonly<ElectronProductionPublicationRecoverySourceState>;
  readonly target: Readonly<ElectronProductionPublicationRecoveryTargetState>;
  readonly publicationIntentEventSha256: string;
  readonly capsuleFileName:
    "electron-production-publication-recovery-capsule.capsule.json";
  readonly capsuleBytes: number;
  readonly capsuleSha256: string;
  readonly capsuleManifestBytes: number;
  readonly capsuleManifestSha256: string;
  readonly publisher: Readonly<ElectronProductionPublicationRecoveryRunIdentity>;
  readonly writer: Readonly<ElectronProductionPublicationRecoveryRunIdentity>;
  readonly durableStore: Readonly<ElectronProductionPublicationDurableRecoveryStore>;
  readonly sealedAt: string;
}

export type ElectronProductionPublicationRecoveryObservationClassification =
  | "source"
  | "target"
  | "foreign"
  | "unknown";

export interface ElectronProductionPublicationRecoveryObservation {
  readonly classification:
    ElectronProductionPublicationRecoveryObservationClassification;
  readonly stateSha256: string | null;
  readonly observedAt: string;
}

export interface ElectronProductionPublicationRecoveryMarkerAuthority {
  readonly attemptSha256: string;
  readonly authorizationSha256: string;
}

export type ElectronProductionPublicationRecoveryOperation =
  | Readonly<{
      kind:
        | "rion-electron-production-public-latest-recovery-observation"
        | "rion-electron-production-public-latest-recovery-rollback-operation";
      sha256: string;
    }>
  | Readonly<{
      kind:
        "rion-electron-production-publication-recovery-public-mutation-operation";
      operation: "rollback-public-latest" | "release-held-lease";
      mode:
        | "actual-transport"
        | "marker-reconciliation"
        | "precondition-rejected";
      authority:
        Readonly<ElectronProductionPublicationRecoveryMarkerAuthority>;
      sha256: string;
    }>;

export type ElectronProductionPublicationRecoveryMutation =
  | Readonly<{
      kind: "none";
      submitted: false;
      acknowledgement: null;
      submittedAt: null;
      resultRecordedAt: null;
    }>
  | Readonly<{
      kind: "rollback";
      submitted: true;
      acknowledgement: "confirmed" | "rejected" | "unknown";
      submittedAt: string;
      resultRecordedAt: string;
    }>
  | Readonly<{
      kind: "rollback";
      submitted: false;
      acknowledgement: "rejected";
      reservedAt: string;
      submittedAt: null;
      resultRecordedAt: string;
      reservation:
        Readonly<ElectronProductionPublicationRecoveryMarkerAuthority>;
    }>
  | Readonly<{
      kind: "rollback";
      submitted: "possibly";
      acknowledgement: "unknown";
      reservedAt: string;
      submittedAt: null;
      resultRecordedAt: string;
      reservation:
        Readonly<ElectronProductionPublicationRecoveryMarkerAuthority>;
    }>;

export type ElectronProductionPublicationRecoveryLeaseRelease =
  | Readonly<{
      attempted: false;
      acknowledgement: null;
      attemptedAt: null;
      operationSha256: null;
      resolvedAt: null;
      successorEventSha256: null;
    }>
  | Readonly<{
      attempted: true;
      acknowledgement: "confirmed" | "rejected" | "unknown";
      attemptedAt: string;
      operationSha256: string;
      resolvedAt: string;
      successorEventSha256: string | null;
    }>
  | Readonly<{
      attempted: false;
      acknowledgement: "rejected";
      attemptedAt: null;
      operationSha256: null;
      reservation:
        Readonly<ElectronProductionPublicationRecoveryMarkerAuthority>;
      reservedAt: string;
      resolvedAt: string;
      successorEventSha256: null;
    }>
  | Readonly<{
      attempted: "possibly";
      acknowledgement: "unknown";
      attemptedAt: null;
      operationSha256: null;
      reservation:
        Readonly<ElectronProductionPublicationRecoveryMarkerAuthority>;
      resolvedAt: string;
      successorEventSha256: null;
    }>
  | Readonly<{
      attempted: "possibly";
      acknowledgement: "confirmed";
      attemptedAt: string;
      operationSha256: null;
      reservation:
        Readonly<ElectronProductionPublicationRecoveryMarkerAuthority>;
      resolvedAt: string;
      successorEventSha256: string;
    }>;

export type ElectronProductionPublicationRecoveryOutcomeClassification =
  | "source-observed-noop"
  | "rollback-confirmed"
  | "indeterminate"
  | "lease-release-acknowledgement-unknown";

export type ElectronProductionPublicationRecoveryDecision =
  | Readonly<{
      classification: "source-observed-noop" | "rollback-confirmed";
      terminal: true;
      safeToReleaseLease: true;
      determinedAt: string;
    }>
  | Readonly<{
      classification:
        | "indeterminate"
        | "lease-release-acknowledgement-unknown";
      terminal: false;
      safeToReleaseLease: false;
      determinedAt: string;
    }>;

export interface ElectronProductionPublicationRecoveryOutcome {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-publication-recovery-outcome";
  readonly status: "closed-recovery-observation";
  readonly transactionId: string;
  readonly lease: Readonly<ElectronProductionPublicationRecoveryLeaseFence>;
  readonly source: Readonly<ElectronProductionPublicationRecoverySourceState>;
  readonly target: Readonly<ElectronProductionPublicationRecoveryTargetState>;
  readonly publicationIntentEventSha256: string;
  readonly capsuleFileName:
    "electron-production-publication-recovery-capsule.capsule.json";
  readonly capsuleBytes: number;
  readonly capsuleSha256: string;
  readonly capsuleManifestBytes: number;
  readonly capsuleManifestSha256: string;
  readonly durableStore: Readonly<
    ElectronProductionPublicationDurableRecoveryStore & {
      sealedAt: string;
      sealSha256: string;
    }
  >;
  readonly previousOutcomeSha256: string | null;
  readonly recoveryRun: Readonly<
    ElectronProductionPublicationRecoveryRunIdentity & { startedAt: string }
  >;
  readonly recoveryOperation: ElectronProductionPublicationRecoveryOperation;
  readonly observation: Readonly<{
    beforeMutation: Readonly<ElectronProductionPublicationRecoveryObservation>;
    final: Readonly<ElectronProductionPublicationRecoveryObservation>;
  }>;
  readonly mutation: ElectronProductionPublicationRecoveryMutation;
  readonly leaseRelease: ElectronProductionPublicationRecoveryLeaseRelease;
  readonly outcome: ElectronProductionPublicationRecoveryDecision;
}

export interface ElectronProductionPublicationRecoveryReceiptFile<Receipt> {
  readonly receipt: Readonly<Receipt>;
  readonly receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  readonly receiptPath: string;
}

export function createElectronProductionPublicationRecoveryStoreSeal(
  input: Readonly<{
    capsuleBytes: number;
    capsuleManifestBytes: number;
    capsuleManifestSha256: string;
    capsuleSha256: string;
    durableStore: ElectronProductionPublicationDurableRecoveryStore;
    heldLease: ElectronProductionPublicLatestLease;
    publicationIntent: ElectronProductionPublicationReceipt;
    sealedAt: string;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    writer: ElectronProductionPublicationRecoveryRunIdentity;
  }>
): Readonly<ElectronProductionPublicationRecoveryStoreSeal>;

export function assertElectronProductionPublicationRecoveryStoreSeal(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryStoreSeal>;

export function assertElectronProductionPublicationRecoveryStoreSealBindings(
  input: Readonly<{
    heldLease: ElectronProductionPublicLatestLease;
    publicationIntent: ElectronProductionPublicationReceipt;
    seal: unknown;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
  }>
): Readonly<ElectronProductionPublicationRecoveryStoreSeal>;

export function createElectronProductionPublicationRecoveryOutcome(
  input: Readonly<{
    beforeMutation: Readonly<{
      observedAt: string;
      snapshot: ElectronProductionPublicLatestSnapshot | null;
    }> | Readonly<{
      classification: "source" | "target" | "foreign" | "unknown";
      observedAt: string;
      stateSha256: string | null;
    }>;
    determinedAt: string;
    finalObservation: Readonly<{
      observedAt: string;
      snapshot: ElectronProductionPublicLatestSnapshot | null;
    }> | Readonly<{
      classification: "source" | "target" | "foreign" | "unknown";
      observedAt: string;
      stateSha256: string | null;
    }>;
    heldLease: ElectronProductionPublicLatestLease;
    leaseRelease: ElectronProductionPublicationRecoveryLeaseRelease;
    mutation: ElectronProductionPublicationRecoveryMutation;
    previousOutcomeSha256: string | null;
    recoveryRun: Readonly<
      ElectronProductionPublicationRecoveryRunIdentity & { startedAt: string }
    >;
    recoveryOperation: ElectronProductionPublicationRecoveryOperation;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    storeSeal: ElectronProductionPublicationRecoveryStoreSeal;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
  }>
): Readonly<ElectronProductionPublicationRecoveryOutcome>;

export function assertElectronProductionPublicationRecoveryOutcome(
  value: unknown
): Readonly<ElectronProductionPublicationRecoveryOutcome>;

export function assertElectronProductionPublicationRecoveryOutcomeBindings(
  input: Readonly<{
    heldLease: ElectronProductionPublicLatestLease;
    outcome: unknown;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    storeSeal: ElectronProductionPublicationRecoveryStoreSeal;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
  }>
): Readonly<ElectronProductionPublicationRecoveryOutcome>;

export function electronProductionPublicationRecoveryStoreSealSha256(
  value: unknown
): string;

export function electronProductionPublicationRecoveryOutcomeSha256(
  value: unknown
): string;

export function electronProductionPublicationRecoveryOutcomeAttemptFileName(
  recoveryRun: Readonly<
    ElectronProductionPublicationRecoveryRunIdentity & { startedAt: string }
  >
): string;

export function serializeElectronProductionPublicationRecoveryStoreSeal(
  value: unknown
): Buffer;

export function serializeElectronProductionPublicationRecoveryOutcome(
  value: unknown
): Buffer;

export function writeElectronProductionPublicationRecoveryStoreSeal(
  input: Readonly<{
    outputPath: string;
    receipt: ElectronProductionPublicationRecoveryStoreSeal;
  }>
): Promise<
  Readonly<
    ElectronProductionPublicationRecoveryReceiptFile<
      ElectronProductionPublicationRecoveryStoreSeal
    >
  >
>;

export function writeElectronProductionPublicationRecoveryOutcome(
  input: Readonly<{
    outputPath: string;
    receipt: ElectronProductionPublicationRecoveryOutcome;
  }>
): Promise<
  Readonly<
    ElectronProductionPublicationRecoveryReceiptFile<
      ElectronProductionPublicationRecoveryOutcome
    >
  >
>;

export function writeElectronProductionPublicationRecoveryOutcomeAttempt(
  input: Readonly<{
    outputPath: string;
    receipt: ElectronProductionPublicationRecoveryOutcome;
  }>
): Promise<
  Readonly<
    ElectronProductionPublicationRecoveryReceiptFile<
      ElectronProductionPublicationRecoveryOutcome
    >
  >
>;

export function readElectronProductionPublicationRecoveryStoreSeal(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<
  Readonly<
    ElectronProductionPublicationRecoveryReceiptFile<
      ElectronProductionPublicationRecoveryStoreSeal
    >
  >
>;

export function readElectronProductionPublicationRecoveryOutcome(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<
  Readonly<
    ElectronProductionPublicationRecoveryReceiptFile<
      ElectronProductionPublicationRecoveryOutcome
    >
  >
>;

export function readElectronProductionPublicationRecoveryOutcomeAttempt(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<
  Readonly<
    ElectronProductionPublicationRecoveryReceiptFile<
      ElectronProductionPublicationRecoveryOutcome
    >
  >
>;
