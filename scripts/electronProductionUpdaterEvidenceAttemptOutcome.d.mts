export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND:
  "rion-production-updater-evidence-attempt-outcome";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE:
  "electron-production-updater-evidence-attempt-outcome.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW:
  ".github/workflows/electron-production-updater-evidence.yml";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY:
  "rion-tw/rion-studio-source";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_MAX_BYTES:
  number;

export type ElectronProductionUpdaterEvidenceAttemptOutcomeStatus =
  | "failed"
  | "cancelled"
  | "indeterminate";
export type ElectronProductionUpdaterEvidenceAttemptOutcomePlatform =
  | "darwin-aarch64"
  | "windows-x86_64";
export type ElectronProductionUpdaterEvidenceAttemptOutcomeTransition =
  | "tauri-v22-to-electron-v23"
  | "electron-v23-to-electron-v23";

export interface ElectronProductionUpdaterEvidenceAttemptOutcomeCell {
  readonly transitionKind:
    ElectronProductionUpdaterEvidenceAttemptOutcomeTransition;
  readonly platform: ElectronProductionUpdaterEvidenceAttemptOutcomePlatform;
  readonly evidenceAttemptId: string;
}

export interface ElectronProductionUpdaterEvidenceAttemptOutcomeProducer {
  readonly repository: "rion-tw/rion-studio-source";
  readonly workflow:
    ".github/workflows/electron-production-updater-evidence.yml";
  readonly runId: string;
  readonly runAttempt: number;
  readonly controlSha: string;
  readonly artifactName: string;
}

export interface ElectronProductionUpdaterEvidenceAttemptOutcomeArtifactIdentity {
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ElectronProductionUpdaterEvidenceAttemptOutcome {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-evidence-attempt-outcome";
  readonly cutoverEligible: false;
  readonly terminal: true;
  readonly outcome: ElectronProductionUpdaterEvidenceAttemptOutcomeStatus;
  readonly deadlineUsedAsSuccess: false;
  readonly cell: Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeCell>;
  readonly attemptPlanSha256: string;
  readonly producer:
    Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeProducer>;
  readonly sourceUpdaterInvoked: boolean;
  readonly sourceInstallAttemptId: string | null;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly observationArtifact:
    Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeArtifactIdentity> | null;
}

export interface ElectronProductionUpdaterEvidenceAttemptOutcomeFile {
  readonly value: Readonly<ElectronProductionUpdaterEvidenceAttemptOutcome>;
  readonly valueIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName:
      "electron-production-updater-evidence-attempt-outcome.json";
    readonly sha256: string;
  }>;
  readonly valuePath: string;
}

export function electronProductionUpdaterEvidenceAttemptOutcomeArtifactName(
  input: Readonly<{
    cell: ElectronProductionUpdaterEvidenceAttemptOutcomeCell;
    runAttempt: number;
    runId: string;
  }>
): string;

export function createElectronProductionUpdaterEvidenceAttemptOutcome(
  input: Readonly<{
    attemptPlanSha256: string;
    cell: ElectronProductionUpdaterEvidenceAttemptOutcomeCell;
    deadlineUsedAsSuccess: boolean;
    observationArtifact:
      ElectronProductionUpdaterEvidenceAttemptOutcomeArtifactIdentity | null;
    observedAt: string;
    outcome: ElectronProductionUpdaterEvidenceAttemptOutcomeStatus;
    outputPath: string;
    producer: ElectronProductionUpdaterEvidenceAttemptOutcomeProducer;
    reasonCode: string;
    sourceInstallAttemptId: string | null;
    sourceUpdaterInvoked: boolean;
  }>
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeFile>>;

export function assertElectronProductionUpdaterEvidenceAttemptOutcome(
  value: unknown
): Readonly<ElectronProductionUpdaterEvidenceAttemptOutcome>;

export function serializeElectronProductionUpdaterEvidenceAttemptOutcome(
  value: unknown
): Buffer;

export function readElectronProductionUpdaterEvidenceAttemptOutcome(
  input: Readonly<{ expectedSha256: string; receiptPath: string }>
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttemptOutcomeFile>>;
