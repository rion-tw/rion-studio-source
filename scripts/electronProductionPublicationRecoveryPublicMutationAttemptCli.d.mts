import type {
  ElectronProductionPublicationRecoveryPublicMutationOperation
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import type {
  ElectronProductionRecoveryStoreRemoteFetch
} from "./electronProductionRecoveryStoreRemote.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_CLI_SUMMARY_KIND:
  "rion-electron-production-publication-recovery-public-mutation-attempt-cli-summary";

export interface ElectronProductionPublicationRecoveryPublicMutationAttemptCliSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-public-mutation-attempt-cli-summary";
  readonly command:
    | "materialize-attempt"
    | "prove-existing-attempt-history"
    | "authorize-attempt";
  readonly status: "created";
  readonly transactionId: string;
  readonly operation:
    ElectronProductionPublicationRecoveryPublicMutationOperation;
  readonly artifact: Readonly<{
    readonly bytes: number;
    readonly fileName: string;
    readonly sha256: string;
  }>;
}

export interface ElectronProductionPublicationRecoveryPublicMutationAttemptCliDependencies {
  readonly fetchImpl?: ElectronProductionRecoveryStoreRemoteFetch;
  readonly readToken?: () => string;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionPublicationRecoveryPublicMutationAttemptCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionPublicationRecoveryPublicMutationAttemptCliDependencies
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationAttemptCliSummary
>>;
