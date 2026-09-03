import type {
  ElectronProductionUpdaterEvidenceAggregate
} from "./electronProductionUpdaterEvidenceAggregate.mjs";

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_AGGREGATE_VERIFICATION_KIND:
  "rion-production-updater-evidence-aggregate-verification";

export interface ElectronProductionUpdaterEvidenceAggregateVerification {
  readonly schemaVersion: 1;
  readonly kind: "rion-production-updater-evidence-aggregate-verification";
  readonly status: "verified";
  readonly aggregateRoot: string;
  readonly attemptPlanSha256: string;
  readonly artifactName: string;
  readonly challengeId: string;
  readonly evidenceAttemptIds: readonly string[];
  readonly plannedCells: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly receiptSha256:
    ElectronProductionUpdaterEvidenceAggregate["receiptSha256"];
  readonly target: Readonly<Record<string, unknown>>;
}

export interface ElectronProductionUpdaterEvidenceAggregateCliDependencies {
  readonly now?: () => Date;
  readonly writeStdout?: (source: Buffer) => void | Promise<void>;
}

export function runElectronProductionUpdaterEvidenceAggregateCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: ElectronProductionUpdaterEvidenceAggregateCliDependencies
): Promise<Readonly<ElectronProductionUpdaterEvidenceAggregateVerification>>;
