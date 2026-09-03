import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_SNAPSHOT_KIND =
  "rion-electron-production-public-latest-snapshot";
export const ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY =
  "rion-tw/rion-studio";
export const ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES = Object.freeze([
  "Rion.Studio-mac.app.tar.gz",
  "Rion.Studio-mac.app.tar.gz.sig",
  "Rion.Studio-mac.dmg",
  "Rion.Studio-win.exe",
  "Rion.Studio-win.exe.sig",
  "SHA256SUMS.txt",
  "latest.json"
].sort(compareStrings));

const CANDIDATE_RECEIPT_NAME = "electron-production-candidate-receipt.json";
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const READ_ONLY_NO_FOLLOW = fileConstants.O_RDONLY |
  (fileConstants.O_NOFOLLOW ?? 0);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GITHUB_DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const DECIMAL_ID_PATTERN = /^[1-9]\d*$/u;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const CONTENT_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u;
const PLATFORM_CONTRACTS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  }),
  "windows-x86_64": Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    signatureName: "Rion.Studio-win.exe.sig"
  })
});

export async function createElectronProductionPublicLatestSnapshot(input) {
  const release = normalizeReleaseMetadata(input?.release);
  const assetDirectory = await requiredStableDirectory(
    input?.assetDirectory,
    "public release asset directory"
  );
  const names = (await readdir(assetDirectory.path)).sort(compareStrings);
  assertStringArrayEqual(
    names,
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
    "public release asset inventory"
  );

  const assets = [];
  const identities = new Map();
  for (const metadata of release.assets) {
    const identity = await captureStableRegularFile(
      path.join(assetDirectory.path, metadata.name),
      maximumBytesForAsset(metadata.name),
      `public release asset ${metadata.name}`
    );
    assertEqual(identity.bytes, metadata.bytes,
      `public release asset ${metadata.name} bytes`);
    assertEqual(`sha256:${identity.sha256}`, metadata.digest,
      `public release asset ${metadata.name} digest`);
    identities.set(metadata.name, identity);
    assets.push(Object.freeze({ ...metadata }));
  }
  await assertStableDirectoryUnchanged(assetDirectory);

  const latestJson = await captureLatestJsonBinding({
    assetDirectory: assetDirectory.path,
    identities,
    release
  });
  await verifyChecksumsDocument(assetDirectory.path, identities);
  const candidateReceipt = await optionalCandidateReceiptBinding({
    candidateReceiptPath: input?.candidateReceiptPath,
    candidateReceiptSha256: input?.candidateReceiptSha256,
    candidateReceiptSummary: input?.candidateReceiptSummary,
    identities,
    latestJson,
    release
  });
  await assertStableDirectoryUnchanged(assetDirectory);
  const state = {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_SNAPSHOT_KIND,
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    release: releaseSummary(release),
    assets,
    latestJson,
    candidateReceipt
  };
  return createSnapshotEnvelope(state, "observed-release");
}

export function assertElectronProductionPublicLatestSnapshot(value) {
  assertExactKeys(value, [
    "assets",
    "candidateReceipt",
    "kind",
    "latestJson",
    "observationKind",
    "release",
    "repository",
    "schemaVersion",
    "snapshotSha256",
    "stateSha256"
  ], "public latest snapshot");
  assertEqual(value.schemaVersion, 1, "public latest snapshot schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_SNAPSHOT_KIND,
    "public latest snapshot kind"
  );
  assertEqual(
    value.repository,
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    "public latest snapshot repository"
  );
  const release = assertReleaseSummary(value.release);
  const assets = assertSnapshotAssets(value.assets, release.tag);
  const latestJson = assertLatestJsonSummary(value.latestJson, release, assets);
  const candidateReceipt = value.candidateReceipt === null
    ? null
    : assertCandidateReceiptSummary(
        value.candidateReceipt,
        release,
        latestJson,
        assets
      );
  if (value.observationKind !== "observed-release" &&
      value.observationKind !== "expected-latest-projection" &&
      value.observationKind !== "expected-tauri-v22-latest-projection") {
    throw new Error("The public latest snapshot observation kind is invalid.");
  }
  if (value.observationKind === "expected-latest-projection" &&
      release.isLatest !== true) {
    throw new Error("An expected-latest projection must project latest status.");
  }
  if (value.observationKind === "expected-latest-projection" &&
      candidateReceipt === null) {
    throw new Error("An expected-latest projection must bind an Electron candidate receipt.");
  }
  if (value.observationKind === "expected-tauri-v22-latest-projection" &&
      release.isLatest !== true) {
    throw new Error("A Tauri v22 expected-latest projection must project latest status.");
  }
  if (value.observationKind === "expected-tauri-v22-latest-projection" &&
      candidateReceipt !== null) {
    throw new Error(
      "A Tauri v22 expected-latest projection must not bind an Electron candidate receipt."
    );
  }
  requiredDigest(value.stateSha256, "public latest state digest");
  requiredDigest(value.snapshotSha256, "public latest snapshot digest");
  const state = {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_SNAPSHOT_KIND,
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    release,
    assets,
    latestJson,
    candidateReceipt
  };
  assertEqual(
    value.stateSha256,
    sha256(serializeCanonicalJson(state)),
    "public latest state digest"
  );
  const normalized = {
    ...state,
    observationKind: value.observationKind,
    stateSha256: value.stateSha256
  };
  assertEqual(
    value.snapshotSha256,
    sha256(serializeCanonicalJson(normalized)),
    "public latest snapshot digest"
  );
  return deepFreeze({ ...normalized, snapshotSha256: value.snapshotSha256 });
}

export function deriveElectronProductionExpectedLatestState(stagedObserved) {
  const staged = assertElectronProductionPublicLatestSnapshot(stagedObserved);
  if (staged.observationKind !== "observed-release") {
    throw new Error("Only an observed release can be projected as expected latest state.");
  }
  if (staged.release.isLatest !== false) {
    throw new Error("The staged target release must be observed as non-latest.");
  }
  const state = snapshotState(staged);
  return createSnapshotEnvelope({
    ...state,
    release: Object.freeze({ ...state.release, isLatest: true })
  }, "expected-latest-projection");
}

export function deriveTauriV22ExpectedLatestState(stagedObserved) {
  const staged = assertElectronProductionPublicLatestSnapshot(stagedObserved);
  if (staged.observationKind !== "observed-release") {
    throw new Error("Only an observed release can be projected as Tauri v22 latest state.");
  }
  if (staged.release.isLatest !== false) {
    throw new Error("The Tauri v22 target release must be observed as non-latest.");
  }
  if (staged.candidateReceipt !== null) {
    throw new Error(
      "The Tauri v22 target release must not bind an Electron candidate receipt."
    );
  }
  const state = snapshotState(staged);
  return createSnapshotEnvelope({
    ...state,
    release: Object.freeze({ ...state.release, isLatest: true })
  }, "expected-tauri-v22-latest-projection");
}

export function assertElectronProductionRestorableSourceRelease(input) {
  const source = assertElectronProductionPublicLatestSnapshot(input?.source);
  const observed = assertElectronProductionPublicLatestSnapshot(input?.observed);
  if (source.observationKind !== "observed-release" ||
      source.release.isLatest !== true) {
    throw new Error(
      "The original source snapshot must be an observed latest release."
    );
  }
  if (source.candidateReceipt !== null) {
    throw new Error(
      "The original source snapshot must not bind an Electron candidate receipt."
    );
  }
  if (observed.observationKind !== "observed-release" ||
      observed.release.isLatest !== false) {
    throw new Error(
      "The observed baseline release-by-tag must be an observed non-latest release."
    );
  }
  if (observed.candidateReceipt !== null) {
    throw new Error(
      "The observed baseline release-by-tag must not bind an Electron candidate receipt."
    );
  }
  const observedAsLatest = {
    ...snapshotState(observed),
    release: { ...observed.release, isLatest: true }
  };
  if (!isDeepStrictEqual(snapshotState(source), observedAsLatest)) {
    throw new Error(
      "The observed baseline release-by-tag does not match the original source snapshot."
    );
  }
  return observed;
}

export function serializeElectronProductionPublicLatestSnapshot(value) {
  return serializeCanonicalJson(assertElectronProductionPublicLatestSnapshot(value));
}

export async function writeElectronProductionPublicLatestSnapshot(input) {
  const snapshot = assertElectronProductionPublicLatestSnapshot(input?.snapshot);
  const source = serializeElectronProductionPublicLatestSnapshot(snapshot);
  if (source.length <= 0 || source.length > MAX_DOCUMENT_BYTES) {
    throw new Error("The canonical public latest snapshot exceeds its size limit.");
  }
  const requestedOutputPath = requiredAbsolutePath(
    input?.outputPath,
    "public latest snapshot output path"
  );
  const outputParent = await requiredStableDirectory(
    path.dirname(requestedOutputPath),
    "public latest snapshot output parent"
  );
  const outputPath = path.join(outputParent.path, path.basename(requestedOutputPath));
  await assertPathMissing(outputPath, "public latest snapshot output");
  await assertStableDirectoryUnchanged(outputParent);

  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertStableDirectoryIdentity(outputParent);

  const reread = await readElectronProductionPublicLatestSnapshot({
    expectedFileSha256: sha256(source),
    snapshotPath: outputPath
  });
  if (!isDeepStrictEqual(reread.snapshot, snapshot)) {
    throw new Error("The public latest snapshot changed during its stable reread.");
  }
  await assertStableDirectoryIdentity(outputParent);
  return reread;
}

export async function readElectronProductionPublicLatestSnapshot(input) {
  const expectedFileSha256 = input?.expectedFileSha256 === undefined
    ? undefined
    : requiredDigest(input.expectedFileSha256, "public latest snapshot file SHA-256");
  const file = await captureStableRegularFile(
    requiredAbsolutePath(input?.snapshotPath, "public latest snapshot path"),
    MAX_DOCUMENT_BYTES,
    "public latest snapshot",
    true
  );
  if (expectedFileSha256 !== undefined) {
    assertEqual(file.sha256, expectedFileSha256,
      "public latest snapshot file SHA-256");
  }
  const parsed = parseJsonObject(file.source, "public latest snapshot");
  const snapshot = assertElectronProductionPublicLatestSnapshot(parsed);
  if (!file.source.equals(serializeElectronProductionPublicLatestSnapshot(snapshot))) {
    throw new Error("The public latest snapshot must use stable canonical JSON.");
  }
  return Object.freeze({
    file: Object.freeze({ bytes: file.bytes, sha256: file.sha256 }),
    snapshot
  });
}

export function classifyElectronProductionPublicLatestSnapshot(input) {
  const observed = assertElectronProductionPublicLatestSnapshot(input?.observed);
  const source = assertElectronProductionPublicLatestSnapshot(input?.source);
  const target = assertElectronProductionPublicLatestSnapshot(input?.target);
  if (observed.observationKind !== "observed-release" ||
      observed.release.isLatest !== true) {
    throw new Error(
      "The post-readback public latest snapshot must be an observed latest release."
    );
  }
  if (source.observationKind !== "observed-release" ||
      source.release.isLatest !== true) {
    throw new Error("The source public latest snapshot must be an observed latest release.");
  }
  if ((target.observationKind !== "expected-latest-projection" &&
       target.observationKind !== "expected-tauri-v22-latest-projection") ||
      target.release.isLatest !== true) {
    throw new Error("The target must be an expected-latest projection.");
  }
  if (snapshotStatesEqual(source, target)) {
    throw new Error("The source and target public latest snapshots must be distinct.");
  }
  if (snapshotStatesEqual(observed, source)) return "source";
  if (snapshotStatesEqual(observed, target)) return "target";
  return "foreign";
}

function createSnapshotEnvelope(state, observationKind) {
  const stateSha256 = sha256(serializeCanonicalJson(state));
  const body = { ...state, observationKind, stateSha256 };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: sha256(serializeCanonicalJson(body))
  });
}

function snapshotState(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    kind: snapshot.kind,
    repository: snapshot.repository,
    release: snapshot.release,
    assets: snapshot.assets,
    latestJson: snapshot.latestJson,
    candidateReceipt: snapshot.candidateReceipt
  };
}

function snapshotStatesEqual(left, right) {
  return left.stateSha256 === right.stateSha256 &&
    isDeepStrictEqual(snapshotState(left), snapshotState(right));
}

async function captureLatestJsonBinding(input) {
  const latestIdentity = input.identities.get("latest.json");
  const source = await readSmallAsset(
    input.assetDirectory,
    "latest.json",
    latestIdentity,
    MAX_DOCUMENT_BYTES
  );
  const manifest = parseJsonObject(source, "public release latest.json");
  const allowedManifestFields = manifest.notes === undefined
    ? ["platforms", "pub_date", "version"]
    : ["notes", "platforms", "pub_date", "version"];
  assertExactKeys(manifest, allowedManifestFields, "public release latest.json");
  const version = requiredSemanticVersion(manifest.version, "public release version");
  assertEqual(input.release.tag, `v${version}`, "public release tag and manifest version");
  const publishedAt = requiredRfc3339(
    manifest.pub_date,
    "public release manifest publication time"
  );
  if (manifest.notes !== undefined &&
      (typeof manifest.notes !== "string" || !manifest.notes.trim() || manifest.notes.includes("\0"))) {
    throw new Error("The public release manifest notes are invalid.");
  }
  assertExactKeys(
    manifest.platforms,
    Object.keys(PLATFORM_CONTRACTS),
    "public release manifest platforms"
  );
  const platforms = {};
  for (const [platform, contract] of Object.entries(PLATFORM_CONTRACTS)) {
    const entry = manifest.platforms[platform];
    assertExactKeys(entry, ["sha256", "signature", "url"],
      `public release manifest ${platform}`);
    const artifact = input.identities.get(contract.artifactName);
    const signature = input.identities.get(contract.signatureName);
    assertEqual(
      requiredDigest(entry.sha256, `public release manifest ${platform} artifact SHA-256`),
      artifact.sha256,
      `public release manifest ${platform} artifact SHA-256`
    );
    const signatureSource = await readSmallAsset(
      input.assetDirectory,
      contract.signatureName,
      signature,
      MAX_SIGNATURE_BYTES
    );
    const signatureText = signatureSource.toString("utf8").trim();
    if (!signatureText || signatureText.includes("\0")) {
      throw new Error(`The public release ${platform} signature is invalid.`);
    }
    assertEqual(entry.signature, signatureText,
      `public release manifest ${platform} signature`);
    const updaterUrl = requiredPublicHttpsUrl(
      entry.url,
      `public release manifest ${platform} URL`
    );
    assertEqual(
      decodedUrlFileName(updaterUrl, `public release manifest ${platform} URL`),
      contract.artifactName,
      `public release manifest ${platform} URL filename`
    );
    platforms[platform] = Object.freeze({
      artifactName: contract.artifactName,
      artifactSha256: artifact.sha256,
      signatureFileName: contract.signatureName,
      signatureFileSha256: signature.sha256,
      url: updaterUrl.href
    });
  }
  return Object.freeze({
    bytes: latestIdentity.bytes,
    publishedAt,
    sha256: latestIdentity.sha256,
    version,
    platforms: Object.freeze(platforms)
  });
}

async function verifyChecksumsDocument(assetDirectory, identities) {
  const checksumIdentity = identities.get("SHA256SUMS.txt");
  const source = await readSmallAsset(
    assetDirectory,
    "SHA256SUMS.txt",
    checksumIdentity,
    MAX_DOCUMENT_BYTES
  );
  const lines = source.toString("utf8").trimEnd().split("\n");
  const expectedNames = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES
    .filter((name) => name !== "SHA256SUMS.txt");
  if (lines.length !== expectedNames.length) {
    throw new Error("The public release checksum inventory is incomplete.");
  }
  const observedNames = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([^\r\n]+)$/u.exec(line);
    if (!match) throw new Error("The public release checksum document is invalid.");
    const [, digest, name] = match;
    if (!identities.has(name) || name === "SHA256SUMS.txt") {
      throw new Error(`The public release checksum entry ${name} is invalid.`);
    }
    assertEqual(digest, identities.get(name).sha256,
      `public release checksum ${name}`);
    observedNames.push(name);
  }
  assertStringArrayEqual(observedNames, expectedNames,
    "public release checksum order and inventory");
}

async function optionalCandidateReceiptBinding(input) {
  const hasPath = input.candidateReceiptPath !== undefined &&
    input.candidateReceiptPath !== null;
  const hasDigest = input.candidateReceiptSha256 !== undefined &&
    input.candidateReceiptSha256 !== null;
  const hasSummary = input.candidateReceiptSummary !== undefined &&
    input.candidateReceiptSummary !== null;
  if (hasPath !== hasDigest) {
    throw new Error(
      "The candidate receipt path and expected SHA-256 must be provided together."
    );
  }
  if (hasSummary && hasPath) {
    throw new Error(
      "The candidate receipt summary and receipt file are mutually exclusive."
    );
  }
  if (hasSummary) {
    return assertCandidateReceiptSummary(
      input.candidateReceiptSummary,
      input.release,
      input.latestJson,
      [...input.identities.entries()].map(([name, identity]) => ({
        name,
        digest: `sha256:${identity.sha256}`
      }))
    );
  }
  if (!hasPath) return null;
  const receiptPath = requiredAbsolutePath(
    input.candidateReceiptPath,
    "candidate receipt path"
  );
  if (path.basename(receiptPath) !== CANDIDATE_RECEIPT_NAME) {
    throw new Error(`The candidate receipt must be named ${CANDIDATE_RECEIPT_NAME}.`);
  }
  const expectedDigest = requiredDigest(
    input.candidateReceiptSha256,
    "candidate receipt SHA-256"
  );
  const file = await captureStableRegularFile(
    receiptPath,
    MAX_DOCUMENT_BYTES,
    "candidate receipt",
    true
  );
  assertEqual(file.sha256, expectedDigest, "candidate receipt SHA-256");
  const receipt = parseJsonObject(file.source, "candidate receipt");
  assertExactKeys(receipt, [
    "assets",
    "compatibility",
    "kind",
    "ownerGate",
    "platforms",
    "publication",
    "publicKeySha256",
    "publishedAt",
    "schemaVersion",
    "sourceSha",
    "status",
    "updaterBaseUrl",
    "updaterEndpoint",
    "updaterEndpointPolicy",
    "version"
  ], "candidate receipt");
  assertEqual(receipt.schemaVersion, 1, "candidate receipt schema version");
  assertEqual(receipt.kind, "rion-electron-production-candidate",
    "candidate receipt kind");
  assertEqual(receipt.status, "verified-not-published", "candidate receipt status");
  assertCandidateReceiptPolicy(receipt);
  const sourceSha = requiredCommitSha(receipt.sourceSha, "candidate source SHA");
  const version = requiredSemanticVersion(receipt.version, "candidate version");
  assertEqual(version, input.latestJson.version, "candidate and manifest version");
  assertEqual(input.release.tag, `v${version}`, "candidate release tag");
  const publishedAt = requiredRfc3339(receipt.publishedAt, "candidate publication time");
  assertEqual(publishedAt, input.latestJson.publishedAt,
    "candidate and manifest publication time");
  const updaterBaseUrl = normalizeUpdaterBaseUrl(receipt.updaterBaseUrl);
  const updaterEndpoint = requiredPublicHttpsUrl(
    receipt.updaterEndpoint,
    "candidate updater endpoint"
  ).href;
  assertEqual(updaterEndpoint, new URL("latest.json", updaterBaseUrl).href,
    "candidate updater endpoint");
  const publicKeySha256 = requiredDigest(
    receipt.publicKeySha256,
    "candidate public-key SHA-256"
  );
  assertExactKeys(
    receipt.assets,
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
    "candidate asset digest map"
  );
  const assets = {};
  for (const name of ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES) {
    const digest = requiredDigest(receipt.assets[name], `candidate ${name} SHA-256`);
    assertEqual(digest, input.identities.get(name).sha256,
      `candidate ${name} SHA-256`);
    assets[name] = digest;
  }
  assertCandidatePlatformBindings(receipt.platforms, input.identities);
  for (const [platform, summary] of Object.entries(input.latestJson.platforms)) {
    const contract = PLATFORM_CONTRACTS[platform];
    assertEqual(
      summary.url,
      new URL(encodeURIComponent(contract.artifactName), updaterBaseUrl).href,
      `candidate ${platform} updater URL`
    );
  }
  return Object.freeze({
    assets: Object.freeze(assets),
    bytes: file.bytes,
    fileName: CANDIDATE_RECEIPT_NAME,
    publicKeySha256,
    sha256: file.sha256,
    sourceSha,
    updaterBaseUrl,
    updaterEndpoint,
    version
  });
}

function assertCandidatePlatformBindings(platforms, identities) {
  assertExactKeys(platforms, Object.keys(PLATFORM_CONTRACTS),
    "candidate platform map");
  for (const [platform, contract] of Object.entries(PLATFORM_CONTRACTS)) {
    assertExactKeys(
      platforms[platform],
      platform === "darwin-aarch64"
        ? ["artifact", "distribution"]
        : ["artifact"],
      `candidate ${platform} platform`
    );
    const artifact = requiredRecord(platforms[platform]?.artifact,
      `candidate ${platform} artifact`);
    assertExactKeys(artifact, [
      "bytes",
      "fileName",
      "sha256",
      "signatureBytes",
      "signatureFileName",
      "signatureSha256"
    ], `candidate ${platform} artifact`);
    const artifactIdentity = identities.get(contract.artifactName);
    const signatureIdentity = identities.get(contract.signatureName);
    for (const [actual, expected, label] of [
      [artifact.fileName, contract.artifactName, "artifact name"],
      [artifact.bytes, artifactIdentity.bytes, "artifact bytes"],
      [artifact.sha256, artifactIdentity.sha256, "artifact SHA-256"],
      [artifact.signatureFileName, contract.signatureName, "signature name"],
      [artifact.signatureBytes, signatureIdentity.bytes, "signature bytes"],
      [artifact.signatureSha256, signatureIdentity.sha256, "signature SHA-256"]
    ]) assertEqual(actual, expected, `candidate ${platform} ${label}`);
  }
  const distribution = requiredRecord(
    platforms["darwin-aarch64"]?.distribution,
    "candidate macOS distribution"
  );
  assertExactKeys(distribution, ["bytes", "fileName", "sha256"],
    "candidate macOS distribution");
  const dmg = identities.get("Rion.Studio-mac.dmg");
  assertEqual(distribution.fileName, "Rion.Studio-mac.dmg",
    "candidate macOS distribution name");
  assertEqual(distribution.bytes, dmg.bytes, "candidate macOS distribution bytes");
  assertEqual(distribution.sha256, dmg.sha256,
    "candidate macOS distribution SHA-256");
}

function assertCandidateReceiptPolicy(receipt) {
  assertExactKeys(receipt.publication, ["allowedByThisWorkflow", "status"],
    "candidate publication policy");
  assertEqual(receipt.publication.allowedByThisWorkflow, false,
    "candidate publication permission");
  assertEqual(receipt.publication.status, "candidate-only",
    "candidate publication status");
  assertExactKeys(receipt.ownerGate, ["approval", "environment"],
    "candidate owner gate");
  assertEqual(receipt.ownerGate.approval, "BUILD ELECTRON PRODUCTION CANDIDATE",
    "candidate owner approval");
  assertEqual(receipt.ownerGate.environment, "electron-production-release",
    "candidate owner environment");
  assertExactKeys(receipt.updaterEndpointPolicy, ["redirects", "requiredStatus"],
    "candidate updater endpoint policy");
  assertEqual(receipt.updaterEndpointPolicy.redirects, "forbidden",
    "candidate updater redirect policy");
  assertEqual(receipt.updaterEndpointPolicy.requiredStatus, 200,
    "candidate updater status policy");
  assertExactKeys(receipt.compatibility, [
    "stableTauriReleasePath",
    "tauriV22CutoverEvidence"
  ], "candidate compatibility policy");
  assertEqual(receipt.compatibility.stableTauriReleasePath, "preserved",
    "candidate stable Tauri release path");
  assertEqual(receipt.compatibility.tauriV22CutoverEvidence,
    "separate-required-gate", "candidate Tauri v22 cutover evidence");
}

function normalizeReleaseMetadata(value) {
  assertExactKeys(value, [
    "assets",
    "draft",
    "id",
    "isLatest",
    "prerelease",
    "repository",
    "tag",
    "targetCommitish"
  ], "public release metadata");
  assertEqual(value.repository, ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    "public release repository");
  const id = requiredDecimalId(value.id, "public release ID");
  const tag = requiredReleaseTag(value.tag);
  const targetCommitish = requiredCommitSha(
    value.targetCommitish,
    "public release target commit"
  );
  if (typeof value.isLatest !== "boolean") {
    throw new Error("The public release latest status must be boolean.");
  }
  assertEqual(value.draft, false, "public release draft status");
  assertEqual(value.prerelease, false, "public release prerelease status");
  if (!Array.isArray(value.assets)) {
    throw new Error("The public release assets must be an array.");
  }
  const ids = new Set();
  const names = new Set();
  const urls = new Set();
  const assets = value.assets.map((asset) => {
    assertExactKeys(asset, ["bytes", "contentType", "digest", "id", "name", "url"],
      "public release asset metadata");
    const assetId = requiredDecimalId(asset.id, "public release asset ID");
    const name = requiredAssetName(asset.name);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
        asset.bytes > maximumBytesForAsset(name)) {
      throw new Error(`The public release asset ${name} byte length is invalid.`);
    }
    const digest = requiredGithubDigest(asset.digest, `public release asset ${name} digest`);
    const url = requiredGithubReleaseAssetUrl(asset.url, tag, name);
    if (typeof asset.contentType !== "string" ||
        !CONTENT_TYPE_PATTERN.test(asset.contentType)) {
      throw new Error(`The public release asset ${name} content type is invalid.`);
    }
    rejectDuplicate(ids, assetId, "public release asset ID");
    rejectDuplicate(names, name, "public release asset name");
    rejectDuplicate(urls, url, "public release asset URL");
    return Object.freeze({
      bytes: asset.bytes,
      contentType: asset.contentType,
      digest,
      id: assetId,
      name,
      url
    });
  }).sort((left, right) => compareStrings(left.name, right.name));
  assertStringArrayEqual(
    assets.map((asset) => asset.name),
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
    "public release metadata asset inventory"
  );
  return Object.freeze({
    assets: Object.freeze(assets),
    draft: false,
    id,
    isLatest: value.isLatest,
    prerelease: false,
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    tag,
    targetCommitish
  });
}

function assertReleaseSummary(value) {
  assertExactKeys(value, [
    "draft", "id", "isLatest", "prerelease", "tag", "targetCommitish"
  ], "public latest snapshot release");
  const id = requiredDecimalId(value.id, "public latest snapshot release ID");
  const tag = requiredReleaseTag(value.tag);
  const targetCommitish = requiredCommitSha(
    value.targetCommitish,
    "public latest snapshot release target commit"
  );
  if (typeof value.isLatest !== "boolean") {
    throw new Error("The public latest snapshot release latest status is invalid.");
  }
  assertEqual(value.draft, false, "public latest snapshot release draft status");
  assertEqual(value.prerelease, false,
    "public latest snapshot release prerelease status");
  return Object.freeze({
    draft: false,
    id,
    isLatest: value.isLatest,
    prerelease: false,
    tag,
    targetCommitish
  });
}

function assertSnapshotAssets(value, releaseTag) {
  if (!Array.isArray(value)) {
    throw new Error("The public latest snapshot assets must be an array.");
  }
  const ids = new Set();
  const names = new Set();
  const urls = new Set();
  const assets = value.map((asset) => {
    assertExactKeys(asset, ["bytes", "contentType", "digest", "id", "name", "url"],
      "public latest snapshot asset");
    const id = requiredDecimalId(asset.id, "public latest snapshot asset ID");
    const name = requiredAssetName(asset.name);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
        asset.bytes > maximumBytesForAsset(name)) {
      throw new Error(`The public latest snapshot asset ${name} bytes are invalid.`);
    }
    const digest = requiredGithubDigest(asset.digest,
      `public latest snapshot asset ${name} digest`);
    const url = requiredGithubReleaseAssetUrl(asset.url, releaseTag, name);
    if (typeof asset.contentType !== "string" ||
        !CONTENT_TYPE_PATTERN.test(asset.contentType)) {
      throw new Error(`The public latest snapshot asset ${name} content type is invalid.`);
    }
    rejectDuplicate(ids, id, "public latest snapshot asset ID");
    rejectDuplicate(names, name, "public latest snapshot asset name");
    rejectDuplicate(urls, url, "public latest snapshot asset URL");
    return Object.freeze({
      bytes: asset.bytes,
      contentType: asset.contentType,
      digest,
      id,
      name,
      url
    });
  });
  assertStringArrayEqual(
    assets.map((asset) => asset.name),
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
    "public latest snapshot sorted asset inventory"
  );
  return Object.freeze(assets);
}

function assertLatestJsonSummary(value, release, assets) {
  assertExactKeys(value, ["bytes", "platforms", "publishedAt", "sha256", "version"],
    "public latest snapshot latest.json");
  const latestAsset = assetByName(assets, "latest.json");
  assertPositiveInteger(value.bytes, "public latest snapshot latest.json bytes");
  assertEqual(value.bytes, latestAsset.bytes, "public latest snapshot latest.json bytes");
  const digest = requiredDigest(value.sha256,
    "public latest snapshot latest.json SHA-256");
  assertEqual(`sha256:${digest}`, latestAsset.digest,
    "public latest snapshot latest.json SHA-256");
  const version = requiredSemanticVersion(value.version,
    "public latest snapshot version");
  assertEqual(release.tag, `v${version}`, "public latest snapshot release tag");
  const publishedAt = requiredRfc3339(
    value.publishedAt,
    "public latest snapshot publication time"
  );
  assertExactKeys(value.platforms, Object.keys(PLATFORM_CONTRACTS),
    "public latest snapshot manifest platforms");
  const platforms = {};
  for (const [platform, contract] of Object.entries(PLATFORM_CONTRACTS)) {
    const summary = value.platforms[platform];
    assertExactKeys(summary, [
      "artifactName",
      "artifactSha256",
      "signatureFileName",
      "signatureFileSha256",
      "url"
    ], `public latest snapshot ${platform}`);
    assertEqual(summary.artifactName, contract.artifactName,
      `public latest snapshot ${platform} artifact name`);
    assertEqual(summary.signatureFileName, contract.signatureName,
      `public latest snapshot ${platform} signature name`);
    const artifactSha256 = requiredDigest(summary.artifactSha256,
      `public latest snapshot ${platform} artifact SHA-256`);
    const signatureFileSha256 = requiredDigest(summary.signatureFileSha256,
      `public latest snapshot ${platform} signature SHA-256`);
    assertEqual(`sha256:${artifactSha256}`,
      assetByName(assets, contract.artifactName).digest,
      `public latest snapshot ${platform} artifact binding`);
    assertEqual(`sha256:${signatureFileSha256}`,
      assetByName(assets, contract.signatureName).digest,
      `public latest snapshot ${platform} signature binding`);
    const url = requiredPublicHttpsUrl(summary.url,
      `public latest snapshot ${platform} URL`);
    assertEqual(decodedUrlFileName(url, `public latest snapshot ${platform} URL`),
      contract.artifactName,
      `public latest snapshot ${platform} URL filename`);
    platforms[platform] = Object.freeze({
      artifactName: contract.artifactName,
      artifactSha256,
      signatureFileName: contract.signatureName,
      signatureFileSha256,
      url: url.href
    });
  }
  return Object.freeze({
    bytes: value.bytes,
    platforms: Object.freeze(platforms),
    publishedAt,
    sha256: digest,
    version
  });
}

function assertCandidateReceiptSummary(value, release, latestJson, assets) {
  assertExactKeys(value, [
    "assets",
    "bytes",
    "fileName",
    "publicKeySha256",
    "sha256",
    "sourceSha",
    "updaterBaseUrl",
    "updaterEndpoint",
    "version"
  ], "public latest snapshot candidate receipt");
  assertEqual(value.fileName, CANDIDATE_RECEIPT_NAME,
    "public latest snapshot candidate receipt name");
  assertPositiveInteger(value.bytes, "public latest snapshot candidate receipt bytes");
  const digest = requiredDigest(value.sha256,
    "public latest snapshot candidate receipt SHA-256");
  const sourceSha = requiredCommitSha(value.sourceSha,
    "public latest snapshot candidate source SHA");
  const publicKeySha256 = requiredDigest(value.publicKeySha256,
    "public latest snapshot candidate public-key SHA-256");
  const version = requiredSemanticVersion(value.version,
    "public latest snapshot candidate version");
  assertEqual(version, latestJson.version,
    "public latest snapshot candidate and manifest version");
  assertEqual(release.tag, `v${version}`,
    "public latest snapshot candidate release tag");
  const updaterBaseUrl = normalizeUpdaterBaseUrl(value.updaterBaseUrl);
  const updaterEndpoint = requiredPublicHttpsUrl(
    value.updaterEndpoint,
    "public latest snapshot candidate updater endpoint"
  ).href;
  assertEqual(updaterEndpoint, new URL("latest.json", updaterBaseUrl).href,
    "public latest snapshot candidate updater endpoint");
  assertExactKeys(value.assets, ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
    "public latest snapshot candidate asset map");
  const assetDigests = {};
  for (const asset of assets) {
    const candidateDigest = requiredDigest(
      value.assets[asset.name],
      `public latest snapshot candidate ${asset.name} SHA-256`
    );
    assertEqual(`sha256:${candidateDigest}`, asset.digest,
      `public latest snapshot candidate ${asset.name} binding`);
    assetDigests[asset.name] = candidateDigest;
  }
  for (const [platform, summary] of Object.entries(latestJson.platforms)) {
    const contract = PLATFORM_CONTRACTS[platform];
    assertEqual(
      summary.url,
      new URL(encodeURIComponent(contract.artifactName), updaterBaseUrl).href,
      `public latest snapshot candidate ${platform} updater URL`
    );
  }
  return Object.freeze({
    assets: Object.freeze(assetDigests),
    bytes: value.bytes,
    fileName: CANDIDATE_RECEIPT_NAME,
    publicKeySha256,
    sha256: digest,
    sourceSha,
    updaterBaseUrl,
    updaterEndpoint,
    version
  });
}

async function requiredStableDirectory(value, label) {
  const requestedPath = requiredAbsolutePath(value, label);
  const requested = await lstat(requestedPath, { bigint: true });
  if (!requested.isDirectory() || requested.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const canonicalPath = await realpath(requestedPath);
  const canonical = await lstat(canonicalPath, { bigint: true });
  assertSameFilesystemObject(requested, canonical, label);
  return Object.freeze({ metadata: canonical, path: canonicalPath, label });
}

async function assertStableDirectoryUnchanged(directory) {
  const observed = await lstat(directory.path, { bigint: true });
  assertSameFilesystemObject(directory.metadata, observed, directory.label);
}

async function assertStableDirectoryIdentity(directory) {
  const observed = await lstat(directory.path, { bigint: true });
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      directory.metadata.dev !== observed.dev ||
      directory.metadata.ino !== observed.ino) {
    throw new Error(`The ${directory.label} identity changed while it was used.`);
  }
}

async function assertPathMissing(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`The ${label} must be create-new.`);
}

async function captureStableRegularFile(filePath, maximumBytes, label, captureSource = false) {
  const before = await lstat(filePath, { bigint: true });
  assertBoundedRegularFile(before, maximumBytes, label);
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameFilesystemObject(before, opened, label);
    assertBoundedRegularFile(opened, maximumBytes, label);
    const digest = createHash("sha256");
    const chunks = captureSource ? [] : undefined;
    let observedBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      observedBytes += chunk.length;
      if (observedBytes > maximumBytes) {
        throw new Error(`The ${label} exceeded its maximum size while it was read.`);
      }
      digest.update(chunk);
      if (chunks) chunks.push(Buffer.from(chunk));
    }
    const completed = await handle.stat({ bigint: true });
    assertSameFilesystemObject(opened, completed, label);
    const pathAfter = await lstat(filePath, { bigint: true });
    assertSameFilesystemObject(completed, pathAfter, label);
    return Object.freeze({
      bytes: Number(completed.size),
      sha256: digest.digest("hex"),
      ...(chunks ? { source: Buffer.concat(chunks) } : {})
    });
  } finally {
    await handle.close();
  }
}

async function readSmallAsset(assetDirectory, name, expected, maximumBytes) {
  const captured = await captureStableRegularFile(
    path.join(assetDirectory, name),
    maximumBytes,
    `public release asset ${name}`,
    true
  );
  assertEqual(captured.bytes, expected.bytes, `public release asset ${name} bytes`);
  assertEqual(captured.sha256, expected.sha256,
    `public release asset ${name} SHA-256`);
  return captured.source;
}

function assertBoundedRegularFile(metadata, maximumBytes, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.size <= 0n || metadata.size > BigInt(maximumBytes)) {
    throw new Error(
      `The ${label} must be a bounded, nonempty, single-link regular file.`
    );
  }
}

function assertSameFilesystemObject(expected, observed, label) {
  if (expected.dev !== observed.dev || expected.ino !== observed.ino ||
      expected.mode !== observed.mode || expected.nlink !== observed.nlink ||
      expected.size !== observed.size || expected.mtimeNs !== observed.mtimeNs ||
      expected.ctimeNs !== observed.ctimeNs) {
    throw new Error(`The ${label} changed while it was verified.`);
  }
}

function releaseSummary(release) {
  return Object.freeze({
    draft: false,
    id: release.id,
    isLatest: release.isLatest,
    prerelease: false,
    tag: release.tag,
    targetCommitish: release.targetCommitish
  });
}

function requiredGithubReleaseAssetUrl(value, tag, name) {
  const url = requiredPublicHttpsUrl(value, `public release asset ${name} URL`);
  assertEqual(url.origin, "https://github.com",
    `public release asset ${name} URL origin`);
  const expectedPath = `/${ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY}/releases/download/` +
    `${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  assertEqual(url.pathname, expectedPath, `public release asset ${name} URL path`);
  return url.href;
}

function requiredPublicHttpsUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`The ${label} is invalid.`, { cause: error });
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || /%2f|%5c/iu.test(url.pathname)) {
    throw new Error(
      `The ${label} must use public HTTPS without credentials, query, fragment, or encoded separators.`
    );
  }
  return url;
}

function decodedUrlFileName(url, label) {
  try {
    return decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
  } catch (error) {
    throw new Error(`The ${label} filename is invalid.`, { cause: error });
  }
}

function normalizeUpdaterBaseUrl(value) {
  const url = requiredPublicHttpsUrl(value, "candidate updater base URL");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function maximumBytesForAsset(name) {
  if (name.endsWith(".sig")) return MAX_SIGNATURE_BYTES;
  if (name === "latest.json" || name === "SHA256SUMS.txt") {
    return MAX_DOCUMENT_BYTES;
  }
  return MAX_ARTIFACT_BYTES;
}

function requiredAssetName(value) {
  if (typeof value !== "string" ||
      !ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.includes(value)) {
    throw new Error(`The public release asset name ${JSON.stringify(value)} is invalid.`);
  }
  return value;
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`The ${label} must be absolute.`);
  }
  return path.resolve(value);
}

function requiredDecimalId(value, label) {
  if (typeof value !== "string" || !DECIMAL_ID_PATTERN.test(value)) {
    throw new Error(`The ${label} must be a positive decimal string.`);
  }
  return value;
}

function requiredCommitSha(value, label) {
  if (typeof value !== "string" || !COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`The ${label} must be a lowercase 40-character commit SHA.`);
  }
  return value;
}

function requiredReleaseTag(value) {
  if (typeof value !== "string" || !value.startsWith("v") ||
      !isSupportedStrictSemanticVersion(value.slice(1))) {
    throw new Error("The public release tag is invalid.");
  }
  return value;
}

function requiredSemanticVersion(value, label) {
  if (typeof value !== "string" || !isSupportedStrictSemanticVersion(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function isSupportedStrictSemanticVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match) return false;
  return !(match[4]?.split(".").some((part) =>
    /^\d+$/u.test(part) && part.startsWith("0") && part.length > 1
  ));
}

function requiredRfc3339(value, label) {
  if (typeof value !== "string" || !isStrictRfc3339Timestamp(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function isStrictRfc3339Timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  const monthLengths = [
    31,
    isGregorianLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day >= 1 && day <= monthLengths[month - 1];
}

function isGregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`The ${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requiredGithubDigest(value, label) {
  if (typeof value !== "string" || !GITHUB_DIGEST_PATTERN.test(value)) {
    throw new Error(`The ${label} must be a sha256-prefixed lowercase digest.`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
}

function requiredRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  requiredRecord(value, label);
  const actual = Object.keys(value).sort(compareStrings);
  const expected = [...expectedKeys].sort(compareStrings);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} has an unexpected schema.`);
  }
}

function assertStringArrayEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, [...expected])) {
    throw new Error(`The ${label} must be exactly ${expected.join(", ")}.`);
  }
}

function rejectDuplicate(seen, value, label) {
  if (seen.has(value)) throw new Error(`The ${label} ${value} is duplicated.`);
  seen.add(value);
}

function assetByName(assets, name) {
  const asset = assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`The public latest snapshot is missing ${name}.`);
  return asset;
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is invalid JSON.`, { cause: error });
  }
  return requiredRecord(value, label);
}

function assertEqual(actual, expected, label) {
  if (!Object.is(actual, expected)) {
    throw new Error(`The ${label} does not match its verified input.`);
  }
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
