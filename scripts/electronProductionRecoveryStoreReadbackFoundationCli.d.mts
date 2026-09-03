import type {
  ElectronProductionRecoveryStoreRemotePackageIdentity
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_FOUNDATION_KIND:
  "rion-electron-production-recovery-store-readback-foundation";

export interface ElectronProductionRecoveryStoreReadbackFoundation {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-recovery-store-readback-foundation";
  readonly status: "verified-current-readback";
  readonly transactionId: string;
  readonly target: Readonly<{
    repository: string;
    ref: string;
    repositoryPolicy: Readonly<{
      defaultBranch: string;
      visibility: "private";
    }>;
  }>;
  readonly paths: Readonly<{
    capsule: string;
    storeSeal: string;
  }>;
  readonly currentObservation: Readonly<{
    headCommitSha: string;
    treeSha: string;
    parentCommitShas: readonly string[];
  }>;
  readonly capsule: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
    blobSha: string;
    readReceiptSha256: string;
  }>;
  readonly storeSeal: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
    blobSha: string;
    readReceiptSha256: string;
  }>;
  readonly historicalCapsuleCreate: Readonly<{
    authority: "seal-recorded-not-reproved";
    parentCommitSha: string;
    commitSha: string;
    treeSha: string;
    operationReceiptSha256: string;
  }>;
}

export interface ElectronProductionRecoveryStoreReadbackFoundationCliDependencies {
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionRecoveryStoreReadbackFoundationCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionRecoveryStoreReadbackFoundationCliDependencies
): Promise<Readonly<ElectronProductionRecoveryStoreReadbackFoundation>>;
