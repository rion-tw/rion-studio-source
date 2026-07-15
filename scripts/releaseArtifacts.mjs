import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_RELEASE_ASSETS = [
  "Rion.Studio-mac.dmg",
  "Rion.Studio-mac.zip",
  "Rion.Studio-mac.zip.blockmap",
  "latest-mac.yml",
  "Rion.Studio-win.exe",
  "Rion.Studio-win.exe.blockmap",
  "latest.yml"
];

export const OPTIONAL_RELEASE_ASSETS = ["Rion.Studio-mac.dmg.blockmap"];
export const CHECKSUM_ASSET_NAME = "SHA256SUMS.txt";

const ALLOWED_RELEASE_ASSETS = new Set([
  ...REQUIRED_RELEASE_ASSETS,
  ...OPTIONAL_RELEASE_ASSETS,
  CHECKSUM_ASSET_NAME
]);

export async function verifyReleaseAssets(directory, expectedVersion, options = {}) {
  const { allowChecksums = false } = options;
  const names = (await readdir(directory)).sort();
  const missing = REQUIRED_RELEASE_ASSETS.filter((name) => !names.includes(name));

  if (missing.length > 0) {
    throw new Error(`Missing required release assets: ${missing.join(", ")}`);
  }

  const unexpected = names.filter(
    (name) => !ALLOWED_RELEASE_ASSETS.has(name) || (!allowChecksums && name === CHECKSUM_ASSET_NAME)
  );

  if (unexpected.length > 0) {
    throw new Error(`Unexpected release assets: ${unexpected.join(", ")}`);
  }

  for (const name of names) {
    const file = await stat(join(directory, name));
    if (!file.isFile() || file.size === 0) {
      throw new Error(`Release asset is empty or not a file: ${name}`);
    }
  }

  await verifyUpdateMetadata(join(directory, "latest.yml"), expectedVersion, [
    "Rion.Studio-win.exe"
  ]);
  await verifyUpdateMetadata(join(directory, "latest-mac.yml"), expectedVersion, [
    "Rion.Studio-mac.zip",
    "Rion.Studio-mac.dmg"
  ]);

  return names;
}

export async function writeReleaseChecksums(directory) {
  const names = (await readdir(directory))
    .filter((name) => ALLOWED_RELEASE_ASSETS.has(name) && name !== CHECKSUM_ASSET_NAME)
    .sort();
  const lines = [];

  for (const name of names) {
    lines.push(`${await sha256File(join(directory, name))}  ${name}`);
  }

  const output = `${lines.join("\n")}\n`;
  await writeFile(join(directory, CHECKSUM_ASSET_NAME), output, "utf8");
  return output;
}

async function verifyUpdateMetadata(path, expectedVersion, expectedAssetNames) {
  const source = await readFile(path, "utf8");
  const version = source.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/mu)?.[1];

  if (version !== expectedVersion) {
    throw new Error(`${basename(path)} version ${version ?? "<missing>"} does not match ${expectedVersion}`);
  }

  for (const name of expectedAssetNames) {
    if (!source.includes(`url: ${name}`)) {
      throw new Error(`${basename(path)} does not reference ${name}`);
    }
  }
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function runCli() {
  const [directoryArg, version, ...flags] = process.argv.slice(2);
  if (!directoryArg || !version) {
    throw new Error("Usage: node scripts/releaseArtifacts.mjs <directory> <version> [--write-checksums]");
  }

  const directory = resolve(directoryArg);
  const writeChecksums = flags.includes("--write-checksums");
  await verifyReleaseAssets(directory, version, { allowChecksums: writeChecksums });
  if (writeChecksums) {
    await writeReleaseChecksums(directory);
    await verifyReleaseAssets(directory, version, { allowChecksums: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
