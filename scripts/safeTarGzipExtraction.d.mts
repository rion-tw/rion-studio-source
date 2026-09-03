export interface SafeTarGzipExtractionLimits {
  maximumArchiveBytes: number;
  maximumEntries: number;
  maximumExpandedBytes: number;
  maximumFileBytes: number;
  maximumPathBytes: number;
  maximumSymlinkTargetBytes: number;
  maximumTotalFileBytes: number;
}

export interface SafeTarGzipExtractionSummary {
  readonly archiveBytes: number;
  readonly archiveRoot: string;
  readonly archiveSha256: string;
  readonly destinationPath: string;
  readonly directoryCount: number;
  readonly entryCount: number;
  readonly regularFileBytes: number;
  readonly regularFileCount: number;
  readonly symlinkCount: number;
}

export function extractSafeTarGzipSubtree(input: {
  archivePath: string;
  archiveRoot: string;
  destinationPath: string;
  limits?: Readonly<Partial<SafeTarGzipExtractionLimits>>;
}): Promise<SafeTarGzipExtractionSummary>;
