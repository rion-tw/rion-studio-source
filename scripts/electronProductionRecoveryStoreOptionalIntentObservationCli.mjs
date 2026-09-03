import { createHash } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  readElectronProductionPublicationRecoveryOutcomeChainProof,
  readElectronProductionPublicationRecoveryOutcomeContinuityProof,
  readElectronProductionPublicationRecoveryOutcomeDiscovery
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_BYTES,
  assertElectronProductionPublicationRecoveryLeaseReleaseIntent,
  electronProductionPublicationRecoveryLeaseReleaseIntentPath,
  serializeElectronProductionPublicationRecoveryLeaseReleaseIntent
} from "./electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_BYTES,
  assertElectronProductionPublicationRecoveryPublicMutationAttempt,
  electronProductionPublicationRecoveryPublicMutationAttemptPath,
  serializeElectronProductionPublicationRecoveryPublicMutationAttempt
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  readElectronProductionRecoveryStoreRemote
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  assertEqual,
  assertExactKeys,
  readStableFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredRfc3339,
  resolveCreateNewFile
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_KIND =
  "rion-electron-production-recovery-store-optional-intent-observation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_FILE =
  "electron-production-recovery-store-optional-intent-observation.json";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_KIND =
  "rion-electron-production-recovery-store-optional-public-mutation-attempt-observation";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_FILE =
  "electron-production-recovery-store-optional-public-mutation-attempt-observation.json";
export const ELECTRON_PRODUCTION_RECOVERY_STORE_MAX_OPTIONAL_INTENT_OBSERVATION_BYTES =
  128 * 1024;

const COMMAND_OPTIONS = Object.freeze({
  observe: new Set([
    "discovery",
    "discovery-sha256",
    "observed-at",
    "output",
    "owner",
    "ref",
    "repo",
    "repository-default-branch",
    "repository-visibility",
    "transaction-id"
  ]),
  verify: new Set([
    "discovery",
    "discovery-sha256",
    "observation",
    "observation-sha256"
  ]),
  "verify-continuity": new Set([
    "fresh-observation",
    "fresh-observation-sha256",
    "initial-observation",
    "initial-observation-sha256",
    "outcome-continuity",
    "outcome-continuity-sha256"
  ]),
  "observe-mutation-attempt": new Set([
    "discovery",
    "discovery-sha256",
    "observed-at",
    "outcome-chain-proof",
    "outcome-chain-proof-sha256",
    "output",
    "owner",
    "ref",
    "repo",
    "repository-default-branch",
    "repository-visibility",
    "transaction-id"
  ]),
  "verify-mutation-attempt": new Set([
    "discovery",
    "discovery-sha256",
    "observation",
    "observation-sha256",
    "outcome-chain-proof",
    "outcome-chain-proof-sha256",
    "transaction-id"
  ])
});

export async function runElectronProductionRecoveryStoreOptionalIntentObservationCli(
  argumentsList = process.argv.slice(2),
  dependencyOverrides = {}
) {
  const dependencies = resolveDependencies(dependencyOverrides);
  const normalized = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  const [command, ...optionArguments] = normalized;
  if (!Object.hasOwn(COMMAND_OPTIONS, command ?? "")) {
    throw new Error(
      "Usage: electronProductionRecoveryStoreOptionalIntentObservationCli.mjs " +
      "<observe|verify|verify-continuity|observe-mutation-attempt|" +
      "verify-mutation-attempt> [strict options]"
    );
  }
  const options = parseArguments(optionArguments);
  assertOptions(command, options);
  let summary;
  if (command === "observe") {
    summary = await observeOptionalIntent(options, dependencies);
  } else if (command === "verify") {
    summary = await verifyOptionalIntent(options);
  } else if (command === "verify-continuity") {
    summary = await verifyOptionalIntentContinuity(options);
  } else if (command === "observe-mutation-attempt") {
    summary = await observeOptionalMutationAttempt(options, dependencies);
  } else {
    summary = await verifyOptionalMutationAttempt(options);
  }
  await dependencies.writeStdout(serializeCanonicalJson(summary));
  return summary;
}

async function observeOptionalIntent(options, dependencies) {
  const outputPath = await resolveCreateNewFile(
    requiredOption(options, "output"),
    ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_FILE,
    "optional recovery intent observation output"
  );
  const transactionId = requiredOption(options, "transaction-id");
  const discovery = await readElectronProductionPublicationRecoveryOutcomeDiscovery({
    receiptPath: requiredOption(options, "discovery"),
    expectedSha256: requiredOption(options, "discovery-sha256")
  });
  const target = {
    owner: requiredOption(options, "owner"),
    repo: requiredOption(options, "repo"),
    ref: requiredOption(options, "ref"),
    path: electronProductionPublicationRecoveryLeaseReleaseIntentPath({
      transactionId
    }),
    repositoryPolicy: {
      defaultBranch: requiredOption(options, "repository-default-branch"),
      visibility: requiredPrivateVisibility(options)
    }
  };
  assertEqual(discovery.value.transactionId, transactionId,
    "optional intent discovery transaction ID");
  const discoveryTarget = {
    repository: `${target.owner}/${target.repo}`,
    ref: target.ref,
    repositoryPolicy: target.repositoryPolicy
  };
  if (!isDeepStrictEqual(discovery.value.target, discoveryTarget)) {
    throw new Error("The optional intent target does not match outcome discovery.");
  }
  const result = await dependencies.readRemote({
    fetchImpl: dependencies.fetchImpl,
    target,
    token: requiredToken(dependencies.environment)
  });
  if (result.outcome !== "present" && result.outcome !== "absent") {
    throw new Error("The optional intent observation was not authoritative.");
  }
  const currentObservation = {
    headCommitSha: result.headSha,
    treeSha: result.treeSha,
    parentCommitShas: result.parentShas
  };
  if (!isDeepStrictEqual(
    currentObservation,
    discovery.value.currentObservation
  )) {
    throw new Error(
      "The optional intent observation is not from the outcome-discovery head."
    );
  }
  const intent = result.outcome === "absent"
    ? { status: "absent-at-head" }
    : presentIntent(result, target, transactionId);
  const observation =
    assertElectronProductionRecoveryStoreOptionalIntentObservation({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_KIND,
    status: "same-head-optional-intent-observation",
    transactionId,
    target: discoveryTarget,
    path: target.path,
    discoveryReceiptSha256: discovery.valueIdentity.sha256,
    currentObservation,
    intent,
    observedAt: requiredOption(options, "observed-at")
    });
  const written = await writeObservation(outputPath, observation);
  return deepFreeze({
    schemaVersion: 1,
    kind:
      "rion-electron-production-recovery-store-optional-intent-observation-cli-summary",
    command: "observe",
    status: "verified",
    transactionId,
    currentObservation,
    intent: observation.intent,
    output: written.identity
  });
}

async function verifyOptionalIntent(options) {
  const [observation, discovery] = await Promise.all([
    readElectronProductionRecoveryStoreOptionalIntentObservation({
      observationPath: requiredOption(options, "observation"),
      expectedSha256: requiredOption(options, "observation-sha256")
    }),
    readElectronProductionPublicationRecoveryOutcomeDiscovery({
      receiptPath: requiredOption(options, "discovery"),
      expectedSha256: requiredOption(options, "discovery-sha256")
    })
  ]);
  const value = observation.value;
  for (const [actual, expected, label] of [
    [value.transactionId, discovery.value.transactionId, "transaction ID"],
    [value.target, discovery.value.target, "private target"],
    [value.currentObservation, discovery.value.currentObservation,
      "head/tree observation"],
    [value.discoveryReceiptSha256, discovery.valueIdentity.sha256,
      "discovery receipt SHA-256"]
  ]) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`The optional intent ${label} does not match discovery.`);
    }
  }
  return deepFreeze({
    schemaVersion: 1,
    kind:
      "rion-electron-production-recovery-store-optional-intent-observation-cli-summary",
    command: "verify",
    status: "verified",
    transactionId: value.transactionId,
    currentObservation: value.currentObservation,
    intent: value.intent,
    output: observation.valueIdentity
  });
}

async function verifyOptionalIntentContinuity(options) {
  const [initial, fresh, continuity] = await Promise.all([
    readElectronProductionRecoveryStoreOptionalIntentObservation({
      observationPath: requiredOption(options, "initial-observation"),
      expectedSha256: requiredOption(
        options,
        "initial-observation-sha256"
      )
    }),
    readElectronProductionRecoveryStoreOptionalIntentObservation({
      observationPath: requiredOption(options, "fresh-observation"),
      expectedSha256: requiredOption(options, "fresh-observation-sha256")
    }),
    readElectronProductionPublicationRecoveryOutcomeContinuityProof({
      receiptPath: requiredOption(options, "outcome-continuity"),
      expectedSha256: requiredOption(options, "outcome-continuity-sha256")
    })
  ]);
  if (initial.valuePath === fresh.valuePath) {
    throw new Error("Optional intent continuity requires distinct observations.");
  }
  for (const [actual, expected, label] of [
    [fresh.value.transactionId, initial.value.transactionId, "transaction ID"],
    [fresh.value.target, initial.value.target, "private target"],
    [fresh.value.path, initial.value.path, "fixed path"],
    [fresh.value.currentObservation, initial.value.currentObservation,
      "head/tree observation"],
    [fresh.value.intent, initial.value.intent, "presence and identity"],
    [initial.value.transactionId, continuity.value.transactionId,
      "outcome transaction ID"],
    [initial.value.target, continuity.value.target, "outcome private target"],
    [initial.value.currentObservation, continuity.value.currentObservation,
      "outcome head/tree observation"],
    [initial.value.discoveryReceiptSha256,
      continuity.value.discoveryReceipts.initialSha256,
      "initial discovery receipt SHA-256"],
    [fresh.value.discoveryReceiptSha256,
      continuity.value.discoveryReceipts.freshSha256,
      "fresh discovery receipt SHA-256"]
  ]) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(`The optional intent continuity ${label} changed.`);
    }
  }
  return deepFreeze({
    schemaVersion: 1,
    kind:
      "rion-electron-production-recovery-store-optional-intent-observation-cli-summary",
    command: "verify-continuity",
    status: "verified",
    transactionId: initial.value.transactionId,
    currentObservation: initial.value.currentObservation,
    intent: initial.value.intent,
    output: {
      initialObservationSha256: initial.valueIdentity.sha256,
      freshObservationSha256: fresh.valueIdentity.sha256,
      outcomeContinuitySha256: continuity.valueIdentity.sha256
    }
  });
}

async function observeOptionalMutationAttempt(options, dependencies) {
  const outputPath = await resolveCreateNewFile(
    requiredOption(options, "output"),
    ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_FILE,
    "optional public-mutation attempt observation output"
  );
  const foundation = await readMutationAttemptObservationFoundation(options);
  const target = {
    owner: requiredOption(options, "owner"),
    repo: requiredOption(options, "repo"),
    ref: requiredOption(options, "ref"),
    path: foundation.path,
    repositoryPolicy: {
      defaultBranch: requiredOption(options, "repository-default-branch"),
      visibility: requiredPrivateVisibility(options)
    }
  };
  const discoveryTarget = {
    repository: `${target.owner}/${target.repo}`,
    ref: target.ref,
    repositoryPolicy: target.repositoryPolicy
  };
  if (!isDeepStrictEqual(foundation.discovery.value.target, discoveryTarget)) {
    throw new Error(
      "The optional public-mutation target does not match outcome discovery."
    );
  }
  const result = await dependencies.readRemote({
    fetchImpl: dependencies.fetchImpl,
    target,
    token: requiredToken(dependencies.environment)
  });
  if (result.outcome !== "present" && result.outcome !== "absent") {
    throw new Error(
      "The optional public-mutation attempt observation was not authoritative."
    );
  }
  const currentObservation = {
    headCommitSha: result.headSha,
    treeSha: result.treeSha,
    parentCommitShas: result.parentShas
  };
  if (!isDeepStrictEqual(
    currentObservation,
    foundation.discovery.value.currentObservation
  )) {
    throw new Error(
      "The optional public-mutation attempt is not from the discovery head."
    );
  }
  const attempt = result.outcome === "absent"
    ? { status: "absent-at-head" }
    : presentMutationAttempt(result, target, foundation);
  const observation =
    assertElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation({
      schemaVersion: 1,
      kind:
        ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_KIND,
      status: "same-head-optional-public-mutation-attempt-observation",
      transactionId: foundation.transactionId,
      target: discoveryTarget,
      path: foundation.path,
      predecessorOutcomeSha256: foundation.predecessorOutcomeSha256,
      discoveryReceiptSha256: foundation.discovery.valueIdentity.sha256,
      outcomeChainProofSha256: foundation.proof.valueIdentity.sha256,
      currentObservation,
      attempt,
      observedAt: requiredOption(options, "observed-at")
    });
  const written = await writeMutationAttemptObservation(outputPath, observation);
  return mutationAttemptSummary("observe-mutation-attempt", written.identity,
    observation);
}

async function verifyOptionalMutationAttempt(options) {
  const [observation, foundation] = await Promise.all([
    readElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation({
      observationPath: requiredOption(options, "observation"),
      expectedSha256: requiredOption(options, "observation-sha256")
    }),
    readMutationAttemptObservationFoundation(options)
  ]);
  const value = observation.value;
  for (const [actual, expected, label] of [
    [value.transactionId, foundation.transactionId, "transaction ID"],
    [value.target, foundation.discovery.value.target, "private target"],
    [value.path, foundation.path, "derived marker path"],
    [value.predecessorOutcomeSha256, foundation.predecessorOutcomeSha256,
      "predecessor outcome SHA-256"],
    [value.currentObservation, foundation.discovery.value.currentObservation,
      "head/tree observation"],
    [value.discoveryReceiptSha256, foundation.discovery.valueIdentity.sha256,
      "discovery receipt SHA-256"],
    [value.outcomeChainProofSha256, foundation.proof.valueIdentity.sha256,
      "outcome-chain proof SHA-256"]
  ]) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `The optional public-mutation attempt ${label} does not match discovery.`
      );
    }
  }
  return mutationAttemptSummary(
    "verify-mutation-attempt",
    observation.valueIdentity,
    value
  );
}

async function readMutationAttemptObservationFoundation(options) {
  const transactionId = requiredOption(options, "transaction-id");
  const [discovery, proof] = await Promise.all([
    readElectronProductionPublicationRecoveryOutcomeDiscovery({
      receiptPath: requiredOption(options, "discovery"),
      expectedSha256: requiredOption(options, "discovery-sha256")
    }),
    readElectronProductionPublicationRecoveryOutcomeChainProof({
      receiptPath: requiredOption(options, "outcome-chain-proof"),
      expectedSha256: requiredOption(options, "outcome-chain-proof-sha256")
    })
  ]);
  assertEqual(discovery.value.transactionId, transactionId,
    "optional public-mutation discovery transaction ID");
  for (const [actual, expected, label] of [
    [proof.value.transactionId, transactionId, "proof transaction ID"],
    [proof.value.discoveryReceiptSha256, discovery.valueIdentity.sha256,
      "proof discovery receipt SHA-256"],
    [proof.value.target, discovery.value.target, "proof private target"],
    [proof.value.currentObservation, discovery.value.currentObservation,
      "proof head/tree observation"],
    [proof.value.outcomeDirectory, discovery.value.outcomeDirectory,
      "proof outcome directory"]
  ]) {
    if (!isDeepStrictEqual(actual, expected)) {
      throw new Error(
        `The optional public-mutation ${label} does not match discovery.`
      );
    }
  }
  if (proof.value.status === "terminal" ||
      proof.value.latestOutcome?.terminal === true) {
    throw new Error(
      "A terminal recovery outcome chain cannot reserve public mutation."
    );
  }
  const predecessorOutcomeSha256 = proof.value.latestOutcome?.sha256 ?? null;
  return deepFreeze({
    transactionId,
    discovery,
    proof,
    predecessorOutcomeSha256,
    path: electronProductionPublicationRecoveryPublicMutationAttemptPath({
      transactionId,
      previousOutcomeSha256: predecessorOutcomeSha256
    })
  });
}

function presentMutationAttempt(result, target, foundation) {
  const source = Buffer.from(result.contentBase64, "base64");
  if (
    source.length <= 0 ||
    source.length !== result.byteLength ||
    gitBlobSha(source) !== result.blobSha ||
    source.length >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_BYTES
  ) {
    throw new Error("The optional public-mutation attempt exceeds its size bound.");
  }
  let raw;
  try {
    raw = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("The optional public-mutation attempt is invalid JSON.");
  }
  const attempt =
    assertElectronProductionPublicationRecoveryPublicMutationAttempt(raw);
  if (!source.equals(
    serializeElectronProductionPublicationRecoveryPublicMutationAttempt(attempt)
  )) {
    throw new Error("The optional public-mutation attempt is not canonical.");
  }
  assertEqual(attempt.transactionId, foundation.transactionId,
    "optional public-mutation attempt transaction ID");
  assertEqual(attempt.privateStore.path, target.path,
    "optional public-mutation attempt private path");
  const predecessor = attempt.authority.predecessor?.sha256 ?? null;
  assertEqual(predecessor, foundation.predecessorOutcomeSha256,
    "optional public-mutation attempt predecessor SHA-256");
  const observedTarget = {
    repository: `${target.owner}/${target.repo}`,
    ref: target.ref,
    repositoryPolicy: target.repositoryPolicy
  };
  if (!isDeepStrictEqual(attempt.privateStore.target, observedTarget)) {
    throw new Error(
      "The optional public-mutation attempt private target does not match."
    );
  }
  return {
    status: "present-at-head",
    blobSha: result.blobSha,
    operation: attempt.operation,
    file: {
      fileName: path.posix.basename(target.path),
      byteLength: source.length,
      sha256: sha256(source)
    }
  };
}

function mutationAttemptSummary(command, output, observation) {
  return deepFreeze({
    schemaVersion: 1,
    kind:
      "rion-electron-production-recovery-store-optional-public-mutation-attempt-observation-cli-summary",
    command,
    status: "verified",
    transactionId: observation.transactionId,
    currentObservation: observation.currentObservation,
    predecessorOutcomeSha256: observation.predecessorOutcomeSha256,
    attempt: observation.attempt,
    output
  });
}

export function assertElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
  value
) {
  assertExactKeys(value, [
    "attempt",
    "currentObservation",
    "discoveryReceiptSha256",
    "kind",
    "observedAt",
    "outcomeChainProofSha256",
    "path",
    "predecessorOutcomeSha256",
    "schemaVersion",
    "status",
    "target",
    "transactionId"
  ], "optional public-mutation attempt observation");
  assertEqual(value.schemaVersion, 1,
    "optional public-mutation attempt observation schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_KIND,
    "optional public-mutation attempt observation kind"
  );
  assertEqual(
    value.status,
    "same-head-optional-public-mutation-attempt-observation",
    "optional public-mutation attempt observation status"
  );
  const transactionId = requiredUuid(
    value.transactionId,
    "optional public-mutation attempt transaction ID"
  );
  const predecessorOutcomeSha256 = value.predecessorOutcomeSha256 === null
    ? null
    : requiredDigest(
        value.predecessorOutcomeSha256,
        "optional public-mutation predecessor SHA-256"
      );
  const expectedPath =
    electronProductionPublicationRecoveryPublicMutationAttemptPath({
      transactionId,
      previousOutcomeSha256: predecessorOutcomeSha256
    });
  assertEqual(value.path, expectedPath,
    "optional public-mutation attempt path");
  return deepFreeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_KIND,
    status: "same-head-optional-public-mutation-attempt-observation",
    transactionId,
    target: assertTarget(value.target),
    path: expectedPath,
    predecessorOutcomeSha256,
    discoveryReceiptSha256: requiredDigest(
      value.discoveryReceiptSha256,
      "optional public-mutation discovery receipt SHA-256"
    ),
    outcomeChainProofSha256: requiredDigest(
      value.outcomeChainProofSha256,
      "optional public-mutation outcome-chain proof SHA-256"
    ),
    currentObservation: assertCurrentObservation(value.currentObservation),
    attempt: assertMutationAttemptObservation(value.attempt, expectedPath),
    observedAt: requiredRfc3339(
      value.observedAt,
      "optional public-mutation attempt observation time"
    )
  });
}

export function serializeElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
      value
    )
  );
}

export async function readElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
  input
) {
  assertExactKeys(input, ["expectedSha256", "observationPath"],
    "optional public-mutation attempt observation read input");
  const observationPath = requiredAbsolutePath(
    input.observationPath,
    "optional public-mutation attempt observation path"
  );
  const file = await readStableFile(
    observationPath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_MAX_OPTIONAL_INTENT_OBSERVATION_BYTES,
    "optional public-mutation attempt observation"
  );
  assertEqual(file.sha256,
    requiredDigest(input.expectedSha256,
      "optional public-mutation attempt observation SHA-256"),
    "optional public-mutation attempt observation SHA-256");
  let raw;
  try {
    raw = JSON.parse(file.source.toString("utf8"));
  } catch {
    throw new Error(
      "The optional public-mutation attempt observation is invalid JSON."
    );
  }
  const value =
    assertElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
      raw
    );
  if (!file.source.equals(
    serializeElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
      value
    )
  )) {
    throw new Error(
      "The optional public-mutation attempt observation is not canonical."
    );
  }
  return deepFreeze({
    value,
    valueIdentity: {
      bytes: file.bytes,
      fileName: path.basename(observationPath),
      sha256: file.sha256
    },
    valuePath: observationPath
  });
}

function assertMutationAttemptObservation(value, expectedPath) {
  if (value?.status === "absent-at-head") {
    assertExactKeys(value, ["status"],
      "absent optional public-mutation attempt");
    return Object.freeze({ status: "absent-at-head" });
  }
  assertExactKeys(value, ["blobSha", "file", "operation", "status"],
    "present optional public-mutation attempt");
  assertEqual(value.status, "present-at-head",
    "present optional public-mutation attempt status");
  if (value.operation !== "rollback-public-latest" &&
      value.operation !== "release-held-lease") {
    throw new Error(
      "The present optional public-mutation attempt operation is invalid."
    );
  }
  assertExactKeys(value.file, ["byteLength", "fileName", "sha256"],
    "present optional public-mutation attempt file");
  assertEqual(value.file.fileName, path.posix.basename(expectedPath),
    "present optional public-mutation attempt filename");
  if (!Number.isSafeInteger(value.file.byteLength) ||
      value.file.byteLength <= 0 ||
      value.file.byteLength >
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_BYTES) {
    throw new Error(
      "The present optional public-mutation attempt bytes are invalid."
    );
  }
  return deepFreeze({
    status: "present-at-head",
    blobSha: requiredObjectSha(value.blobSha,
      "present optional public-mutation attempt blob SHA"),
    operation: value.operation,
    file: {
      fileName: value.file.fileName,
      byteLength: value.file.byteLength,
      sha256: requiredDigest(value.file.sha256,
        "present optional public-mutation attempt SHA-256")
    }
  });
}

export function assertElectronProductionRecoveryStoreOptionalIntentObservation(
  value
) {
  assertExactKeys(value, [
    "currentObservation",
    "discoveryReceiptSha256",
    "intent",
    "kind",
    "observedAt",
    "path",
    "schemaVersion",
    "status",
    "target",
    "transactionId"
  ], "optional recovery intent observation");
  assertEqual(value.schemaVersion, 1,
    "optional recovery intent observation schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_KIND,
    "optional recovery intent observation kind"
  );
  assertEqual(value.status, "same-head-optional-intent-observation",
    "optional recovery intent observation status");
  const transactionId = requiredUuid(
    value.transactionId,
    "optional recovery intent transaction ID"
  );
  const expectedPath =
    electronProductionPublicationRecoveryLeaseReleaseIntentPath({
      transactionId
    });
  assertEqual(value.path, expectedPath, "optional recovery intent path");
  const target = assertTarget(value.target);
  const currentObservation = assertCurrentObservation(value.currentObservation);
  const intent = assertIntentObservation(value.intent, expectedPath);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_KIND,
    status: "same-head-optional-intent-observation",
    transactionId,
    target,
    path: expectedPath,
    discoveryReceiptSha256: requiredDigest(
      value.discoveryReceiptSha256,
      "optional intent discovery receipt SHA-256"
    ),
    currentObservation,
    intent,
    observedAt: requiredRfc3339(
      value.observedAt,
      "optional recovery intent observation time"
    )
  });
}

export function serializeElectronProductionRecoveryStoreOptionalIntentObservation(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionRecoveryStoreOptionalIntentObservation(value)
  );
}

export async function readElectronProductionRecoveryStoreOptionalIntentObservation(
  input
) {
  assertExactKeys(input, ["expectedSha256", "observationPath"],
    "optional recovery intent observation read input");
  const observationPath = requiredAbsolutePath(
    input.observationPath,
    "optional recovery intent observation path"
  );
  const file = await readStableFile(
    observationPath,
    ELECTRON_PRODUCTION_RECOVERY_STORE_MAX_OPTIONAL_INTENT_OBSERVATION_BYTES,
    "optional recovery intent observation"
  );
  assertEqual(file.sha256,
    requiredDigest(input.expectedSha256,
      "optional recovery intent observation SHA-256"),
    "optional recovery intent observation SHA-256");
  let raw;
  try {
    raw = JSON.parse(file.source.toString("utf8"));
  } catch {
    throw new Error("The optional recovery intent observation is invalid JSON.");
  }
  const value =
    assertElectronProductionRecoveryStoreOptionalIntentObservation(raw);
  if (!file.source.equals(
    serializeElectronProductionRecoveryStoreOptionalIntentObservation(value)
  )) {
    throw new Error("The optional recovery intent observation is not canonical.");
  }
  return deepFreeze({
    value,
    valueIdentity: {
      bytes: file.bytes,
      fileName: path.basename(observationPath),
      sha256: file.sha256
    },
    valuePath: observationPath
  });
}

function presentIntent(result, target, transactionId) {
  const source = Buffer.from(result.contentBase64, "base64");
  if (
    source.length <= 0 ||
    source.length !== result.byteLength ||
    gitBlobSha(source) !== result.blobSha ||
    source.length >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_BYTES
  ) {
    throw new Error("The optional recovery intent exceeds its size bound.");
  }
  let raw;
  try {
    raw = JSON.parse(source.toString("utf8"));
  } catch {
    throw new Error("The optional recovery intent is invalid JSON.");
  }
  const intent =
    assertElectronProductionPublicationRecoveryLeaseReleaseIntent(raw);
  if (!source.equals(
    serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(intent)
  )) {
    throw new Error("The optional recovery intent is not canonical.");
  }
  assertEqual(intent.transactionId, transactionId,
    "optional recovery intent transaction ID");
  assertEqual(intent.privateStore.path, target.path,
    "optional recovery intent private path");
  const intentTarget = intent.privateStore.target;
  const observedTarget = {
    repository: `${target.owner}/${target.repo}`,
    ref: target.ref,
    repositoryPolicy: target.repositoryPolicy
  };
  if (!isDeepStrictEqual(intentTarget, observedTarget)) {
    throw new Error("The optional recovery intent private target does not match.");
  }
  return {
    status: "present-at-head",
    blobSha: result.blobSha,
    file: {
      fileName: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE,
      byteLength: source.length,
      sha256: sha256(source)
    }
  };
}

function assertIntentObservation(value, expectedPath) {
  if (value?.status === "absent-at-head") {
    assertExactKeys(value, ["status"], "absent optional recovery intent");
    return Object.freeze({ status: "absent-at-head" });
  }
  assertExactKeys(value, ["blobSha", "file", "status"],
    "present optional recovery intent");
  assertEqual(value.status, "present-at-head",
    "present optional recovery intent status");
  assertExactKeys(value.file, ["byteLength", "fileName", "sha256"],
    "present optional recovery intent file");
  assertEqual(
    value.file.fileName,
    path.posix.basename(expectedPath),
    "present optional recovery intent filename"
  );
  if (!Number.isSafeInteger(value.file.byteLength) ||
      value.file.byteLength <= 0 ||
      value.file.byteLength >
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_BYTES) {
    throw new Error("The present optional recovery intent bytes are invalid.");
  }
  return deepFreeze({
    status: "present-at-head",
    blobSha: requiredObjectSha(value.blobSha,
      "present optional recovery intent blob SHA"),
    file: {
      fileName: value.file.fileName,
      byteLength: value.file.byteLength,
      sha256: requiredDigest(value.file.sha256,
        "present optional recovery intent SHA-256")
    }
  });
}

function assertTarget(value) {
  assertExactKeys(value, ["ref", "repository", "repositoryPolicy"],
    "optional recovery intent target");
  if (typeof value.repository !== "string" ||
      !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/u.test(
        value.repository
      )) {
    throw new Error("The optional recovery intent repository is invalid.");
  }
  if (typeof value.ref !== "string" || value.ref.length === 0 ||
      value.ref.length > 255) {
    throw new Error("The optional recovery intent ref is invalid.");
  }
  assertExactKeys(value.repositoryPolicy, ["defaultBranch", "visibility"],
    "optional recovery intent repository policy");
  assertEqual(value.repositoryPolicy.visibility, "private",
    "optional recovery intent repository visibility");
  assertEqual(value.repositoryPolicy.defaultBranch, value.ref,
    "optional recovery intent default branch");
  return deepFreeze({
    repository: value.repository,
    ref: value.ref,
    repositoryPolicy: {
      defaultBranch: value.ref,
      visibility: "private"
    }
  });
}

function assertCurrentObservation(value) {
  assertExactKeys(value, ["headCommitSha", "parentCommitShas", "treeSha"],
    "optional recovery intent current observation");
  if (!Array.isArray(value.parentCommitShas) ||
      value.parentCommitShas.length !== 1) {
    throw new Error("The optional recovery intent head must be linear.");
  }
  return deepFreeze({
    headCommitSha: requiredObjectSha(value.headCommitSha,
      "optional recovery intent head SHA"),
    treeSha: requiredObjectSha(value.treeSha,
      "optional recovery intent tree SHA"),
    parentCommitShas: [requiredObjectSha(
      value.parentCommitShas[0],
      "optional recovery intent parent SHA"
    )]
  });
}

async function writeObservation(outputPath, value) {
  const source =
    serializeElectronProductionRecoveryStoreOptionalIntentObservation(value);
  let handle = null;
  let identity = null;
  try {
    handle = await open(outputPath, "wx", 0o600);
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new Error("The optional intent observation output is not a regular file.");
    }
    identity = { dev: metadata.dev, ino: metadata.ino };
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = null;
    const reread = await readStableFile(
      outputPath,
      ELECTRON_PRODUCTION_RECOVERY_STORE_MAX_OPTIONAL_INTENT_OBSERVATION_BYTES,
      "optional recovery intent observation output"
    );
    if (!reread.source.equals(source)) {
      throw new Error("The optional intent observation output changed.");
    }
    return deepFreeze({
      value,
      identity: {
        bytes: reread.bytes,
        fileName: path.basename(outputPath),
        sha256: reread.sha256
      }
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (identity !== null) await unlinkIfSame(outputPath, identity);
    throw error;
  }
}

async function writeMutationAttemptObservation(outputPath, value) {
  const source =
    serializeElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation(
      value
    );
  let handle = null;
  let identity = null;
  try {
    handle = await open(outputPath, "wx", 0o600);
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
      throw new Error(
        "The optional public-mutation observation output is not a regular file."
      );
    }
    identity = { dev: metadata.dev, ino: metadata.ino };
    await handle.writeFile(source);
    await handle.sync();
    await handle.close();
    handle = null;
    const reread = await readStableFile(
      outputPath,
      ELECTRON_PRODUCTION_RECOVERY_STORE_MAX_OPTIONAL_INTENT_OBSERVATION_BYTES,
      "optional public-mutation attempt observation output"
    );
    if (!reread.source.equals(source)) {
      throw new Error(
        "The optional public-mutation attempt observation output changed."
      );
    }
    return deepFreeze({
      value,
      identity: {
        bytes: reread.bytes,
        fileName: path.basename(outputPath),
        sha256: reread.sha256
      }
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (identity !== null) await unlinkIfSame(outputPath, identity);
    throw error;
  }
}

async function unlinkIfSame(filePath, identity) {
  try {
    const metadata = await lstat(filePath, { bigint: true });
    if (metadata.isFile() && !metadata.isSymbolicLink() &&
        metadata.nlink === 1n && metadata.dev === identity.dev &&
        metadata.ino === identity.ino) {
      await unlink(filePath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function parseArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Every optional intent observation option needs one value.");
  }
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const rawName = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!rawName?.startsWith("--") || rawName.length === 2 ||
        value === undefined || value.startsWith("--")) {
      throw new Error(
        `Invalid optional intent observation option near ${rawName ?? "<end>"}.`
      );
    }
    const name = rawName.slice(2);
    if (options.has(name)) {
      throw new Error(`Duplicate optional intent observation option --${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function assertOptions(command, options) {
  const allowed = COMMAND_OPTIONS[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown optional intent observation option --${name}.`);
    }
  }
  for (const name of allowed) requiredOption(options, name);
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function requiredPrivateVisibility(options) {
  const visibility = requiredOption(options, "repository-visibility");
  if (visibility !== "private") {
    throw new Error("The optional intent repository must be private.");
  }
  return visibility;
}

function requiredToken(environment) {
  const token = environment.GH_TOKEN;
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 ||
      /\s/u.test(token)) {
    throw new Error("A bounded GH_TOKEN is required for optional intent read.");
  }
  return token;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredObjectSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function resolveDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Optional intent observation dependencies are invalid.");
  }
  const allowed = new Set(["environment", "fetchImpl", "readRemote", "writeStdout"]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown optional intent observation dependency ${name}.`);
    }
  }
  const dependencies = {
    environment: overrides.environment ?? process.env,
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    readRemote: overrides.readRemote ?? readElectronProductionRecoveryStoreRemote,
    writeStdout: overrides.writeStdout ?? ((source) => {
      process.stdout.write(source);
    })
  };
  if (typeof dependencies.fetchImpl !== "function" ||
      typeof dependencies.readRemote !== "function" ||
      typeof dependencies.writeStdout !== "function") {
    throw new Error("Optional intent observation dependencies are invalid.");
  }
  return Object.freeze(dependencies);
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
  runElectronProductionRecoveryStoreOptionalIntentObservationCli().catch(
    () => {
      process.stderr.write("Optional recovery intent observation failed closed.\n");
      process.exitCode = 1;
    }
  );
}
