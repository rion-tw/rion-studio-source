import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  readElectronProductionPublicationRecoveryOutcome,
  readElectronProductionPublicationRecoveryOutcomeAttempt
} from "./electronProductionPublicationRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
  assertElectronProductionPublicationRecoveryOutcomeChainProof,
  assertElectronProductionPublicationRecoveryOutcomeContinuityProof,
  serializeElectronProductionPublicationRecoveryOutcomeChainProof,
  serializeElectronProductionPublicationRecoveryOutcomeContinuityProof
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  createElectronProductionRecoveryStoreAtomicPairRequest,
  readElectronProductionRecoveryStoreAtomicPairOperationReceipt,
  verifyElectronProductionRecoveryStoreAtomicPairOperationRequest
} from "./electronProductionRecoveryStoreRemoteAtomicPairOperation.mjs";
import {
  createElectronProductionRecoveryStoreRemoteRequest,
  readElectronProductionRecoveryStoreRemoteOperationReceipt,
  verifyElectronProductionRecoveryStoreRemoteOperationRequest
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  electronProductionRecoveryStoreOutcomePaths
} from "./electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  assertEqual,
  assertExactKeys,
  readStableFile,
  requiredCommitSha,
  requiredDigest
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_CREATE_CHAIN_KIND =
  "rion-electron-production-recovery-store-outcome-create-chain-verification";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_APPEND_FOUNDATION_KIND =
  "rion-electron-production-recovery-store-outcome-append-foundation-verification";

const APPEND_OPTIONS = new Set([
  "attempt-outcome",
  "attempt-outcome-sha256",
  "expected-head-sha",
  "outcome-chain-proof",
  "outcome-chain-proof-sha256",
  "owner",
  "ref",
  "repo",
  "terminal-outcome",
  "terminal-outcome-sha256",
  "transaction-id"
]);
const CREATE_CHAIN_OPTIONS = new Set([
  ...APPEND_OPTIONS,
  "operation",
  "operation-sha256"
]);
const TERMINAL_OPTIONS = ["terminal-outcome", "terminal-outcome-sha256"];

export async function runElectronProductionRecoveryStoreOutcomeCreateChainCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (command !== "verify-outcome-create-chain" &&
      command !== "verify-outcome-append-foundation") {
    throw new Error(
      "Usage: electronProductionRecoveryStoreOutcomeCreateChainCli.mjs " +
      "<verify-outcome-append-foundation|verify-outcome-create-chain> " +
      "[strict local evidence and target options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertAllowedOptions(
    options,
    command === "verify-outcome-create-chain"
      ? CREATE_CHAIN_OPTIONS
      : APPEND_OPTIONS,
    command
  );
  const foundation = await verifyOutcomeAppendFoundation(options, dependencies);
  if (command === "verify-outcome-append-foundation") {
    const summary = appendFoundationSummary(foundation);
    await dependencies.writeStdout(serializeCanonicalJson(summary));
    return summary;
  }
  const operation = foundation.terminalSource === null
    ? await verifySingleCreate({
        attemptIdentity: foundation.attemptIdentity,
        attemptSource: foundation.attemptSource.source.source,
        expectedHeadSha: foundation.expectedHeadSha,
        operationPath: requiredOption(options, "operation"),
        operationSha256: requiredOption(options, "operation-sha256"),
        outcomePaths: foundation.outcomePaths,
        readOperation: dependencies.readOperation,
        target: foundation.targetForPath
      })
    : await verifyAtomicTerminalCreate({
        attemptIdentity: foundation.attemptIdentity,
        attemptSource: foundation.attemptSource.source.source,
        expectedHeadSha: foundation.expectedHeadSha,
        operationPath: requiredOption(options, "operation"),
        operationSha256: requiredOption(options, "operation-sha256"),
        outcomePaths: foundation.outcomePaths,
        readOperation: dependencies.readAtomicPairOperation,
        target: foundation.targetForPath,
        terminalIdentity: packageIdentity(
          foundation.terminalSource.file.receiptIdentity
        )
      });
  const summary = deepFreeze({
    ...appendFoundationSummary(foundation),
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_CREATE_CHAIN_KIND,
    operation
  });
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function verifyOutcomeAppendFoundation(options, dependencies) {
  const transactionId = requiredOption(options, "transaction-id");
  const owner = requiredOption(options, "owner");
  const repo = requiredOption(options, "repo");
  const ref = requiredOption(options, "ref");
  const expectedHeadSha = requiredCommitSha(
    requiredOption(options, "expected-head-sha"),
    "recovery outcome expected store head SHA"
  );
  const appendProof = await dependencies.readAppendProof({
    expectedSha256: requiredOption(options, "outcome-chain-proof-sha256"),
    proofPath: requiredOption(options, "outcome-chain-proof")
  });
  const target = (storePath) => ({
    owner,
    repo,
    ref,
    path: storePath,
    repositoryPolicy: { defaultBranch: ref, visibility: "private" }
  });
  const attemptSource = await readOutcomeSource({
    expectedSha256: requiredOption(options, "attempt-outcome-sha256"),
    label: "recovery outcome attempt create-chain evidence",
    outcomePath: requiredOption(options, "attempt-outcome"),
    readOutcome: dependencies.readOutcomeAttempt
  });
  verifyAppendFoundation({
    attempt: attemptSource.file.receipt,
    expectedHeadSha,
    proof: appendProof.proof,
    target: {
      repository: `${owner}/${repo}`,
      ref,
      repositoryPolicy: { defaultBranch: ref, visibility: "private" }
    },
    transactionId
  });
  const outcomePaths = electronProductionRecoveryStoreOutcomePaths({
    transactionId,
    recoveryRun: attemptSource.file.receipt.recoveryRun
  });
  const attemptIdentity = packageIdentity(attemptSource.file.receiptIdentity);
  const terminalSource = await readTerminalSource({
    attemptOutcome: attemptSource.file.receipt,
    attemptSource: attemptSource.source.source,
    options,
    readOutcome: dependencies.readOutcome
  });
  return {
    appendProof,
    attemptIdentity,
    attemptSource,
    expectedHeadSha,
    outcomePaths,
    target: {
      repository: `${owner}/${repo}`,
      ref,
      repositoryPolicy: { defaultBranch: ref, visibility: "private" }
    },
    targetForPath: target,
    terminalSource
  };
}

function appendFoundationSummary(foundation) {
  return deepFreeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_APPEND_FOUNDATION_KIND,
    status: "verified",
    transactionId: foundation.outcomePaths.transactionId,
    recoveryRun: foundation.outcomePaths.recoveryRun,
    target: foundation.target,
    paths: {
      attempt: foundation.outcomePaths.attemptPath,
      terminal: foundation.terminalSource === null
        ? null
        : foundation.outcomePaths.terminalPath
    },
    previousOutcomeSha256:
      foundation.attemptSource.file.receipt.previousOutcomeSha256,
    appendFoundation: {
      proofSha256: foundation.appendProof.proofIdentity.sha256,
      currentObservation: foundation.appendProof.proof.currentObservation,
      predecessor: foundation.appendProof.proof.latestOutcome
    },
    attempt: { file: foundation.attemptIdentity },
    terminal: foundation.terminalSource === null
      ? null
      : {
          file: packageIdentity(
            foundation.terminalSource.file.receiptIdentity
          )
        }
  });
}

function verifyAppendFoundation(input) {
  if (
    input.proof.terminal !== null ||
    input.proof.latestOutcome?.terminal === true ||
    input.proof.status === "terminal"
  ) {
    throw new Error("A terminal recovery outcome chain cannot be appended.");
  }
  assertEqual(input.proof.transactionId, input.transactionId,
    "recovery outcome append transaction ID");
  if (!isDeepStrictEqual(input.proof.target, input.target)) {
    throw new Error("The recovery outcome append private target does not match.");
  }
  assertEqual(input.expectedHeadSha,
    input.proof.currentObservation.headCommitSha,
    "recovery outcome append expected head");
  assertEqual(
    input.attempt.previousOutcomeSha256,
    input.proof.latestOutcome?.sha256 ?? null,
    "recovery outcome append predecessor SHA-256"
  );
  const foundation = {
    transactionId: input.attempt.transactionId,
    leaseId: input.attempt.lease.leaseId,
    generation: input.attempt.lease.generation,
    heldLeaseEventSha256: input.attempt.lease.eventSha256,
    storeSealSha256: input.attempt.durableStore.sealSha256,
    sourceStateSha256: input.attempt.source.stateSha256,
    targetStateSha256: input.attempt.target.stateSha256
  };
  for (const [name, actual] of Object.entries(foundation)) {
    assertEqual(
      actual,
      input.proof.foundation[name],
      `recovery outcome append foundation ${name}`
    );
  }
}

async function readAppendProof(input) {
  const source = await readStableFile(
    input.proofPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "recovery outcome append chain proof"
  );
  assertEqual(source.sha256,
    requiredDigest(input.expectedSha256,
      "recovery outcome append chain proof SHA-256"),
    "recovery outcome append chain proof SHA-256");
  let raw;
  try {
    raw = JSON.parse(source.source.toString("utf8"));
  } catch {
    throw new Error("The recovery outcome append chain proof is invalid JSON.");
  }
  const proof = raw?.kind ===
    "rion-electron-production-publication-recovery-outcome-chain-proof"
    ? assertElectronProductionPublicationRecoveryOutcomeChainProof(raw)
    : assertElectronProductionPublicationRecoveryOutcomeContinuityProof(raw);
  const canonical = proof.kind ===
    "rion-electron-production-publication-recovery-outcome-chain-proof"
    ? serializeElectronProductionPublicationRecoveryOutcomeChainProof(proof)
    : serializeElectronProductionPublicationRecoveryOutcomeContinuityProof(proof);
  if (!source.source.equals(canonical)) {
    throw new Error("The recovery outcome append chain proof is not canonical.");
  }
  return deepFreeze({
    proof,
    proofIdentity: {
      bytes: source.bytes,
      fileName: path.basename(input.proofPath),
      sha256: source.sha256
    }
  });
}

async function verifySingleCreate(input) {
  const operation = await input.readOperation({
    receiptPath: input.operationPath,
    expectedSha256: input.operationSha256
  });
  const applied = requiredApplied(
    operation.receipt,
    "recovery outcome attempt write"
  );
  verifyElectronProductionRecoveryStoreRemoteOperationRequest({
    receipt: operation.receipt,
    request: createElectronProductionRecoveryStoreRemoteRequest({
      expectedHeadSha: input.expectedHeadSha,
      packageIdentity: input.attemptIdentity,
      target: input.target(input.outcomePaths.attemptPath)
    })
  });
  assertEqual(applied.parentCommitSha, input.expectedHeadSha,
    "recovery outcome attempt parent");
  assertEqual(applied.blobSha, gitBlobSha(input.attemptSource),
    "recovery outcome attempt applied blob SHA");
  return deepFreeze({
    mode: "single-attempt-create",
    operationReceiptSha256: operation.receiptIdentity.sha256,
    applied
  });
}

async function verifyAtomicTerminalCreate(input) {
  const operation = await input.readOperation({
    receiptPath: input.operationPath,
    expectedSha256: input.operationSha256
  });
  const applied = requiredApplied(
    operation.receipt,
    "atomic terminal recovery outcome write"
  );
  const targets = [
    input.target(input.outcomePaths.attemptPath),
    input.target(input.outcomePaths.terminalPath)
  ];
  verifyElectronProductionRecoveryStoreAtomicPairOperationRequest({
    receipt: operation.receipt,
    request: createElectronProductionRecoveryStoreAtomicPairRequest({
      expectedHeadSha: input.expectedHeadSha,
      packageIdentities: [input.attemptIdentity, input.terminalIdentity],
      targets
    })
  });
  assertEqual(applied.parentCommitSha, input.expectedHeadSha,
    "atomic terminal recovery outcome parent");
  assertEqual(applied.blobSha, gitBlobSha(input.attemptSource),
    "atomic terminal recovery outcome applied blob SHA");
  return deepFreeze({
    mode: "atomic-terminal-pair-create",
    operationReceiptSha256: operation.receiptIdentity.sha256,
    applied
  });
}

async function readTerminalSource(input) {
  const supplied = TERMINAL_OPTIONS.filter((name) => input.options.has(name));
  if (!input.attemptOutcome.outcome.terminal) {
    if (supplied.length !== 0) {
      throw new Error(
        "A nonterminal recovery outcome attempt cannot have terminal evidence."
      );
    }
    return null;
  }
  if (supplied.length !== TERMINAL_OPTIONS.length) {
    throw new Error(
      "A terminal recovery outcome attempt requires complete terminal evidence."
    );
  }
  const terminalSource = await readOutcomeSource({
    expectedSha256: requiredOption(input.options, "terminal-outcome-sha256"),
    label: "fixed terminal recovery outcome create-chain evidence",
    outcomePath: requiredOption(input.options, "terminal-outcome"),
    readOutcome: input.readOutcome
  });
  assertEqual(terminalSource.file.receiptIdentity.fileName,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
    "fixed terminal recovery outcome filename");
  if (
    !input.attemptSource.equals(terminalSource.source.source) ||
    !isDeepStrictEqual(input.attemptOutcome, terminalSource.file.receipt)
  ) {
    throw new Error(
      "The terminal recovery outcome must be byte-identical to its terminal attempt."
    );
  }
  return terminalSource;
}

async function readOutcomeSource(input) {
  const source = await readStableFile(
    input.outcomePath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES,
    input.label
  );
  assertEqual(source.sha256,
    requiredDigest(input.expectedSha256, `${input.label} SHA-256`),
    `${input.label} SHA-256`);
  const file = await input.readOutcome({
    receiptPath: input.outcomePath,
    expectedSha256: source.sha256
  });
  for (const [actual, expected, label] of [
    [file.receiptIdentity.sha256, source.sha256, "SHA-256"],
    [file.receiptIdentity.bytes, source.bytes, "byte length"]
  ]) assertEqual(actual, expected, `${input.label} ${label}`);
  return { file, source };
}

function packageIdentity(identity) {
  return {
    fileName: identity.fileName,
    byteLength: identity.bytes,
    sha256: identity.sha256
  };
}

function requiredApplied(receipt, label) {
  if (receipt.terminal.classification !== "applied" || receipt.applied === null) {
    throw new Error(`The ${label} recovery-store operation must be applied.`);
  }
  return receipt.applied;
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every outcome create-chain option must have one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(
        `Invalid outcome create-chain option near ${name ?? "<end>"}.`
      );
    }
    const key = name.slice(2);
    if (!key || options.has(key)) {
      throw new Error(`Duplicate or empty outcome create-chain option --${key}.`);
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

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Recovery outcome create-chain CLI dependencies are invalid.");
  }
  const allowed = [
    "readAppendProof",
    "readAtomicPairOperation",
    "readOperation",
    "readOutcome",
    "readOutcomeAttempt",
    "writeStdout"
  ];
  assertExactKeys(overrides,
    allowed.filter((name) => Object.hasOwn(overrides, name)),
    "recovery outcome create-chain CLI dependencies");
  const dependencies = {
    readAppendProof: overrides.readAppendProof ?? readAppendProof,
    readAtomicPairOperation: overrides.readAtomicPairOperation ??
      readElectronProductionRecoveryStoreAtomicPairOperationReceipt,
    readOperation: overrides.readOperation ??
      readElectronProductionRecoveryStoreRemoteOperationReceipt,
    readOutcome: overrides.readOutcome ??
      readElectronProductionPublicationRecoveryOutcome,
    readOutcomeAttempt: overrides.readOutcomeAttempt ??
      readElectronProductionPublicationRecoveryOutcomeAttempt,
    writeStdout: overrides.writeStdout ?? ((source) => {
      process.stdout.write(source);
    })
  };
  if (Object.values(dependencies).some((value) => typeof value !== "function")) {
    throw new Error("Recovery outcome create-chain CLI dependencies are invalid.");
  }
  return Object.freeze(dependencies);
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
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
  runElectronProductionRecoveryStoreOutcomeCreateChainCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Outcome create-chain verification failed."}\n`
    );
    process.exitCode = 1;
  });
}
