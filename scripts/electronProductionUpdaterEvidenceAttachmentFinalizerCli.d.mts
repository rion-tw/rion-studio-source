import type {
  ElectronProductionUpdaterEvidenceAttachmentFinalization,
  finalizeElectronProductionUpdaterEvidenceAttachments
} from "./electronProductionUpdaterEvidenceAttachmentFinalizer.mjs";

export type ElectronProductionUpdaterEvidenceAttachmentFinalizerCliSummary = Pick<
    ElectronProductionUpdaterEvidenceAttachmentFinalization,
    | "attemptPlanSha256"
    | "attachments"
    | "cell"
    | "journalTraceSha256"
    | "kind"
    | "outputRoot"
    | "schemaVersion"
  >;

export interface ElectronProductionUpdaterEvidenceAttachmentFinalizerCliDependencies {
  readonly finalize?: typeof finalizeElectronProductionUpdaterEvidenceAttachments;
  readonly now?: () => Date;
  readonly writeStdout?: (source: Buffer) => boolean | void | Promise<boolean | void>;
}

export function runElectronProductionUpdaterEvidenceAttachmentFinalizerCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: Readonly<
    ElectronProductionUpdaterEvidenceAttachmentFinalizerCliDependencies
  >
): Promise<Readonly<ElectronProductionUpdaterEvidenceAttachmentFinalizerCliSummary>>;
