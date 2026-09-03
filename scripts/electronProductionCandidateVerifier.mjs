import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import {
  assembleElectronProductionCandidate,
  ELECTRON_CANDIDATE_RECEIPT_NAME,
  ELECTRON_MACOS_PACKAGE_BINDING_KIND,
  ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME,
  ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
  ELECTRON_PLATFORM_RECEIPT_NAME,
  ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
  ELECTRON_PRODUCTION_ENVIRONMENT,
  ELECTRON_WINDOWS_INSTALLER_PAYLOAD_PROOF_NAME,
  validateElectronProductionCandidateInputs
} from "./electronProductionCandidate.mjs";
import { assertPackagedElectronPackageManifestSummary } from
  "./packagedElectronPackageManifest.mjs";
import { PACKAGED_ELECTRON_BLACK_BOX_KIND } from
  "./packagedElectronBlackBoxReportContract.mjs";
import { serializeElectronProductionPlatformReceipt } from
  "./electronProductionPlatformReceiptContract.mjs";
import { readAndVerifyWindowsElectronInstallerPayloadProof } from
  "./windowsElectronInstallerPayloadProof.mjs";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const CANDIDATE_ASSETS = Object.freeze([
  "Rion.Studio-mac.app.tar.gz",
  "Rion.Studio-mac.app.tar.gz.sig",
  "Rion.Studio-mac.dmg",
  "Rion.Studio-win.exe",
  "Rion.Studio-win.exe.sig",
  "SHA256SUMS.txt",
  "latest.json"
]);

const PLATFORM_CONTRACTS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    applicationKind: "retained-appkit-chromium",
    artifactName: "Rion.Studio-mac.app.tar.gz",
    blackBox: Object.freeze({
      executableName: "Rion Studio",
      isolationKind: "fixed-macos-home",
      nativeHostKind: "appkit-chromium",
      runtimePlatform: "darwin",
      runtimeTarget: "chromium-v23-macos-appkit"
    }),
    distributionName: "Rion.Studio-mac.dmg",
    policy: Object.freeze({
      architecture: "arm64",
      codeSignature: "adhoc",
      notarization: "disabled"
    })
  }),
  "windows-x86_64": Object.freeze({
    applicationKind: "bundled-chromium",
    artifactName: "Rion.Studio-win.exe",
    blackBox: Object.freeze({
      executableName: "Rion Studio.exe",
      isolationKind: "temporary-local-windows-user-profile-v1",
      nativeHostKind: "bundled-chromium",
      runtimePlatform: "win32",
      runtimeTarget: "chromium-v23-windows"
    }),
    distributionName: undefined,
    installerPayloadProofName: ELECTRON_WINDOWS_INSTALLER_PAYLOAD_PROOF_NAME,
    policy: Object.freeze({
      architecture: "x86_64",
      authenticode: "unsigned"
    })
  })
});

export async function verifyElectronProductionCandidateBundle(input) {
  const candidateDirectory = await requiredDirectory(
    input.candidateDirectory,
    "candidate directory"
  );
  const macDirectory = await requiredDirectory(
    input.macDirectory,
    "macOS platform candidate directory"
  );
  const windowsDirectory = await requiredDirectory(
    input.windowsDirectory,
    "Windows platform candidate directory"
  );
  const candidateReceiptPath = resolveRequiredPath(
    input.candidateReceiptPath,
    "candidate receipt path"
  );
  const candidateReceiptSource = await readBoundedRegularFile(
    candidateReceiptPath,
    MAX_RECEIPT_BYTES,
    "candidate receipt"
  );
  const candidateReceiptSha256 = sha256Buffer(candidateReceiptSource);
  assertEqual(
    candidateReceiptSha256,
    requiredDigest(input.candidateReceiptSha256, "candidate receipt SHA-256"),
    "candidate receipt SHA-256"
  );
  const receipt = parseJsonObject(candidateReceiptSource, "candidate receipt");
  const validated = assertCandidateReceipt(receipt, input.publicKey, {
    sourceSha: input.sourceSha,
    version: input.version
  });

  await Promise.all([
    assertPlatformCandidateReceiptExact(macDirectory, "darwin-aarch64"),
    assertPlatformCandidateReceiptExact(windowsDirectory, "windows-x86_64")
  ]);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "rion-electron-candidate-verify-"));
  const rebuiltDirectory = join(temporaryRoot, "candidate");
  const rebuiltReceiptPath = join(temporaryRoot, ELECTRON_CANDIDATE_RECEIPT_NAME);
  try {
    await assembleElectronProductionCandidate({
      macDirectory,
      outputDirectory: rebuiltDirectory,
      ownerApproval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
      publicKey: input.publicKey,
      publishedAt: receipt.publishedAt,
      receiptPath: rebuiltReceiptPath,
      sourceSha: validated.sourceSha,
      updaterBaseUrl: validated.baseUrl,
      version: validated.version,
      windowsDirectory
    });
    const rebuiltReceiptSource = await readBoundedRegularFile(
      rebuiltReceiptPath,
      MAX_RECEIPT_BYTES,
      "rebuilt candidate receipt"
    );
    if (!candidateReceiptSource.equals(rebuiltReceiptSource)) {
      throw new Error(
        "The candidate receipt is not the canonical output of the verified platform candidates."
      );
    }
    await assertDirectoriesByteIdentical(candidateDirectory, rebuiltDirectory);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }

  const assets = await hashExactInventory(candidateDirectory, CANDIDATE_ASSETS);
  for (const name of CANDIDATE_ASSETS) {
    assertEqual(assets[name].sha256, receipt.assets[name], `candidate asset ${name} SHA-256`);
  }
  return Object.freeze({
    assets: Object.freeze(assets),
    receipt,
    receiptSha256: candidateReceiptSha256,
    sourceSha: validated.sourceSha,
    updaterBaseUrl: validated.baseUrl,
    updaterEndpoint: validated.updaterEndpoint,
    version: validated.version
  });
}

function assertCandidateReceipt(receipt, publicKey, expected) {
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
  assertEqual(receipt.schemaVersion, 1, "candidate schema version");
  assertEqual(receipt.kind, "rion-electron-production-candidate", "candidate kind");
  assertEqual(receipt.status, "verified-not-published", "candidate status");
  assertExactRecord(receipt.publication, {
    allowedByThisWorkflow: false,
    status: "candidate-only"
  }, "candidate publication boundary");
  assertExactRecord(receipt.ownerGate, {
    approval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
    environment: ELECTRON_PRODUCTION_ENVIRONMENT
  }, "candidate owner gate");
  assertExactRecord(receipt.updaterEndpointPolicy, {
    redirects: "forbidden",
    requiredStatus: 200
  }, "candidate updater endpoint policy");
  assertExactRecord(receipt.compatibility, {
    stableTauriReleasePath: "preserved",
    tauriV22CutoverEvidence: "separate-required-gate"
  }, "candidate compatibility boundary");
  const validated = validateElectronProductionCandidateInputs({
    ownerApproval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
    publicKey,
    publishedAt: receipt.publishedAt,
    sourceSha: receipt.sourceSha,
    updaterBaseUrl: receipt.updaterBaseUrl,
    version: receipt.version
  });
  assertEqual(validated.sourceSha, requiredCommitSha(expected.sourceSha), "candidate source SHA");
  assertEqual(validated.version, requiredVersion(expected.version), "candidate version");
  assertEqual(receipt.updaterBaseUrl, validated.baseUrl, "candidate updater base URL");
  assertEqual(receipt.updaterEndpoint, validated.updaterEndpoint, "candidate updater endpoint");
  assertEqual(receipt.publicKeySha256, validated.publicKeySha256, "candidate public-key SHA-256");
  assertExactKeys(receipt.assets, CANDIDATE_ASSETS, "candidate asset digest map");
  for (const name of CANDIDATE_ASSETS) requiredDigest(receipt.assets[name], `${name} SHA-256`);
  assertExactKeys(
    receipt.platforms,
    Object.keys(PLATFORM_CONTRACTS),
    "candidate platform summary map"
  );
  for (const [platform, contract] of Object.entries(PLATFORM_CONTRACTS)) {
    const summary = receipt.platforms[platform];
    assertPlatformSummary(summary, platform, contract, validated);
    assertPlatformSummaryAssetBindings(receipt.assets, summary, platform, contract);
  }
  return validated;
}

function assertPlatformSummaryAssetBindings(assets, summary, platform, contract) {
  assertEqual(
    assets[contract.artifactName],
    summary.artifact.sha256,
    `${platform} candidate artifact asset SHA-256`
  );
  assertEqual(
    assets[`${contract.artifactName}.sig`],
    summary.artifact.signatureSha256,
    `${platform} candidate signature asset SHA-256`
  );
  if (contract.distributionName) {
    assertEqual(
      assets[contract.distributionName],
      summary.distribution.sha256,
      `${platform} candidate distribution asset SHA-256`
    );
  }
}

function assertPlatformSummary(summary, platform, contract, expected) {
  assertExactKeys(summary, [
    "applicationKind",
    "artifact",
    "blackBox",
    ...(contract.installerPayloadProofName
      ? ["windowsInstallerPayloadProof"]
      : []),
    ...(contract.distributionName ? ["distribution"] : []),
    ...(contract.distributionName ? ["macosPackageBinding"] : []),
    "distributionPolicy",
    "platformReceiptSha256"
  ], `${platform} candidate platform summary`);
  assertEqual(summary.applicationKind, contract.applicationKind, `${platform} application kind`);
  assertArtifact(summary.artifact, contract.artifactName, platform);
  if (contract.distributionName) {
    assertDistribution(summary.distribution, contract.distributionName, platform);
  }
  assertExactRecord(summary.distributionPolicy, contract.policy, `${platform} distribution policy`);
  requiredDigest(summary.platformReceiptSha256, `${platform} platform receipt SHA-256`);
  assertBlackBox(summary.blackBox, platform, contract.blackBox, expected.version);
  if (contract.distributionName) {
    assertMacosPackageBinding(
      summary.macosPackageBinding,
      summary.blackBox,
      summary.artifact,
      summary.distribution,
      platform
    );
  }
  if (contract.installerPayloadProofName) {
    assertPayloadProofIdentity(summary.windowsInstallerPayloadProof, platform);
  }
}

async function assertPlatformCandidateReceiptExact(directory, platform) {
  const contract = PLATFORM_CONTRACTS[platform];
  const expectedNames = [
    contract.artifactName,
    `${contract.artifactName}.sig`,
    ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME,
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
    ELECTRON_PLATFORM_RECEIPT_NAME,
    ...(contract.installerPayloadProofName
      ? [contract.installerPayloadProofName]
      : []),
    ...(contract.distributionName ? [contract.distributionName] : [])
  ].sort();
  await assertExactDirectoryInventory(directory, expectedNames, `${platform} platform candidate`);
  const source = await readBoundedRegularFile(
    join(directory, ELECTRON_PLATFORM_RECEIPT_NAME),
    MAX_RECEIPT_BYTES,
    `${platform} platform receipt`
  );
  const receipt = parseJsonObject(source, `${platform} platform receipt`);
  assertExactKeys(receipt, [
    "applicationKind",
    "artifact",
    "blackBox",
    ...(contract.installerPayloadProofName
      ? ["windowsInstallerPayloadProof"]
      : []),
    ...(contract.distributionName ? ["distribution"] : []),
    ...(contract.distributionName ? ["macosPackageBinding"] : []),
    "distributionPolicy",
    "kind",
    "platform",
    "publicKeySha256",
    "publishedAt",
    "schemaVersion",
    "sourceSha",
    "status",
    "updaterBaseUrl",
    "updaterEndpoint",
    "updaterEndpointPolicy",
    "version"
  ], `${platform} platform receipt`);
  if (!source.equals(serializeElectronProductionPlatformReceipt(receipt))) {
    throw new Error(`${platform} platform receipt is not canonical JSON.`);
  }
  assertArtifact(receipt.artifact, contract.artifactName, platform);
  if (contract.distributionName) {
    assertDistribution(receipt.distribution, contract.distributionName, platform);
  }
  const [artifactIdentity, signatureIdentity, distributionIdentity] = await Promise.all([
    fileIdentity(join(directory, contract.artifactName), `${platform} updater artifact`),
    fileIdentity(
      join(directory, `${contract.artifactName}.sig`),
      `${platform} updater signature`
    ),
    ...(contract.distributionName
      ? [fileIdentity(
        join(directory, contract.distributionName),
        `${platform} distribution`
      )]
      : [Promise.resolve(undefined)])
  ]);
  assertEqual(artifactIdentity.bytes, receipt.artifact.bytes, `${platform} artifact bytes`);
  assertEqual(artifactIdentity.sha256, receipt.artifact.sha256, `${platform} artifact SHA-256`);
  assertEqual(
    signatureIdentity.bytes,
    receipt.artifact.signatureBytes,
    `${platform} signature bytes`
  );
  assertEqual(
    signatureIdentity.sha256,
    receipt.artifact.signatureSha256,
    `${platform} signature SHA-256`
  );
  if (contract.distributionName) {
    assertEqual(
      distributionIdentity.bytes,
      receipt.distribution.bytes,
      `${platform} distribution bytes`
    );
    assertEqual(
      distributionIdentity.sha256,
      receipt.distribution.sha256,
      `${platform} distribution SHA-256`
    );
  }
  assertBlackBox(receipt.blackBox, platform, contract.blackBox, receipt.version);
  if (contract.distributionName) {
    assertMacosPackageBinding(
      receipt.macosPackageBinding,
      receipt.blackBox,
      receipt.artifact,
      receipt.distribution,
      platform
    );
  }
  if (contract.installerPayloadProofName) {
    const proof = await readAndVerifyWindowsElectronInstallerPayloadProof({
      blackBoxEvidence: receipt.blackBox,
      installerPath: join(directory, contract.artifactName),
      proofPath: join(directory, contract.installerPayloadProofName),
      sourceSha: receipt.sourceSha,
      version: receipt.version
    });
    assertPayloadProofIdentity(receipt.windowsInstallerPayloadProof, platform);
    if (!isDeepStrictEqual(receipt.windowsInstallerPayloadProof, proof.identity)) {
      throw new Error(`${platform} installer payload proof identity does not match its proof.`);
    }
  }
}

function assertArtifact(artifact, artifactName, label) {
  assertExactKeys(artifact, [
    "bytes",
    "fileName",
    "sha256",
    "signatureBytes",
    "signatureFileName",
    "signatureSha256"
  ], `${label} artifact`);
  assertPositiveInteger(artifact.bytes, `${label} artifact bytes`);
  assertEqual(artifact.fileName, artifactName, `${label} artifact name`);
  requiredDigest(artifact.sha256, `${label} artifact SHA-256`);
  assertPositiveInteger(artifact.signatureBytes, `${label} signature bytes`);
  assertEqual(
    artifact.signatureFileName,
    `${artifactName}.sig`,
    `${label} signature name`
  );
  requiredDigest(artifact.signatureSha256, `${label} signature SHA-256`);
}

function assertDistribution(distribution, distributionName, label) {
  assertExactKeys(distribution, ["bytes", "fileName", "sha256"], `${label} distribution`);
  assertPositiveInteger(distribution.bytes, `${label} distribution bytes`);
  assertEqual(distribution.fileName, distributionName, `${label} distribution name`);
  requiredDigest(distribution.sha256, `${label} distribution SHA-256`);
}

function assertMacosPackageBinding(
  binding,
  blackBox,
  artifact,
  distribution,
  label
) {
  assertExactKeys(binding, [
    "applicationBundle",
    "artifact",
    "distribution",
    "kind",
    "packageManifest",
    "schemaVersion",
    "verificationKind"
  ], `${label} macOS package binding`);
  assertEqual(binding.schemaVersion, 1, `${label} macOS package binding schema version`);
  assertEqual(
    binding.kind,
    ELECTRON_MACOS_PACKAGE_BINDING_KIND,
    `${label} macOS package binding kind`
  );
  assertEqual(
    binding.verificationKind,
    "safe-tar-extraction-and-read-only-dmg-mount-v2",
    `${label} macOS package binding verification kind`
  );
  assertEqual(
    binding.applicationBundle,
    "Rion Studio.app",
    `${label} macOS package binding application bundle`
  );
  assertMacosPackageBindingFile(
    binding.artifact,
    artifact.fileName,
    `${label} macOS package binding updater archive`
  );
  assertMacosPackageBindingFile(
    binding.distribution,
    distribution.fileName,
    `${label} macOS package binding distribution`
  );
  assertPackagedElectronPackageManifestSummary(binding.packageManifest);
  if (!isDeepStrictEqual(binding.packageManifest, blackBox.packageManifest)) {
    throw new Error(`${label} macOS package binding manifest does not match its black-box package.`);
  }
  const expectedArtifact = {
    bytes: artifact.bytes,
    fileName: artifact.fileName,
    sha256: artifact.sha256
  };
  if (!isDeepStrictEqual(binding.artifact, expectedArtifact)) {
    throw new Error(`${label} macOS package binding does not match its updater archive.`);
  }
  if (!isDeepStrictEqual(binding.distribution, distribution)) {
    throw new Error(`${label} macOS package binding does not match its distribution.`);
  }
}

function assertMacosPackageBindingFile(identity, fileName, label) {
  assertExactKeys(identity, ["bytes", "fileName", "sha256"], label);
  assertPositiveInteger(identity.bytes, `${label} bytes`);
  assertEqual(identity.fileName, fileName, `${label} name`);
  requiredDigest(identity.sha256, `${label} SHA-256`);
}

function assertPayloadProofIdentity(identity, label) {
  assertExactKeys(
    identity,
    ["bytes", "fileName", "sha256"],
    `${label} installer payload proof identity`
  );
  assertPositiveInteger(identity.bytes, `${label} installer payload proof bytes`);
  assertEqual(
    identity.fileName,
    ELECTRON_WINDOWS_INSTALLER_PAYLOAD_PROOF_NAME,
    `${label} installer payload proof name`
  );
  requiredDigest(identity.sha256, `${label} installer payload proof SHA-256`);
}

function assertBlackBox(blackBox, platform, contract, version) {
  assertExactKeys(blackBox, [
    "appAsar",
    "appVersion",
    "application",
    "executable",
    "exitCode",
    "isolationKind",
    "kind",
    "nativeAddon",
    "nativeHostKind",
    "packageManifest",
    "remoteDebugging",
    "report",
    "runtimePlatform",
    "runtimeTarget",
    "schemaVersion",
    "screenshot",
    "verdict"
  ], `${platform} black-box summary`);
  assertEqual(blackBox.schemaVersion, 1, `${platform} black-box schema version`);
  assertEqual(
    blackBox.kind,
    PACKAGED_ELECTRON_BLACK_BOX_KIND,
    `${platform} black-box kind`
  );
  assertEqual(blackBox.verdict, "passed", `${platform} black-box verdict`);
  assertEqual(blackBox.runtimePlatform, contract.runtimePlatform, `${platform} runtime platform`);
  assertEqual(blackBox.runtimeTarget, contract.runtimeTarget, `${platform} runtime target`);
  assertEqual(
    blackBox.isolationKind,
    contract.isolationKind,
    `${platform} profile isolation kind`
  );
  assertEqual(blackBox.nativeHostKind, contract.nativeHostKind, `${platform} native host kind`);
  assertEqual(blackBox.appVersion, version, `${platform} black-box app version`);
  assertExactKeys(blackBox.application, ["path"], `${platform} black-box application`);
  requiredString(blackBox.application.path, `${platform} black-box application path`);
  assertBlackBoxFile(blackBox.executable, contract.executableName, `${platform} executable`);
  assertBlackBoxFile(blackBox.appAsar, "app.asar", `${platform} app.asar`);
  assertBlackBoxFile(blackBox.nativeAddon, "rion-core.node", `${platform} native addon`);
  assertPackagedElectronPackageManifestSummary(blackBox.packageManifest);
  assertEqual(blackBox.remoteDebugging, false, `${platform} remote debugging`);
  assertEqual(blackBox.exitCode, 0, `${platform} black-box exit code`);
  assertExactKeys(blackBox.report, ["bytes", "fileName", "sha256"], `${platform} report`);
  assertPositiveInteger(blackBox.report.bytes, `${platform} report bytes`);
  assertEqual(
    blackBox.report.fileName,
    ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME,
    `${platform} report name`
  );
  requiredDigest(blackBox.report.sha256, `${platform} report SHA-256`);
  assertExactKeys(
    blackBox.screenshot,
    ["bytes", "fileName", "sha256"],
    `${platform} screenshot`
  );
  assertPositiveInteger(blackBox.screenshot.bytes, `${platform} screenshot bytes`);
  assertEqual(
    blackBox.screenshot.fileName,
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
    `${platform} screenshot name`
  );
  requiredDigest(blackBox.screenshot.sha256, `${platform} screenshot SHA-256`);
}

function assertBlackBoxFile(value, fileName, label) {
  assertExactKeys(value, ["fileName", "sha256"], label);
  assertEqual(value.fileName, fileName, `${label} name`);
  requiredDigest(value.sha256, `${label} SHA-256`);
}

async function assertDirectoriesByteIdentical(actualDirectory, expectedDirectory) {
  const actualNames = (await readdir(actualDirectory)).sort();
  const expectedNames = (await readdir(expectedDirectory)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("The assembled candidate inventory differs from the canonical rebuild.");
  }
  for (const name of expectedNames) {
    const [actual, expected] = await Promise.all([
      fileIdentity(join(actualDirectory, name), `candidate asset ${name}`),
      fileIdentity(join(expectedDirectory, name), `rebuilt candidate asset ${name}`)
    ]);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`Candidate asset ${name} differs from the canonical rebuild.`);
    }
  }
}

async function hashExactInventory(directory, expectedNames) {
  await assertExactDirectoryInventory(directory, [...expectedNames].sort(), "candidate");
  const result = {};
  for (const name of expectedNames) result[name] = await fileIdentity(join(directory, name), name);
  return result;
}

async function assertExactDirectoryInventory(directory, expectedNames, label) {
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(`${label} inventory must be exactly ${expectedNames.join(", ")}.`);
  }
}

async function requiredDirectory(value, label) {
  const directory = resolveRequiredPath(value, label);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const canonical = await realpath(directory);
  const canonicalMetadata = await lstat(canonical);
  if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink() ||
      canonicalMetadata.dev !== metadata.dev || canonicalMetadata.ino !== metadata.ino) {
    throw new Error(`The ${label} changed while it was being resolved.`);
  }
  return canonical;
}

async function readBoundedRegularFile(filePath, maximumBytes, label) {
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > maximumBytes
    ) {
      throw new Error(
        `The ${label} must be a bounded, nonempty, exclusively linked regular file.`
      );
    }
    const source = await handle.readFile();
    const after = await handle.stat();
    assertStableFileIdentity(before, after, label);
    return source;
  } finally {
    await handle.close();
  }
}

async function fileIdentity(filePath, label) {
  const pathBefore = await lstat(filePath);
  assertExclusivelyLinkedRegularFile(pathBefore, label);
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const before = await handle.stat();
    assertExclusivelyLinkedRegularFile(before, label);
    assertStableFileIdentity(pathBefore, before, label);
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat();
    assertStableFileIdentity(before, after, label);
    const pathAfter = await lstat(filePath);
    assertExclusivelyLinkedRegularFile(pathAfter, label);
    assertStableFileIdentity(after, pathAfter, label);
    return Object.freeze({ bytes: after.size, sha256: digest.digest("hex") });
  } finally {
    await handle.close();
  }
}

function assertExclusivelyLinkedRegularFile(metadata, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size <= 0) {
    throw new Error(`The ${label} must be a nonempty, exclusively linked regular file.`);
  }
}

function assertStableFileIdentity(before, after, label) {
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.mode !== after.mode || before.nlink !== after.nlink ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs) {
    throw new Error(`The ${label} changed while it was being verified.`);
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

function assertExactRecord(actual, expected, label) {
  assertExactKeys(actual, Object.keys(expected), label);
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(actual[key], value, `${label} ${key}`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(wantedKeys)) {
    throw new Error(`The ${label} has an unexpected schema.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`The ${label} does not match.`);
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function requiredCommitSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("The expected candidate source SHA must be 40 lowercase hexadecimal characters.");
  }
  return value;
}

function requiredVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error("The expected candidate version must be semantic without a leading v.");
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${label} is required.`);
  return value;
}

function resolveRequiredPath(value, label) {
  return resolve(requiredString(value, label));
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}
