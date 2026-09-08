import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { normalizeUpdaterPublicKey, verifyMinisignArtifact } from "./electronProductionCandidate.mjs";
import { packageElectron } from "./packageElectron.mjs";
import { isSupportedStrictSemanticVersion } from "./releaseVersionPolicy.mjs";
import { sanitizeUpdaterRuntimeEnvironment } from "./runtimeEnvironmentPolicy.mjs";
import { signUpdaterArtifact } from "./updaterSignerEnvironment.mjs";
import { verifyPackagedElectron } from "./verifyElectronPackage.mjs";

export function electronReleaseInputs({ platform, environment, version }) {
  if (!new Set(["darwin", "win32"]).has(platform)) {
    throw new Error(`Electron releases do not support ${platform}.`);
  }
  if (!isSupportedStrictSemanticVersion(version)) {
    throw new Error("Electron releases require a semantic version.");
  }
  for (const name of [
    "RION_STUDIO_UPDATER_PUBLIC_KEY",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
  ]) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required.`);
  }
  normalizeUpdaterPublicKey(environment.RION_STUDIO_UPDATER_PUBLIC_KEY);
  const endpoint = environment.RION_STUDIO_UPDATER_ENDPOINT?.trim()
    || "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json";
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The updater endpoint must be HTTPS without credentials, query or fragment.");
  }
  return {
    artifactName: platform === "darwin" ? "Rion.Studio-mac.app.tar.gz" : "Rion.Studio-win.exe",
    endpoint,
    version
  };
}

export async function buildElectronRelease({
  platform = process.platform,
  environment = process.env
} = {}) {
  const root = path.resolve(import.meta.dirname, "..");
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const input = electronReleaseInputs({ platform, environment, version: metadata.version });
  const artifactPath = path.join(root, "release/electron", input.artifactName);
  await packageElectron({
    platform,
    environment: {
      ...sanitizeUpdaterRuntimeEnvironment(environment),
      RION_STUDIO_UPDATER_ENDPOINT: input.endpoint,
      RION_STUDIO_UPDATER_PUBLIC_KEY: environment.RION_STUDIO_UPDATER_PUBLIC_KEY,
      RION_STUDIO_ELECTRON_PACKAGE_VERSION: input.version
    }
  });
  await access(artifactPath);
  await verifyPackagedElectron(path.join(root, "release/electron",
    platform === "darwin" ? "mac-arm64/Rion Studio.app" : "win-unpacked"));
  await signUpdaterArtifact({ artifactPath, environment, workingDirectory: root });
  await verifyMinisignArtifact(
    artifactPath,
    `${artifactPath}.sig`,
    environment.RION_STUDIO_UPDATER_PUBLIC_KEY
  );
  console.log(`Verified updater-signed Electron release artifact: ${artifactPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((argument) => argument !== "--")) {
    throw new Error("Usage: pnpm run dist");
  }
  await buildElectronRelease();
}
