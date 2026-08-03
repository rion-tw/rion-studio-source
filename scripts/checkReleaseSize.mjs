import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const RELEASE_SIZE_BASELINE_VERSION = "v3.18.1";
export const REQUIRED_RELEASE_SIZE_REDUCTION_PERCENT = 10;
export const RELEASE_SIZE_BASELINES = Object.freeze({
  "Rion.Studio-mac.app.tar.gz": 14_153_681,
  "Rion.Studio-mac.dmg": 15_273_570,
  "Rion.Studio-win.exe": 10_119_820
});
export const RELEASE_SIZE_TOLERANCES = Object.freeze({
  "Rion.Studio-mac.dmg": 32 * 1024
});
export const RELEASE_SIZE_LIMITS = Object.freeze(Object.fromEntries(
  Object.entries(RELEASE_SIZE_BASELINES).map(([name, baselineBytes]) => [
    name,
    Math.floor(baselineBytes * (1 - REQUIRED_RELEASE_SIZE_REDUCTION_PERCENT / 100))
      + (RELEASE_SIZE_TOLERANCES[name] ?? 0)
  ])
));

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
    const baselineBytes = RELEASE_SIZE_BASELINES[name];
    const maximumBytes = RELEASE_SIZE_LIMITS[name];
    const toleranceBytes = RELEASE_SIZE_TOLERANCES[name] ?? 0;
    if (details.size > maximumBytes) {
      const toleranceDescription = toleranceBytes > 0
        ? ` within a ${toleranceBytes}-byte packaging tolerance`
        : "";
      throw new Error(
        `${name} is ${details.size} bytes; it must be at most ${maximumBytes} bytes ` +
        `to remain${toleranceDescription} of ${REQUIRED_RELEASE_SIZE_REDUCTION_PERCENT}% smaller than ` +
        `${RELEASE_SIZE_BASELINE_VERSION} (${baselineBytes} bytes).`
      );
    }
    return {
      baselineBytes,
      maximumBytes,
      name,
      reductionPercent: ((baselineBytes - details.size) / baselineBytes) * 100,
      sizeBytes: details.size,
      toleranceBytes
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
      `(${result.reductionPercent.toFixed(2)}% below ${RELEASE_SIZE_BASELINE_VERSION}; ` +
      `limit ${formatMiB(result.maximumBytes)} MiB` +
      `${result.toleranceBytes > 0 ? ` including ${result.toleranceBytes}-byte packaging tolerance` : ""})\n`
    );
  }
}

function formatMiB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runCli();
}
