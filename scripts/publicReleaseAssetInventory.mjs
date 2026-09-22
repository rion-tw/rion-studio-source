import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const LEGACY_PUBLIC_RELEASE_ASSET_NAMES = Object.freeze([
  "Rion.Studio-mac.app.tar.gz", "Rion.Studio-mac.app.tar.gz.sig",
  "Rion.Studio-mac.dmg", "Rion.Studio-win.exe", "Rion.Studio-win.exe.sig",
  "SHA256SUMS.txt", "latest.json"
].sort());
export const PUBLIC_RELEASE_ASSET_NAMES = Object.freeze([
  ...LEGACY_PUBLIC_RELEASE_ASSET_NAMES, "Rion.Studio-source.tar.gz"
].sort());

/** New publications include corresponding source. Published legacy releases
 * remain valid snapshot/restore inputs with their original exact inventory. */
export function assertPublicReleaseAssetNames(names, { allowLegacy = false } = {}) {
  if (!Array.isArray(names) || names.some(name => typeof name !== "string")) {
    throw new Error("The public release asset inventory must contain names.");
  }
  const sorted = [...names].sort();
  const expected = allowLegacy && !sorted.includes("Rion.Studio-source.tar.gz")
    ? LEGACY_PUBLIC_RELEASE_ASSET_NAMES : PUBLIC_RELEASE_ASSET_NAMES;
  if (sorted.length !== expected.length || sorted.some((name, index) => name !== expected[index])) {
    throw new Error("The public release asset inventory is incomplete, duplicated, or unexpected.");
  }
  return sorted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [file, ...flags] = process.argv.slice(2);
    if (!file || flags.some(flag => flag !== "--allow-legacy")) throw new Error("Invalid release inventory arguments.");
    const release = JSON.parse(await readFile(file, "utf8"));
    const names = assertPublicReleaseAssetNames(release.assets?.map(asset => asset.name),
      { allowLegacy: flags.includes("--allow-legacy") });
    process.stdout.write(names.join("\n") + "\n");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
