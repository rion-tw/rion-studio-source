import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const RELEASE_SIZE_LIMITS = Object.freeze({
  "Rion.Studio-mac.app.tar.gz": 16 * 1024 * 1024,
  "Rion.Studio-mac.dmg": 18 * 1024 * 1024,
  "Rion.Studio-win.exe": 12 * 1024 * 1024
});

const MAC_ARTIFACTS = ["Rion.Studio-mac.app.tar.gz", "Rion.Studio-mac.dmg"];
const WINDOWS_ARTIFACTS = ["Rion.Studio-win.exe"];

export async function verifyReleaseSizeBudget(directory) {
  const artifactDirectory = resolve(directory);
  const names = new Set(await readdir(artifactDirectory));
  const hasMacArtifact = MAC_ARTIFACTS.some((name) => names.has(name));
  const hasWindowsArtifact = WINDOWS_ARTIFACTS.some((name) => names.has(name));

  if (hasMacArtifact && hasWindowsArtifact) {
    throw new Error("Release size verification requires one platform candidate at a time.");
  }
  const requiredArtifacts = hasMacArtifact
    ? MAC_ARTIFACTS
    : hasWindowsArtifact
      ? WINDOWS_ARTIFACTS
      : [];
  if (requiredArtifacts.length === 0) {
    throw new Error("Release size verification found no normalized release artifacts.");
  }

  const missingArtifacts = requiredArtifacts.filter((name) => !names.has(name));
  if (missingArtifacts.length > 0) {
    throw new Error(`Release size verification is missing: ${missingArtifacts.join(", ")}`);
  }

  return Promise.all(requiredArtifacts.map(async (name) => {
    const details = await stat(join(artifactDirectory, name));
    if (!details.isFile() || details.size === 0) {
      throw new Error(`${name} must be a non-empty file.`);
    }
    const maximumBytes = RELEASE_SIZE_LIMITS[name];
    if (details.size > maximumBytes) {
      throw new Error(
        `${name} is ${details.size} bytes; it must be at most ${maximumBytes} bytes.`
      );
    }
    return {
      maximumBytes,
      name,
      sizeBytes: details.size
    };
  }));
}

async function runCli() {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--") arguments_.shift();
  const [directory, ...unexpectedArguments] = arguments_;
  if (!directory) {
    throw new Error("Usage: node scripts/checkReleaseSize.mjs <artifact-directory>");
  }
  if (unexpectedArguments.length > 0) {
    throw new Error("Release size verification accepts exactly one artifact directory.");
  }
  const results = await verifyReleaseSizeBudget(directory);
  for (const result of results) {
    process.stdout.write(
      `${result.name}: ${formatMiB(result.sizeBytes)} MiB ` +
      `(limit ${formatMiB(result.maximumBytes)} MiB)\n`
    );
  }
}

function formatMiB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runCli();
}
