import type {
  ElectronProductionPublicationRecoveryOutcomeChainProof
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import type {
  ElectronProductionRecoveryStoreReadbackFoundation
} from "./electronProductionRecoveryStoreReadbackFoundationCli.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_OUTCOME_BINDING_KIND:
  "rion-electron-production-recovery-store-readback-outcome-binding";

export interface ElectronProductionRecoveryStoreReadbackOutcomeBinding {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-readback-outcome-binding";
  readonly status: "verified-same-head-outcome-chain";
  readonly transactionId: string;
  readonly target: ElectronProductionRecoveryStoreReadbackFoundation["target"];
  readonly currentObservation:
    ElectronProductionRecoveryStoreReadbackFoundation["currentObservation"];
  readonly readback: Readonly<{
    capsule: ElectronProductionRecoveryStoreReadbackFoundation["capsule"];
    storeSeal: ElectronProductionRecoveryStoreReadbackFoundation["storeSeal"];
  }>;
  readonly outcomeChain: Readonly<{
    proofSha256: string;
    status: ElectronProductionPublicationRecoveryOutcomeChainProof["status"];
    outcomeDirectory:
      ElectronProductionPublicationRecoveryOutcomeChainProof["outcomeDirectory"];
    latestOutcome:
      ElectronProductionPublicationRecoveryOutcomeChainProof["latestOutcome"];
    terminal:
      ElectronProductionPublicationRecoveryOutcomeChainProof["terminal"];
  }>;
}

export interface ElectronProductionRecoveryStoreReadbackOutcomeBindingDependencies {
  readonly readChainProof?: (input: Readonly<{
    expectedSha256: string;
    proofPath: string;
  }>) => Promise<Readonly<{
    value: Readonly<ElectronProductionPublicationRecoveryOutcomeChainProof>;
    sha256: string;
  }>>;
  readonly verifyReadback?: (
    argumentsList: readonly string[],
    dependencies: Readonly<{ writeStdout: (source: Buffer) => void }>
  ) => Promise<Readonly<ElectronProductionRecoveryStoreReadbackFoundation>>;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionRecoveryStoreReadbackOutcomeBindingCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionRecoveryStoreReadbackOutcomeBindingDependencies
): Promise<
  Readonly<ElectronProductionRecoveryStoreReadbackOutcomeBinding>
>;
