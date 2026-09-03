import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { normalizeUpdaterPublicKey } from "./electronProductionCandidate.mjs";

const RELEASE_REPOSITORY = "rion-tw/rion-studio";
const WORKFLOW_REPOSITORY = "rion-tw/rion-studio-source";
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PLATFORM_ASSETS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifact: "Rion.Studio-mac.app.tar.gz",
    signature: "Rion.Studio-mac.app.tar.gz.sig"
  }),
  "windows-x86_64": Object.freeze({
    artifact: "Rion.Studio-win.exe",
    signature: "Rion.Studio-win.exe.sig"
  })
});

export async function verifyTauriV22UpdaterInput(
  argumentsList,
  environment = process.env
) {
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true") {
    throw new Error("The Tauri v22 updater input gate is restricted to GitHub CI.");
  }
  if (environment.GITHUB_REPOSITORY !== WORKFLOW_REPOSITORY) {
    throw new Error(`The Tauri v22 input gate must run from ${WORKFLOW_REPOSITORY}.`);
  }
  const options = parseArguments(argumentsList);
  const directory = requiredAbsolutePath(options.get("directory"), "--directory");
  const output = requiredAbsolutePath(options.get("output"), "--output");
  const platform = requiredPlatform(options.get("platform"));
  const version = requiredSemanticVersion(options.get("version"), "--version");
  const releaseTag = requiredReleaseTag(options.get("release-tag"));
  const sourceSha = requiredCommitSha(options.get("source-sha"), "--source-sha");
  const targetSha = requiredCommitSha(options.get("target-sha"), "--target-sha");
  const updaterTrust = requiredUpdaterPublicKey(
    environment.RION_STUDIO_UPDATER_PUBLIC_KEY
  );
  const expectedSha256 = requiredSha256(
    options.get("expected-sha256"),
    "--expected-sha256"
  );
  const names = PLATFORM_ASSETS[platform];
  const artifactPath = join(directory, names.artifact);
  const signaturePath = join(directory, names.signature);
  const manifestPath = join(directory, "latest.json");
  const checksumPath = join(directory, "SHA256SUMS.txt");
  const [artifact, signature] = await Promise.all([
    regularFile(artifactPath, MAX_ARTIFACT_BYTES),
    regularFile(signaturePath, 64 * 1024),
    regularFile(manifestPath, MAX_MANIFEST_BYTES),
    regularFile(checksumPath, MAX_MANIFEST_BYTES)
  ]);
  if (artifact.size === 0 || signature.size === 0) {
    throw new Error("The Tauri v22 updater artifact or signature is empty.");
  }
  const actualSha256 = await hashFile(artifactPath);
  if (actualSha256 !== expectedSha256) {
    throw new Error("The Tauri v22 artifact does not match its externally pinned SHA-256.");
  }
  const checksums = parseChecksums(await readFile(checksumPath, "utf8"));
  if (checksums.get(names.artifact) !== expectedSha256) {
    throw new Error("The Tauri v22 release checksum does not match the pinned artifact.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const platformArtifact = manifest?.platforms?.[platform];
  const publishedSignature = (await readFile(signaturePath, "utf8")).trim();
  if (
    manifest?.version !== version ||
    typeof manifest.pub_date !== "string" ||
    Number.isNaN(Date.parse(manifest.pub_date)) ||
    typeof platformArtifact?.url !== "string" ||
    platformArtifact.sha256 !== expectedSha256 ||
    platformArtifact.signature?.trim() !== publishedSignature
  ) {
    throw new Error("The Tauri v22 manifest does not bind the exact signed artifact input.");
  }
  assertArtifactUrl(platformArtifact.url, names.artifact, releaseTag);
  const [signatureSha256, manifestSha256, checksumSha256] = await Promise.all([
    hashFile(signaturePath),
    hashFile(manifestPath),
    hashFile(checksumPath)
  ]);
  const receipt = {
    schemaVersion: 2,
    evidenceKind: "tauri-v22-published-input",
    runtime: "tauri-v22",
    repository: RELEASE_REPOSITORY,
    releaseTag,
    releaseVersion: version,
    sourceSha,
    targetSha,
    updaterPublicKeySha256: updaterTrust.sha256,
    platform,
    artifactName: names.artifact,
    artifactBytes: artifact.size,
    artifactSha256: actualSha256,
    signatureName: names.signature,
    signatureSha256,
    manifestName: basename(manifestPath),
    manifestSha256,
    checksumName: basename(checksumPath),
    checksumSha256
  };
  await writeFile(output, serializeCanonicalJson(receipt), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  const githubEnvironment = requiredAbsolutePath(environment.GITHUB_ENV, "GITHUB_ENV");
  await appendFile(githubEnvironment, [
    `RION_TAURI_V22_ARTIFACT=${artifactPath}`,
    `RION_TAURI_V22_MANIFEST=${manifestPath}`,
    `RION_TAURI_V22_PLATFORM=${platform}`,
    `RION_TAURI_V22_INPUT_RECEIPT=${output}`,
    `RION_TAURI_V22_SOURCE_SHA=${sourceSha}`,
    `RION_TAURI_V22_VERSION=${version}`,
    `RION_ELECTRON_TARGET_SHA=${targetSha}`,
    `RION_UPDATER_PRODUCTION_PUBLIC_KEY_SHA256=${receipt.updaterPublicKeySha256}`,
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  return receipt;
}

async function regularFile(path, maximumBytes) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`Expected a bounded regular release file: ${path}`);
  }
  return metadata;
}

function parseChecksums(document) {
  const entries = new Map();
  for (const line of document.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/u.exec(line);
    if (!match || entries.has(match[2])) {
      throw new Error("The Tauri v22 checksum document is malformed or duplicated.");
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

function assertArtifactUrl(value, artifactName, releaseTag) {
  const url = new URL(value);
  const releasePaths = new Set([
    `/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(releaseTag)}/${artifactName}`
  ]);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !releasePaths.has(url.pathname)
  ) {
    throw new Error("The Tauri v22 manifest artifact URL has the wrong immutable source.");
  }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid Tauri v22 input option near ${option ?? "<end>"}.`);
    }
    const name = option.slice(2);
    if (values.has(name)) throw new Error(`Duplicate Tauri v22 input option --${name}.`);
    values.set(name, value);
  }
  return values;
}

function requiredAbsolutePath(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function requiredPlatform(value) {
  if (value !== "darwin-aarch64" && value !== "windows-x86_64") {
    throw new Error("--platform must name one exact updater platform.");
  }
  return value;
}

function requiredSemanticVersion(value, name) {
  if (!value || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error(`${name} must be a semantic version.`);
  }
  return value;
}

function requiredReleaseTag(value) {
  if (!value || !/^v?[0-9][0-9A-Za-z._-]{0,63}$/u.test(value)) {
    throw new Error("--release-tag must be one bounded release tag.");
  }
  return value;
}

function requiredSha256(value, name) {
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 value.`);
  }
  return value;
}

function requiredCommitSha(value, name) {
  if (!value || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase 40-character commit SHA.`);
  }
  return value;
}

function requiredUpdaterPublicKey(value) {
  try {
    return normalizeUpdaterPublicKey(value);
  } catch {
    throw new Error(
      "RION_STUDIO_UPDATER_PUBLIC_KEY must contain one valid Minisign public key."
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--") argumentsList.shift();
  const receipt = await verifyTauriV22UpdaterInput(argumentsList);
  console.log(
    `Verified ${receipt.platform} Tauri v22 input ${receipt.releaseTag} at ${receipt.sourceSha}.`
  );
}
