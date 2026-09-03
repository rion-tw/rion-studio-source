import type {
  ElectronProductionRecoveryStoreRemoteFailure,
  ElectronProductionRecoveryStoreRemoteTarget
} from "./electronProductionRecoveryStoreRemote.mjs";
import type {
  ElectronProductionRecoveryStoreRemotePackageIdentity,
  ElectronProductionRecoveryStoreRemoteTerminal
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_REQUEST_KIND:
  "rion-electron-production-recovery-store-remote-atomic-pair-request";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_KIND:
  "rion-electron-production-recovery-store-remote-atomic-pair-operation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE:
  "electron-production-recovery-store-remote-atomic-pair-operation.json";

export interface ElectronProductionRecoveryStoreAtomicPairRequest {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-remote-atomic-pair-request";
  readonly operation: "create-atomic-pair";
  readonly requests: readonly [unknown, unknown];
}

export interface ElectronProductionRecoveryStoreAtomicPairAppliedIdentity {
  readonly parentCommitSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly blobSha: string;
  readonly byteLength: number;
  readonly paths: readonly [string, string];
}

export interface ElectronProductionRecoveryStoreAtomicPairOperationReceipt {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-remote-atomic-pair-operation";
  readonly operation: "create-atomic-pair";
  readonly requestIdentity: Readonly<{
    entries: readonly Readonly<{
      target: unknown;
      package: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
    }>[];
    expectedHeadSha256: string;
    commitMessageSha256: string;
    requestSha256: string;
  }>;
  readonly terminal: Readonly<ElectronProductionRecoveryStoreRemoteTerminal>;
  readonly applied:
    Readonly<ElectronProductionRecoveryStoreAtomicPairAppliedIdentity> | null;
}

export function createElectronProductionRecoveryStoreAtomicPairRequest(
  input: Readonly<{
    expectedHeadSha: string;
    packageIdentities: readonly [
      Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>,
      Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>
    ];
    targets: readonly [
      Readonly<ElectronProductionRecoveryStoreRemoteTarget>,
      Readonly<ElectronProductionRecoveryStoreRemoteTarget>
    ];
  }>
): Readonly<ElectronProductionRecoveryStoreAtomicPairRequest>;

export function assertElectronProductionRecoveryStoreAtomicPairRequest(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreAtomicPairRequest>;

export function createElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  input: Readonly<{
    request: unknown;
    result:
      | Readonly<{
        outcome: "applied";
        blobSha: string;
        byteLength: number;
        commitSha: string;
        parentSha: string;
        paths: readonly [string, string];
        treeSha: string;
      }>
      | Readonly<ElectronProductionRecoveryStoreRemoteFailure>;
  }>
): Readonly<ElectronProductionRecoveryStoreAtomicPairOperationReceipt>;

export function assertElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreAtomicPairOperationReceipt>;

export function verifyElectronProductionRecoveryStoreAtomicPairOperationRequest(
  input: Readonly<{ receipt: unknown; request: unknown }>
): Readonly<ElectronProductionRecoveryStoreAtomicPairOperationReceipt>;

export function serializeElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  value: unknown
): Buffer;

export function writeElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  input: Readonly<{ outputPath: string; receipt: unknown }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionRecoveryStoreAtomicPairOperationReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: typeof ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE;
    sha256: string;
  }>;
}>>;

export function readElectronProductionRecoveryStoreAtomicPairOperationReceipt(
  input: Readonly<{ receiptPath: string; expectedSha256: string }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionRecoveryStoreAtomicPairOperationReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: typeof ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE;
    sha256: string;
  }>;
}>>;
