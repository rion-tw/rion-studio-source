export interface PackagedElectronPackageManifestLimits {
  readonly maximumEntries: number;
  readonly maximumFileBytes: number;
  readonly maximumSymlinkTargetBytes: number;
  readonly maximumTotalFileBytes: number;
}

export type PackagedElectronPackageManifestEntry =
  | Readonly<{ mode: number; path: string; type: "directory" }>
  | Readonly<{
    bytes: number;
    mode: number;
    path: string;
    sha256: string;
    type: "regular-file";
  }>
  | Readonly<{
    mode: number;
    path: string;
    target: string;
    type: "symlink";
  }>;

export interface PackagedElectronPackageManifestSummary {
  readonly directoryCount: number;
  readonly entryCount: number;
  readonly regularFileBytes: number;
  readonly regularFileCount: number;
  readonly schemaVersion: 1;
  readonly sha256: string;
  readonly symlinkCount: number;
}

export interface PackagedElectronPackageManifest
  extends PackagedElectronPackageManifestSummary {
  readonly entries: readonly PackagedElectronPackageManifestEntry[];
  readonly packageDirectory: string;
  readonly rootMode: number;
}

export interface PortablePackagedElectronPackageManifest
  extends PackagedElectronPackageManifestSummary {
  readonly entries: readonly PackagedElectronPackageManifestEntry[];
  readonly rootMode: number;
}

export interface PackagedElectronPackageManifestComparison {
  readonly addedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly matches: boolean;
  readonly removedPaths: readonly string[];
}

export const PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS:
  Readonly<PackagedElectronPackageManifestLimits>;

export function capturePackagedElectronPackageManifest(
  packageDirectory: string,
  limits?: Readonly<Partial<PackagedElectronPackageManifestLimits>>
): Promise<PackagedElectronPackageManifest>;

export function createPortablePackagedElectronPackageManifest(
  entries: readonly PackagedElectronPackageManifestEntry[],
  rootMode: number
): PortablePackagedElectronPackageManifest;

export function toPortablePackagedElectronPackageManifest(
  manifest: PackagedElectronPackageManifest
): PortablePackagedElectronPackageManifest;

export function assertPortablePackagedElectronPackageManifest(
  value: unknown
): PortablePackagedElectronPackageManifest;

export function removeExactPortablePackagedElectronPackageManifestEntry(
  manifest: PortablePackagedElectronPackageManifest,
  exactPath: string
): PortablePackagedElectronPackageManifest;

export function summarizePackagedElectronPackageManifest(
  manifest: PackagedElectronPackageManifest
): PackagedElectronPackageManifestSummary;

export function assertPackagedElectronPackageManifestSummary(
  value: unknown
): PackagedElectronPackageManifestSummary;

export function comparePackagedElectronPackageManifests(
  expected: PackagedElectronPackageManifest,
  actual: PackagedElectronPackageManifest
): PackagedElectronPackageManifestComparison;

export function assertPackagedElectronPackageManifestUnchanged(
  expected: PackagedElectronPackageManifest,
  actual: PackagedElectronPackageManifest
): PackagedElectronPackageManifestSummary;
