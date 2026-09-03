import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
  createElectronProductionRecoveryStoreRemoteRequest,
  readElectronProductionRecoveryStoreRemoteOperationReceipt,
  verifyElectronProductionRecoveryStoreRemoteOperationRequest
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "./electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  assertEqual,
  assertExactKeys,
  readStableFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_CREATE_CHAIN_VERIFICATION_KIND =
  "rion-electron-production-recovery-store-create-chain-verification";

const OPTIONS = new Set([
  "capsule",
  "capsule-operation",
  "capsule-operation-sha256",
  "owner",
  "ref",
  "repo",
  "seal-operation",
  "seal-operation-sha256",
  "store-seal",
  "transaction-id"
]);

export async function runElectronProductionRecoveryStoreCreateChainCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "verify-create-chain") {
    throw new Error(
      "Usage: electronProductionRecoveryStoreCreateChainCli.mjs " +
      "verify-create-chain [strict local evidence and target options]"
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
  const [capsuleOperationFile, sealOperationFile] = await Promise.all([
    readElectronProductionRecoveryStoreRemoteOperationReceipt({
      receiptPath: requiredOption(options, "capsule-operation"),
      expectedSha256: requiredOption(options, "capsule-operation-sha256")
    }),
    readElectronProductionRecoveryStoreRemoteOperationReceipt({
      receiptPath: requiredOption(options, "seal-operation"),
      expectedSha256: requiredOption(options, "seal-operation-sha256")
    })
  ]);
  const capsuleApplied = requiredApplied(
    capsuleOperationFile.receipt,
    "capsule-write"
  );
  const sealApplied = requiredApplied(
    sealOperationFile.receipt,
    "seal-write"
  );
  const capsulePath = requiredOption(options, "capsule");
  assertEqual(
    path.basename(capsulePath),
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    "recovery capsule filename"
  );
  const capsuleFile = await readStableFile(
    capsulePath,
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS.maximumPackageBytes,
    "recovery capsule create-chain evidence"
  );
  assertEqual(
    capsuleApplied.blobSha,
    gitBlobSha(capsuleFile.source),
    "recovery-store capsule applied blob SHA"
  );
  const storeSealPath = requiredOption(options, "store-seal");
  const sealSource = await readStableFile(
    storeSealPath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
    "recovery store-seal create-chain evidence"
  );
  const sealFile = await readElectronProductionPublicationRecoveryStoreSeal({
    receiptPath: storeSealPath,
    expectedSha256: sealOperationFile.receipt.requestIdentity.package.sha256
  });
  assertEqual(
    sealSource.sha256,
    sealFile.receiptIdentity.sha256,
    "recovery-store seal stable SHA-256"
  );
  const capsuleIdentity = {
    fileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    byteLength: capsuleFile.bytes,
    sha256: capsuleFile.sha256
  };
  verifyElectronProductionRecoveryStoreRemoteOperationRequest({
    receipt: capsuleOperationFile.receipt,
    request: createElectronProductionRecoveryStoreRemoteRequest({
      expectedHeadSha: capsuleApplied.parentCommitSha,
      packageIdentity: capsuleIdentity,
      target: target(transactionPaths.capsulePath)
    })
  });
  const storeSeal = sealFile.receipt;
  assertSealCapsuleBinding({
    capsuleApplied,
    capsuleIdentity,
    capsuleOperationSha256: capsuleOperationFile.receiptIdentity.sha256,
    repository: `${owner}/${repo}`,
    ref,
    storeSeal,
    transactionPaths
  });
  const sealIdentity = {
    fileName: sealFile.receiptIdentity.fileName,
    byteLength: sealFile.receiptIdentity.bytes,
    sha256: sealFile.receiptIdentity.sha256
  };
  verifyElectronProductionRecoveryStoreRemoteOperationRequest({
    receipt: sealOperationFile.receipt,
    request: createElectronProductionRecoveryStoreRemoteRequest({
      expectedHeadSha: capsuleApplied.commitSha,
      packageIdentity: sealIdentity,
      target: target(transactionPaths.storeSealPath)
    })
  });
  assertEqual(
    sealApplied.parentCommitSha,
    capsuleApplied.commitSha,
    "recovery-store seal-write parent"
  );
  assertEqual(
    sealApplied.blobSha,
    gitBlobSha(sealSource.source),
    "recovery-store seal applied blob SHA"
  );
  const summary = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_CREATE_CHAIN_VERIFICATION_KIND,
    status: "verified",
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
    capsule: {
      file: capsuleIdentity,
      operationReceiptSha256: capsuleOperationFile.receiptIdentity.sha256,
      applied: capsuleApplied
    },
    storeSeal: {
      file: sealIdentity,
      operationReceiptSha256: sealOperationFile.receiptIdentity.sha256,
      applied: sealApplied
    }
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

function requiredApplied(receipt, label) {
  if (receipt.terminal.classification !== "applied" || receipt.applied === null) {
    throw new Error(`The ${label} recovery-store operation must be applied.`);
  }
  return receipt.applied;
}

function assertSealCapsuleBinding(input) {
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
    [durableStore.byteLength, input.capsuleApplied.byteLength, "stored bytes"],
    [durableStore.blobSha, input.capsuleApplied.blobSha, "blob SHA"],
    [durableStore.treeSha, input.capsuleApplied.treeSha, "tree SHA"],
    [durableStore.parentCommitSha, input.capsuleApplied.parentCommitSha,
      "parent commit SHA"],
    [durableStore.commitSha, input.capsuleApplied.commitSha, "commit SHA"],
    [durableStore.remoteReceiptSha256, input.capsuleOperationSha256,
      "operation receipt SHA-256"]
  ]) assertEqual(actual, expected, `recovery store-seal ${label}`);
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every create-chain option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid create-chain option near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty create-chain option --${key}.`);
    }
    options.set(key, value);
  }
  return options;
}

function assertAllowedOptions(options) {
  for (const name of options.keys()) {
    if (!OPTIONS.has(name)) {
      throw new Error(`Unknown verify-create-chain option --${name}.`);
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
    throw new Error("Recovery-store create-chain CLI dependencies are invalid.");
  }
  assertExactKeys(overrides, ["writeStdout"].filter((name) =>
    Object.hasOwn(overrides, name)
  ), "recovery-store create-chain CLI dependencies");
  const writeStdout = overrides.writeStdout ?? ((source) => {
    process.stdout.write(source);
  });
  if (typeof writeStdout !== "function") {
    throw new Error("Recovery-store create-chain CLI dependencies are invalid.");
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
  runElectronProductionRecoveryStoreCreateChainCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Create-chain verification failed."}\n`
    );
    process.exitCode = 1;
  });
}
