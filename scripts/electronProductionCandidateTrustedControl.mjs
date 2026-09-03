import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
  ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
  normalizeUpdaterPublicKey,
  validateElectronProductionCandidateInputs
} from "./electronProductionCandidate.mjs";
import { WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME } from
  "./windowsElectronInstallerPayloadProofContract.mjs";

const CONTROL_KIND = "rion-electron-production-candidate-trusted-control";
const SIGNING_INPUT_KIND =
  "rion-electron-production-candidate-trusted-signing-input";
const CONTROL_RECEIPT_NAME =
  "electron-production-candidate-trusted-control-receipt.json";
const SIGNING_INPUT_RECEIPT_NAME =
  "electron-production-candidate-signing-input-receipt.json";
const CONTROL_REF = "refs/heads/main";
const CONTROL_WORKFLOW =
  ".github/workflows/electron-production-candidate.yml";
const CONTROL_REPOSITORY = "rion-tw/rion-studio-source";
const SOURCE_BLACK_BOX_REPORT_NAME = "packaged-smoke-report.json";
const MAX_CONTROL_RECEIPT_BYTES = 1024 * 1024;
const MAX_SIGNING_INPUT_RECEIPT_BYTES = 8 * 1024 * 1024;
const MAX_SIGNING_INPUT_FILES = 20_000;
const PLATFORM_CONTRACTS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    archiveName: "electron-production-unsigned-macos-arm64.tar.gz",
    topLevelDirectories: Object.freeze(["black-box", "control", "unsigned"]),
    windowsProofPath: null
  }),
  "windows-x86_64": Object.freeze({
    archiveName: "electron-production-unsigned-windows-x64.tar.gz",
    topLevelDirectories: Object.freeze([
      "black-box",
      "control",
      "unsigned",
      "windows-proof"
    ]),
    windowsProofPath: `windows-proof/${WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME}`
  })
});

export async function createTrustedControlReceipt(input) {
  const controlPlane = requiredControlPlane(input);
  const producer = requiredProducer(input);
  const candidate = validateElectronProductionCandidateInputs({
    ownerApproval: input.ownerApproval,
    publicKey: input.updaterPublicKey,
    publishedAt: input.publishedAt,
    sourceSha: input.sourceSha,
    updaterBaseUrl: input.updaterBaseUrl,
    version: input.version
  });
  const publicKey = normalizeUpdaterPublicKey(input.updaterPublicKey);
  const receipt = assertTrustedControlReceipt({
    schemaVersion: 1,
    kind: CONTROL_KIND,
    candidate: {
      publishedAt: candidate.publishedAt,
      sourceSha: candidate.sourceSha,
      updaterBaseUrl: candidate.baseUrl,
      updaterEndpoint: candidate.updaterEndpoint,
      version: candidate.version
    },
    controlPlane,
    ownerApproval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
    producer,
    updaterTrust: {
      publicKey: publicKey.canonicalBase64,
      publicKeySha256: publicKey.sha256
    }
  });
  await writeCanonicalCreateNew(input.outputPath, receipt);
  return receipt;
}

export async function readTrustedControlReceipt(input) {
  const receipt = await readCanonicalFile(
    input.receiptPath,
    MAX_CONTROL_RECEIPT_BYTES,
    "trusted-control receipt"
  );
  const value = assertTrustedControlReceipt(receipt.value);
  assertExpectedControlContext(value, input);
  return Object.freeze({
    receipt: value,
    receiptPath: receipt.path,
    receiptSha256: receipt.sha256
  });
}

export async function createTrustedSigningInputReceipt(input) {
  const control = await readTrustedControlReceipt({
    controlPlaneSha: input.controlPlaneSha,
    receiptPath: input.controlReceiptPath,
    repository: input.repository,
    runAttempt: input.runAttempt,
    runId: input.runId,
    sourceSha: input.sourceSha,
    version: input.version
  });
  const platform = requiredPlatform(input.platform);
  const root = await requiredStableDirectory(input.inputRoot, "signing-input root");
  const files = await captureClosedFileInventory(root);
  const required = assertRequiredSigningInputFiles(platform, root, files);
  const receipt = assertTrustedSigningInputReceipt({
    schemaVersion: 1,
    kind: SIGNING_INPUT_KIND,
    candidate: {
      sourceSha: control.receipt.candidate.sourceSha,
      version: control.receipt.candidate.version
    },
    controlPlane: control.receipt.controlPlane,
    files,
    platform: input.platform,
    producer: control.receipt.producer,
    required,
    trustedControlReceiptSha256: control.receiptSha256
  });
  await writeCanonicalCreateNew(input.outputPath, receipt);
  return receipt;
}

export async function readTrustedSigningInputReceipt(input) {
  const receiptFile = await readCanonicalFile(
    input.receiptPath,
    MAX_SIGNING_INPUT_RECEIPT_BYTES,
    "trusted signing-input receipt"
  );
  const receipt = assertTrustedSigningInputReceipt(receiptFile.value);
  assertExpectedSigningInputContext(receipt, input);
  const platform = requiredPlatform(receipt.platform);
  const root = await requiredStableDirectory(input.inputRoot, "signing-input root");
  const observedFiles = await captureClosedFileInventory(root);
  if (!isDeepStrictEqual(observedFiles, receipt.files)) {
    throw new Error("The sealed signing-input inventory or bytes changed after attestation.");
  }
  const required = assertRequiredSigningInputFiles(platform, root, observedFiles);
  if (!isDeepStrictEqual(required, receipt.required)) {
    throw new Error("The sealed signing-input required identities changed after attestation.");
  }
  const control = await readTrustedControlReceipt({
    controlPlaneSha: input.controlPlaneSha,
    receiptPath: path.join(root.path, required.controlReceipt.path),
    repository: input.repository,
    runAttempt: input.runAttempt,
    runId: input.runId,
    sourceSha: input.sourceSha,
    version: input.version
  });
  if (control.receiptSha256 !== receipt.trustedControlReceiptSha256) {
    throw new Error("The trusted-control receipt identity does not match the signing input.");
  }
  if (!isDeepStrictEqual(control.receipt.controlPlane, receipt.controlPlane) ||
      !isDeepStrictEqual(control.receipt.producer, receipt.producer)) {
    throw new Error("The trusted-control provenance does not match the signing input.");
  }
  return Object.freeze({
    blackBoxReportPath: path.join(root.path, required.blackBoxReport.path),
    controlReceiptPath: control.receiptPath,
    inputRoot: root.path,
    receipt,
    receiptPath: receiptFile.path,
    receiptSha256: receiptFile.sha256,
    unsignedArchivePath: path.join(root.path, required.unsignedArchive.path),
    updaterPublicKey: control.receipt.updaterTrust.publicKey,
    windowsInstallerPayloadProofPath: required.windowsInstallerPayloadProof === null
      ? null
      : path.join(root.path, required.windowsInstallerPayloadProof.path)
  });
}

function assertTrustedControlReceipt(value) {
  assertExactKeys(value, [
    "candidate",
    "controlPlane",
    "kind",
    "ownerApproval",
    "producer",
    "schemaVersion",
    "updaterTrust"
  ], "trusted-control receipt");
  assertEqual(value.schemaVersion, 1, "trusted-control schema version");
  assertEqual(value.kind, CONTROL_KIND, "trusted-control kind");
  assertEqual(
    value.ownerApproval,
    ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
    "trusted-control owner approval"
  );
  assertExactKeys(value.candidate, [
    "publishedAt",
    "sourceSha",
    "updaterBaseUrl",
    "updaterEndpoint",
    "version"
  ], "trusted-control candidate");
  const validated = validateElectronProductionCandidateInputs({
    ownerApproval: value.ownerApproval,
    publicKey: value.updaterTrust?.publicKey,
    publishedAt: value.candidate.publishedAt,
    sourceSha: value.candidate.sourceSha,
    updaterBaseUrl: value.candidate.updaterBaseUrl,
    version: value.candidate.version
  });
  assertEqual(value.candidate.updaterBaseUrl, validated.baseUrl,
    "trusted-control updater base URL");
  assertEqual(value.candidate.updaterEndpoint, validated.updaterEndpoint,
    "trusted-control updater endpoint");
  const controlPlane = requiredControlPlane(value);
  const producer = requiredProducer(value);
  assertExactKeys(value.updaterTrust, ["publicKey", "publicKeySha256"],
    "trusted-control updater trust");
  const publicKey = normalizeUpdaterPublicKey(value.updaterTrust.publicKey);
  assertEqual(value.updaterTrust.publicKey, publicKey.canonicalBase64,
    "trusted-control canonical updater public key");
  assertEqual(value.updaterTrust.publicKeySha256, publicKey.sha256,
    "trusted-control updater public-key digest");
  return deepFreeze({
    schemaVersion: 1,
    kind: CONTROL_KIND,
    candidate: { ...value.candidate },
    controlPlane,
    ownerApproval: value.ownerApproval,
    producer,
    updaterTrust: { ...value.updaterTrust }
  });
}

function assertTrustedSigningInputReceipt(value) {
  assertExactKeys(value, [
    "candidate",
    "controlPlane",
    "files",
    "kind",
    "platform",
    "producer",
    "required",
    "schemaVersion",
    "trustedControlReceiptSha256"
  ], "trusted signing-input receipt");
  assertEqual(value.schemaVersion, 1, "trusted signing-input schema version");
  assertEqual(value.kind, SIGNING_INPUT_KIND, "trusted signing-input kind");
  assertExactKeys(value.candidate, ["sourceSha", "version"],
    "trusted signing-input candidate");
  requiredSourceSha(value.candidate.sourceSha);
  requiredVersion(value.candidate.version);
  requiredControlPlane(value);
  requiredProducer(value);
  requiredPlatform(value.platform);
  requiredDigest(value.trustedControlReceiptSha256,
    "trusted-control receipt SHA-256");
  if (!Array.isArray(value.files) || value.files.length === 0 ||
      value.files.length > MAX_SIGNING_INPUT_FILES) {
    throw new Error("The trusted signing-input file inventory is invalid.");
  }
  let previousPath = "";
  for (const file of value.files) {
    assertFileIdentity(file, "trusted signing-input file");
    if (file.path <= previousPath) {
      throw new Error("The trusted signing-input file inventory is not uniquely sorted.");
    }
    previousPath = file.path;
  }
  assertExactKeys(value.required, [
    "blackBoxReport",
    "blackBoxScreenshot",
    "controlReceipt",
    "unsignedArchive",
    "windowsInstallerPayloadProof"
  ], "trusted signing-input required identities");
  for (const field of [
    "blackBoxReport",
    "blackBoxScreenshot",
    "controlReceipt",
    "unsignedArchive"
  ]) assertFileIdentity(value.required[field], `trusted signing-input ${field}`);
  if (value.required.windowsInstallerPayloadProof !== null) {
    assertFileIdentity(
      value.required.windowsInstallerPayloadProof,
      "trusted signing-input Windows payload proof"
    );
  }
  return deepFreeze(structuredClone(value));
}

function assertExpectedControlContext(receipt, input) {
  assertEqual(receipt.candidate.sourceSha, requiredSourceSha(input.sourceSha),
    "trusted-control candidate source SHA");
  assertEqual(receipt.candidate.version, requiredVersion(input.version),
    "trusted-control candidate version");
  assertEqual(receipt.controlPlane.repository, requiredRepository(input.repository),
    "trusted-control repository");
  assertEqual(receipt.controlPlane.sha, requiredSourceSha(input.controlPlaneSha),
    "trusted-control control-plane SHA");
  assertEqual(receipt.producer.runId, requiredPositiveIntegerString(input.runId, "run ID"),
    "trusted-control run ID");
  assertEqual(receipt.producer.runAttempt,
    requiredPositiveInteger(input.runAttempt, "run attempt"),
    "trusted-control run attempt");
}

function assertExpectedSigningInputContext(receipt, input) {
  assertEqual(receipt.candidate.sourceSha, requiredSourceSha(input.sourceSha),
    "signing-input candidate source SHA");
  assertEqual(receipt.candidate.version, requiredVersion(input.version),
    "signing-input candidate version");
  assertEqual(receipt.controlPlane.repository, requiredRepository(input.repository),
    "signing-input repository");
  assertEqual(receipt.controlPlane.sha, requiredSourceSha(input.controlPlaneSha),
    "signing-input control-plane SHA");
  assertEqual(receipt.producer.runId, requiredPositiveIntegerString(input.runId, "run ID"),
    "signing-input run ID");
  assertEqual(receipt.producer.runAttempt,
    requiredPositiveInteger(input.runAttempt, "run attempt"),
    "signing-input run attempt");
  assertEqual(receipt.platform, input.platform, "signing-input platform");
}

function requiredControlPlane(input) {
  const value = input.controlPlane ?? {
    ref: input.controlPlaneRef,
    repository: input.repository,
    sha: input.controlPlaneSha,
    workflow: CONTROL_WORKFLOW
  };
  assertExactKeys(value, ["ref", "repository", "sha", "workflow"],
    "trusted control plane");
  assertEqual(value.ref, CONTROL_REF, "trusted control-plane ref");
  assertEqual(value.workflow, CONTROL_WORKFLOW, "trusted control-plane workflow");
  return Object.freeze({
    ref: value.ref,
    repository: requiredRepository(value.repository),
    sha: requiredSourceSha(value.sha),
    workflow: value.workflow
  });
}

function requiredProducer(input) {
  const value = input.producer ?? {
    event: input.event,
    runAttempt: input.runAttempt,
    runId: input.runId
  };
  assertExactKeys(value, ["event", "runAttempt", "runId"],
    "trusted-control producer");
  assertEqual(value.event, "workflow_dispatch", "trusted-control producer event");
  return Object.freeze({
    event: value.event,
    runAttempt: requiredPositiveInteger(value.runAttempt, "producer run attempt"),
    runId: requiredPositiveIntegerString(value.runId, "producer run ID")
  });
}

async function requiredStableDirectory(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  const metadata = await lstat(resolved);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const canonical = await realpath(resolved);
  const canonicalMetadata = await lstat(canonical);
  if (!canonicalMetadata.isDirectory() || canonicalMetadata.isSymbolicLink() ||
      canonicalMetadata.dev !== metadata.dev || canonicalMetadata.ino !== metadata.ino) {
    throw new Error(`The ${label} does not resolve to its exact directory identity.`);
  }
  return Object.freeze({ canonicalPath: canonical, path: resolved });
}

async function captureClosedFileInventory(root) {
  const files = [];
  await walkDirectory(root.path, "", files);
  if (files.length === 0 || files.length > MAX_SIGNING_INPUT_FILES) {
    throw new Error("The sealed signing-input file count is invalid.");
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return deepFreeze(files);
}

async function walkDirectory(rootPath, relativeDirectory, files) {
  const directoryPath = path.join(rootPath, relativeDirectory);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error("The sealed signing input contains an unrecorded empty directory.");
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.name.includes("\n") || entry.name.includes("\r")) {
      throw new Error("The sealed signing-input inventory contains an unsafe filename.");
    }
    const relativePath = relativeDirectory
      ? `${relativeDirectory.replaceAll(path.sep, "/")}/${entry.name}`
      : entry.name;
    const absolutePath = path.join(rootPath, ...relativePath.split("/"));
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`The sealed signing input contains a symbolic link: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      await walkDirectory(rootPath, relativePath, files);
      continue;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`The sealed signing input is not a single-link regular file: ${relativePath}`);
    }
    files.push(await captureStableFileIdentity(absolutePath, relativePath));
    if (files.length > MAX_SIGNING_INPUT_FILES) {
      throw new Error("The sealed signing-input file count exceeds its bound.");
    }
  }
}

async function captureStableFileIdentity(filePath, relativePath) {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`The sealed signing input changed type: ${relativePath}`);
  }
  if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The sealed signing-input file size is invalid: ${relativePath}`);
  }
  const hash = createHash("sha256");
  let observedBytes = 0n;
  for await (const chunk of createReadStream(filePath)) {
    observedBytes += BigInt(chunk.length);
    hash.update(chunk);
  }
  const after = await lstat(filePath, { bigint: true });
  for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
    if (before[field] !== after[field]) {
      throw new Error(`The sealed signing input changed during capture: ${relativePath}`);
    }
  }
  if (observedBytes !== before.size) {
    throw new Error(`The sealed signing-input byte count changed: ${relativePath}`);
  }
  return Object.freeze({
    bytes: Number(before.size),
    path: relativePath,
    sha256: hash.digest("hex")
  });
}

function assertRequiredSigningInputFiles(platform, root, files) {
  const topLevel = new Set(files.map((file) => file.path.split("/", 1)[0]));
  const expectedTopLevel = new Set(platform.topLevelDirectories);
  if (!isDeepStrictEqual(topLevel, expectedTopLevel)) {
    throw new Error("The sealed signing-input top-level inventory is not closed.");
  }
  const controlReceipt = requireExactPath(
    files,
    `control/${CONTROL_RECEIPT_NAME}`,
    "trusted-control receipt"
  );
  const unsignedArchive = requireExactPath(
    files,
    `unsigned/${platform.archiveName}`,
    "unsigned package archive"
  );
  const blackBoxReport = requireUniqueBasename(
    files,
    SOURCE_BLACK_BOX_REPORT_NAME,
    "packaged black-box report"
  );
  const blackBoxScreenshot = requireUniqueBasename(
    files,
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
    "packaged black-box screenshot"
  );
  if (!blackBoxReport.path.startsWith("black-box/") ||
      !blackBoxScreenshot.path.startsWith("black-box/") ||
      path.posix.dirname(blackBoxReport.path) !== path.posix.dirname(blackBoxScreenshot.path)) {
    throw new Error("The packaged black-box report and screenshot are not exact siblings.");
  }
  const windowsInstallerPayloadProof = platform.windowsProofPath === null
    ? null
    : requireExactPath(files, platform.windowsProofPath, "Windows payload proof");
  assertOnlyExpectedPrefix(files, "control/", [controlReceipt.path]);
  assertOnlyExpectedPrefix(files, "unsigned/", [unsignedArchive.path]);
  if (windowsInstallerPayloadProof !== null) {
    assertOnlyExpectedPrefix(
      files,
      "windows-proof/",
      [windowsInstallerPayloadProof.path]
    );
  }
  for (const file of files) {
    const absolute = path.join(root.path, ...file.path.split("/"));
    if (!absolute.startsWith(`${root.path}${path.sep}`)) {
      throw new Error("The sealed signing-input inventory escapes its root.");
    }
  }
  return deepFreeze({
    blackBoxReport,
    blackBoxScreenshot,
    controlReceipt,
    unsignedArchive,
    windowsInstallerPayloadProof
  });
}

function assertOnlyExpectedPrefix(files, prefix, expectedPaths) {
  const observed = files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => file.path);
  if (!isDeepStrictEqual(observed, expectedPaths)) {
    throw new Error(`The sealed signing-input ${prefix} inventory is not closed.`);
  }
}

function requireExactPath(files, expectedPath, label) {
  const matches = files.filter((file) => file.path === expectedPath);
  if (matches.length !== 1) throw new Error(`The sealed signing input has no exact ${label}.`);
  return matches[0];
}

function requireUniqueBasename(files, expectedName, label) {
  const matches = files.filter((file) => path.posix.basename(file.path) === expectedName);
  if (matches.length !== 1) throw new Error(`The sealed signing input has no unique ${label}.`);
  return matches[0];
}

function assertFileIdentity(value, label) {
  assertExactKeys(value, ["bytes", "path", "sha256"], label);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw new Error(`The ${label} byte count must be a nonnegative integer.`);
  }
  requiredDigest(value.sha256, `${label} SHA-256`);
  const normalized = path.posix.normalize(requiredString(value.path, `${label} path`));
  if (normalized !== value.path || normalized.startsWith("../") ||
      normalized.startsWith("/") || normalized.includes("\\")) {
    throw new Error(`The ${label} path is invalid.`);
  }
}

async function readCanonicalFile(filePathValue, maxBytes, label) {
  const filePath = path.resolve(requiredString(filePathValue, `${label} path`));
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size <= 0 || metadata.size > maxBytes) {
    throw new Error(`The ${label} must be a bounded single-link regular file.`);
  }
  const source = await readFile(filePath);
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is invalid JSON.`, { cause: error });
  }
  if (!source.equals(serializeCanonicalJson(value))) {
    throw new Error(`The ${label} is not canonical JSON.`);
  }
  return Object.freeze({
    path: filePath,
    sha256: createHash("sha256").update(source).digest("hex"),
    value
  });
}

async function writeCanonicalCreateNew(outputPathValue, value) {
  const outputPath = path.resolve(requiredString(outputPathValue, "output path"));
  await writeFile(outputPath, serializeCanonicalJson(value), { flag: "wx", mode: 0o600 });
}

function requiredPlatform(value) {
  const platform = PLATFORM_CONTRACTS[value];
  if (!platform) throw new Error(`Unsupported production candidate platform: ${value}`);
  return platform;
}

function requiredRepository(value) {
  const repository = requiredString(value, "repository");
  if (repository !== CONTROL_REPOSITORY) {
    throw new Error("The trusted-control repository is not the fixed source repository.");
  }
  return repository;
}

function requiredSourceSha(value) {
  const sha = requiredString(value, "SHA");
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("The trusted-control SHA is invalid.");
  return sha;
}

function requiredVersion(value) {
  const version = requiredString(value, "version");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
    throw new Error("The trusted-control version is invalid.");
  }
  return version;
}

function requiredDigest(value, label) {
  const digest = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error(`The ${label} is invalid.`);
  return digest;
}

function requiredPositiveInteger(value, label) {
  const parsed = typeof value === "string" && /^[1-9]\d*$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`The ${label} must be a positive integer.`);
  }
  return parsed;
}

function requiredPositiveIntegerString(value, label) {
  const source = String(value ?? "");
  if (!/^[1-9]\d*$/u.test(source) || !Number.isSafeInteger(Number(source))) {
    throw new Error(`The ${label} must be a positive integer string.`);
  }
  return source;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The ${label} is required.`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} fields are not closed.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`The ${label} does not match.`);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("Trusted candidate control arguments are invalid or duplicated.");
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function requiredOption(options, name) {
  return requiredString(options.get(name), `--${name}`);
}

function commonCliInput(options) {
  return {
    controlPlaneSha: requiredOption(options, "control-plane-sha"),
    repository: requiredOption(options, "repository"),
    runAttempt: requiredOption(options, "run-attempt"),
    runId: requiredOption(options, "run-id"),
    sourceSha: requiredOption(options, "source-sha"),
    version: requiredOption(options, "version")
  };
}

async function runCli(argumentsList = process.argv.slice(2), environment = process.env) {
  const [command, ...rest] = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const options = parseArguments(rest);
  if (command === "create-control") {
    const receipt = await createTrustedControlReceipt({
      ...commonCliInput(options),
      controlPlaneRef: requiredOption(options, "control-plane-ref"),
      event: requiredOption(options, "event"),
      outputPath: requiredOption(options, "output"),
      ownerApproval: requiredOption(options, "owner-approval"),
      publishedAt: requiredOption(options, "published-at"),
      updaterBaseUrl: requiredOption(options, "updater-base-url"),
      updaterPublicKey: requiredString(
        environment.RION_STUDIO_UPDATER_PUBLIC_KEY,
        "RION_STUDIO_UPDATER_PUBLIC_KEY"
      )
    });
    process.stdout.write(`${JSON.stringify({
      publicKeySha256: receipt.updaterTrust.publicKeySha256,
      updaterEndpoint: receipt.candidate.updaterEndpoint
    })}\n`);
    return;
  }
  if (command === "create-signing-input") {
    await createTrustedSigningInputReceipt({
      ...commonCliInput(options),
      controlReceiptPath: requiredOption(options, "control-receipt"),
      inputRoot: requiredOption(options, "input-root"),
      outputPath: requiredOption(options, "output"),
      platform: requiredOption(options, "platform")
    });
    return;
  }
  if (command === "verify-signing-input") {
    const verified = await readTrustedSigningInputReceipt({
      ...commonCliInput(options),
      inputRoot: requiredOption(options, "input-root"),
      platform: requiredOption(options, "platform"),
      receiptPath: requiredOption(options, "receipt")
    });
    process.stdout.write(`${JSON.stringify({
      blackBoxReportPath: verified.blackBoxReportPath,
      unsignedArchivePath: verified.unsignedArchivePath,
      updaterPublicKey: verified.updaterPublicKey,
      windowsInstallerPayloadProofPath: verified.windowsInstallerPayloadProofPath
    })}\n`);
    return;
  }
  throw new Error(
    "Usage: electronProductionCandidateTrustedControl.mjs <create-control|create-signing-input|verify-signing-input> [options]"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  CONTROL_RECEIPT_NAME as ELECTRON_PRODUCTION_CANDIDATE_TRUSTED_CONTROL_RECEIPT_NAME,
  SIGNING_INPUT_RECEIPT_NAME as ELECTRON_PRODUCTION_CANDIDATE_SIGNING_INPUT_RECEIPT_NAME
};
