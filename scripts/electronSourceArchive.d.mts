export const ELECTRON_SOURCE_ARCHIVE_NAME: "Rion.Studio-source.tar.gz";

export interface ElectronSourceArchiveResult {
  readonly name: string;
  readonly path: string;
  readonly sourceCount: number;
}

export function createElectronSourceArchive(input: {
  outputPath?: string;
  root?: string;
  trackedPaths?: readonly string[];
  version: string;
}): Promise<ElectronSourceArchiveResult>;

export function verifyElectronSourceArchive(
  archivePath: string,
  version: string
): Promise<Readonly<{ sourceCount: number; version: string }>>;
