import type {
  ElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import type {
  ElectronProductionPublicLatestLeaseRemoteOperationSummary
} from "./electronProductionPublicLatestLeaseRemoteCli.mjs";
import type {
  ElectronProductionPublicLatestRecoveryObservation
} from "./electronProductionPublicLatestRecovery.mjs";
import type {
  ElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND:
  "rion-electron-production-public-latest-lease-release-operation";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE:
  "electron-production-public-latest-lease-release-operation.json";

export interface ElectronProductionPublicLatestLeaseReleaseRecoveryOperation {
  readonly kind:
    | "rion-electron-production-public-latest-recovery-observation"
    | "rion-electron-production-public-latest-recovery-rollback-operation";
  readonly sha256: string;
}

export interface ElectronProductionPublicLatestLeaseReleaseHeldIdentity {
  readonly transactionId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly revision: number;
  readonly eventSha256: string;
  readonly sourceStateSha256: string;
  readonly targetStateSha256: string;
}

export interface ElectronProductionPublicLatestLeaseReleaseSuccessor {
  readonly lease: Readonly<ElectronProductionPublicLatestLease>;
  readonly eventSha256: string;
  readonly bytes: number;
  readonly fileSha256: string;
  readonly blobSha: string;
}

export interface ElectronProductionPublicLatestLeaseReleaseObservation {
  readonly kind:
    "rion-electron-production-public-latest-recovery-observation";
  readonly sha256: string;
  readonly receipt: Readonly<
    ElectronProductionPublicLatestRecoveryObservation
  >;
}

export interface ElectronProductionPublicLatestLeaseReleaseOperation {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-public-latest-lease-release-operation";
  readonly operation: "release-held-lease" | "reconcile-released-lease";
  readonly held: Readonly<
    ElectronProductionPublicLatestLeaseReleaseHeldIdentity
  >;
  readonly preReleaseObservation: Readonly<
    ElectronProductionPublicLatestLeaseReleaseObservation
  >;
  readonly recoveryOperation: Readonly<
    ElectronProductionPublicLatestLeaseReleaseRecoveryOperation
  >;
  readonly attemptedAt: string;
  readonly resolvedAt: string;
  readonly remoteOperation: Readonly<{
    kind: "rion-electron-production-public-latest-lease-remote-operation";
    sha256: string;
    receipt: Readonly<ElectronProductionPublicLatestLeaseRemoteOperationSummary>;
  }>;
  readonly acknowledgement: "confirmed" | "rejected" | "unknown";
  readonly successor:
    Readonly<ElectronProductionPublicLatestLeaseReleaseSuccessor> | null;
}

export interface ElectronProductionPublicLatestLeaseReleaseOperationFile {
  readonly operation: Readonly<
    ElectronProductionPublicLatestLeaseReleaseOperation
  >;
  readonly operationIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  readonly operationPath: string;
}

export function createElectronProductionPublicLatestLeaseReleaseOperation(
  input: Readonly<{
    heldLease: ElectronProductionPublicLatestLease;
    preReleaseObservation: ElectronProductionPublicLatestRecoveryObservation;
    recoveryOperation:
      ElectronProductionPublicLatestLeaseReleaseRecoveryOperation;
    remoteOperation: ElectronProductionPublicLatestLeaseRemoteOperationSummary;
    resolvedAt: string;
  }>
): Readonly<ElectronProductionPublicLatestLeaseReleaseOperation>;

export function assertElectronProductionPublicLatestLeaseReleaseOperation(
  value: unknown
): Readonly<ElectronProductionPublicLatestLeaseReleaseOperation>;

export function assertElectronProductionPublicLatestLeaseReleaseOperationBindings(
  input: Readonly<{
    heldLease: ElectronProductionPublicLatestLease;
    operation: unknown;
    recoveryOperation:
      ElectronProductionPublicLatestLeaseReleaseRecoveryOperation;
    sourceSnapshot: ElectronProductionPublicLatestSnapshot;
    sourceSnapshotFileSha256: string;
    targetSnapshot: ElectronProductionPublicLatestSnapshot;
    targetSnapshotFileSha256: string;
  }>
): Readonly<ElectronProductionPublicLatestLeaseReleaseOperation>;

export function electronProductionPublicLatestLeaseReleaseOperationSha256(
  value: unknown
): string;

export function serializeElectronProductionPublicLatestLeaseReleaseOperation(
  value: unknown
): Buffer;

export function writeElectronProductionPublicLatestLeaseReleaseOperation(
  input: Readonly<{
    operation: ElectronProductionPublicLatestLeaseReleaseOperation;
    outputPath: string;
  }>
): Promise<Readonly<ElectronProductionPublicLatestLeaseReleaseOperationFile>>;

export function readElectronProductionPublicLatestLeaseReleaseOperation(
  input: Readonly<{ expectedSha256: string; operationPath: string }>
): Promise<Readonly<ElectronProductionPublicLatestLeaseReleaseOperationFile>>;
