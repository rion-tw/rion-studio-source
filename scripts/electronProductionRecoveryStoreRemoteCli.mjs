import path from "node:path";
import process from "node:process";
import { lstat, open, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
  createElectronProductionRecoveryStoreRemote,
  createElectronProductionRecoveryStoreRemoteAtomicPair,
  readElectronProductionRecoveryStoreRemote
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE,
  createElectronProductionRecoveryStoreAtomicPairOperationReceipt,
  createElectronProductionRecoveryStoreAtomicPairRequest,
  serializeElectronProductionRecoveryStoreAtomicPairOperationReceipt,
  writeElectronProductionRecoveryStoreAtomicPairOperationReceipt
} from "./electronProductionRecoveryStoreRemoteAtomicPairOperation.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadFailureReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  serializeElectronProductionRecoveryStoreRemoteOperationReceipt,
  serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  writeElectronProductionRecoveryStoreRemoteOperationReceipt,
  writeElectronProductionRecoveryStoreRemoteReadOperationReceipt
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  readStableFile,
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const CREATE_OPTIONS = new Set([
  "expected-head-sha",
  "output",
  "owner",
  "package",
  "path",
  "ref",
  "repo",
  "repository-default-branch",
  "repository-visibility"
]);
const READ_OPTIONS = new Set([
  "content-output",
  "expected-content-bytes",
  "expected-content-sha256",
  "operation-output",
  "owner",
  "path",
  "ref",
  "repo",
  "repository-default-branch",
  "repository-visibility"
]);
const ATOMIC_PAIR_OPTIONS = new Set([
  "expected-head-sha",
  "first-path",
  "output",
  "owner",
  "package",
  "ref",
  "repo",
  "repository-default-branch",
  "repository-visibility",
  "second-path"
]);

export class ElectronProductionRecoveryStoreRemoteCliFailure extends Error {
  constructor(summary) {
    const terminal = summary.receipt.terminal;
    const reason = summary.localFailure ?? terminal.reason ?? "none";
    super(`Recovery-store remote ${terminal.classification}: ${reason}.`);
    this.name = "ElectronProductionRecoveryStoreRemoteCliFailure";
    this.summary = summary;
  }
}

export async function runElectronProductionRecoveryStoreRemoteCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command === "create") {
    return runCreate(optionArguments, dependencies);
  }
  if (command === "read") {
    return runRead(optionArguments, dependencies);
  }
  if (command === "create-atomic-pair") {
    return runCreateAtomicPair(optionArguments, dependencies);
  }
  throw new Error(
    "Usage: electronProductionRecoveryStoreRemoteCli.mjs " +
    "<create|create-atomic-pair|read> [strict private-store options]"
  );
}

async function runCreateAtomicPair(optionArguments, dependencies) {
  const options = parseArguments(optionArguments);
  assertAllowedOptions(options, ATOMIC_PAIR_OPTIONS, "create-atomic-pair");
  const outputPath = await resolveCreateNewFile(
    requiredOption(options, "output"),
    ELECTRON_PRODUCTION_RECOVERY_STORE_ATOMIC_PAIR_OPERATION_FILE,
    "recovery-store atomic-pair operation receipt output"
  );
  const token = requiredToken(dependencies.environment);
  const packagePath = requiredOption(options, "package");
  const packageFile = await readStableFile(
    packagePath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
    "recovery-store atomic-pair package"
  );
  const targets = [
    targetFromOptions(options, requiredOption(options, "first-path")),
    targetFromOptions(options, requiredOption(options, "second-path"))
  ];
  const packageIdentity = (target) => ({
    fileName: path.posix.basename(target.path),
    byteLength: packageFile.bytes,
    sha256: packageFile.sha256
  });
  const request = createElectronProductionRecoveryStoreAtomicPairRequest({
    expectedHeadSha: requiredOption(options, "expected-head-sha"),
    packageIdentities: targets.map(packageIdentity),
    targets
  });
  const result = await createElectronProductionRecoveryStoreRemoteAtomicPair({
    commitMessage: request.requests[0].commitMessage,
    content: packageFile.source,
    expectedHeadSha: request.requests[0].expectedHeadSha,
    fetchImpl: dependencies.fetchImpl,
    targets,
    token
  });
  const receipt =
    createElectronProductionRecoveryStoreAtomicPairOperationReceipt({
      request,
      result
    });
  return finishOperation({
    dependencies,
    outputPath,
    receipt,
    serializeReceipt:
      serializeElectronProductionRecoveryStoreAtomicPairOperationReceipt,
    successClassification: "applied",
    writeReceipt:
      writeElectronProductionRecoveryStoreAtomicPairOperationReceipt
  });
}

async function runCreate(optionArguments, dependencies) {
  const options = parseArguments(optionArguments);
  assertAllowedOptions(options, CREATE_OPTIONS, "create");
  const outputPath = await resolveCreateNewFile(
    requiredOption(options, "output"),
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
    "recovery-store remote operation receipt output"
  );
  const token = requiredToken(dependencies.environment);
  const target = targetFromOptions(options);
  const packagePath = requiredOption(options, "package");
  const packageFile = await readStableFile(
    packagePath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
    "recovery-store package"
  );
  const request = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: requiredOption(options, "expected-head-sha"),
    packageIdentity: {
      fileName: path.basename(packagePath),
      byteLength: packageFile.bytes,
      sha256: packageFile.sha256
    },
    target
  });
  const result = await createElectronProductionRecoveryStoreRemote({
    commitMessage: request.commitMessage,
    content: packageFile.source,
    expectedHeadSha: request.expectedHeadSha,
    fetchImpl: dependencies.fetchImpl,
    target,
    token
  });
  const receipt = createElectronProductionRecoveryStoreRemoteOperationReceipt({
    request,
    result
  });
  return finishOperation({
    dependencies,
    outputPath,
    receipt,
    serializeReceipt:
      serializeElectronProductionRecoveryStoreRemoteOperationReceipt,
    successClassification: "applied",
    writeReceipt: writeElectronProductionRecoveryStoreRemoteOperationReceipt
  });
}

async function runRead(optionArguments, dependencies) {
  const options = parseArguments(optionArguments);
  assertAllowedOptions(options, READ_OPTIONS, "read");
  const target = targetFromOptions(options);
  const contentOutputPath = await resolveCreateNewFile(
    requiredOption(options, "content-output"),
    path.posix.basename(target.path),
    "recovery-store read content output"
  );
  const operationOutputPath = await resolveCreateNewFile(
    requiredOption(options, "operation-output"),
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
    "recovery-store read operation receipt output"
  );
  if (contentOutputPath === operationOutputPath) {
    throw new Error("Recovery-store read outputs must be distinct.");
  }
  const token = requiredToken(dependencies.environment);
  const request = createElectronProductionRecoveryStoreRemoteReadRequest({
    expectedContent: {
      byteLength: optionalPositiveBytes(options, "expected-content-bytes"),
      sha256: optionalOption(options, "expected-content-sha256")
    },
    target
  });
  const result = await readElectronProductionRecoveryStoreRemote({
    fetchImpl: dependencies.fetchImpl,
    target,
    token
  });
  const content = result.outcome === "present"
    ? Buffer.from(result.contentBase64, "base64")
    : null;
  let createdContentIdentity = null;
  let receipt = createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
    content,
    request,
    result
  });
  if (receipt.terminal.classification === "present") {
    try {
      if (content === null) {
        throw new ReadContentMaterializationFailure("content-output-failed");
      }
      const materialized = await materializeReadContent(
        contentOutputPath,
        content,
        dependencies.rereadContentFile
      );
      createdContentIdentity = materialized.createdIdentity;
      receipt = createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
        content: materialized.reread.source,
        request,
        result
      });
    } catch (error) {
      if (createdContentIdentity !== null) {
        await unlinkCreatedFile(contentOutputPath, createdContentIdentity);
        createdContentIdentity = null;
      }
      const reason = error instanceof ReadContentMaterializationFailure
        ? error.reason
        : "content-verification-failed";
      receipt = createElectronProductionRecoveryStoreRemoteReadFailureReceipt({
        reason,
        request
      });
    }
  }
  return finishOperation({
    dependencies,
    outputPath: operationOutputPath,
    receipt,
    serializeReceipt:
      serializeElectronProductionRecoveryStoreRemoteReadOperationReceipt,
    successClassification: "present",
    receiptWriteFailureCleanup: createdContentIdentity === null
      ? null
      : () => unlinkCreatedFile(contentOutputPath, createdContentIdentity),
    writeReceipt:
      writeElectronProductionRecoveryStoreRemoteReadOperationReceipt
  });
}

class ReadContentMaterializationFailure extends Error {
  constructor(reason) {
    super("Recovery-store read content materialization failed.");
    this.name = "ReadContentMaterializationFailure";
    this.reason = reason;
  }
}

async function materializeReadContent(outputPath, source, rereadContentFile) {
  let createdIdentity = null;
  let handle = null;
  let reason = "content-output-failed";
  try {
    handle = await open(outputPath, "wx", 0o600);
    const metadata = await handle.stat({ bigint: true });
    createdIdentity = { dev: metadata.dev, ino: metadata.ino };
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = null;
    reason = "content-verification-failed";
    const reread = await rereadContentFile(
      outputPath,
      ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
      "recovery-store read content output"
    );
    if (!source.equals(reread.source)) {
      throw new Error("The recovery-store read content output changed.");
    }
    return { createdIdentity, reread };
  } catch {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
    if (createdIdentity !== null) {
      await unlinkCreatedFile(outputPath, createdIdentity);
    }
    throw new ReadContentMaterializationFailure(reason);
  }
}

async function unlinkCreatedFile(outputPath, identity) {
  try {
    const current = await lstat(outputPath, { bigint: true });
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    ) {
      await unlink(outputPath);
    }
  } catch {
    // Missing, replaced, or unremovable output remains non-authoritative.
  }
}

async function finishOperation(input) {
  const {
    dependencies,
    outputPath,
    receipt,
    serializeReceipt,
    successClassification,
    receiptWriteFailureCleanup = null,
    writeReceipt
  } = input;
  let written;
  try {
    written = await writeReceipt({
      outputPath,
      receipt
    });
  } catch {
    if (receiptWriteFailureCleanup !== null) {
      await receiptWriteFailureCleanup();
    }
    const summary = summaryFor(receipt, null, "receipt-output-failed");
    try {
      await emitReceipt(receipt, serializeReceipt, dependencies);
    } finally {
      dependencies.setExitCode(1);
    }
    throw new ElectronProductionRecoveryStoreRemoteCliFailure(summary);
  }
  const summary = summaryFor(receipt, written.receiptIdentity, null);
  try {
    await emitReceipt(receipt, serializeReceipt, dependencies);
  } catch {
    dependencies.setExitCode(1);
    throw new ElectronProductionRecoveryStoreRemoteCliFailure(
      summaryFor(receipt, written.receiptIdentity, "stdout-output-failed")
    );
  }
  if (receipt.terminal.classification !== successClassification) {
    dependencies.setExitCode(1);
    throw new ElectronProductionRecoveryStoreRemoteCliFailure(summary);
  }
  return summary;
}

function summaryFor(receipt, receiptIdentity, localFailure) {
  return deepFreeze({ receipt, receiptIdentity, localFailure });
}

async function emitReceipt(receipt, serializeReceipt, dependencies) {
  await dependencies.writeStdout(serializeReceipt(receipt));
}

function targetFromOptions(options, targetPath = requiredOption(options, "path")) {
  return {
    owner: requiredOption(options, "owner"),
    repo: requiredOption(options, "repo"),
    ref: requiredOption(options, "ref"),
    path: targetPath,
    repositoryPolicy: {
      defaultBranch: requiredOption(options, "repository-default-branch"),
      visibility: requiredOption(options, "repository-visibility")
    }
  };
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every recovery-store CLI option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid recovery-store CLI option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty recovery-store CLI option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function assertAllowedOptions(options, allowed, command) {
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown ${command} option --${name}.`);
    }
  }
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function optionalOption(options, name) {
  if (!options.has(name)) return null;
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} must not be empty.`);
  return value;
}

function optionalPositiveBytes(options, name) {
  const value = optionalOption(options, name);
  if (value === null) return null;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`--${name} must be a positive decimal byte count.`);
  }
  const bytes = Number(value);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
  ) {
    throw new Error(`--${name} exceeds the recovery-store content bound.`);
  }
  return bytes;
}

function requiredToken(environment) {
  const token = environment.GH_TOKEN;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 4096 ||
    /\s/u.test(token)
  ) {
    throw new Error("GH_TOKEN is required for the recovery-store remote CLI.");
  }
  return token;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Recovery-store CLI dependencies must be an object.");
  }
  const allowed = new Set([
    "environment",
    "fetchImpl",
    "rereadContentFile",
    "setExitCode",
    "writeStdout"
  ]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown recovery-store CLI dependency ${name}.`);
    }
  }
  const environment = overrides.environment ?? process.env;
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const rereadContentFile = overrides.rereadContentFile ?? readStableFile;
  const setExitCode = overrides.setExitCode ?? ((code) => {
    process.exitCode = code;
  });
  const writeStdout = overrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  if (
    !environment ||
    typeof environment !== "object" ||
    typeof fetchImpl !== "function" ||
    typeof rereadContentFile !== "function" ||
    typeof setExitCode !== "function" ||
    typeof writeStdout !== "function"
  ) {
    throw new Error("Recovery-store CLI dependencies are invalid.");
  }
  return Object.freeze({
    environment,
    fetchImpl,
    rereadContentFile,
    setExitCode,
    writeStdout
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionRecoveryStoreRemoteCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Recovery-store CLI failed."}\n`
    );
    process.exitCode = 1;
  });
}
