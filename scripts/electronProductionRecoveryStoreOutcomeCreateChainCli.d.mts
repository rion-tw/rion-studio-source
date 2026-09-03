import type {
  ElectronProductionPublicationRecoveryOutcome,
  ElectronProductionPublicationRecoveryReceiptFile
} from "./electronProductionPublicationRecovery.mjs";
import type {
  ElectronProductionPublicationRecoveryOutcomeChainProof,
  ElectronProductionPublicationRecoveryOutcomeContinuityProof
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import type {
  ElectronProductionRecoveryStoreAtomicPairOperationReceipt
} from "./electronProductionRecoveryStoreRemoteAtomicPairOperation.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteAppliedIdentity,
  ElectronProductionRecoveryStoreRemoteOperationReceipt,
  ElectronProductionRecoveryStoreRemotePackageIdentity
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_CREATE_CHAIN_KIND:
  "rion-electron-production-recovery-store-outcome-create-chain-verification";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_APPEND_FOUNDATION_KIND:
  "rion-electron-production-recovery-store-outcome-append-foundation-verification";

export interface ElectronProductionRecoveryStoreOutcomeAppendFoundationVerification {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-outcome-append-foundation-verification";
  readonly status: "verified";
  readonly transactionId: string;
  readonly recoveryRun: Readonly<{ runId: string; runAttempt: number }>;
  readonly target: Readonly<{
    repository: string;
    ref: string;
    repositoryPolicy: Readonly<{
      defaultBranch: string;
      visibility: "private";
    }>;
  }>;
  readonly paths: Readonly<{ attempt: string; terminal: string | null }>;
  readonly previousOutcomeSha256: string | null;
  readonly appendFoundation: Readonly<{
    proofSha256: string;
    currentObservation: Readonly<
      ElectronProductionPublicationRecoveryOutcomeChainProof["currentObservation"]
    >;
    predecessor: Readonly<
      ElectronProductionPublicationRecoveryOutcomeChainProof["latestOutcome"]
    >;
  }>;
  readonly attempt: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
  }>;
  readonly terminal: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
  }> | null;
}

export interface ElectronProductionRecoveryStoreOutcomeCreateChainVerification
  extends Omit<
    ElectronProductionRecoveryStoreOutcomeAppendFoundationVerification,
    "kind"
  > {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-recovery-store-outcome-create-chain-verification";
  readonly status: "verified";
  readonly transactionId: string;
  readonly recoveryRun: Readonly<{ runId: string; runAttempt: number }>;
  readonly target: Readonly<{
    repository: string;
    ref: string;
    repositoryPolicy: Readonly<{
      defaultBranch: string;
      visibility: "private";
    }>;
  }>;
  readonly paths: Readonly<{ attempt: string; terminal: string | null }>;
  readonly previousOutcomeSha256: string | null;
  readonly appendFoundation: Readonly<{
    proofSha256: string;
    currentObservation: Readonly<
      ElectronProductionPublicationRecoveryOutcomeChainProof["currentObservation"]
    >;
    predecessor: Readonly<
      ElectronProductionPublicationRecoveryOutcomeChainProof["latestOutcome"]
    >;
  }>;
  readonly attempt: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
  }>;
  readonly terminal: Readonly<{
    file: Readonly<ElectronProductionRecoveryStoreRemotePackageIdentity>;
  }> | null;
  readonly operation: Readonly<{
    mode: "single-attempt-create" | "atomic-terminal-pair-create";
    operationReceiptSha256: string;
    applied: Readonly<ElectronProductionRecoveryStoreRemoteAppliedIdentity & {
      readonly paths?: readonly [string, string];
    }>;
  }>;
}

type OutcomeFile = Readonly<
  ElectronProductionPublicationRecoveryReceiptFile<
    ElectronProductionPublicationRecoveryOutcome
  >
>;
type OperationFile<Receipt> = Readonly<{
  receipt: Readonly<Receipt>;
  receiptIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
}>;

export interface ElectronProductionRecoveryStoreOutcomeCreateChainDependencies {
  readonly readAppendProof?: (input: Readonly<{
    proofPath: string;
    expectedSha256: string;
  }>) => Promise<Readonly<{
    proof: Readonly<
      ElectronProductionPublicationRecoveryOutcomeChainProof |
        ElectronProductionPublicationRecoveryOutcomeContinuityProof
    >;
    proofIdentity: Readonly<{
      bytes: number;
      fileName: string;
      sha256: string;
    }>;
  }>>;
  readonly readAtomicPairOperation?: (input: Readonly<{
    receiptPath: string;
    expectedSha256: string;
  }>) => Promise<
    OperationFile<ElectronProductionRecoveryStoreAtomicPairOperationReceipt>
  >;
  readonly readOperation?: (input: Readonly<{
    receiptPath: string;
    expectedSha256: string;
  }>) => Promise<
    OperationFile<ElectronProductionRecoveryStoreRemoteOperationReceipt>
  >;
  readonly readOutcome?: (input: Readonly<{
    receiptPath: string;
    expectedSha256: string;
  }>) => Promise<OutcomeFile>;
  readonly readOutcomeAttempt?: (input: Readonly<{
    receiptPath: string;
    expectedSha256: string;
  }>) => Promise<OutcomeFile>;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionRecoveryStoreOutcomeCreateChainCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionRecoveryStoreOutcomeCreateChainDependencies
): Promise<
  Readonly<
    ElectronProductionRecoveryStoreOutcomeAppendFoundationVerification |
      ElectronProductionRecoveryStoreOutcomeCreateChainVerification
  >
>;
