import type {
  ElectronProductionUpdaterEvidenceAttemptOutcomeArtifactIdentity,
  ElectronProductionUpdaterEvidenceAttemptOutcomeCell,
  ElectronProductionUpdaterEvidenceAttemptOutcomeStatus
} from "./electronProductionUpdaterEvidenceAttemptOutcome.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_CLI_SUMMARY_KIND:
  "rion-production-updater-evidence-attempt-outcome-cli-summary";

export interface ElectronProductionUpdaterEvidenceAttemptOutcomeCliSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-production-updater-evidence-attempt-outcome-cli-summary";
  readonly command: "create" | "verify";
  readonly status: "created" | "verified";
  readonly attemptPlanSha256: string;
  readonly cell: Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeCell>;
  readonly outcome: ElectronProductionUpdaterEvidenceAttemptOutcomeStatus;
  readonly producerArtifactName: string;
  readonly receipt:
    Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeArtifactIdentity>;
}

export interface ElectronProductionUpdaterEvidenceAttemptOutcomeCliDependencies {
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterEvidenceAttemptOutcomeCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionUpdaterEvidenceAttemptOutcomeCliDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeCliSummary>>;
