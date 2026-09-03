import type {
  ElectronProductionRecoveryStoreReadbackFoundation
} from "./electronProductionRecoveryStoreReadbackFoundationCli.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_CONTINUITY_KIND:
  "rion-electron-production-recovery-store-readback-continuity";

export interface ElectronProductionRecoveryStoreReadbackContinuitySummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-readback-continuity";
  readonly status: "verified-same-observation";
  readonly transactionId: string;
  readonly target:
    ElectronProductionRecoveryStoreReadbackFoundation["target"];
  readonly paths:
    ElectronProductionRecoveryStoreReadbackFoundation["paths"];
  readonly currentObservation:
    ElectronProductionRecoveryStoreReadbackFoundation["currentObservation"];
  readonly capsule: Readonly<{
    file: ElectronProductionRecoveryStoreReadbackFoundation["capsule"]["file"];
    blobSha: string;
  }>;
  readonly storeSeal: Readonly<{
    file:
      ElectronProductionRecoveryStoreReadbackFoundation["storeSeal"]["file"];
    blobSha: string;
  }>;
  readonly historicalCapsuleCreate:
    ElectronProductionRecoveryStoreReadbackFoundation["historicalCapsuleCreate"];
  readonly receipts: Readonly<{
    initial: Readonly<{
      capsuleReadReceiptSha256: string;
      sealReadReceiptSha256: string;
    }>;
    fresh: Readonly<{
      capsuleReadReceiptSha256: string;
      sealReadReceiptSha256: string;
    }>;
  }>;
}

export interface ElectronProductionRecoveryStoreReadbackContinuityDependencies {
  readonly verifyReadback?: (
    argumentsList: readonly string[],
    dependencyOverrides: Readonly<{
      writeStdout: (source: Buffer) => void;
    }>
  ) => Promise<
    Readonly<ElectronProductionRecoveryStoreReadbackFoundation>
  >;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionRecoveryStoreReadbackContinuityCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionRecoveryStoreReadbackContinuityDependencies
): Promise<
  Readonly<ElectronProductionRecoveryStoreReadbackContinuitySummary>
>;
