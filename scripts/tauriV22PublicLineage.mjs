import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";

export const TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME =
  "tauri-v22-public-lineage-receipt.json";
export const TAURI_V22_PUBLIC_LINEAGE_KIND =
  "rion-tauri-v22-public-source-lineage";
export const TAURI_V22_COMPATIBILITY_WORKFLOW =
  ".github/workflows/electron-updater-tauri-v22-compatibility.yml";

const SOURCE_REPOSITORY = "rion-tw/rion-studio-source";
const RELEASE_REPOSITORY = "rion-tw/rion-studio";
const VERIFIED_INPUT_RECEIPT_NAME = "verified-input-receipt.json";
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const PLATFORM_CONTRACTS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    derivation: "macos-exact-archive-member",
    executableName: "rion-tauri",
    executableRelativePath: "Rion Studio.app/Contents/MacOS/rion-tauri",
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  }),
  "windows-x86_64": Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    derivation: "windows-isolated-current-user-nsis-install",
    executableName: "rion-tauri.exe",
    executableRelativePath: "rion-tauri.exe",
    signatureName: "Rion.Studio-win.exe.sig"
  })
});
const MANIFEST_PLATFORM_ASSETS = Object.freeze({
  "darwin-aarch64": "Rion.Studio-mac.app.tar.gz",
  "windows-x86_64": "Rion.Studio-win.exe"
});

export async function createTauriV22PublicLineage(input) {
  const outputPath = await resolveCreateNewOutputPath(input.outputPath);
  const assetDirectory = await requiredDirectory(input.assetDirectory, "public asset directory");
  assertPathOutside(outputPath, assetDirectory, "public asset directory");
  const receipt = await buildExpectedReceipt({ ...input, assetDirectory });
  await writeFile(outputPath, serializeCanonicalJson(receipt), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  return Object.freeze(receipt);
}

export async function verifyTauriV22PublicLineage(input) {
  const receipt = await readTauriV22PublicLineageReceipt(input);
  const expected = await buildExpectedReceipt(input);
  assertDeepExact(receipt, expected, "public-lineage receipt");
  return Object.freeze(receipt);
}

export async function readTauriV22PublicLineageReceipt(input) {
  const expectedDigest = requiredDigest(
    input.expectedReceiptSha256,
    "public-lineage receipt SHA-256"
  );
  const receiptPath = requiredReceiptPath(input.receiptPath);
  const receiptFile = await fileIdentity(
    receiptPath,
    MAX_JSON_BYTES,
    "public-lineage receipt",
    true
  );
  assertEqual(receiptFile.sha256, expectedDigest, "public-lineage receipt SHA-256");
  const receipt = parseCanonicalJsonObject(
    receiptFile.source,
    "public-lineage receipt"
  );
  assertLineageReceipt(receipt);
  return Object.freeze(receipt);
}

export function assertTauriV22PublicLineagePair(input) {
  assertExactKeys(input, ["macos", "windows"], "public-lineage pair");
  const macos = input.macos;
  const windows = input.windows;
  assertLineageReceipt(macos);
  assertLineageReceipt(windows);
  assertEqual(macos.platform, "darwin-aarch64", "macOS public-lineage platform");
  assertEqual(windows.platform, "windows-x86_64", "Windows public-lineage platform");
  const macRelease = { ...macos.release };
  const windowsRelease = { ...windows.release };
  delete macRelease.observedAt;
  delete windowsRelease.observedAt;
  const macSourceTag = { ...macos.sourceTag };
  const windowsSourceTag = { ...windows.sourceTag };
  delete macSourceTag.observedAt;
  delete windowsSourceTag.observedAt;
  for (const [field, left, right] of [
    ["release", macRelease, windowsRelease],
    ["source tag", macSourceTag, windowsSourceTag],
    ["target source SHA", macos.targetSourceSha, windows.targetSourceSha],
    ["updater trust", macos.trust, windows.trust],
    ["manifest asset", macos.assets.manifest, windows.assets.manifest],
    ["checksum asset", macos.assets.checksums, windows.assets.checksums]
  ]) {
    assertDeepExact(left, right, `cross-platform ${field}`);
  }
  const macProducer = { ...macos.producer };
  const windowsProducer = { ...windows.producer };
  delete macProducer.artifactName;
  delete windowsProducer.artifactName;
  delete macProducer.producedAt;
  delete windowsProducer.producedAt;
  assertDeepExact(macProducer, windowsProducer, "cross-platform producer");
  return Object.freeze({ macos, windows });
}

async function buildExpectedReceipt(input) {
  assertExactKeys(input.runningExecutable, ["derivation", "path"], "running executable input");
  const assetDirectory = await requiredDirectory(input.assetDirectory, "public asset directory");
  const inputReceiptPath = resolveRequiredPath(
    input.verifiedInputReceiptPath, "verified input receipt"
  );
  if (basename(inputReceiptPath) !== VERIFIED_INPUT_RECEIPT_NAME) {
    throw new Error(`The verified input receipt must be named ${VERIFIED_INPUT_RECEIPT_NAME}.`);
  }
  const canonicalInputReceiptPath = await canonicalRegularFilePath(
    inputReceiptPath,
    "verified input receipt"
  );
  await assertExactAssetInventory(assetDirectory, canonicalInputReceiptPath);
  const inputReceiptFile = await fileIdentity(
    inputReceiptPath,
    MAX_JSON_BYTES,
    "verified input receipt",
    true
  );
  const inputReceipt = parseCanonicalJsonObject(
    inputReceiptFile.source,
    "verified input receipt"
  );
  const platform = assertVerifiedInputReceipt(inputReceipt);
  const contract = PLATFORM_CONTRACTS[platform];
  const publicRelease = assertPublicReleaseMetadata(input.publicRelease, inputReceipt, contract);
  const sourceTag = assertSourceTagMetadata(input.sourceTag, inputReceipt);
  const producer = assertProducer(input.producer, inputReceipt, publicRelease, sourceTag);
  const paths = Object.freeze({
    artifact: join(assetDirectory, contract.artifactName),
    signature: join(assetDirectory, contract.signatureName),
    manifest: join(assetDirectory, "latest.json"),
    checksums: join(assetDirectory, "SHA256SUMS.txt")
  });
  const [artifact, signature, manifest, checksums, runningExecutable] = await Promise.all([
    fileIdentity(paths.artifact, MAX_ARTIFACT_BYTES, "published updater artifact"),
    fileIdentity(paths.signature, MAX_SIGNATURE_BYTES, "published updater signature", true),
    fileIdentity(paths.manifest, MAX_JSON_BYTES, "published updater manifest", true),
    fileIdentity(paths.checksums, MAX_JSON_BYTES, "published release checksums", true),
    runningExecutableIdentity(input.runningExecutable, platform, contract)
  ]);
  const identities = { artifact, signature, manifest, checksums };
  assertDownloadedAssets(identities, inputReceipt, publicRelease.assets);
  assertManifest(
    manifest.source,
    inputReceipt.releaseVersion,
    inputReceipt.releaseTag,
    platform,
    artifact.sha256,
    signature.source
  );
  assertChecksums(checksums.source, {
    [contract.artifactName]: artifact.sha256,
    [contract.signatureName]: signature.sha256,
    "latest.json": manifest.sha256
  });
  return {
    schemaVersion: 1,
    kind: TAURI_V22_PUBLIC_LINEAGE_KIND,
    status: "verified-public-source-lineage",
    cutoverEligible: false,
    runtime: "tauri-v22",
    platform,
    release: {
      repository: publicRelease.repository,
      id: publicRelease.id,
      tag: publicRelease.tagName,
      version: publicRelease.version,
      draft: false,
      prerelease: false,
      wasLatestAtCapture: true,
      publishedAt: publicRelease.publishedAt,
      observedAt: publicRelease.observedAt
    },
    sourceTag: {
      repository: sourceTag.repository,
      releaseTag: sourceTag.releaseTag,
      refObjectType: sourceTag.refObjectType,
      refObjectSha: sourceTag.refObjectSha,
      peeledCommitSha: sourceTag.peeledCommitSha,
      observedAt: sourceTag.observedAt
    },
    targetSourceSha: inputReceipt.targetSha,
    trust: {
      updaterPublicKeySha256: inputReceipt.updaterPublicKeySha256
    },
    verifiedInputReceipt: {
      fileName: VERIFIED_INPUT_RECEIPT_NAME,
      sha256: inputReceiptFile.sha256
    },
    assets: receiptAssets(publicRelease.assets, identities),
    runningExecutable: {
      derivation: contract.derivation,
      relativePath: contract.executableRelativePath,
      fileName: contract.executableName,
      bytes: runningExecutable.bytes,
      sha256: runningExecutable.sha256,
      derivedFromArtifactSha256: artifact.sha256
    },
    producer,
    verifiedAt: producer.producedAt
  };
}

function assertVerifiedInputReceipt(receipt) {
  assertExactKeys(receipt, [
    "artifactBytes",
    "artifactName",
    "artifactSha256",
    "checksumName",
    "checksumSha256",
    "evidenceKind",
    "manifestName",
    "manifestSha256",
    "platform",
    "releaseTag",
    "releaseVersion",
    "repository",
    "runtime",
    "schemaVersion",
    "signatureName",
    "signatureSha256",
    "sourceSha",
    "targetSha",
    "updaterPublicKeySha256"
  ], "verified input receipt");
  assertEqual(receipt.schemaVersion, 2, "verified input receipt schema version");
  assertEqual(receipt.evidenceKind, "tauri-v22-published-input", "verified input evidence kind");
  assertEqual(receipt.runtime, "tauri-v22", "verified input runtime");
  assertEqual(receipt.repository, RELEASE_REPOSITORY, "verified input repository");
  const platform = requiredPlatform(receipt.platform);
  const contract = PLATFORM_CONTRACTS[platform];
  const version = requiredSemanticVersion(receipt.releaseVersion, "verified input version");
  assertEqual(receipt.releaseTag, `v${version}`, "verified input release tag");
  requiredCommitSha(receipt.sourceSha, "verified input source SHA");
  requiredCommitSha(receipt.targetSha, "verified input target SHA");
  requiredDigest(receipt.updaterPublicKeySha256, "verified input updater public-key SHA-256");
  assertEqual(receipt.artifactName, contract.artifactName, "verified input artifact name");
  assertEqual(receipt.signatureName, contract.signatureName, "verified input signature name");
  assertEqual(receipt.manifestName, "latest.json", "verified input manifest name");
  assertEqual(receipt.checksumName, "SHA256SUMS.txt", "verified input checksum name");
  requiredPositiveInteger(receipt.artifactBytes, "verified input artifact bytes");
  for (const field of [
    "artifactSha256",
    "signatureSha256",
    "manifestSha256",
    "checksumSha256"
  ]) requiredDigest(receipt[field], `verified input ${field}`);
  return platform;
}

function assertPublicReleaseMetadata(value, receipt, contract) {
  assertExactKeys(value, [
    "assets",
    "draft",
    "id",
    "observedAt",
    "prerelease",
    "publishedAt",
    "repository",
    "tagName",
    "version",
    "wasLatestAtCapture"
  ], "public release metadata");
  assertEqual(value.repository, RELEASE_REPOSITORY, "public release repository");
  requiredDecimalId(value.id, "public release ID");
  assertEqual(value.draft, false, "public release draft status");
  assertEqual(value.prerelease, false, "public release prerelease status");
  assertEqual(value.wasLatestAtCapture, true, "public release latest-at-capture status");
  const version = requiredSemanticVersion(value.version, "public release version");
  assertEqual(version, receipt.releaseVersion, "public release version");
  assertEqual(value.tagName, receipt.releaseTag, "public release tag");
  const publishedAt = requiredRfc3339(value.publishedAt, "public release publication time");
  const observedAt = requiredRfc3339(value.observedAt, "public release observation time");
  if (observedAt < publishedAt) {
    throw new Error("The public release cannot be observed before it was published.");
  }
  assertExactKeys(value.assets, ["artifact", "checksums", "manifest", "signature"],
    "public release selected assets");
  const expectedNames = {
    artifact: contract.artifactName,
    signature: contract.signatureName,
    manifest: "latest.json",
    checksums: "SHA256SUMS.txt"
  };
  const ids = new Set();
  for (const [role, name] of Object.entries(expectedNames)) {
    const asset = value.assets[role];
    assertExactKeys(asset, ["bytes", "id", "name"], `public release ${role} asset`);
    requiredDecimalId(asset.id, `public release ${role} asset ID`);
    requiredPositiveInteger(asset.bytes, `public release ${role} asset bytes`);
    assertEqual(asset.name, name, `public release ${role} asset name`);
    if (ids.has(asset.id)) throw new Error("Public release asset IDs must be distinct.");
    ids.add(asset.id);
  }
  return value;
}

function assertSourceTagMetadata(value, receipt) {
  assertExactKeys(value, [
    "observedAt",
    "peeledCommitSha",
    "refObjectSha",
    "refObjectType",
    "releaseTag",
    "repository"
  ], "source tag metadata");
  assertEqual(value.repository, SOURCE_REPOSITORY, "source tag repository");
  assertEqual(value.releaseTag, receipt.releaseTag, "source tag release tag");
  if (value.refObjectType !== "commit" && value.refObjectType !== "tag") {
    throw new Error("The source tag object type must be commit or tag.");
  }
  requiredCommitSha(value.refObjectSha, "source tag ref-object SHA");
  const peeled = requiredCommitSha(value.peeledCommitSha, "source tag peeled commit SHA");
  assertEqual(peeled, receipt.sourceSha, "source tag peeled commit SHA");
  if (value.refObjectType === "commit") {
    assertEqual(value.refObjectSha, peeled, "lightweight source tag commit SHA");
  }
  requiredRfc3339(value.observedAt, "source tag observation time");
  return value;
}

function assertProducer(value, receipt, publicRelease, sourceTag) {
  assertExactKeys(value, [
    "artifactName",
    "event",
    "headSha",
    "producedAt",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "lineage producer");
  assertEqual(value.repository, SOURCE_REPOSITORY, "lineage producer repository");
  assertEqual(value.workflow, TAURI_V22_COMPATIBILITY_WORKFLOW, "lineage producer workflow");
  assertEqual(value.event, "workflow_dispatch", "lineage producer event");
  const runId = requiredDecimalId(value.runId, "lineage producer run ID");
  const runAttempt = requiredPositiveInteger(value.runAttempt, "lineage producer run attempt");
  assertEqual(value.headSha, receipt.targetSha, "lineage producer head SHA");
  const producedAt = requiredRfc3339(value.producedAt, "lineage producer production time");
  if (
    producedAt < requiredRfc3339(publicRelease.observedAt, "public release observation time") ||
    producedAt < requiredRfc3339(sourceTag.observedAt, "source tag observation time")
  ) throw new Error("The lineage receipt cannot be produced before its observations.");
  assertEqual(
    value.artifactName,
    `tauri-v22-public-lineage-${receipt.platform}-${runId}-${runAttempt}`,
    "lineage producer artifact name"
  );
  return { ...value };
}

async function runningExecutableIdentity(value, platform, contract) {
  assertEqual(value.derivation, contract.derivation, "running executable derivation");
  const filePath = resolveRequiredPath(value.path, "running executable path");
  assertEqual(basename(filePath), contract.executableName, "running executable name");
  if (platform === "darwin-aarch64") {
    const expectedSuffix = `${sep}${contract.executableRelativePath.split("/").join(sep)}`;
    if (!filePath.endsWith(expectedSuffix)) {
      throw new Error(
        `The macOS running executable path must end with ${contract.executableRelativePath}.`
      );
    }
  }
  return fileIdentity(filePath, MAX_EXECUTABLE_BYTES, "running executable");
}

function assertDownloadedAssets(identities, receipt, assets) {
  const receiptDigests = {
    artifact: receipt.artifactSha256,
    signature: receipt.signatureSha256,
    manifest: receipt.manifestSha256,
    checksums: receipt.checksumSha256
  };
  for (const role of Object.keys(receiptDigests)) {
    assertEqual(identities[role].bytes, assets[role].bytes, `${role} public asset bytes`);
    assertEqual(identities[role].sha256, receiptDigests[role], `${role} verified-input SHA-256`);
  }
  assertEqual(identities.artifact.bytes, receipt.artifactBytes, "verified-input artifact bytes");
}

function receiptAssets(metadata, identities) {
  const result = {};
  for (const role of ["artifact", "signature", "manifest", "checksums"]) {
    result[role] = {
      id: metadata[role].id,
      name: metadata[role].name,
      bytes: identities[role].bytes,
      sha256: identities[role].sha256
    };
  }
  return result;
}

function assertManifest(source, version, releaseTag, platform, artifactSha256, signatureSource) {
  const manifest = parseJsonObject(source, "published updater manifest");
  const expectedKeys = Object.hasOwn(manifest, "notes")
    ? ["notes", "platforms", "pub_date", "version"]
    : ["platforms", "pub_date", "version"];
  assertExactKeys(manifest, expectedKeys, "published updater manifest");
  if (Object.hasOwn(manifest, "notes")) requiredString(manifest.notes, "updater manifest notes");
  assertEqual(manifest.version, version, "updater manifest version");
  requiredRfc3339(manifest.pub_date, "updater manifest publication time");
  assertExactKeys(manifest.platforms, Object.keys(MANIFEST_PLATFORM_ASSETS),
    "updater manifest platforms");
  for (const [name, artifactName] of Object.entries(MANIFEST_PLATFORM_ASSETS)) {
    const entry = manifest.platforms[name];
    assertExactKeys(entry, ["sha256", "signature", "url"], `${name} updater manifest entry`);
    requiredDigest(entry.sha256, `${name} updater manifest SHA-256`);
    requiredString(entry.signature, `${name} updater manifest signature`);
    assertReleaseArtifactUrl(entry.url, releaseTag, artifactName, name);
  }
  const selected = manifest.platforms[platform];
  assertEqual(selected.sha256, artifactSha256, "selected updater manifest artifact SHA-256");
  assertEqual(
    selected.signature.trim(),
    signatureSource.toString("utf8").trim(),
    "selected updater manifest signature"
  );
}

function assertReleaseArtifactUrl(value, releaseTag, artifactName, platform) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The ${platform} updater artifact URL is invalid.`);
  }
  const expectedPath = `/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(releaseTag)}/${artifactName}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== expectedPath
  ) {
    throw new Error(`The ${platform} updater artifact URL does not bind the tagged public release.`);
  }
}

function assertChecksums(source, expected) {
  const document = source.toString("utf8");
  if (!document.endsWith("\n")) throw new Error("The public checksum document must end with a newline.");
  const entries = new Map();
  for (const line of document.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/u.exec(line);
    if (!match || entries.has(match[2])) {
      throw new Error("The public checksum document is malformed or duplicated.");
    }
    entries.set(match[2], match[1]);
  }
  for (const [name, digest] of Object.entries(expected)) {
    assertEqual(entries.get(name), digest, `public checksum for ${name}`);
  }
}

function assertLineageReceipt(receipt) {
  assertExactKeys(receipt, [
    "assets",
    "cutoverEligible",
    "kind",
    "platform",
    "producer",
    "release",
    "runningExecutable",
    "runtime",
    "schemaVersion",
    "sourceTag",
    "status",
    "targetSourceSha",
    "trust",
    "verifiedAt",
    "verifiedInputReceipt"
  ], "public-lineage receipt");
  assertExactKeys(receipt.release, [
    "draft", "id", "observedAt", "prerelease", "publishedAt", "repository", "tag",
    "version", "wasLatestAtCapture"
  ], "public-lineage release");
  assertExactKeys(receipt.sourceTag, [
    "observedAt", "peeledCommitSha", "refObjectSha", "refObjectType", "releaseTag", "repository"
  ], "public-lineage source tag");
  assertExactKeys(receipt.trust, ["updaterPublicKeySha256"], "public-lineage trust");
  assertExactKeys(receipt.verifiedInputReceipt, ["fileName", "sha256"],
    "public-lineage verified input receipt");
  assertExactKeys(receipt.assets, ["artifact", "checksums", "manifest", "signature"],
    "public-lineage assets");
  for (const role of Object.keys(receipt.assets)) {
    assertExactKeys(receipt.assets[role], ["bytes", "id", "name", "sha256"],
      `public-lineage ${role} asset`);
  }
  assertExactKeys(receipt.runningExecutable, [
    "bytes", "derivation", "derivedFromArtifactSha256", "fileName", "relativePath", "sha256"
  ], "public-lineage running executable");
  assertExactKeys(receipt.producer, [
    "artifactName", "event", "headSha", "producedAt", "repository", "runAttempt", "runId",
    "workflow"
  ], "public-lineage producer");
  assertEqual(receipt.schemaVersion, 1, "public-lineage schema version");
  assertEqual(receipt.kind, TAURI_V22_PUBLIC_LINEAGE_KIND, "public-lineage kind");
  assertEqual(receipt.status, "verified-public-source-lineage", "public-lineage status");
  assertEqual(receipt.cutoverEligible, false, "public-lineage cutover eligibility");
  assertEqual(receipt.runtime, "tauri-v22", "public-lineage runtime");
  const platform = requiredPlatform(receipt.platform);
  const contract = PLATFORM_CONTRACTS[platform];
  assertEqual(receipt.release.repository, RELEASE_REPOSITORY, "public-lineage release repository");
  requiredDecimalId(receipt.release.id, "public-lineage release ID");
  const version = requiredSemanticVersion(receipt.release.version, "public-lineage release version");
  assertEqual(receipt.release.tag, `v${version}`, "public-lineage release tag");
  assertEqual(receipt.release.draft, false, "public-lineage release draft status");
  assertEqual(receipt.release.prerelease, false, "public-lineage release prerelease status");
  assertEqual(receipt.release.wasLatestAtCapture, true,
    "public-lineage latest-at-capture status");
  const publishedAt = requiredRfc3339(receipt.release.publishedAt,
    "public-lineage release publication time");
  const observedAt = requiredRfc3339(receipt.release.observedAt,
    "public-lineage release observation time");
  if (observedAt < publishedAt) {
    throw new Error("The public-lineage release cannot be observed before it was published.");
  }
  assertEqual(receipt.sourceTag.repository, SOURCE_REPOSITORY,
    "public-lineage source tag repository");
  assertEqual(receipt.sourceTag.releaseTag, receipt.release.tag,
    "public-lineage source tag release tag");
  if (receipt.sourceTag.refObjectType !== "commit" && receipt.sourceTag.refObjectType !== "tag") {
    throw new Error("The public-lineage source tag object type must be commit or tag.");
  }
  const refObjectSha = requiredCommitSha(receipt.sourceTag.refObjectSha,
    "public-lineage source tag ref-object SHA");
  const peeledCommitSha = requiredCommitSha(receipt.sourceTag.peeledCommitSha,
    "public-lineage source tag peeled commit SHA");
  if (receipt.sourceTag.refObjectType === "commit") {
    assertEqual(refObjectSha, peeledCommitSha, "public-lineage lightweight source tag SHA");
  }
  requiredRfc3339(receipt.sourceTag.observedAt, "public-lineage source tag observation time");
  const targetSourceSha = requiredCommitSha(receipt.targetSourceSha,
    "public-lineage target source SHA");
  requiredDigest(receipt.trust.updaterPublicKeySha256,
    "public-lineage updater public-key SHA-256");
  assertEqual(receipt.verifiedInputReceipt.fileName, VERIFIED_INPUT_RECEIPT_NAME,
    "public-lineage verified input receipt name");
  requiredDigest(receipt.verifiedInputReceipt.sha256,
    "public-lineage verified input receipt SHA-256");
  const expectedNames = {
    artifact: contract.artifactName,
    signature: contract.signatureName,
    manifest: "latest.json",
    checksums: "SHA256SUMS.txt"
  };
  const assetIds = new Set();
  for (const [role, name] of Object.entries(expectedNames)) {
    const asset = receipt.assets[role];
    requiredDecimalId(asset.id, `public-lineage ${role} asset ID`);
    if (assetIds.has(asset.id)) throw new Error("Public-lineage asset IDs must be distinct.");
    assetIds.add(asset.id);
    assertEqual(asset.name, name, `public-lineage ${role} asset name`);
    requiredPositiveInteger(asset.bytes, `public-lineage ${role} asset bytes`);
    requiredDigest(asset.sha256, `public-lineage ${role} asset SHA-256`);
  }
  assertEqual(receipt.runningExecutable.derivation, contract.derivation,
    "public-lineage running executable derivation");
  assertEqual(receipt.runningExecutable.relativePath, contract.executableRelativePath,
    "public-lineage running executable relative path");
  assertEqual(receipt.runningExecutable.fileName, contract.executableName,
    "public-lineage running executable name");
  requiredPositiveInteger(receipt.runningExecutable.bytes,
    "public-lineage running executable bytes");
  requiredDigest(receipt.runningExecutable.sha256,
    "public-lineage running executable SHA-256");
  assertEqual(receipt.runningExecutable.derivedFromArtifactSha256,
    receipt.assets.artifact.sha256, "public-lineage running executable artifact binding");
  assertEqual(receipt.producer.repository, SOURCE_REPOSITORY,
    "public-lineage producer repository");
  assertEqual(receipt.producer.workflow, TAURI_V22_COMPATIBILITY_WORKFLOW,
    "public-lineage producer workflow");
  assertEqual(receipt.producer.event, "workflow_dispatch", "public-lineage producer event");
  const producedAt = requiredRfc3339(receipt.producer.producedAt,
    "public-lineage producer production time");
  const sourceObservedAt = requiredRfc3339(receipt.sourceTag.observedAt,
    "public-lineage source tag observation time");
  if (producedAt < observedAt || producedAt < sourceObservedAt) {
    throw new Error("The public-lineage receipt cannot be produced before its observations.");
  }
  const runId = requiredDecimalId(receipt.producer.runId, "public-lineage producer run ID");
  const runAttempt = requiredPositiveInteger(receipt.producer.runAttempt,
    "public-lineage producer run attempt");
  assertEqual(receipt.producer.headSha, targetSourceSha, "public-lineage producer head SHA");
  assertEqual(receipt.producer.artifactName,
    `tauri-v22-public-lineage-${platform}-${runId}-${runAttempt}`,
    "public-lineage producer artifact name");
  requiredRfc3339(receipt.verifiedAt, "public-lineage verification time");
  assertEqual(receipt.verifiedAt, receipt.producer.producedAt,
    "public-lineage verification and production time");
  return receipt;
}

async function assertExactAssetInventory(directory, inputReceiptPath) {
  const inputInside = dirname(inputReceiptPath) === directory;
  const receipt = parseCanonicalJsonObject(
    (await fileIdentity(inputReceiptPath, MAX_JSON_BYTES, "verified input receipt", true)).source,
    "verified input receipt"
  );
  const platform = requiredPlatform(receipt.platform);
  const contract = PLATFORM_CONTRACTS[platform];
  const expected = [
    contract.artifactName,
    contract.signatureName,
    "SHA256SUMS.txt",
    "latest.json",
    ...(inputInside ? [VERIFIED_INPUT_RECEIPT_NAME] : [])
  ].sort();
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`The public asset directory inventory must be exactly ${expected.join(", ")}.`);
  }
}

async function fileIdentity(filePath, maximumBytes, label, includeSource = false) {
  const requested = resolveRequiredPath(filePath, label);
  const initial = await lstat(requested);
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error(`The ${label} must be a regular file, not a symlink.`);
  }
  const handle = await open(requested, READ_ONLY_NO_FOLLOW);
  try {
    const before = await handle.stat();
    assertStableFileIdentity(initial, before, label);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      throw new Error(`The ${label} must be a bounded, nonempty regular file.`);
    }
    const hash = createHash("sha256");
    let source;
    if (includeSource) {
      source = await handle.readFile();
      hash.update(source);
    } else {
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    }
    const after = await handle.stat();
    assertStableFileIdentity(before, after, label);
    return Object.freeze({
      bytes: before.size,
      sha256: hash.digest("hex"),
      ...(includeSource ? { source } : {})
    });
  } finally {
    await handle.close();
  }
}

async function canonicalRegularFilePath(filePath, label) {
  const requested = resolveRequiredPath(filePath, label);
  const initial = await lstat(requested);
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error(`The ${label} must be a regular file, not a symlink.`);
  }
  const canonical = await realpath(requested);
  const resolved = await lstat(canonical);
  assertStableFileIdentity(initial, resolved, label);
  return canonical;
}

function assertStableFileIdentity(before, after, label) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) throw new Error(`The ${label} changed while it was being verified.`);
}

async function requiredDirectory(value, label) {
  const requested = resolveRequiredPath(value, label);
  const metadata = await lstat(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  return realpath(requested);
}

async function resolveCreateNewOutputPath(value) {
  const requested = resolveRequiredPath(value, "public-lineage receipt output path");
  if (basename(requested) !== TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME) {
    throw new Error(`The output must be named ${TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME}.`);
  }
  const parent = await requiredDirectory(dirname(requested), "public-lineage output parent");
  const output = join(parent, basename(requested));
  try {
    await lstat(output);
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  throw new Error("The public-lineage receipt output must not already exist.");
}

function requiredReceiptPath(value) {
  const filePath = resolveRequiredPath(value, "public-lineage receipt path");
  if (basename(filePath) !== TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME) {
    throw new Error(`The receipt must be named ${TAURI_V22_PUBLIC_LINEAGE_RECEIPT_NAME}.`);
  }
  return filePath;
}

function assertPathOutside(filePath, directory, label) {
  const relation = relative(directory, filePath);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) {
    throw new Error(`The public-lineage receipt output must stay outside the ${label}.`);
  }
}

function parseJsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is not valid JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must contain one JSON object.`);
  }
  return value;
}

function parseCanonicalJsonObject(source, label) {
  const value = parseJsonObject(source, label);
  if (!source.equals(serializeCanonicalJson(value))) {
    throw new Error(`The ${label} is not canonical JSON.`);
  }
  return value;
}

function assertDeepExact(actual, expected, label) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new Error(`The ${label} does not match.`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      assertDeepExact(actual[index], expected[index], `${label}[${index}]`);
    }
    return;
  }
  if (expected && typeof expected === "object") {
    assertExactKeys(actual, Object.keys(expected), label);
    for (const [key, value] of Object.entries(expected)) {
      assertDeepExact(actual[key], value, `${label}.${key}`);
    }
    return;
  }
  assertEqual(actual, expected, label);
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`The ${label} has an unexpected schema.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`The ${label} does not match.`);
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${label} is required.`);
  return resolve(value);
}

function requiredPlatform(value) {
  if (!Object.hasOwn(PLATFORM_CONTRACTS, value)) {
    throw new Error("The lineage platform must be darwin-aarch64 or windows-x86_64.");
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value || value.trim() !== value || value.includes("\0")) {
    throw new Error(`The ${label} must be one nonempty normalized string.`);
  }
  return value;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requiredCommitSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase 40-character commit SHA.`);
  }
  return value;
}

function requiredDecimalId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal string.`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
  return value;
}

function requiredSemanticVersion(value, label) {
  const version = requiredString(value, label);
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version);
  if (!match || match[4]?.split(".").some((part) => /^\d+$/u.test(part) && part.length > 1 && part[0] === "0")) {
    throw new Error(`The ${label} must be strict SemVer without build metadata.`);
  }
  return version;
}

function requiredRfc3339(value, label) {
  const timestamp = requiredString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(timestamp);
  if (!match) throw new Error(`The ${label} must be a valid RFC 3339 timestamp.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const monthLengths = [31, isGregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > (monthLengths[month - 1] ?? 0) ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) throw new Error(`The ${label} must be a valid RFC 3339 timestamp.`);
  return Date.parse(timestamp);
}

function isGregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
