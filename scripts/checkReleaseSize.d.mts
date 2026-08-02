export type ReleaseArtifactName =
  | "Rion.Studio-mac.app.tar.gz"
  | "Rion.Studio-mac.dmg"
  | "Rion.Studio-win.exe";

export interface ReleaseSizeResult {
  baselineBytes: number;
  maximumBytes: number;
  name: ReleaseArtifactName;
  reductionPercent: number;
  sizeBytes: number;
  toleranceBytes: number;
}

export const RELEASE_SIZE_BASELINE_VERSION: "v3.18.1";
export const REQUIRED_RELEASE_SIZE_REDUCTION_PERCENT: 10;
export const RELEASE_SIZE_BASELINES: Readonly<Record<ReleaseArtifactName, number>>;
export const RELEASE_SIZE_TOLERANCES: Readonly<Partial<Record<ReleaseArtifactName, number>>>;
export const RELEASE_SIZE_LIMITS: Readonly<Record<ReleaseArtifactName, number>>;

export function verifyReleaseSizeBudget(directory: string): Promise<ReleaseSizeResult[]>;
