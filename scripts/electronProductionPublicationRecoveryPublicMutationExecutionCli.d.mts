import type {
  observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote
} from "./electronProductionPublicLatestLeaseRemote.mjs";
import type {
  runElectronProductionPublicLatestLeaseRemoteCli
} from "./electronProductionPublicLatestLeaseRemoteCli.mjs";
import type {
  observeElectronProductionPublicLatestRecoveryRemoteAtResult,
  rollbackElectronProductionPublicLatestRecoveryRemoteAtResult
} from "./electronProductionPublicLatestRecoveryRemote.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_EXECUTION_CLI_SUMMARY_KIND:
  "rion-electron-production-publication-recovery-public-mutation-execution-cli-summary";

export interface ElectronProductionPublicationRecoveryPublicMutationExecutionCliSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-public-mutation-execution-cli-summary";
  readonly command: "execute" | "verify";
  readonly status: "recorded" | "verified";
  readonly operation: "rollback-public-latest" | "release-held-lease";
  readonly mode:
    | "actual-transport"
    | "marker-reconciliation"
    | "precondition-rejected";
  readonly finalObservation: "source" | "target" | "foreign" | "unknown";
  readonly acknowledgement: "confirmed" | "rejected" | "unknown";
  readonly output: Readonly<{
    bytes: number;
    fileName:
      "electron-production-publication-recovery-public-mutation-operation.json";
    sha256: string;
  }>;
}

export class ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure
  extends Error {
  readonly summary:
    Readonly<ElectronProductionPublicationRecoveryPublicMutationExecutionCliSummary>;
}

export interface ElectronProductionPublicationRecoveryPublicMutationExecutionCliDependencies {
  readonly clock?: () => string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly observeLeaseSuccessor?:
    typeof observeElectronProductionPublicLatestLeaseReleasedSuccessorRemote;
  readonly observeRecovery?:
    typeof observeElectronProductionPublicLatestRecoveryRemoteAtResult;
  readonly rollbackRecovery?:
    typeof rollbackElectronProductionPublicLatestRecoveryRemoteAtResult;
  readonly runLeaseRemote?:
    typeof runElectronProductionPublicLatestLeaseRemoteCli;
  readonly setExitCode?: (code: 1) => void;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionPublicationRecoveryPublicMutationExecutionCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionPublicationRecoveryPublicMutationExecutionCliDependencies
): Promise<Readonly<
  ElectronProductionPublicationRecoveryPublicMutationExecutionCliSummary
>>;
