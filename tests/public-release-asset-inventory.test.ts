import { describe, expect, it } from "vitest";
import { assertPublicReleaseAssetNames, LEGACY_PUBLIC_RELEASE_ASSET_NAMES,
  PUBLIC_RELEASE_ASSET_NAMES } from "../scripts/publicReleaseAssetInventory.mjs";
import { CHECKSUM_ASSET_NAME, REQUIRED_RELEASE_ASSETS } from "../scripts/releaseArtifacts.mjs";

describe("public release inventory", () => {
  it("requires corresponding source for a new release and matches artifact verification", () => {
    expect(PUBLIC_RELEASE_ASSET_NAMES).toEqual([...REQUIRED_RELEASE_ASSETS, CHECKSUM_ASSET_NAME].sort());
    expect(assertPublicReleaseAssetNames([...PUBLIC_RELEASE_ASSET_NAMES].reverse())).toEqual(PUBLIC_RELEASE_ASSET_NAMES);
    expect(() => assertPublicReleaseAssetNames(LEGACY_PUBLIC_RELEASE_ASSET_NAMES)).toThrow("incomplete");
    expect(assertPublicReleaseAssetNames(LEGACY_PUBLIC_RELEASE_ASSET_NAMES, { allowLegacy: true }))
      .toEqual(LEGACY_PUBLIC_RELEASE_ASSET_NAMES);
  });

  it.each([false, true])("rejects missing, duplicate and path-bearing assets with allowLegacy=%s", allowLegacy => {
    for (const names of [PUBLIC_RELEASE_ASSET_NAMES.slice(1),
      [...PUBLIC_RELEASE_ASSET_NAMES, "latest.json"],
      [...PUBLIC_RELEASE_ASSET_NAMES.slice(1), "../outside"],
      [...LEGACY_PUBLIC_RELEASE_ASSET_NAMES, "unknown.tar.gz"]]) {
      expect(() => assertPublicReleaseAssetNames(names, { allowLegacy })).toThrow();
    }
  });
});
