import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  readElectronProductionPublicationRecoveryStoreSeal
} from "./electronProductionPublicationRecovery.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "./electronProductionRecoveryCapsule.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  createElectronProductionRecoveryStoreRemoteReadRequest,
  readElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "./electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  assertEqual,
  assertExactKeys,
  readStableFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_FOUNDATION_KIND =
  "rion-electron-production-recovery-store-readback-foundation";

const OPTIONS = new Set([
  "capsule",
  "capsule-read-operation",
  "capsule-read-operation-sha256",
  "owner",
  "ref",
  "repo",
  "seal-read-operation",
  "seal-read-operation-sha256",
  "store-seal",
  "transaction-id"
]);

export async function runElectronProductionRecoveryStoreReadbackFoundationCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "verify-readback-foundation") {
    throw new Error(
      "Usage: electronProductionRecoveryStoreReadbackFoundationCli.mjs " +
      "verify-readback-foundation [strict local readback options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(options);
  const transactionPaths = electronProductionRecoveryStoreTransactionPaths({
    transactionId: requiredOption(options, "transaction-id")
  });
  const owner = requiredOption(options, "owner");
  const repo = requiredOption(options, "repo");
  const ref = requiredOption(options, "ref");
  const target = (storePath) => ({
    owner,
    repo,
    ref,
    path: storePath,
    repositoryPolicy: { defaultBranch: ref, visibility: "private" }
  });
  const [capsuleReadFile, sealReadFile] = await Promise.all([
    readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      receiptPath: requiredOption(options, "capsule-read-operation"),
      expectedSha256: requiredOption(options, "capsule-read-operation-sha256")
    }),
    readElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      receiptPath: requiredOption(options, "seal-read-operation"),
      expectedSha256: requiredOption(options, "seal-read-operation-sha256")
    })
  ]);
  const capsuleObserved = requiredPresent(
    capsuleReadFile.receipt,
    "capsule"
  );
  const sealObserved = requiredPresent(sealReadFile.receipt, "store-seal");
  const capsulePath = requiredOption(options, "capsule");
  assertEqual(
    path.basename(capsulePath),
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    "recovery capsule filename"
  );
  const capsuleFile = await readStableFile(
    capsulePath,
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS.maximumPackageBytes,
    "recovery capsule readback evidence"
  );
  const capsuleIdentity = {
    fileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    byteLength: capsuleFile.bytes,
    sha256: capsuleFile.sha256
  };
  assertObservedFile(capsuleObserved.file, capsuleIdentity, "capsule");
  assertEqual(
    capsuleObserved.blobSha,
    gitBlobSha(capsuleFile.source),
    "recovery-store capsule readback blob SHA"
  );
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
    receipt: capsuleReadFile.receipt,
    request: createElectronProductionRecoveryStoreRemoteReadRequest({
      expectedContent: capsuleReadFile.receipt.requestIdentity.expectedContent,
      target: target(transactionPaths.capsulePath)
    })
  });
  const storeSealPath = requiredOption(options, "store-seal");
  const sealSource = await readStableFile(
    storeSealPath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
    "recovery store-seal readback evidence"
  );
  const storeSealFile =
    await readElectronProductionPublicationRecoveryStoreSeal({
      receiptPath: storeSealPath,
      expectedSha256: sealObserved.file.sha256
    });
  const sealIdentity = {
    fileName: storeSealFile.receiptIdentity.fileName,
    byteLength: storeSealFile.receiptIdentity.bytes,
    sha256: storeSealFile.receiptIdentity.sha256
  };
  assertObservedFile(sealObserved.file, sealIdentity, "store-seal");
  assertEqual(
    sealSource.sha256,
    sealIdentity.sha256,
    "recovery-store seal stable SHA-256"
  );
  assertEqual(
    sealObserved.blobSha,
    gitBlobSha(sealSource.source),
    "recovery-store seal readback blob SHA"
  );
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
    receipt: sealReadFile.receipt,
    request: createElectronProductionRecoveryStoreRemoteReadRequest({
      expectedContent: sealReadFile.receipt.requestIdentity.expectedContent,
      target: target(transactionPaths.storeSealPath)
    })
  });
  assertCoherentObservation(capsuleObserved, sealObserved);
  assertSealReadbackBinding({
    capsuleIdentity,
    capsuleObserved,
    ref,
    repository: `${owner}/${repo}`,
    storeSeal: storeSealFile.receipt,
    transactionPaths
  });
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_FOUNDATION_KIND,
    status: "verified-current-readback",
    transactionId: transactionPaths.transactionId,
    target: {
      repository: `${owner}/${repo}`,
      ref,
      repositoryPolicy: { defaultBranch: ref, visibility: "private" }
    },
    paths: {
      capsule: transactionPaths.capsulePath,
      storeSeal: transactionPaths.storeSealPath
    },
    currentObservation: {
      headCommitSha: capsuleObserved.headCommitSha,
      treeSha: capsuleObserved.treeSha,
      parentCommitShas: capsuleObserved.parentCommitShas
    },
    capsule: {
      file: capsuleIdentity,
      blobSha: capsuleObserved.blobSha,
      readReceiptSha256: capsuleReadFile.receiptIdentity.sha256
    },
    storeSeal: {
      file: sealIdentity,
      blobSha: sealObserved.blobSha,
      readReceiptSha256: sealReadFile.receiptIdentity.sha256
    },
    historicalCapsuleCreate: {
      authority: "seal-recorded-not-reproved",
      parentCommitSha: storeSealFile.receipt.durableStore.parentCommitSha,
      commitSha: storeSealFile.receipt.durableStore.commitSha,
      treeSha: storeSealFile.receipt.durableStore.treeSha,
      operationReceiptSha256:
        storeSealFile.receipt.durableStore.remoteReceiptSha256
    }
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function requiredPresent(receipt, label) {
  if (receipt.terminal.classification !== "present" || receipt.observed === null) {
    throw new Error(`The ${label} recovery-store read must be present.`);
  }
  return receipt.observed;
}

function assertObservedFile(observed, actual, label) {
  for (const [left, right, field] of [
    [observed.fileName, actual.fileName, "filename"],
    [observed.byteLength, actual.byteLength, "byte length"],
    [observed.sha256, actual.sha256, "SHA-256"]
  ]) assertEqual(left, right, `recovery-store ${label} readback ${field}`);
}

function assertCoherentObservation(capsule, seal) {
  assertEqual(
    capsule.headCommitSha,
    seal.headCommitSha,
    "recovery-store readback head commit"
  );
  assertEqual(capsule.treeSha, seal.treeSha, "recovery-store readback tree");
  if (!isDeepStrictEqual(capsule.parentCommitShas, seal.parentCommitShas)) {
    throw new Error("The recovery-store readback parents do not match.");
  }
}

function assertSealReadbackBinding(input) {
  const { durableStore } = input.storeSeal;
  for (const [actual, expected, label] of [
    [input.storeSeal.transactionId, input.transactionPaths.transactionId,
      "transaction ID"],
    [input.storeSeal.capsuleFileName, input.capsuleIdentity.fileName,
      "capsule filename"],
    [input.storeSeal.capsuleBytes, input.capsuleIdentity.byteLength,
      "capsule bytes"],
    [input.storeSeal.capsuleSha256, input.capsuleIdentity.sha256,
      "capsule SHA-256"],
    [durableStore.repository, input.repository, "repository"],
    [durableStore.ref, input.ref, "ref"],
    [durableStore.path, input.transactionPaths.capsulePath, "capsule path"],
    [durableStore.repositoryPolicy.defaultBranch, input.ref, "default branch"],
    [durableStore.repositoryPolicy.visibility, "private", "visibility"],
    [durableStore.byteLength, input.capsuleIdentity.byteLength, "stored bytes"],
    [durableStore.blobSha, input.capsuleObserved.blobSha, "stored blob SHA"]
  ]) assertEqual(actual, expected, `recovery store-seal readback ${label}`);
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every readback-foundation option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid readback-foundation option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty readback-foundation option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function assertAllowedOptions(options) {
  for (const name of options.keys()) {
    if (!OPTIONS.has(name)) {
      throw new Error(`Unknown verify-readback-foundation option --${name}.`);
    }
  }
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Recovery-store readback CLI dependencies are invalid.");
  }
  assertExactKeys(overrides, ["writeStdout"].filter((name) =>
    Object.hasOwn(overrides, name)
  ), "recovery-store readback CLI dependencies");
  const writeStdout = overrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  if (typeof writeStdout !== "function") {
    throw new Error("Recovery-store readback CLI dependencies are invalid.");
  }
  return Object.freeze({ writeStdout });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runElectronProductionRecoveryStoreReadbackFoundationCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Readback verification failed."}\n`
    );
    process.exitCode = 1;
  });
}
