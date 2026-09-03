import type {
  ElectronProductionUpdaterEvidenceProvenance,
  ElectronProductionUpdaterSourceBinding,
  ElectronProductionUpdaterTargetBinding,
  assembleElectronProductionUpdaterEvidenceBundle,
  readElectronProductionUpdaterEvidenceBundle
} from "./electronProductionUpdaterEvidenceBundle.mjs";

export interface ElectronProductionUpdaterEvidenceBundleCliBindings {
  readonly provenance: Readonly<ElectronProductionUpdaterEvidenceProvenance>;
  readonly sourceBinding: Readonly<ElectronProductionUpdaterSourceBinding>;
  readonly targetBinding: Readonly<ElectronProductionUpdaterTargetBinding>;
}

export interface ElectronProductionUpdaterEvidenceBundleCliSummary {
  readonly outputRoot: string;
  readonly receiptSha256: string;
}

export interface ElectronProductionUpdaterEvidenceBundleCliDependencies {
  readonly assembleBundle?: typeof assembleElectronProductionUpdaterEvidenceBundle;
  readonly readBundle?: typeof readElectronProductionUpdaterEvidenceBundle;
  readonly writeStdout?: (
    source: Buffer
  ) => boolean | void | Promise<boolean | void>;
}

export function runElectronProductionUpdaterEvidenceBundleCli(
  argumentsList?: readonly string[],
  dependencyOverrides?: Readonly<
    ElectronProductionUpdaterEvidenceBundleCliDependencies
  >
): Promise<Readonly<ElectronProductionUpdaterEvidenceBundleCliSummary>>;
