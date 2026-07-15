export const REQUIRED_RELEASE_ASSETS: string[];
export const OPTIONAL_RELEASE_ASSETS: string[];
export const CHECKSUM_ASSET_NAME: string;

export function verifyReleaseAssets(
  directory: string,
  expectedVersion: string,
  options?: { allowChecksums?: boolean }
): Promise<string[]>;

export function writeReleaseChecksums(directory: string): Promise<string>;
