import { sha256File } from "./releaseFileHash.mjs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertElectronPublicReleaseAssets,
  assertStableTauriV22PublicReleaseAssets,
  identifyPublicReleaseRuntime
} from "./publicReleaseRuntimePolicy.mjs";

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
const UPDATER_PLATFORM_ASSETS = [
  ["darwin-aarch64", "Rion.Studio-mac.app.tar.gz", "Rion.Studio-mac.app.tar.gz.sig"],
  ["windows-x86_64", "Rion.Studio-win.exe", "Rion.Studio-win.exe.sig"]
];

export async function verifyReleaseAssets(directory, expectedVersion, options = {}) {
  const {
    allowChecksums = false,
    allowLegacyManifestWithoutDigests = false
  } = options;
  if (allowLegacyManifestWithoutDigests && !allowChecksums) {
    throw new Error(
      "Legacy updater manifests require a verified checksum document."
    );
  }
  const names = (await readdir(directory)).sort();
  const missing = REQUIRED_RELEASE_ASSETS.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`Missing required release assets: ${missing.join(", ")}`);

  const unexpected = names.filter(
    (name) => !ALLOWED_RELEASE_ASSETS.has(name) || (!allowChecksums && name === CHECKSUM_ASSET_NAME)
  );
  if (unexpected.length > 0) throw new Error(`Unexpected release assets: ${unexpected.join(", ")}`);

  for (const name of names) {
    const file = await lstat(join(directory, name));
    if (!file.isFile() || file.isSymbolicLink() || file.size === 0) {
      throw new Error(`Release asset is empty or not a file: ${name}`);
    }
  }

  const checksumEntries = allowChecksums
    ? await readReleaseChecksumEntries(directory)
    : undefined;
  await verifyUpdaterManifest(
    join(directory, "latest.json"),
    expectedVersion,
    directory,
    checksumEntries,
    allowLegacyManifestWithoutDigests
  );
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
  for (const name of names) lines.push(`${await sha256File(join(directory, name))}  ${name}`);
  return `${lines.join("\n")}\n`;
}

async function verifyUpdaterManifest(
  manifestPath,
  expectedVersion,
  directory,
  checksumEntries,
  allowLegacyManifestWithoutDigests
) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${basename(manifestPath)} version ${manifest.version ?? "<missing>"} does not match ${expectedVersion}`
    );
  }
  if (
    typeof manifest.pub_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(manifest.pub_date) ||
    Number.isNaN(Date.parse(manifest.pub_date))
  ) {
    throw new Error(`${basename(manifestPath)} has an invalid pub_date.`);
  }
  const expectedPlatforms = UPDATER_PLATFORM_ASSETS.map(([platform]) => platform).sort();
  const actualPlatforms = Object.keys(manifest.platforms ?? {}).sort();
  if (JSON.stringify(actualPlatforms) !== JSON.stringify(expectedPlatforms)) {
    throw new Error(
      `${basename(manifestPath)} platforms must be exactly ${expectedPlatforms.join(", ")}.`
    );
  }
  const digestEntryCount = UPDATER_PLATFORM_ASSETS.filter(([platform]) =>
    Object.hasOwn(manifest.platforms[platform], "sha256")
  ).length;
  if (digestEntryCount !== 0 && digestEntryCount !== UPDATER_PLATFORM_ASSETS.length) {
    throw new Error(`${basename(manifestPath)} has an inconsistent sha256 schema.`);
  }
  const manifestIncludesDigests = digestEntryCount !== 0;
  if (!manifestIncludesDigests && !allowLegacyManifestWithoutDigests) {
    throw new Error(`${basename(manifestPath)} has an invalid darwin-aarch64 sha256.`);
  }
  for (const [platform, name, signatureName] of UPDATER_PLATFORM_ASSETS) {
    const artifact = manifest.platforms?.[platform];
    if (
      !artifact ||
      typeof artifact.url !== "string" ||
      typeof artifact.signature !== "string" ||
      !artifact.signature.trim()
    ) {
      throw new Error(`${basename(manifestPath)} has an invalid ${platform} signed artifact.`);
    }
    assertUpdaterArtifactUrl(artifact.url, name, manifestPath, platform);
    const publishedSignature = (await readFile(join(directory, signatureName), "utf8")).trim();
    if (artifact.signature.trim() !== publishedSignature) {
      throw new Error(
        `${basename(manifestPath)} ${platform} signature does not match ${signatureName}.`
      );
    }
    const payloadSha256 = await sha256File(join(directory, name));
    if (manifestIncludesDigests) {
      if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
        throw new Error(`${basename(manifestPath)} has an invalid ${platform} sha256.`);
      }
      if (artifact.sha256 !== payloadSha256) {
        throw new Error(`${basename(manifestPath)} ${platform} sha256 does not match ${name}.`);
      }
    }
    if (checksumEntries && checksumEntries.get(name) !== payloadSha256) {
      throw new Error(
        `${basename(manifestPath)} ${platform} sha256 does not match ${CHECKSUM_ASSET_NAME}.`
      );
    }
  }
}

function assertUpdaterArtifactUrl(value, name, manifestPath, platform) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${basename(manifestPath)} has an invalid ${platform} artifact URL.`);
  }
  let urlName;
  try {
    urlName = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
  } catch {
    throw new Error(`${basename(manifestPath)} has an invalid ${platform} artifact URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    urlName !== name
  ) {
    throw new Error(`${basename(manifestPath)} has an invalid ${platform} artifact URL.`);
  }
}

async function readReleaseChecksumEntries(directory) {
  const document = await readFile(join(directory, CHECKSUM_ASSET_NAME), "utf8");
  const entries = new Map();
  for (const line of document.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match || entries.has(match[2])) {
      throw new Error(`${CHECKSUM_ASSET_NAME} has an invalid or duplicate entry.`);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}


async function runCli() {
  const [directoryArg, version, ...flags] = process.argv.slice(2);
  if (!directoryArg || !version) {
    throw new Error(
      "Usage: node scripts/releaseArtifacts.mjs <directory> <version> " +
      "[--write-checksums|--verify-checksums] [--require-electron|--require-supported-source|--require-tauri-v22]"
    );
  }
  const directory = resolve(directoryArg);
  const writeChecksums = flags.includes("--write-checksums");
  const verifyChecksums = flags.includes("--verify-checksums");
  const requireTauriV22 = flags.includes("--require-tauri-v22");
  const requireElectron = flags.includes("--require-electron");
  const requireSupportedSource = flags.includes("--require-supported-source");
  const unknownFlags = flags.filter(
    (flag) => !["--write-checksums", "--verify-checksums", "--require-tauri-v22",
      "--require-electron", "--require-supported-source"].includes(flag)
  );
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown release artifact flags: ${unknownFlags.join(", ")}`);
  }
  if (writeChecksums && verifyChecksums) {
    throw new Error("Choose either --write-checksums or --verify-checksums.");
  }
  if ([requireTauriV22, requireElectron, requireSupportedSource].filter(Boolean).length > 1) {
    throw new Error("Choose exactly one release runtime policy.");
  }
  await verifyReleaseAssets(directory, version, {
    allowChecksums: verifyChecksums,
    allowLegacyManifestWithoutDigests: requireSupportedSource
  });
  if (requireTauriV22) await assertStableTauriV22PublicReleaseAssets(directory);
  if (requireElectron) await assertElectronPublicReleaseAssets(directory);
  if (requireSupportedSource) {
    const sourceRuntime = await identifyPublicReleaseRuntime(directory);
    if (sourceRuntime === "electron-v23") {
      await verifyReleaseAssets(directory, version, {
        allowChecksums: verifyChecksums
      });
    }
    console.log(`Verified source runtime: ${sourceRuntime}`);
  }
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
