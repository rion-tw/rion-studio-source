import type {
  ElectronProductionRecoveryStoreRemoteAppliedIdentity,
  ElectronProductionRecoveryStoreRemotePackageIdentity
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_CREATE_CHAIN_VERIFICATION_KIND:
  "rion-electron-production-recovery-store-create-chain-verification";

export interface ElectronProductionRecoveryStoreCreateChainVerification {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-create-chain-verification";
  readonly status: "verified";
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
  readonly capsule: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
    operationReceiptSha256: string;
    applied: Readonly<ElectronProductionRecoveryStoreRemoteAppliedIdentity>;
  }>;
  readonly storeSeal: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
    operationReceiptSha256: string;
    applied: Readonly<ElectronProductionRecoveryStoreRemoteAppliedIdentity>;
  }>;
}

export interface ElectronProductionRecoveryStoreCreateChainCliDependencies {
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionRecoveryStoreCreateChainCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionRecoveryStoreCreateChainCliDependencies
): Promise<Readonly<ElectronProductionRecoveryStoreCreateChainVerification>>;
