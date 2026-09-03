import type {
  ElectronProductionPublicationRecoveryOutcomeClassification,
  ElectronProductionPublicationRecoveryRunIdentity
} from "./electronProductionPublicationRecovery.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_CLI_SUMMARY_KIND:
  "rion-electron-production-publication-recovery-cli-summary";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_INPUT_KIND:
  "rion-electron-production-publication-recovery-store-seal-materialization";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND:
  "rion-electron-production-publication-recovery-outcome-materialization";

export interface ElectronProductionPublicationRecoveryStoreSealMaterializationInput {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-store-seal-materialization";
  readonly committedAt: string;
  readonly writer: Readonly<ElectronProductionPublicationRecoveryRunIdentity>;
  readonly sealedAt: string;
}

export interface ElectronProductionPublicationRecoveryOutcomeMaterializationInput {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-publication-recovery-outcome-materialization";
  readonly recoveryRun: Readonly<
    ElectronProductionPublicationRecoveryRunIdentity & { startedAt: string }
  >;
  readonly determinedAt: string;
}

export type ElectronProductionPublicationRecoveryCliCommand =
  | "materialize-store-seal"
  | "verify-store-seal"
  | "materialize-outcome"
  | "verify-outcome"
  | "materialize-marker-outcome"
  | "verify-marker-outcome";

export interface ElectronProductionPublicationRecoveryCliSummary {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-publication-recovery-cli-summary";
  readonly command: ElectronProductionPublicationRecoveryCliCommand;
  readonly status: "materialized" | "verified";
  readonly output: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  readonly terminalOutput: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }> | null;
  readonly outcome: Readonly<{
    classification: ElectronProductionPublicationRecoveryOutcomeClassification;
    terminal: boolean;
    safeToReleaseLease: boolean;
  }> | null;
}

export function runElectronProductionPublicationRecoveryCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: Readonly<{
    writeStdout?: (source: Buffer) => void;
  }>
): Promise<Readonly<ElectronProductionPublicationRecoveryCliSummary>>;
