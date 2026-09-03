export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_KIND:
  "rion-electron-production-updater-evidence-attempt-plan";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_BINDINGS_KIND:
  "rion-electron-production-updater-evidence-attempt-plan-bindings";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_FILE:
  "electron-production-updater-evidence-attempt-plan.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_WORKFLOW:
  ".github/workflows/electron-production-updater-evidence.yml";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_REPOSITORY:
  "rion-tw/rion-studio-source";

export type ElectronProductionUpdaterEvidenceAttemptTransition =
  | "tauri-v22-to-electron-v23"
  | "electron-v23-to-electron-v23";
export type ElectronProductionUpdaterEvidenceAttemptPlatform =
  | "darwin-aarch64"
  | "windows-x86_64";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_TRANSITIONS:
  readonly ElectronProductionUpdaterEvidenceAttemptTransition[];
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_PLATFORMS:
  readonly ElectronProductionUpdaterEvidenceAttemptPlatform[];

export interface ElectronProductionUpdaterEvidenceCandidateIdentity {
  readonly artifactName: string;
  readonly candidateReceiptSha256: string;
  readonly controlSha: string;
  readonly repository: "rion-tw/rion-studio-source";
  readonly runAttempt: number;
  readonly runId: string;
  readonly sourceSha: string;
  readonly trustedControlReceiptSha256: string;
  readonly version: string;
  readonly workflow: ".github/workflows/electron-production-candidate.yml";
}

export interface ElectronProductionUpdaterEvidenceTauriV22Identity {
  readonly artifacts: Readonly<Record<
    ElectronProductionUpdaterEvidenceAttemptPlatform,
    Readonly<{
      readonly artifactName: string;
      readonly receiptSha256: string;
    }>
  >>;
  readonly controlSha: string;
  readonly releaseTag: string;
  readonly repository: "rion-tw/rion-studio-source";
  readonly runAttempt: number;
  readonly runId: string;
  readonly sourceSha: string;
  readonly targetSourceSha: string;
  readonly version: string;
  readonly workflow:
    ".github/workflows/electron-updater-tauri-v22-compatibility.yml";
}

export interface ElectronProductionUpdaterEvidenceProvisionalIdentity {
  readonly artifactName: string;
  readonly controlSha: string;
  readonly receiptSha256: string;
  readonly repository: "rion-tw/rion-studio-source";
  readonly revision: number;
  readonly runAttempt: number;
  readonly runId: string;
  readonly transactionId: string;
  readonly workflow:
    ".github/workflows/electron-production-provisional-publish.yml";
}

export interface ElectronProductionUpdaterEvidenceAttemptPlanProducer {
  readonly aggregateArtifactName: string;
  readonly controlSha: string;
  readonly repository: "rion-tw/rion-studio-source";
  readonly runAttempt: number;
  readonly runId: string;
  readonly workflow:
    ".github/workflows/electron-production-updater-evidence.yml";
}

export interface ElectronProductionUpdaterEvidenceAttemptPlanBindings {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-updater-evidence-attempt-plan-bindings";
  readonly producer: ElectronProductionUpdaterEvidenceAttemptPlanProducer;
  readonly upstream: Readonly<{
    readonly target: ElectronProductionUpdaterEvidenceCandidateIdentity;
    readonly priorV23: ElectronProductionUpdaterEvidenceCandidateIdentity;
    readonly tauriV22: ElectronProductionUpdaterEvidenceTauriV22Identity;
    readonly provisionalPublication:
      ElectronProductionUpdaterEvidenceProvisionalIdentity;
  }>;
}

export interface ElectronProductionUpdaterEvidenceAttemptPlanCell {
  readonly evidenceAttemptId: string;
  readonly platform: ElectronProductionUpdaterEvidenceAttemptPlatform;
  readonly transitionKind: ElectronProductionUpdaterEvidenceAttemptTransition;
}

export interface ElectronProductionUpdaterEvidenceAttemptPlan {
  readonly schemaVersion: 1;
  readonly kind: "rion-electron-production-updater-evidence-attempt-plan";
  readonly producer: ElectronProductionUpdaterEvidenceAttemptPlanProducer;
  readonly upstream: ElectronProductionUpdaterEvidenceAttemptPlanBindings["upstream"];
  readonly challenge: Readonly<{
    readonly expiresAt: string;
    readonly id: string;
    readonly issuedAt: string;
    readonly nonceSha256: string;
  }>;
  readonly cells: readonly ElectronProductionUpdaterEvidenceAttemptPlanCell[];
}

export interface ElectronProductionUpdaterEvidenceAttemptPlanFile {
  readonly plan: ElectronProductionUpdaterEvidenceAttemptPlan;
  readonly planIdentity: Readonly<{
    readonly bytes: number;
    readonly fileName:
      "electron-production-updater-evidence-attempt-plan.json";
    readonly sha256: string;
  }>;
  readonly planPath: string;
}

export interface ElectronProductionUpdaterEvidenceAttemptPlanDependencies {
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}

export function createElectronProductionUpdaterEvidenceAttemptPlan(
  input: Readonly<{
    bindings: ElectronProductionUpdaterEvidenceAttemptPlanBindings;
    challengeNonce: Uint8Array;
    outputPath: string;
  }>,
  dependencyOverrides?: ElectronProductionUpdaterEvidenceAttemptPlanDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttemptPlanFile>>;

export function readElectronProductionUpdaterEvidenceAttemptPlan(
  input: Readonly<{
    expectedSha256?: string;
    planPath: string;
  }>,
  dependencyOverrides?: Pick<
    ElectronProductionUpdaterEvidenceAttemptPlanDependencies,
    "now"
  >
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttemptPlanFile>>;

export function readElectronProductionUpdaterEvidenceAttemptPlanBindings(
  bindingsPath: string
): Promise<Readonly<{
  bindings: ElectronProductionUpdaterEvidenceAttemptPlanBindings;
  bindingsIdentity: Readonly<{
    bytes: number;
    fileName: string;
    sha256: string;
  }>;
  bindingsPath: string;
}>>;

export function readElectronProductionUpdaterEvidenceChallengeNonce(
  noncePath: string
): Promise<Buffer>;

export function assertElectronProductionUpdaterEvidenceAttemptPlanBindings(
  value: unknown
): Readonly<ElectronProductionUpdaterEvidenceAttemptPlanBindings>;

export function assertElectronProductionUpdaterEvidenceAttemptPlan(
  value: unknown,
  options?: Readonly<{ now?: Date }>
): Readonly<ElectronProductionUpdaterEvidenceAttemptPlan>;
