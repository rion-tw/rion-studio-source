import type {
  ElectronProductionUpdaterEvidenceAttemptPlanDependencies
} from "./electronProductionUpdaterEvidenceAttemptPlan.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_PLAN_CLI_SUMMARY_KIND:
  "rion-electron-production-updater-evidence-attempt-plan-cli-summary";

export interface ElectronProductionUpdaterEvidenceAttemptPlanCliSummary {
  readonly schemaVersion: 1;
  readonly kind:
    "rion-electron-production-updater-evidence-attempt-plan-cli-summary";
  readonly command: "create" | "verify";
  readonly status: "created" | "verified";
  readonly artifact: Readonly<{
    readonly bytes: number;
    readonly fileName:
      "electron-production-updater-evidence-attempt-plan.json";
    readonly sha256: string;
  }>;
}

export interface ElectronProductionUpdaterEvidenceAttemptPlanCliDependencies
  extends ElectronProductionUpdaterEvidenceAttemptPlanDependencies {
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterEvidenceAttemptPlanCli(
  argumentsList?: readonly string[],
  dependencyOverrides?:
    ElectronProductionUpdaterEvidenceAttemptPlanCliDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttemptPlanCliSummary>>;
