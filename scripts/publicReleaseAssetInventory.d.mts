export const LEGACY_PUBLIC_RELEASE_ASSET_NAMES: readonly string[];
export const PUBLIC_RELEASE_ASSET_NAMES: readonly string[];
export function assertPublicReleaseAssetNames(
  names: unknown, options?: { allowLegacy?: boolean }
): string[];
