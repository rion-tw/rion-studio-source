import { readdir } from "node:fs/promises";
import path from "node:path";

import { readElectronUpdaterPreparedProbeInput } from
  "./electronUpdaterPreparedProbeInput.mjs";
import {
  assertDirectChild,
  assertEqual,
  assertExactKeys,
  assertPathOutsideRoot,
  assertStableReread,
  canonicalRegularFilePath,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRealDirectory,
  requiredSemanticVersion
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import { readTauriV22PublicLineageReceipt } from
  "./tauriV22PublicLineage.mjs";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const PLATFORM = "windows-x86_64";
const PREPARED_PLATFORM = "win32";
const PREPARED_ARCHITECTURE = "x64";
const INPUT_RECEIPT_NAME = "verified-input-receipt.json";
const SOURCE_REPOSITORY = "rion-tw/rion-studio";

export async function rereadWindowsPreparedUpdaterInput(
  input,
  expected,
  childOutputRoot
) {
  assertExactKeys(input, [
    "artifactPath",
    "fixtureRoot",
    "receiptPath",
    "version"
  ], "prepared-input finalizer request");
  const fixtureRoot = await requiredRealDirectory(
    input.fixtureRoot,
    "prepared-input root"
  );
  assertPathOutsideRoot(
    fixtureRoot,
    childOutputRoot,
    "sealed prepared-input root"
  );
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "prepared-input receipt"
  );
  await assertDirectChild(receiptPath, fixtureRoot, "prepared-input receipt");
  const before = await readCanonicalJsonFile(
    receiptPath,
    MAX_JSON_BYTES,
    "prepared-input receipt"
  );
  assertEqual(
    before.sha256,
    expected.preparedInputReceiptSha256,
    "prepared-input receipt SHA-256"
  );
  const prepared = await readElectronUpdaterPreparedProbeInput({
    architecture: PREPARED_ARCHITECTURE,
    artifactPath: requiredAbsolutePath(input.artifactPath, "prepared artifact"),
    environment: {},
    fixtureRoot,
    platform: PREPARED_PLATFORM,
    receiptPath,
    version: requiredSemanticVersion(input.version, "target version")
  });
  const after = await readCanonicalJsonFile(
    receiptPath,
    MAX_JSON_BYTES,
    "prepared-input receipt"
  );
  assertStableReread(before, after, "prepared-input receipt");
  assertEqual(
    prepared.receiptIdentity.sha256,
    before.sha256,
    "prepared-input reader receipt SHA-256"
  );
  return Object.freeze({
    ...prepared,
    receiptIdentity: publicIdentity(receiptPath, after),
    root: fixtureRoot
  });
}

export async function rereadWindowsTauriV22Evidence(
  input,
  expected,
  childOutputRoot
) {
  assertExactKeys(input, [
    "assetDirectory",
    "inputReceiptPath",
    "lineageReceiptPath"
  ], "Tauri v22 finalizer request");
  const assetDirectory = await requiredRealDirectory(
    input.assetDirectory,
    "Tauri v22 asset directory"
  );
  assertPathOutsideRoot(
    assetDirectory,
    childOutputRoot,
    "sealed Tauri v22 asset root"
  );
  const inputReceiptPath = requiredAbsolutePath(
    input.inputReceiptPath,
    "Tauri v22 input receipt"
  );
  await assertDirectChild(
    inputReceiptPath,
    assetDirectory,
    "Tauri v22 input receipt"
  );
  assertEqual(
    path.basename(inputReceiptPath),
    INPUT_RECEIPT_NAME,
    "Tauri v22 input receipt filename"
  );
  const inputFile = await readCanonicalJsonFile(
    inputReceiptPath,
    MAX_JSON_BYTES,
    "Tauri v22 input receipt"
  );
  assertEqual(
    inputFile.sha256,
    expected.tauriV22InputReceiptSha256,
    "Tauri v22 input receipt SHA-256"
  );
  const inputReceipt = assertTauriV22InputReceipt(inputFile.value);

  const lineageReceiptPath = requiredAbsolutePath(
    input.lineageReceiptPath,
    "Tauri v22 public-lineage receipt"
  );
  const canonicalLineageReceiptPath = await canonicalRegularFilePath(
    lineageReceiptPath,
    MAX_JSON_BYTES,
    "Tauri v22 public-lineage receipt"
  );
  assertPathOutsideRoot(
    canonicalLineageReceiptPath,
    childOutputRoot,
    "sealed Tauri v22 public-lineage receipt"
  );
  const lineageBefore = await readCanonicalJsonFile(
    lineageReceiptPath,
    MAX_JSON_BYTES,
    "Tauri v22 public-lineage receipt"
  );
  assertEqual(
    lineageBefore.sha256,
    expected.tauriV22LineageReceiptSha256,
    "Tauri v22 public-lineage receipt SHA-256"
  );
  const lineageReceipt = await readTauriV22PublicLineageReceipt({
    expectedReceiptSha256: expected.tauriV22LineageReceiptSha256,
    receiptPath: lineageReceiptPath
  });
  const lineageAfter = await readCanonicalJsonFile(
    lineageReceiptPath,
    MAX_JSON_BYTES,
    "Tauri v22 public-lineage receipt"
  );
  assertStableReread(
    lineageBefore,
    lineageAfter,
    "Tauri v22 public-lineage receipt"
  );
  assertV22ReceiptBindings(inputReceipt, inputFile, lineageReceipt, expected);
  const assets = await rereadV22Assets(
    assetDirectory,
    inputReceipt,
    lineageReceipt
  );
  const inputAfter = await readCanonicalJsonFile(
    inputReceiptPath,
    MAX_JSON_BYTES,
    "Tauri v22 input receipt"
  );
  const lineageFinal = await readCanonicalJsonFile(
    lineageReceiptPath,
    MAX_JSON_BYTES,
    "Tauri v22 public-lineage receipt"
  );
  assertStableReread(inputFile, inputAfter, "Tauri v22 input receipt");
  assertStableReread(
    lineageAfter,
    lineageFinal,
    "Tauri v22 public-lineage receipt"
  );
  return Object.freeze({
    assets,
    inputReceipt,
    inputReceiptIdentity: publicIdentity(inputReceiptPath, inputAfter),
    lineageReceipt,
    lineageReceiptIdentity: publicIdentity(lineageReceiptPath, lineageFinal)
  });
}

export function assertWindowsCompatibilityTargetBindings(
  prepared,
  v22,
  expected,
  target
) {
  assertEqual(prepared.receipt.platform, PREPARED_PLATFORM, "prepared target platform");
  assertEqual(
    prepared.receipt.architecture,
    PREPARED_ARCHITECTURE,
    "prepared target architecture"
  );
  assertEqual(prepared.receipt.version, target.version, "prepared target version");
  assertEqual(v22.inputReceipt.targetSha, expected.targetSourceSha, "target source SHA");
  assertEqual(
    v22.inputReceipt.updaterPublicKeySha256,
    expected.updaterPublicKeySha256,
    "target updater trust"
  );
}

async function rereadV22Assets(directory, inputReceipt, lineage) {
  const expectedNames = [
    inputReceipt.artifactName,
    inputReceipt.signatureName,
    inputReceipt.manifestName,
    inputReceipt.checksumName,
    INPUT_RECEIPT_NAME
  ].sort();
  const observedNames = (await readdir(directory)).sort();
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error("The sealed Tauri v22 asset inventory is not exact.");
  }
  const contracts = {
    artifact: {
      fileName: inputReceipt.artifactName,
      maximumBytes: MAX_ARTIFACT_BYTES,
      receiptBytes: inputReceipt.artifactBytes,
      receiptSha256: inputReceipt.artifactSha256
    },
    signature: {
      fileName: inputReceipt.signatureName,
      maximumBytes: MAX_SIGNATURE_BYTES,
      receiptBytes: lineage.assets.signature.bytes,
      receiptSha256: inputReceipt.signatureSha256
    },
    manifest: {
      fileName: inputReceipt.manifestName,
      maximumBytes: MAX_JSON_BYTES,
      receiptBytes: lineage.assets.manifest.bytes,
      receiptSha256: inputReceipt.manifestSha256
    },
    checksums: {
      fileName: inputReceipt.checksumName,
      maximumBytes: MAX_JSON_BYTES,
      receiptBytes: lineage.assets.checksums.bytes,
      receiptSha256: inputReceipt.checksumSha256
    }
  };
  const assets = {};
  for (const [role, contract] of Object.entries(contracts)) {
    const filePath = path.join(directory, contract.fileName);
    const observed = await readStableFile(
      filePath,
      contract.maximumBytes,
      `Tauri v22 ${role}`
    );
    assertEqual(observed.bytes, contract.receiptBytes, `Tauri v22 ${role} bytes`);
    assertEqual(
      observed.sha256,
      contract.receiptSha256,
      `Tauri v22 ${role} SHA-256`
    );
    assertEqual(
      lineage.assets[role].sha256,
      observed.sha256,
      `Tauri v22 public-lineage ${role} SHA-256`
    );
    assets[role] = publicIdentity(filePath, observed);
  }
  return Object.freeze(assets);
}

function assertTauriV22InputReceipt(value) {
  assertExactKeys(value, [
    "artifactBytes", "artifactName", "artifactSha256", "checksumName",
    "checksumSha256", "evidenceKind", "manifestName", "manifestSha256",
    "platform", "releaseTag", "releaseVersion", "repository", "runtime",
    "schemaVersion", "signatureName", "signatureSha256", "sourceSha",
    "targetSha", "updaterPublicKeySha256"
  ], "Tauri v22 input receipt");
  assertEqual(value.schemaVersion, 2, "Tauri v22 input schema version");
  assertEqual(
    value.evidenceKind,
    "tauri-v22-published-input",
    "Tauri v22 input evidence kind"
  );
  assertEqual(value.runtime, "tauri-v22", "Tauri v22 input runtime");
  assertEqual(value.repository, SOURCE_REPOSITORY, "Tauri v22 input repository");
  assertEqual(value.platform, PLATFORM, "Tauri v22 input platform");
  const version = requiredSemanticVersion(value.releaseVersion, "Tauri v22 version");
  assertEqual(value.releaseTag, `v${version}`, "Tauri v22 release tag");
  requiredCommitSha(value.sourceSha, "Tauri v22 source SHA");
  requiredCommitSha(value.targetSha, "Electron target source SHA");
  requiredDigest(value.updaterPublicKeySha256, "updater public-key SHA-256");
  assertEqual(value.artifactName, "Rion.Studio-win.exe", "Tauri v22 artifact name");
  assertEqual(
    value.signatureName,
    "Rion.Studio-win.exe.sig",
    "Tauri v22 signature name"
  );
  assertEqual(value.manifestName, "latest.json", "Tauri v22 manifest name");
  assertEqual(value.checksumName, "SHA256SUMS.txt", "Tauri v22 checksum name");
  requiredPositiveInteger(value.artifactBytes, "Tauri v22 artifact bytes");
  for (const field of [
    "artifactSha256", "signatureSha256", "manifestSha256", "checksumSha256"
  ]) requiredDigest(value[field], `Tauri v22 ${field}`);
  return Object.freeze(value);
}

function assertV22ReceiptBindings(input, inputFile, lineage, expected) {
  assertEqual(lineage.platform, PLATFORM, "public-lineage platform");
  assertEqual(
    lineage.verifiedInputReceipt.sha256,
    inputFile.sha256,
    "public-lineage verified input receipt SHA-256"
  );
  assertEqual(lineage.release.tag, input.releaseTag, "public-lineage release tag");
  assertEqual(
    lineage.release.version,
    input.releaseVersion,
    "public-lineage release version"
  );
  assertEqual(
    lineage.sourceTag.peeledCommitSha,
    input.sourceSha,
    "public-lineage source commit SHA"
  );
  assertEqual(
    lineage.targetSourceSha,
    input.targetSha,
    "public-lineage target source SHA"
  );
  assertEqual(
    lineage.trust.updaterPublicKeySha256,
    input.updaterPublicKeySha256,
    "public-lineage updater trust"
  );
  assertEqual(input.targetSha, expected.targetSourceSha, "expected target source SHA");
  assertEqual(
    input.updaterPublicKeySha256,
    expected.updaterPublicKeySha256,
    "expected updater public-key SHA-256"
  );
  const inputAssets = {
    artifact: [input.artifactName, input.artifactBytes, input.artifactSha256],
    signature: [input.signatureName, null, input.signatureSha256],
    manifest: [input.manifestName, null, input.manifestSha256],
    checksums: [input.checksumName, null, input.checksumSha256]
  };
  for (const [role, [name, bytes, sha256]] of Object.entries(inputAssets)) {
    assertEqual(lineage.assets[role].name, name, `public-lineage ${role} name`);
    if (bytes !== null) {
      assertEqual(lineage.assets[role].bytes, bytes, `public-lineage ${role} bytes`);
    }
    assertEqual(lineage.assets[role].sha256, sha256, `public-lineage ${role} SHA-256`);
  }
}
