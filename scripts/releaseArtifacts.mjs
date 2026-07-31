import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_RELEASE_ASSETS = [
  "Rion.Studio-mac.dmg",
  "Rion.Studio-mac.app.tar.gz",
  "Rion.Studio-mac.app.tar.gz.sig",
  "Rion.Studio-win.exe",
  "Rion.Studio-win.exe.sig",
  "latest.json"
];

export const CHECKSUM_ASSET_NAME = "SHA256SUMS.txt";
const ALLOWED_RELEASE_ASSETS = new Set([...REQUIRED_RELEASE_ASSETS, CHECKSUM_ASSET_NAME]);

export async function verifyReleaseAssets(directory, expectedVersion, options = {}) {
  const { allowChecksums = false } = options;
  const names = (await readdir(directory)).sort();
  const missing = REQUIRED_RELEASE_ASSETS.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`Missing required release assets: ${missing.join(", ")}`);

  const unexpected = names.filter(
    (name) => !ALLOWED_RELEASE_ASSETS.has(name) || (!allowChecksums && name === CHECKSUM_ASSET_NAME)
  );
  if (unexpected.length > 0) throw new Error(`Unexpected release assets: ${unexpected.join(", ")}`);

  for (const name of names) {
    const file = await stat(join(directory, name));
    if (!file.isFile() || file.size === 0) throw new Error(`Release asset is empty or not a file: ${name}`);
  }

  await verifyTauriManifest(join(directory, "latest.json"), expectedVersion);
  if (allowChecksums) await verifyReleaseChecksums(directory);
  return names;
}

export async function writeReleaseChecksums(directory) {
  const output = await releaseChecksumDocument(directory);
  await writeFile(join(directory, CHECKSUM_ASSET_NAME), output, "utf8");
  return output;
}

export async function verifyReleaseChecksums(directory) {
  const expected = await releaseChecksumDocument(directory);
  const actual = await readFile(join(directory, CHECKSUM_ASSET_NAME), "utf8");
  if (actual !== expected) throw new Error(`${CHECKSUM_ASSET_NAME} does not match the release assets.`);
}

async function releaseChecksumDocument(directory) {
  const names = (await readdir(directory))
    .filter((name) => ALLOWED_RELEASE_ASSETS.has(name) && name !== CHECKSUM_ASSET_NAME)
    .sort();
  const lines = [];
  for (const name of names) lines.push(`${await hashFile(join(directory, name), "sha256", "hex")}  ${name}`);
  return `${lines.join("\n")}\n`;
}

async function verifyTauriManifest(path, expectedVersion) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (manifest.version !== expectedVersion) {
    throw new Error(`${basename(path)} version ${manifest.version ?? "<missing>"} does not match ${expectedVersion}`);
  }
  for (const [platform, name] of [
    ["darwin-aarch64", "Rion.Studio-mac.app.tar.gz"],
    ["windows-x86_64", "Rion.Studio-win.exe"]
  ]) {
    const artifact = manifest.platforms?.[platform];
    if (!artifact?.url?.endsWith(`/${name}`) || typeof artifact.signature !== "string" || !artifact.signature.trim()) {
      throw new Error(`${basename(path)} has an invalid ${platform} signed artifact.`);
    }
  }
}

function hashFile(path, algorithm, encoding) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash(algorithm);
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest(encoding)));
  });
}

async function runCli() {
  const [directoryArg, version, ...flags] = process.argv.slice(2);
  if (!directoryArg || !version) {
    throw new Error("Usage: node scripts/releaseArtifacts.mjs <directory> <version> [--write-checksums|--verify-checksums]");
  }
  const directory = resolve(directoryArg);
  const writeChecksums = flags.includes("--write-checksums");
  const verifyChecksums = flags.includes("--verify-checksums");
  if (writeChecksums && verifyChecksums) {
    throw new Error("Choose either --write-checksums or --verify-checksums.");
  }
  await verifyReleaseAssets(directory, version, { allowChecksums: verifyChecksums });
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
