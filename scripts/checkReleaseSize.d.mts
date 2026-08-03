export type ReleaseArtifactName =
  | "Rion.Studio-mac.app.tar.gz"
  | "Rion.Studio-mac.dmg"
  | "Rion.Studio-win.exe";

export interface ReleaseSizeResult {
  maximumBytes: number;
  name: ReleaseArtifactName;
  sizeBytes: number;
}

export const RELEASE_SIZE_LIMITS: Readonly<Record<ReleaseArtifactName, number>>;

export function verifyReleaseSizeBudget(directory: string): Promise<ReleaseSizeResult[]>;
