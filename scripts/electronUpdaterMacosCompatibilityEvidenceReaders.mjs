import { readdir } from "node:fs/promises";
import path from "node:path";

import { readElectronUpdaterDarwinProcessIsolationResult } from
  "./electronUpdaterDarwinIsolationResultContract.mjs";
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
const MAX_COMMAND_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_COMMAND_HARNESS_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const PLATFORM = "darwin-aarch64";
const PREPARED_PLATFORM = "darwin";
const PREPARED_ARCHITECTURE = "arm64";
const INPUT_RECEIPT_NAME = "verified-input-receipt.json";
const SOURCE_REPOSITORY = "rion-tw/rion-studio";

export async function rereadMacosPreparedUpdaterInput(
  input,
  expected,
  childOutputRoot
) {
  assertExactKeys(input, [
    "artifactPath",
    "fixtureRoot",
    "receiptPath",
    "version"
  ], "macOS prepared-input finalizer request");
  const fixtureRoot = await requiredRealDirectory(
    input.fixtureRoot,
    "macOS prepared-input root"
  );
  assertPathOutsideRoot(
    fixtureRoot,
    childOutputRoot,
    "sealed macOS prepared-input root"
  );
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "macOS prepared-input receipt"
  );
  await assertDirectChild(receiptPath, fixtureRoot, "macOS prepared-input receipt");
  const before = await readCanonicalJsonFile(
    receiptPath,
    MAX_JSON_BYTES,
    "macOS prepared-input receipt"
  );
  assertEqual(
    before.sha256,
    expected.preparedInputReceiptSha256,
    "macOS prepared-input receipt SHA-256"
  );
  const prepared = await readElectronUpdaterPreparedProbeInput({
    architecture: PREPARED_ARCHITECTURE,
    artifactPath: requiredAbsolutePath(input.artifactPath, "prepared macOS artifact"),
    environment: {},
    fixtureRoot,
    platform: PREPARED_PLATFORM,
    receiptPath,
    version: requiredSemanticVersion(input.version, "target version")
  });
  const after = await readCanonicalJsonFile(
    receiptPath,
    MAX_JSON_BYTES,
    "macOS prepared-input receipt"
  );
  assertStableReread(before, after, "macOS prepared-input receipt");
  assertEqual(
    prepared.receiptIdentity.sha256,
    before.sha256,
    "macOS prepared-input reader receipt SHA-256"
  );
  return Object.freeze({
    ...prepared,
    receiptIdentity: publicIdentity(receiptPath, after),
    root: fixtureRoot
  });
}

export async function rereadMacosTauriV22Evidence(
  input,
  expected,
  childOutputRoot
) {
  assertExactKeys(input, [
    "assetDirectory",
    "inputReceiptPath",
    "lineageReceiptPath"
  ], "macOS Tauri v22 finalizer request");
  const assetDirectory = await requiredRealDirectory(
    input.assetDirectory,
    "macOS Tauri v22 asset directory"
  );
  assertPathOutsideRoot(
    assetDirectory,
    childOutputRoot,
    "sealed macOS Tauri v22 asset root"
  );
  const inputReceiptPath = requiredAbsolutePath(
    input.inputReceiptPath,
    "macOS Tauri v22 input receipt"
  );
  await assertDirectChild(
    inputReceiptPath,
    assetDirectory,
    "macOS Tauri v22 input receipt"
  );
  assertEqual(
    path.basename(inputReceiptPath),
    INPUT_RECEIPT_NAME,
    "macOS Tauri v22 input receipt filename"
  );
  const inputBefore = await readCanonicalJsonFile(
    inputReceiptPath,
    MAX_JSON_BYTES,
    "macOS Tauri v22 input receipt"
  );
  assertEqual(
    inputBefore.sha256,
    expected.tauriV22InputReceiptSha256,
    "macOS Tauri v22 input receipt SHA-256"
  );
  const inputReceipt = assertMacosTauriV22InputReceipt(inputBefore.value);

  const lineageReceiptPath = requiredAbsolutePath(
    input.lineageReceiptPath,
    "macOS Tauri v22 public-lineage receipt"
  );
  const canonicalLineagePath = await canonicalRegularFilePath(
    lineageReceiptPath,
    MAX_JSON_BYTES,
    "macOS Tauri v22 public-lineage receipt"
  );
  assertPathOutsideRoot(
    canonicalLineagePath,
    childOutputRoot,
    "sealed macOS Tauri v22 public-lineage receipt"
  );
  const lineageBefore = await readCanonicalJsonFile(
    lineageReceiptPath,
    MAX_JSON_BYTES,
    "macOS Tauri v22 public-lineage receipt"
  );
  assertEqual(
    lineageBefore.sha256,
    expected.tauriV22LineageReceiptSha256,
    "macOS Tauri v22 public-lineage receipt SHA-256"
  );
  const lineageReceipt = await readTauriV22PublicLineageReceipt({
    expectedReceiptSha256: expected.tauriV22LineageReceiptSha256,
    receiptPath: lineageReceiptPath
  });
  const lineageAfter = await readCanonicalJsonFile(
    lineageReceiptPath,
    MAX_JSON_BYTES,
    "macOS Tauri v22 public-lineage receipt"
  );
  assertStableReread(
    lineageBefore,
    lineageAfter,
    "macOS Tauri v22 public-lineage receipt"
  );
  assertReceiptBindings(inputReceipt, inputBefore, lineageReceipt, expected);
  const assets = await rereadAssets(assetDirectory, inputReceipt, lineageReceipt);
  const [inputAfter, lineageFinal] = await Promise.all([
    readCanonicalJsonFile(
      inputReceiptPath,
      MAX_JSON_BYTES,
      "macOS Tauri v22 input receipt"
    ),
    readCanonicalJsonFile(
      lineageReceiptPath,
      MAX_JSON_BYTES,
      "macOS Tauri v22 public-lineage receipt"
    )
  ]);
  assertStableReread(inputBefore, inputAfter, "macOS Tauri v22 input receipt");
  assertStableReread(
    lineageAfter,
    lineageFinal,
    "macOS Tauri v22 public-lineage receipt"
  );
  return Object.freeze({
    assets,
    inputReceipt,
    inputReceiptIdentity: publicIdentity(inputReceiptPath, inputAfter),
    lineageReceipt,
    lineageReceiptIdentity: publicIdentity(lineageReceiptPath, lineageFinal)
  });
}

export async function readMacosParentIsolationResult(
  resultPath,
  childOutputRoot,
  expected
) {
  const isolation = await readElectronUpdaterDarwinProcessIsolationResult({
    childOutputRoot,
    expected: {
      attemptNonce: expected.isolationAttemptNonce,
      commandInvocationSha256: expected.isolationCommandInvocationSha256,
      resultSha256: expected.isolationResultSha256,
      sandboxProfileSha256: expected.sandboxProfileSha256
    },
    resultPath
  });
  const [commandExecutable, commandHarness] = await Promise.all([
    rereadExpectedParentInput({
      childOutputRoot,
      expectedSha256: expected.isolationCommandExecutableSha256,
      label: "macOS isolation command executable",
      maximumBytes: MAX_COMMAND_EXECUTABLE_BYTES,
      path: expected.isolationCommandExecutablePath
    }),
    rereadExpectedParentInput({
      childOutputRoot,
      expectedSha256: expected.isolationCommandHarnessSha256,
      label: "macOS isolation command harness",
      maximumBytes: MAX_COMMAND_HARNESS_BYTES,
      path: expected.isolationCommandHarnessPath
    })
  ]);
  return Object.freeze({
    ...isolation,
    commandExecutable,
    commandHarness
  });
}

export function assertMacosCompatibilityExpectedBindings(value) {
  assertExactKeys(value, [
    "isolationAttemptNonce",
    "isolationCommandExecutablePath",
    "isolationCommandExecutableSha256",
    "isolationCommandHarnessPath",
    "isolationCommandHarnessSha256",
    "isolationCommandInvocationSha256",
    "isolationResultSha256",
    "preparedInputReceiptSha256",
    "sandboxProfileSha256",
    "targetSourceSha",
    "tauriV22InputReceiptSha256",
    "tauriV22LineageReceiptSha256",
    "updaterPublicKeySha256"
  ], "macOS terminal receipt expected bindings");
  if (!/^[a-f0-9]{32}$/u.test(value.isolationAttemptNonce ?? "")) {
    throw new Error("The expected macOS isolation attempt nonce is invalid.");
  }
  requiredAbsolutePath(
    value.isolationCommandExecutablePath,
    "expected macOS isolation command executable"
  );
  requiredAbsolutePath(
    value.isolationCommandHarnessPath,
    "expected macOS isolation command harness"
  );
  for (const [field, label] of [
    ["isolationCommandExecutableSha256", "isolation command executable"],
    ["isolationCommandHarnessSha256", "isolation command harness"],
    ["isolationCommandInvocationSha256", "isolation command invocation"],
    ["isolationResultSha256", "isolation result"],
    ["preparedInputReceiptSha256", "prepared-input receipt"],
    ["sandboxProfileSha256", "sandbox profile"],
    ["tauriV22InputReceiptSha256", "Tauri v22 input receipt"],
    ["tauriV22LineageReceiptSha256", "Tauri v22 public-lineage receipt"],
    ["updaterPublicKeySha256", "updater trust"]
  ]) requiredDigest(value[field], `expected macOS ${label} SHA-256`);
  requiredCommitSha(value.targetSourceSha, "expected macOS target source SHA");
  return Object.freeze({ ...value });
}

async function rereadExpectedParentInput(input) {
  const requested = requiredAbsolutePath(input.path, input.label);
  const canonical = await canonicalRegularFilePath(
    requested,
    input.maximumBytes,
    input.label
  );
  assertEqual(canonical, requested, `${input.label} canonical path`);
  assertPathOutsideRoot(canonical, input.childOutputRoot, input.label);
  const file = await readStableFile(requested, input.maximumBytes, input.label);
  assertEqual(file.sha256, input.expectedSha256, `${input.label} SHA-256`);
  return Object.freeze({
    ...publicIdentity(requested, file),
    path: requested
  });
}

export function assertMacosCompatibilityTargetBindings(
  prepared,
  v22,
  expected,
  target
) {
  assertEqual(
    prepared.receipt.platform,
    PREPARED_PLATFORM,
    "prepared macOS target platform"
  );
  assertEqual(
    prepared.receipt.architecture,
    PREPARED_ARCHITECTURE,
    "prepared macOS target architecture"
  );
  assertEqual(prepared.receipt.version, target.version, "prepared macOS target version");
  assertEqual(v22.inputReceipt.targetSha, expected.targetSourceSha, "macOS target source SHA");
  assertEqual(
    v22.inputReceipt.updaterPublicKeySha256,
    expected.updaterPublicKeySha256,
    "macOS target updater trust"
  );
}

async function rereadAssets(directory, inputReceipt, lineage) {
  const expectedNames = [
    inputReceipt.artifactName,
    inputReceipt.signatureName,
    inputReceipt.manifestName,
    inputReceipt.checksumName,
    INPUT_RECEIPT_NAME
  ].sort();
  const observedNames = (await readdir(directory)).sort();
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw new Error("The sealed macOS Tauri v22 asset inventory is not exact.");
  }
  const contracts = {
    artifact: [
      inputReceipt.artifactName,
      MAX_ARTIFACT_BYTES,
      inputReceipt.artifactBytes,
      inputReceipt.artifactSha256
    ],
    signature: [
      inputReceipt.signatureName,
      MAX_SIGNATURE_BYTES,
      lineage.assets.signature.bytes,
      inputReceipt.signatureSha256
    ],
    manifest: [
      inputReceipt.manifestName,
      MAX_JSON_BYTES,
      lineage.assets.manifest.bytes,
      inputReceipt.manifestSha256
    ],
    checksums: [
      inputReceipt.checksumName,
      MAX_JSON_BYTES,
      lineage.assets.checksums.bytes,
      inputReceipt.checksumSha256
    ]
  };
  const assets = {};
  for (const [role, [fileName, maximumBytes, bytes, sha256]] of
    Object.entries(contracts)) {
    const filePath = path.join(directory, fileName);
    const observed = await readStableFile(
      filePath,
      maximumBytes,
      `macOS Tauri v22 ${role}`
    );
    assertEqual(observed.bytes, bytes, `macOS Tauri v22 ${role} bytes`);
    assertEqual(observed.sha256, sha256, `macOS Tauri v22 ${role} SHA-256`);
    assertEqual(
      lineage.assets[role].sha256,
      observed.sha256,
      `macOS Tauri v22 public-lineage ${role} SHA-256`
    );
    assets[role] = publicIdentity(filePath, observed);
  }
  return Object.freeze(assets);
}

function assertMacosTauriV22InputReceipt(value) {
  assertExactKeys(value, [
    "artifactBytes", "artifactName", "artifactSha256", "checksumName",
    "checksumSha256", "evidenceKind", "manifestName", "manifestSha256",
    "platform", "releaseTag", "releaseVersion", "repository", "runtime",
    "schemaVersion", "signatureName", "signatureSha256", "sourceSha",
    "targetSha", "updaterPublicKeySha256"
  ], "macOS Tauri v22 input receipt");
  assertEqual(value.schemaVersion, 2, "macOS Tauri v22 input schema version");
  assertEqual(
    value.evidenceKind,
    "tauri-v22-published-input",
    "macOS Tauri v22 input evidence kind"
  );
  assertEqual(value.runtime, "tauri-v22", "macOS Tauri v22 input runtime");
  assertEqual(value.repository, SOURCE_REPOSITORY, "macOS Tauri v22 input repository");
  assertEqual(value.platform, PLATFORM, "macOS Tauri v22 input platform");
  const version = requiredSemanticVersion(value.releaseVersion, "macOS Tauri v22 version");
  assertEqual(value.releaseTag, `v${version}`, "macOS Tauri v22 release tag");
  requiredCommitSha(value.sourceSha, "macOS Tauri v22 source SHA");
  requiredCommitSha(value.targetSha, "macOS Electron target source SHA");
  requiredDigest(value.updaterPublicKeySha256, "macOS updater public-key SHA-256");
  assertEqual(
    value.artifactName,
    "Rion.Studio-mac.app.tar.gz",
    "macOS Tauri v22 artifact name"
  );
  assertEqual(
    value.signatureName,
    "Rion.Studio-mac.app.tar.gz.sig",
    "macOS Tauri v22 signature name"
  );
  assertEqual(value.manifestName, "latest.json", "macOS Tauri v22 manifest name");
  assertEqual(value.checksumName, "SHA256SUMS.txt", "macOS Tauri v22 checksum name");
  requiredPositiveInteger(value.artifactBytes, "macOS Tauri v22 artifact bytes");
  for (const field of [
    "artifactSha256", "signatureSha256", "manifestSha256", "checksumSha256"
  ]) requiredDigest(value[field], `macOS Tauri v22 ${field}`);
  return Object.freeze(value);
}

function assertReceiptBindings(input, inputFile, lineage, expected) {
  assertEqual(lineage.platform, PLATFORM, "macOS public-lineage platform");
  assertEqual(
    lineage.verifiedInputReceipt.sha256,
    inputFile.sha256,
    "macOS public-lineage verified input receipt SHA-256"
  );
  assertEqual(lineage.release.tag, input.releaseTag, "macOS public-lineage release tag");
  assertEqual(
    lineage.release.version,
    input.releaseVersion,
    "macOS public-lineage release version"
  );
  assertEqual(
    lineage.sourceTag.peeledCommitSha,
    input.sourceSha,
    "macOS public-lineage source commit SHA"
  );
  assertEqual(
    lineage.targetSourceSha,
    input.targetSha,
    "macOS public-lineage target source SHA"
  );
  assertEqual(
    lineage.trust.updaterPublicKeySha256,
    input.updaterPublicKeySha256,
    "macOS public-lineage updater trust"
  );
  assertEqual(input.targetSha, expected.targetSourceSha, "expected macOS target source SHA");
  assertEqual(
    input.updaterPublicKeySha256,
    expected.updaterPublicKeySha256,
    "expected macOS updater public-key SHA-256"
  );
  const inputAssets = {
    artifact: [input.artifactName, input.artifactBytes, input.artifactSha256],
    signature: [input.signatureName, null, input.signatureSha256],
    manifest: [input.manifestName, null, input.manifestSha256],
    checksums: [input.checksumName, null, input.checksumSha256]
  };
  for (const [role, [name, bytes, sha256]] of Object.entries(inputAssets)) {
    assertEqual(lineage.assets[role].name, name, `macOS public-lineage ${role} name`);
    if (bytes !== null) {
      assertEqual(lineage.assets[role].bytes, bytes, `macOS public-lineage ${role} bytes`);
    }
    assertEqual(
      lineage.assets[role].sha256,
      sha256,
      `macOS public-lineage ${role} SHA-256`
    );
  }
}
