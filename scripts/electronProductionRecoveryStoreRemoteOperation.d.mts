import type {
  ElectronProductionRecoveryStoreRemoteApplied,
  ElectronProductionRecoveryStoreRemoteFailure,
  ElectronProductionRecoveryStoreRemoteIndeterminateReason,
  ElectronProductionRecoveryStoreRemoteReadResult,
  ElectronProductionRecoveryStoreRemoteRejectedReason,
  ElectronProductionRecoveryStoreRemoteTarget
} from "./electronProductionRecoveryStoreRemote.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_REQUEST_KIND:
  "rion-electron-production-recovery-store-remote-request";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_KIND:
  "rion-electron-production-recovery-store-remote-operation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE:
  "electron-production-recovery-store-remote-operation.json";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_REQUEST_KIND:
  "rion-electron-production-recovery-store-remote-read-request";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_KIND:
  "rion-electron-production-recovery-store-remote-read-operation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE:
  "electron-production-recovery-store-remote-read-operation.json";

export interface ElectronProductionRecoveryStoreRemotePackageIdentity {
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ElectronProductionRecoveryStoreRemoteCanonicalTarget {
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
  readonly repositoryPolicy: Readonly<{
    readonly defaultBranch: string;
    readonly visibility: "private";
  }>;
}

export interface ElectronProductionRecoveryStoreRemoteRequest {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-store-remote-request";
  readonly operation: "create";
  readonly target: Readonly<ElectronProductionRecoveryStoreRemoteCanonicalTarget>;
  readonly expectedHeadSha: string;
  readonly package: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
  readonly commitMessage: string;
}

export interface ElectronProductionRecoveryStoreRemoteRequestIdentity {
  readonly target: Readonly<ElectronProductionRecoveryStoreRemoteCanonicalTarget>;
  readonly package: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
  readonly expectedHeadSha256: string;
  readonly commitMessageSha256: string;
  readonly requestSha256: string;
}

export type ElectronProductionRecoveryStoreRemoteTerminal =
  | Readonly<{
      classification: "applied";
      reason: null;
      httpStatus: null;
    }>
  | Readonly<{
      classification: "rejected";
      reason: ElectronProductionRecoveryStoreRemoteRejectedReason;
      httpStatus: number | null;
    }>
  | Readonly<{
      classification: "indeterminate";
      reason: ElectronProductionRecoveryStoreRemoteIndeterminateReason;
      httpStatus: number | null;
    }>;

export interface ElectronProductionRecoveryStoreRemoteAppliedIdentity {
  readonly parentCommitSha: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly blobSha: string;
  readonly byteLength: number;
}

export interface ElectronProductionRecoveryStoreRemoteOperationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-store-remote-operation";
  readonly operation: "create";
  readonly requestIdentity:
    Readonly<ElectronProductionRecoveryStoreRemoteRequestIdentity>;
  readonly terminal: ElectronProductionRecoveryStoreRemoteTerminal;
  readonly applied:
    Readonly<ElectronProductionRecoveryStoreRemoteAppliedIdentity> | null;
}

export interface ElectronProductionRecoveryStoreRemoteExpectedContentIdentity {
  readonly byteLength: number | null;
  readonly sha256: string | null;
}

export interface ElectronProductionRecoveryStoreRemoteReadRequest {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-store-remote-read-request";
  readonly operation: "read";
  readonly target: Readonly<ElectronProductionRecoveryStoreRemoteCanonicalTarget>;
  readonly expectedContent:
    Readonly<ElectronProductionRecoveryStoreRemoteExpectedContentIdentity>;
}

export interface ElectronProductionRecoveryStoreRemoteReadRequestIdentity {
  readonly target: Readonly<ElectronProductionRecoveryStoreRemoteCanonicalTarget>;
  readonly expectedContent:
    Readonly<ElectronProductionRecoveryStoreRemoteExpectedContentIdentity>;
  readonly requestSha256: string;
}

export type ElectronProductionRecoveryStoreRemoteReadTerminal =
  | Readonly<{
      classification: "present";
      reason: null;
      httpStatus: null;
    }>
  | Readonly<{
      classification: "absent";
      reason: "path-absent";
      httpStatus: null;
    }>
  | Readonly<{
      classification: "rejected";
      reason:
        | ElectronProductionRecoveryStoreRemoteRejectedReason
        | "content-identity-mismatch";
      httpStatus: number | null;
    }>
  | Readonly<{
      classification: "indeterminate";
      reason:
        | ElectronProductionRecoveryStoreRemoteIndeterminateReason
        | "content-output-failed"
        | "content-verification-failed";
      httpStatus: number | null;
    }>;

export interface ElectronProductionRecoveryStoreRemoteReadObservedIdentity {
  readonly headCommitSha: string;
  readonly treeSha: string;
  readonly blobSha: string;
  readonly parentCommitShas: readonly string[];
  readonly file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
}

export interface ElectronProductionRecoveryStoreRemoteReadOperationReceipt {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-store-remote-read-operation";
  readonly operation: "read";
  readonly requestIdentity:
    Readonly<ElectronProductionRecoveryStoreRemoteReadRequestIdentity>;
  readonly terminal: ElectronProductionRecoveryStoreRemoteReadTerminal;
  readonly observed:
    Readonly<ElectronProductionRecoveryStoreRemoteReadObservedIdentity> | null;
}

export type ElectronProductionRecoveryStoreRemoteResult =
  | ElectronProductionRecoveryStoreRemoteApplied
  | ElectronProductionRecoveryStoreRemoteFailure;

export function createElectronProductionRecoveryStoreRemoteRequest(
  input: Readonly<{
    expectedHeadSha: string;
    packageIdentity:
      Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
    target: Readonly<ElectronProductionRecoveryStoreRemoteTarget>;
  }>
): Readonly<ElectronProductionRecoveryStoreRemoteRequest>;

export function assertElectronProductionRecoveryStoreRemoteRequest(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreRemoteRequest>;

export function electronProductionRecoveryStoreRemoteRequestSha256(
  value: unknown
): string;

export function createElectronProductionRecoveryStoreRemoteOperationReceipt(
  input: Readonly<{
    request: unknown;
    result: Readonly<ElectronProductionRecoveryStoreRemoteResult>;
  }>
): Readonly<ElectronProductionRecoveryStoreRemoteOperationReceipt>;

export function assertElectronProductionRecoveryStoreRemoteOperationReceipt(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreRemoteOperationReceipt>;

export function verifyElectronProductionRecoveryStoreRemoteOperationRequest(
  input: Readonly<{ receipt: unknown; request: unknown }>
): Readonly<ElectronProductionRecoveryStoreRemoteOperationReceipt>;

export function serializeElectronProductionRecoveryStoreRemoteOperationReceipt(
  value: unknown
): Buffer;

export function electronProductionRecoveryStoreRemoteOperationReceiptSha256(
  value: unknown
): string;

export function writeElectronProductionRecoveryStoreRemoteOperationReceipt(
  input: Readonly<{ outputPath: string; receipt: unknown }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionRecoveryStoreRemoteOperationReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: typeof ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE;
    sha256: string;
  }>;
}>>;

export function readElectronProductionRecoveryStoreRemoteOperationReceipt(
  input: Readonly<{ receiptPath: string; expectedSha256: string }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionRecoveryStoreRemoteOperationReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: typeof ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE;
    sha256: string;
  }>;
}>>;

export function createElectronProductionRecoveryStoreRemoteReadRequest(
  input: Readonly<{
    expectedContent:
      Readonly<ElectronProductionRecoveryStoreRemoteExpectedContentIdentity>;
    target: Readonly<ElectronProductionRecoveryStoreRemoteTarget>;
  }>
): Readonly<ElectronProductionRecoveryStoreRemoteReadRequest>;

export function assertElectronProductionRecoveryStoreRemoteReadRequest(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreRemoteReadRequest>;

export function electronProductionRecoveryStoreRemoteReadRequestSha256(
  value: unknown
): string;

export function createElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  input: Readonly<{
    content: Uint8Array | null;
    request: unknown;
    result: Readonly<ElectronProductionRecoveryStoreRemoteReadResult>;
  }>
): Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;

export function createElectronProductionRecoveryStoreRemoteReadFailureReceipt(
  input: Readonly<{
    reason: "content-output-failed" | "content-verification-failed";
    request: unknown;
  }>
): Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;

export function assertElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  value: unknown
): Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;

export function verifyElectronProductionRecoveryStoreRemoteReadOperationRequest(
  input: Readonly<{ receipt: unknown; request: unknown }>
): Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;

export function serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  value: unknown
): Buffer;

export function electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(
  value: unknown
): string;

export function writeElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  input: Readonly<{ outputPath: string; receipt: unknown }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName:
      typeof ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE;
    sha256: string;
  }>;
}>>;

export function readElectronProductionRecoveryStoreRemoteReadOperationReceipt(
  input: Readonly<{ receiptPath: string; expectedSha256: string }>
): Promise<Readonly<{
  receipt: Readonly<ElectronProductionRecoveryStoreRemoteReadOperationReceipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName:
      typeof ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE;
    sha256: string;
  }>;
}>>;
