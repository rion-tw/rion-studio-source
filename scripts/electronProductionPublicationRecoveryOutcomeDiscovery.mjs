import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  assertElectronProductionPublicationRecoveryOutcome,
  assertElectronProductionPublicationRecoveryOutcomeBindings,
  assertElectronProductionPublicationRecoveryStoreSeal,
  electronProductionPublicationRecoveryStoreSealSha256,
  electronProductionPublicationRecoveryOutcomeAttemptFileName,
  electronProductionPublicationRecoveryOutcomeSha256,
  serializeElectronProductionPublicationRecoveryOutcome
} from "./electronProductionPublicationRecovery.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256,
  serializeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  serializeElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "./electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  assertRecoveryOutcomeProofLeaseRelease as assertProofLeaseRelease,
  assertRecoveryOutcomeProofMutation as assertProofMutation
} from "./electronProductionPublicationRecoveryOutcomeProofEvidence.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_KIND =
  "rion-electron-production-publication-recovery-outcome-discovery";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_KIND =
  "rion-electron-production-publication-recovery-outcome-chain-proof";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_KIND =
  "rion-electron-production-publication-recovery-outcome-continuity";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE =
  "electron-production-publication-recovery-outcome-discovery.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE =
  "electron-production-publication-recovery-outcome-chain-proof.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE =
  "electron-production-publication-recovery-outcome-continuity.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES =
  128;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES =
  1024 * 1024;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_TOTAL_OUTCOME_BYTES =
  8 * 1024 * 1024;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES =
  16 * 1024 * 1024;

const OUTCOME_DIRECTORY_STATUSES = new Set([
  "transactions-directory-absent",
  "transaction-directory-absent",
  "outcome-directory-absent",
  "present"
]);
const CHAIN_STATUSES = new Set(["empty", "open", "terminal"]);
const FORBIDDEN_REF_CHARACTERS = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

export function createElectronProductionPublicationRecoveryOutcomeDiscovery(
  input
) {
  assertExactKeys(input, [
    "currentObservation",
    "entries",
    "observedAt",
    "outcomeDirectory",
    "target",
    "transactionId"
  ], "publication recovery outcome discovery input");
  return assertElectronProductionPublicationRecoveryOutcomeDiscovery({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_KIND,
    status: "same-head-canonical-discovery",
    transactionId: input.transactionId,
    target: input.target,
    currentObservation: input.currentObservation,
    outcomeDirectory: input.outcomeDirectory,
    entries: input.entries,
    observedAt: input.observedAt
  });
}

export function assertElectronProductionPublicationRecoveryOutcomeDiscovery(
  value
) {
  assertExactKeys(value, [
    "currentObservation",
    "entries",
    "kind",
    "observedAt",
    "outcomeDirectory",
    "schemaVersion",
    "status",
    "target",
    "transactionId"
  ], "publication recovery outcome discovery");
  assertEqual(value.schemaVersion, 1,
    "publication recovery outcome discovery schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_KIND,
    "publication recovery outcome discovery kind"
  );
  assertEqual(value.status, "same-head-canonical-discovery",
    "publication recovery outcome discovery status");
  const transactionId = requiredUuid(
    value.transactionId,
    "publication recovery discovery transaction ID"
  );
  const target = assertTarget(value.target);
  const currentObservation = assertCurrentObservation(value.currentObservation);
  const outcomeDirectory = assertOutcomeDirectory(
    value.outcomeDirectory,
    transactionId
  );
  if (!Array.isArray(value.entries)) {
    throw new Error("Publication recovery discovery entries must be an array.");
  }
  if (value.entries.length >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES + 1) {
    throw new Error("Publication recovery discovery exceeds its entry bound.");
  }
  const entries = value.entries.map((entry) =>
    assertEmbeddedEntry(entry, transactionId, outcomeDirectory.path)
  );
  assertSortedUniqueEntries(entries);
  const attempts = entries.filter((entry) => entry.role === "attempt");
  const terminals = entries.filter((entry) => entry.role === "terminal");
  if (attempts.length >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES) {
    throw new Error("Publication recovery discovery exceeds its attempt bound.");
  }
  if (terminals.length > 1) {
    throw new Error("Publication recovery discovery has duplicate terminal files.");
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (totalBytes >
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_TOTAL_OUTCOME_BYTES) {
    throw new Error("Publication recovery discovery exceeds its total byte bound.");
  }
  if (outcomeDirectory.status !== "present" && entries.length !== 0) {
    throw new Error("An absent recovery outcome directory cannot contain entries.");
  }
  const receipt = deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_KIND,
    status: "same-head-canonical-discovery",
    transactionId,
    target,
    currentObservation,
    outcomeDirectory,
    entries,
    observedAt: requiredRfc3339(
      value.observedAt,
      "publication recovery outcome discovery time"
    )
  });
  assertSerializedBound(
    serializeCanonicalJson(receipt),
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome discovery"
  );
  return receipt;
}

export function verifyElectronProductionPublicationRecoveryOutcomeChain(input) {
  assertExactKeys(input, [
    "discovery",
    "discoverySha256",
    "heldLease",
    "heldLeaseSha256",
    "sourceSnapshot",
    "sourceSnapshotSha256",
    "storeSeal",
    "storeSealSha256",
    "targetSnapshot",
    "targetSnapshotSha256"
  ], "publication recovery outcome chain verification input");
  const discovery = assertElectronProductionPublicationRecoveryOutcomeDiscovery(
    input.discovery
  );
  const discoverySha256 = requiredDigest(
    input.discoverySha256,
    "publication recovery outcome discovery SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery),
    discoverySha256,
    "publication recovery outcome discovery SHA-256"
  );
  const foundation = assertFoundation(input, discovery);
  if (
    discovery.outcomeDirectory.status === "transactions-directory-absent" ||
    discovery.outcomeDirectory.status === "transaction-directory-absent"
  ) {
    throw new Error(
      "The sealed recovery transaction directory is absent at the discovered head."
    );
  }
  const decoded = discovery.entries.map(decodeEntry);
  const attemptNodes = decoded.filter((node) => node.entry.role === "attempt");
  const terminalNodes = decoded.filter((node) => node.entry.role === "terminal");
  for (const node of attemptNodes) {
    assertElectronProductionPublicationRecoveryOutcomeBindings({
      heldLease: input.heldLease,
      outcome: node.outcome,
      sourceSnapshot: input.sourceSnapshot,
      storeSeal: input.storeSeal,
      targetSnapshot: input.targetSnapshot
    });
  }
  const orderedNodes = orderOutcomeChain(attemptNodes);
  assertTerminalFile(orderedNodes, terminalNodes);
  const outcomes = orderedNodes.map(nodeIdentity);
  const latestOutcome = outcomes.at(-1) ?? null;
  const terminal = terminalNodes.length === 0
    ? null
    : fileIdentity(terminalNodes[0].entry);
  const status = outcomes.length === 0
    ? "empty"
    : latestOutcome.terminal ? "terminal" : "open";
  return assertElectronProductionPublicationRecoveryOutcomeChainProof({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_KIND,
    status,
    transactionId: discovery.transactionId,
    discoveryReceiptSha256: discoverySha256,
    foundation,
    target: discovery.target,
    currentObservation: discovery.currentObservation,
    outcomeDirectory: discovery.outcomeDirectory,
    terminal,
    latestOutcome,
    outcomes
  });
}

export function verifyElectronProductionPublicationRecoveryOutcomeContinuity(
  input
) {
  assertExactKeys(input, [
    "freshDiscovery",
    "freshDiscoverySha256",
    "heldLease",
    "heldLeaseSha256",
    "initialDiscovery",
    "initialDiscoverySha256",
    "sourceSnapshot",
    "sourceSnapshotSha256",
    "storeSeal",
    "storeSealSha256",
    "targetSnapshot",
    "targetSnapshotSha256"
  ], "publication recovery outcome continuity input");
  const foundation = {
    heldLease: input.heldLease,
    heldLeaseSha256: input.heldLeaseSha256,
    sourceSnapshot: input.sourceSnapshot,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    storeSeal: input.storeSeal,
    storeSealSha256: input.storeSealSha256,
    targetSnapshot: input.targetSnapshot,
    targetSnapshotSha256: input.targetSnapshotSha256
  };
  const initial = verifyElectronProductionPublicationRecoveryOutcomeChain({
    ...foundation,
    discovery: input.initialDiscovery,
    discoverySha256: input.initialDiscoverySha256
  });
  const fresh = verifyElectronProductionPublicationRecoveryOutcomeChain({
    ...foundation,
    discovery: input.freshDiscovery,
    discoverySha256: input.freshDiscoverySha256
  });
  if (!isDeepStrictEqual(chainContinuityProjection(initial),
    chainContinuityProjection(fresh))) {
    throw new Error(
      "The publication recovery outcome chain changed between same-head reads."
    );
  }
  return assertElectronProductionPublicationRecoveryOutcomeContinuityProof({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_KIND,
    status: "verified-same-head-chain",
    transactionId: fresh.transactionId,
    discoveryReceipts: {
      initialSha256: initial.discoveryReceiptSha256,
      freshSha256: fresh.discoveryReceiptSha256
    },
    foundation: fresh.foundation,
    target: fresh.target,
    currentObservation: fresh.currentObservation,
    outcomeDirectory: fresh.outcomeDirectory,
    terminal: fresh.terminal,
    latestOutcome: fresh.latestOutcome,
    outcomes: fresh.outcomes
  });
}

export function assertElectronProductionPublicationRecoveryOutcomeChainProof(
  value
) {
  assertExactKeys(value, [
    "currentObservation",
    "discoveryReceiptSha256",
    "foundation",
    "kind",
    "latestOutcome",
    "outcomeDirectory",
    "outcomes",
    "schemaVersion",
    "status",
    "target",
    "terminal",
    "transactionId"
  ], "publication recovery outcome chain proof");
  assertEqual(value.schemaVersion, 1,
    "publication recovery outcome chain-proof schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_KIND,
    "publication recovery outcome chain-proof kind"
  );
  if (!CHAIN_STATUSES.has(value.status)) {
    throw new Error("The publication recovery outcome chain status is invalid.");
  }
  const transactionId = requiredUuid(
    value.transactionId,
    "publication recovery chain transaction ID"
  );
  const outcomes = assertOutcomeIdentities(value.outcomes, transactionId);
  const latestOutcome = value.latestOutcome === null
    ? null
    : assertOutcomeIdentity(value.latestOutcome, transactionId);
  const terminal = value.terminal === null
    ? null
    : assertFileIdentity(value.terminal, "publication recovery terminal identity");
  assertTerminalProofPath(terminal, transactionId);
  assertProofTerminality(value.status, outcomes, latestOutcome, terminal);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_KIND,
    status: value.status,
    transactionId,
    discoveryReceiptSha256: requiredDigest(
      value.discoveryReceiptSha256,
      "publication recovery outcome discovery receipt SHA-256"
    ),
    foundation: assertFoundationIdentity(value.foundation, transactionId),
    target: assertTarget(value.target),
    currentObservation: assertCurrentObservation(value.currentObservation),
    outcomeDirectory: assertOutcomeDirectory(value.outcomeDirectory, transactionId),
    terminal,
    latestOutcome,
    outcomes
  });
}

export function assertElectronProductionPublicationRecoveryOutcomeContinuityProof(
  value
) {
  assertExactKeys(value, [
    "currentObservation",
    "discoveryReceipts",
    "foundation",
    "kind",
    "latestOutcome",
    "outcomeDirectory",
    "outcomes",
    "schemaVersion",
    "status",
    "target",
    "terminal",
    "transactionId"
  ], "publication recovery outcome continuity proof");
  assertEqual(value.schemaVersion, 1,
    "publication recovery outcome continuity schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_KIND,
    "publication recovery outcome continuity kind"
  );
  assertEqual(value.status, "verified-same-head-chain",
    "publication recovery outcome continuity status");
  assertExactKeys(value.discoveryReceipts, ["freshSha256", "initialSha256"],
    "publication recovery outcome continuity discoveries");
  const transactionId = requiredUuid(
    value.transactionId,
    "publication recovery continuity transaction ID"
  );
  const outcomes = assertOutcomeIdentities(value.outcomes, transactionId);
  const latestOutcome = value.latestOutcome === null
    ? null
    : assertOutcomeIdentity(value.latestOutcome, transactionId);
  const terminal = value.terminal === null
    ? null
    : assertFileIdentity(value.terminal, "publication recovery terminal identity");
  assertTerminalProofPath(terminal, transactionId);
  const chainStatus = outcomes.length === 0
    ? "empty"
    : outcomes.at(-1).terminal ? "terminal" : "open";
  assertProofTerminality(chainStatus, outcomes, latestOutcome, terminal);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_KIND,
    status: "verified-same-head-chain",
    transactionId,
    discoveryReceipts: {
      initialSha256: requiredDigest(
        value.discoveryReceipts.initialSha256,
        "initial publication recovery discovery SHA-256"
      ),
      freshSha256: requiredDigest(
        value.discoveryReceipts.freshSha256,
        "fresh publication recovery discovery SHA-256"
      )
    },
    foundation: assertFoundationIdentity(value.foundation, transactionId),
    target: assertTarget(value.target),
    currentObservation: assertCurrentObservation(value.currentObservation),
    outcomeDirectory: assertOutcomeDirectory(value.outcomeDirectory, transactionId),
    terminal,
    latestOutcome,
    outcomes
  });
}

export function electronProductionPublicationRecoveryOutcomeDiscoverySha256(
  value
) {
  return sha256(serializeElectronProductionPublicationRecoveryOutcomeDiscovery(value));
}

export function serializeElectronProductionPublicationRecoveryOutcomeDiscovery(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryOutcomeDiscovery(value)
  );
}

export function serializeElectronProductionPublicationRecoveryOutcomeChainProof(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryOutcomeChainProof(value)
  );
}

export function serializeElectronProductionPublicationRecoveryOutcomeContinuityProof(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryOutcomeContinuityProof(value)
  );
}

export async function writeElectronProductionPublicationRecoveryOutcomeDiscovery(
  input
) {
  return writeCanonicalContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome discovery",
    assertElectronProductionPublicationRecoveryOutcomeDiscovery
  );
}

export async function readElectronProductionPublicationRecoveryOutcomeDiscovery(
  input
) {
  return readCanonicalContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome discovery",
    assertElectronProductionPublicationRecoveryOutcomeDiscovery
  );
}

export async function writeElectronProductionPublicationRecoveryOutcomeChainProof(
  input
) {
  return writeCanonicalContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome chain proof",
    assertElectronProductionPublicationRecoveryOutcomeChainProof
  );
}

export async function readElectronProductionPublicationRecoveryOutcomeChainProof(
  input
) {
  return readCanonicalContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome chain proof",
    assertElectronProductionPublicationRecoveryOutcomeChainProof
  );
}

export async function writeElectronProductionPublicationRecoveryOutcomeContinuityProof(
  input
) {
  return writeCanonicalContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome continuity proof",
    assertElectronProductionPublicationRecoveryOutcomeContinuityProof
  );
}

export async function readElectronProductionPublicationRecoveryOutcomeContinuityProof(
  input
) {
  return readCanonicalContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_FILE,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERY_BYTES,
    "publication recovery outcome continuity proof",
    assertElectronProductionPublicationRecoveryOutcomeContinuityProof
  );
}

export function electronProductionPublicationRecoveryLatestOutcomeSource(
  discoveryValue,
  proofValue
) {
  const discovery = assertElectronProductionPublicationRecoveryOutcomeDiscovery(
    discoveryValue
  );
  const proof = proofValue.kind ===
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_KIND
    ? assertElectronProductionPublicationRecoveryOutcomeContinuityProof(proofValue)
    : assertElectronProductionPublicationRecoveryOutcomeChainProof(proofValue);
  const expectedDiscoverySha256 = proof.kind ===
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CONTINUITY_KIND
    ? proof.discoveryReceipts.freshSha256
    : proof.discoveryReceiptSha256;
  assertEqual(
    electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery),
    expectedDiscoverySha256,
    "latest recovery outcome discovery proof binding"
  );
  if (proof.latestOutcome === null) return null;
  const entry = discovery.entries.find((candidate) =>
    candidate.role === "attempt" &&
    candidate.path === proof.latestOutcome.path &&
    candidate.sha256 === proof.latestOutcome.sha256
  );
  if (entry === undefined) {
    throw new Error("The latest recovery outcome is absent from its discovery.");
  }
  return Buffer.from(entry.contentBase64, "base64");
}

function assertFoundation(input, discovery) {
  const seal = assertElectronProductionPublicationRecoveryStoreSeal(
    input.storeSeal
  );
  const heldLease = assertElectronProductionPublicLatestLease(input.heldLease);
  const sourceSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.sourceSnapshot
  );
  const targetSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.targetSnapshot
  );
  assertFoundationBindings(seal, heldLease, sourceSnapshot, targetSnapshot);
  assertEqual(
    sha256(serializeElectronProductionPublicLatestLease(heldLease)),
    requiredDigest(
      input.heldLeaseSha256,
      "publication recovery held-lease file SHA-256"
    ),
    "publication recovery held-lease file SHA-256"
  );
  assertEqual(
    sha256(serializeElectronProductionPublicLatestSnapshot(sourceSnapshot)),
    requiredDigest(
      input.sourceSnapshotSha256,
      "publication recovery source snapshot file SHA-256"
    ),
    "publication recovery source snapshot file SHA-256"
  );
  assertEqual(
    sha256(serializeElectronProductionPublicLatestSnapshot(targetSnapshot)),
    requiredDigest(
      input.targetSnapshotSha256,
      "publication recovery target snapshot file SHA-256"
    ),
    "publication recovery target snapshot file SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryStoreSealSha256(seal),
    requiredDigest(
      input.storeSealSha256,
      "publication recovery store-seal SHA-256"
    ),
    "publication recovery store-seal SHA-256"
  );
  const outcomeFoundation = {
    heldLease,
    sourceSnapshot,
    storeSeal: seal,
    targetSnapshot
  };
  const transactionId = requiredUuid(
    seal?.transactionId,
    "recovery store-seal transaction ID"
  );
  assertEqual(discovery.transactionId, transactionId,
    "publication recovery discovery transaction ID binding");
  const expectedTarget = {
    repository: seal.durableStore.repository,
    ref: seal.durableStore.ref,
    repositoryPolicy: seal.durableStore.repositoryPolicy
  };
  if (!isDeepStrictEqual(discovery.target, expectedTarget)) {
    throw new Error("The publication recovery discovery store target does not match.");
  }
  // The binding parser is also the closed validator for held/source/target/seal.
  if (discovery.entries.length > 0) {
    assertElectronProductionPublicationRecoveryOutcomeBindings({
      ...outcomeFoundation,
      outcome: decodeEntry(
        discovery.entries.find((entry) => entry.role === "attempt") ??
        discovery.entries[0]
      ).outcome
    });
  }
  return assertFoundationIdentity({
    heldLeaseSha256: requiredDigest(
      input.heldLeaseSha256,
      "publication recovery held-lease file SHA-256"
    ),
    heldLeaseEventSha256: seal.lease.eventSha256,
    storeSealSha256: requiredDigest(
      input.storeSealSha256,
      "publication recovery store-seal SHA-256"
    ),
    sourceSnapshotSha256: requiredDigest(
      input.sourceSnapshotSha256,
      "publication recovery source snapshot file SHA-256"
    ),
    targetSnapshotSha256: requiredDigest(
      input.targetSnapshotSha256,
      "publication recovery target snapshot file SHA-256"
    ),
    leaseId: seal.lease.leaseId,
    generation: seal.lease.generation,
    sourceStateSha256: seal.source.stateSha256,
    targetStateSha256: seal.target.stateSha256,
    transactionId
  }, transactionId);
}

function assertFoundationBindings(seal, heldLease, sourceSnapshot, targetSnapshot) {
  for (const [actual, expected, label] of [
    [heldLease.status, "held", "held-lease status"],
    [heldLease.transactionId, seal.transactionId, "held-lease transaction ID"],
    [heldLease.leaseId, seal.lease.leaseId, "held-lease ID"],
    [heldLease.generation, seal.lease.generation, "held-lease generation"],
    [electronProductionPublicLatestLeaseEventSha256(heldLease),
      seal.lease.eventSha256, "held-lease event SHA-256"],
    [sourceSnapshot.observationKind, "observed-release",
      "source snapshot observation kind"],
    [sourceSnapshot.release.isLatest, true, "source snapshot latest status"],
    [sourceSnapshot.candidateReceipt, null, "source candidate receipt"],
    [sourceSnapshot.stateSha256, seal.source.stateSha256, "source state"],
    [sourceSnapshot.snapshotSha256, seal.source.snapshotSha256, "source snapshot"],
    [sourceSnapshot.release.id, seal.source.releaseId, "source release ID"],
    [sourceSnapshot.release.tag, seal.source.releaseTag, "source release tag"],
    [sourceSnapshot.latestJson.version, seal.source.version, "source version"],
    [targetSnapshot.observationKind, "expected-latest-projection",
      "target snapshot observation kind"],
    [targetSnapshot.release.isLatest, true, "target snapshot latest status"],
    [targetSnapshot.stateSha256, seal.target.stateSha256, "target state"],
    [targetSnapshot.snapshotSha256, seal.target.snapshotSha256, "target snapshot"],
    [targetSnapshot.release.id, seal.target.releaseId, "target release ID"],
    [targetSnapshot.release.tag, seal.target.releaseTag, "target release tag"],
    [targetSnapshot.latestJson.version, seal.target.version, "target version"]
  ]) assertEqual(actual, expected, `publication recovery ${label} binding`);
  if (targetSnapshot.candidateReceipt === null) {
    throw new Error("The publication recovery target candidate receipt is missing.");
  }
  assertEqual(
    targetSnapshot.candidateReceipt.sha256,
    seal.target.candidateReceiptSha256,
    "publication recovery target candidate receipt binding"
  );
}

function orderOutcomeChain(nodes) {
  if (nodes.length === 0) return [];
  const byDigest = new Map();
  const byRunAttempt = new Set();
  for (const node of nodes) {
    if (byDigest.has(node.entry.sha256)) {
      throw new Error("Publication recovery outcome digests must be unique.");
    }
    byDigest.set(node.entry.sha256, node);
    const runAttempt = `${node.outcome.recoveryRun.runId}:` +
      `${node.outcome.recoveryRun.runAttempt}`;
    if (byRunAttempt.has(runAttempt)) {
      throw new Error("Publication recovery outcome run attempts must be unique.");
    }
    byRunAttempt.add(runAttempt);
  }
  const children = new Map();
  const genesis = [];
  for (const node of nodes) {
    const predecessor = node.outcome.previousOutcomeSha256;
    if (predecessor === null) {
      genesis.push(node);
      continue;
    }
    if (!byDigest.has(predecessor)) {
      throw new Error("The publication recovery outcome chain has a gap.");
    }
    if (children.has(predecessor)) {
      throw new Error("The publication recovery outcome chain has a fork.");
    }
    children.set(predecessor, node);
  }
  if (genesis.length !== 1) {
    throw new Error("The publication recovery outcome chain needs one genesis.");
  }
  const ordered = [];
  const visited = new Set();
  let current = genesis[0];
  while (current !== undefined) {
    if (visited.has(current.entry.sha256)) {
      throw new Error("The publication recovery outcome chain has a cycle.");
    }
    visited.add(current.entry.sha256);
    ordered.push(current);
    const successor = children.get(current.entry.sha256);
    if (successor !== undefined) assertSuccessor(current.outcome, successor.outcome);
    current = successor;
  }
  if (visited.size !== nodes.length) {
    throw new Error(
      "The publication recovery outcome chain is cyclic or disconnected."
    );
  }
  if (ordered.slice(0, -1).some((node) => node.outcome.outcome.terminal)) {
    throw new Error("A terminal recovery outcome cannot have a successor.");
  }
  return ordered;
}

function assertSuccessor(predecessor, successor) {
  if (Date.parse(successor.recoveryRun.startedAt) <
      Date.parse(predecessor.outcome.determinedAt)) {
    throw new Error("A recovery outcome successor precedes its predecessor.");
  }
}

function assertTerminalFile(ordered, terminals) {
  if (ordered.length === 0) {
    if (terminals.length !== 0) {
      throw new Error("A terminal recovery file cannot exist without an attempt.");
    }
    return;
  }
  const head = ordered.at(-1);
  if (!head.outcome.outcome.terminal) {
    if (terminals.length !== 0) {
      throw new Error("An open recovery chain cannot have a fixed terminal file.");
    }
    return;
  }
  if (terminals.length !== 1) {
    throw new Error("A terminal recovery head requires one fixed terminal file.");
  }
  const terminal = terminals[0];
  if (
    terminal.entry.sha256 !== head.entry.sha256 ||
    terminal.entry.blobSha !== head.entry.blobSha ||
    terminal.entry.byteLength !== head.entry.byteLength ||
    terminal.entry.contentBase64 !== head.entry.contentBase64
  ) {
    throw new Error(
      "The fixed terminal recovery outcome must be byte-identical to the chain head."
    );
  }
}

function assertEmbeddedEntry(value, transactionId, directoryPath) {
  assertExactKeys(value, [
    "blobSha",
    "byteLength",
    "contentBase64",
    "fileName",
    "mode",
    "path",
    "role",
    "sha256",
    "type"
  ], "publication recovery discovery entry");
  if (value.role !== "attempt" && value.role !== "terminal") {
    throw new Error("The publication recovery discovery entry role is invalid.");
  }
  assertEqual(value.mode, "100644", "publication recovery outcome Git mode");
  assertEqual(value.type, "blob", "publication recovery outcome Git type");
  const fileName = assertOutcomeFileName(value.fileName, value.role);
  assertEqual(value.path, path.posix.join(directoryPath, fileName),
    "publication recovery discovery entry path");
  const source = decodeStrictBase64(
    value.contentBase64,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_OUTCOME_BYTES
  );
  const byteLength = requiredPositiveInteger(
    value.byteLength,
    "publication recovery outcome byte length"
  );
  assertEqual(source.length, byteLength,
    "publication recovery outcome byte length");
  const blobSha = requiredCommitSha(
    value.blobSha,
    "publication recovery outcome blob SHA"
  );
  assertEqual(gitBlobSha(source), blobSha,
    "publication recovery outcome Git blob SHA");
  const digest = requiredDigest(
    value.sha256,
    "publication recovery outcome SHA-256"
  );
  assertEqual(sha256(source), digest, "publication recovery outcome SHA-256");
  const outcome = parseCanonicalOutcome(source);
  assertEqual(outcome.transactionId, transactionId,
    "publication recovery outcome transaction ID");
  if (value.role === "attempt") {
    assertEqual(
      fileName,
      electronProductionPublicationRecoveryOutcomeAttemptFileName(
        outcome.recoveryRun
      ),
      "publication recovery outcome attempt filename"
    );
  } else {
    assertEqual(outcome.outcome.terminal, true,
      "fixed publication recovery outcome terminality");
  }
  return deepFreeze({
    role: value.role,
    path: value.path,
    fileName,
    mode: "100644",
    type: "blob",
    blobSha,
    byteLength,
    sha256: digest,
    contentBase64: source.toString("base64")
  });
}

function decodeEntry(entry) {
  return {
    entry,
    outcome: parseCanonicalOutcome(Buffer.from(entry.contentBase64, "base64"))
  };
}

function parseCanonicalOutcome(source) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The discovered publication recovery outcome is invalid JSON.", {
      cause: error
    });
  }
  const outcome = assertElectronProductionPublicationRecoveryOutcome(value);
  if (!source.equals(serializeElectronProductionPublicationRecoveryOutcome(outcome))) {
    throw new Error("The discovered publication recovery outcome is not canonical.");
  }
  assertEqual(
    electronProductionPublicationRecoveryOutcomeSha256(outcome),
    sha256(source),
    "discovered publication recovery outcome digest"
  );
  return outcome;
}

function assertSortedUniqueEntries(entries) {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Publication recovery discovery paths must be unique.");
  }
  const sorted = [...paths].sort();
  if (!isDeepStrictEqual(paths, sorted)) {
    throw new Error("Publication recovery discovery entries must be path-sorted.");
  }
}

function assertTarget(value) {
  assertExactKeys(value, ["ref", "repository", "repositoryPolicy"],
    "publication recovery discovery target");
  assertRepository(value.repository);
  assertBranch(value.ref, "publication recovery discovery ref");
  assertExactKeys(value.repositoryPolicy, ["defaultBranch", "visibility"],
    "publication recovery discovery repository policy");
  assertBranch(
    value.repositoryPolicy.defaultBranch,
    "publication recovery discovery default branch"
  );
  assertEqual(value.repositoryPolicy.visibility, "private",
    "publication recovery discovery repository visibility");
  assertEqual(value.ref, value.repositoryPolicy.defaultBranch,
    "publication recovery discovery protected default branch");
  return deepFreeze({
    repository: value.repository,
    ref: value.ref,
    repositoryPolicy: {
      defaultBranch: value.repositoryPolicy.defaultBranch,
      visibility: "private"
    }
  });
}

function assertCurrentObservation(value) {
  assertExactKeys(value, ["headCommitSha", "parentCommitShas", "treeSha"],
    "publication recovery discovery current observation");
  if (
    !Array.isArray(value.parentCommitShas) ||
    value.parentCommitShas.length > 16
  ) {
    throw new Error("Publication recovery discovery parents exceed their bound.");
  }
  const parents = value.parentCommitShas.map((parent) =>
    requiredCommitSha(parent, "publication recovery discovery parent commit SHA")
  );
  if (new Set(parents).size !== parents.length) {
    throw new Error("Publication recovery discovery parents must be unique.");
  }
  return deepFreeze({
    headCommitSha: requiredCommitSha(
      value.headCommitSha,
      "publication recovery discovery head commit SHA"
    ),
    treeSha: requiredCommitSha(
      value.treeSha,
      "publication recovery discovery tree SHA"
    ),
    parentCommitShas: parents
  });
}

function assertOutcomeDirectory(value, transactionId) {
  assertExactKeys(value, ["path", "status", "treeSha"],
    "publication recovery outcome directory");
  if (!OUTCOME_DIRECTORY_STATUSES.has(value.status)) {
    throw new Error("The publication recovery outcome directory status is invalid.");
  }
  const expectedPath = path.posix.dirname(
    electronProductionRecoveryStoreTransactionPaths({ transactionId })
      .recoveryOutcomeTerminalPath
  );
  assertEqual(value.path, expectedPath, "publication recovery outcome directory path");
  const treeSha = value.status === "present"
    ? requiredCommitSha(
        value.treeSha,
        "publication recovery outcome directory tree SHA"
      )
    : null;
  assertEqual(value.treeSha, treeSha,
    "publication recovery outcome directory tree identity");
  return deepFreeze({ path: expectedPath, status: value.status, treeSha });
}

function assertFoundationIdentity(value, transactionId) {
  assertExactKeys(value, [
    "generation",
    "heldLeaseEventSha256",
    "heldLeaseSha256",
    "leaseId",
    "sourceSnapshotSha256",
    "sourceStateSha256",
    "storeSealSha256",
    "targetSnapshotSha256",
    "targetStateSha256",
    "transactionId"
  ], "publication recovery outcome chain foundation");
  assertEqual(value.transactionId, transactionId,
    "publication recovery outcome chain foundation transaction ID");
  return deepFreeze({
    transactionId,
    leaseId: requiredUuid(value.leaseId, "publication recovery chain lease ID"),
    generation: requiredPositiveInteger(
      value.generation,
      "publication recovery chain lease generation"
    ),
    heldLeaseEventSha256: requiredDigest(
      value.heldLeaseEventSha256,
      "publication recovery held-lease event SHA-256"
    ),
    heldLeaseSha256: requiredDigest(
      value.heldLeaseSha256,
      "publication recovery held-lease file SHA-256"
    ),
    storeSealSha256: requiredDigest(
      value.storeSealSha256,
      "publication recovery store-seal SHA-256"
    ),
    sourceSnapshotSha256: requiredDigest(
      value.sourceSnapshotSha256,
      "publication recovery source snapshot file SHA-256"
    ),
    targetSnapshotSha256: requiredDigest(
      value.targetSnapshotSha256,
      "publication recovery target snapshot file SHA-256"
    ),
    sourceStateSha256: requiredDigest(
      value.sourceStateSha256,
      "publication recovery source state SHA-256"
    ),
    targetStateSha256: requiredDigest(
      value.targetStateSha256,
      "publication recovery target state SHA-256"
    )
  });
}

function nodeIdentity(node) {
  return deepFreeze({
    ...fileIdentity(node.entry),
    leaseRelease: node.outcome.leaseRelease,
    mutation: node.outcome.mutation,
    observation: {
      beforeMutation: node.outcome.observation.beforeMutation,
      final: node.outcome.observation.final
    },
    previousOutcomeSha256: node.outcome.previousOutcomeSha256,
    recoveryOperation: node.outcome.recoveryOperation,
    recoveryRun: node.outcome.recoveryRun,
    terminal: node.outcome.outcome.terminal,
    determinedAt: node.outcome.outcome.determinedAt
  });
}

function fileIdentity(entry) {
  return deepFreeze({
    path: entry.path,
    fileName: entry.fileName,
    blobSha: entry.blobSha,
    bytes: entry.byteLength,
    sha256: entry.sha256
  });
}

function assertOutcomeIdentities(value, transactionId) {
  if (!Array.isArray(value) ||
      value.length > ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_DISCOVERED_OUTCOMES) {
    throw new Error("Publication recovery outcome proof entries are invalid.");
  }
  const outcomes = value.map((entry) =>
    assertOutcomeIdentity(entry, transactionId)
  );
  assertProofOrderedLinks(outcomes);
  return deepFreeze(outcomes);
}

function assertOutcomeIdentity(value, transactionId) {
  assertExactKeys(value, [
    "blobSha",
    "bytes",
    "determinedAt",
    "fileName",
    "leaseRelease",
    "mutation",
    "observation",
    "path",
    "previousOutcomeSha256",
    "recoveryOperation",
    "recoveryRun",
    "sha256",
    "terminal"
  ], "publication recovery outcome proof identity");
  const file = assertFileIdentity(value, "publication recovery outcome proof file", [
    "determinedAt",
    "leaseRelease",
    "mutation",
    "observation",
    "previousOutcomeSha256",
    "recoveryOperation",
    "recoveryRun",
    "terminal"
  ]);
  assertExactKeys(value.recoveryRun, [
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "startedAt",
    "workflow"
  ], "publication recovery outcome proof run");
  const expectedPath = path.posix.join(
    path.posix.dirname(
      electronProductionRecoveryStoreTransactionPaths({ transactionId })
        .recoveryOutcomeTerminalPath
    ),
    value.fileName
  );
  assertEqual(value.path, expectedPath, "publication recovery outcome proof path");
  if (typeof value.terminal !== "boolean") {
    throw new Error("Publication recovery outcome proof terminality is invalid.");
  }
  const recoveryRun = {
    repository: requiredNonemptyString(value.recoveryRun.repository,
      "publication recovery run repository", 200),
    workflow: requiredNonemptyString(value.recoveryRun.workflow,
      "publication recovery run workflow", 255),
    runId: requiredRunId(value.recoveryRun.runId),
    runAttempt: requiredPositiveInteger(
      value.recoveryRun.runAttempt,
      "publication recovery run attempt"
    ),
    controlSha: requiredCommitSha(
      value.recoveryRun.controlSha,
      "publication recovery run control SHA"
    ),
    startedAt: requiredRfc3339(
      value.recoveryRun.startedAt,
      "publication recovery run start time"
    )
  };
  const leaseRelease = assertProofLeaseRelease(value.leaseRelease);
  const mutation = assertProofMutation(value.mutation);
  const observation = assertProofObservation(value.observation);
  const recoveryOperation = assertProofRecoveryOperation(
    value.recoveryOperation,
    mutation,
    leaseRelease,
    observation
  );
  assertEqual(
    value.fileName,
    electronProductionPublicationRecoveryOutcomeAttemptFileName(recoveryRun),
    "publication recovery outcome proof filename"
  );
  return deepFreeze({
    ...file,
    previousOutcomeSha256: value.previousOutcomeSha256 === null
      ? null
      : requiredDigest(
          value.previousOutcomeSha256,
          "publication recovery outcome predecessor SHA-256"
        ),
    recoveryRun,
    recoveryOperation,
    leaseRelease,
    mutation,
    observation,
    terminal: value.terminal,
    determinedAt: requiredRfc3339(
      value.determinedAt,
      "publication recovery outcome determined time"
    )
  });
}

function assertProofRecoveryOperation(value, mutation, leaseRelease, observation) {
  const marker = value?.kind ===
    "rion-electron-production-publication-recovery-public-mutation-operation";
  assertExactKeys(value, marker
    ? ["authority", "kind", "mode", "operation", "sha256"]
    : ["kind", "sha256"],
  "publication recovery proof authoritative operation");
  if (!marker) {
    const expectedKind = mutation.kind === "rollback"
      ? "rion-electron-production-public-latest-recovery-rollback-operation"
      : "rion-electron-production-public-latest-recovery-observation";
    assertEqual(value.kind, expectedKind,
      "publication recovery proof authoritative operation kind");
    return deepFreeze({
      kind: expectedKind,
      sha256: requiredDigest(
        value.sha256,
        "publication recovery proof authoritative operation SHA-256"
      )
    });
  }
  const operation = mutation.kind === "rollback"
    ? "rollback-public-latest"
    : "release-held-lease";
  assertEqual(value.operation, operation,
    "publication recovery proof public-mutation operation");
  if (!["actual-transport", "marker-reconciliation", "precondition-rejected"]
    .includes(value.mode)) {
    throw new Error(
      "The publication recovery proof public-mutation operation mode is invalid."
    );
  }
  const parsed = deepFreeze({
    kind:
      "rion-electron-production-publication-recovery-public-mutation-operation",
    operation,
    mode: value.mode,
    authority: assertProofMarkerAuthority(
      value.authority,
      "public-mutation operation"
    ),
    sha256: requiredDigest(
      value.sha256,
      "publication recovery proof public-mutation operation SHA-256"
    )
  });
  assertProofMarkerOperationBinding(
    parsed,
    mutation,
    leaseRelease,
    observation
  );
  return parsed;
}

function assertProofMarkerOperationBinding(
  operation,
  mutation,
  leaseRelease,
  observation
) {
  if (operation.operation === "rollback-public-latest") {
    assertEqual(mutation.kind, "rollback",
      "publication recovery proof marker rollback mutation");
    assertEqual(leaseRelease.attempted, false,
      "publication recovery proof marker rollback lease release");
    const expectedMode = mutation.submitted === "possibly"
      ? "marker-reconciliation"
      : mutation.submitted === false
        ? "precondition-rejected"
        : "actual-transport";
    assertEqual(operation.mode, expectedMode,
      "publication recovery proof marker rollback mode");
    if (mutation.submitted !== true) {
      assertDeepEqual(mutation.reservation, operation.authority,
        "publication recovery proof marker rollback authority");
    }
    return;
  }
  assertEqual(mutation.kind, "none",
    "publication recovery proof marker lease-release mutation");
  assertEqual(observation.beforeMutation.classification, "source",
    "publication recovery proof marker lease-release source observation");
  if (leaseRelease.attempted === false &&
      leaseRelease.acknowledgement !== "rejected") {
    throw new Error(
      "The marker lease-release proof lacks a recorded marker result."
    );
  }
  const expectedMode = leaseRelease.attempted === "possibly"
    ? "marker-reconciliation"
    : leaseRelease.attempted === false
      ? "precondition-rejected"
      : "actual-transport";
  assertEqual(operation.mode, expectedMode,
    "publication recovery proof marker lease-release mode");
  if (leaseRelease.attempted !== true) {
    assertDeepEqual(leaseRelease.reservation, operation.authority,
      "publication recovery proof marker lease-release authority");
  }
}

function assertProofObservation(value) {
  assertExactKeys(value, ["beforeMutation", "final"],
    "publication recovery outcome proof observation");
  return deepFreeze({
    beforeMutation: assertProofObservationState(
      value.beforeMutation,
      "publication recovery proof before-mutation observation"
    ),
    final: assertProofObservationState(
      value.final,
      "publication recovery proof final observation"
    )
  });
}

function assertProofObservationState(value, label) {
  assertExactKeys(value, ["classification", "observedAt", "stateSha256"], label);
  if (!["source", "target", "foreign", "unknown"].includes(
    value.classification
  )) throw new Error(`The ${label} classification is invalid.`);
  const stateSha256 = value.classification === "unknown"
    ? null
    : requiredDigest(value.stateSha256, `${label} state SHA-256`);
  if (value.classification === "unknown") {
    assertEqual(value.stateSha256, null, `${label} state SHA-256`);
  }
  return deepFreeze({
    classification: value.classification,
    stateSha256,
    observedAt: requiredRfc3339(value.observedAt, `${label} time`)
  });
}

function assertProofMarkerAuthority(value, label) {
  assertExactKeys(value, ["attemptSha256", "authorizationSha256"],
    `publication recovery proof ${label} reservation authority`);
  return deepFreeze({
    attemptSha256: requiredDigest(
      value.attemptSha256,
      `publication recovery proof ${label} attempt SHA-256`
    ),
    authorizationSha256: requiredDigest(
      value.authorizationSha256,
      `publication recovery proof ${label} authorization SHA-256`
    )
  });
}

function assertProofOrderedLinks(outcomes) {
  const digests = new Set();
  const paths = new Set();
  const runAttempts = new Set();
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (digests.has(outcome.sha256)) {
      throw new Error("Publication recovery proof outcome digests must be unique.");
    }
    digests.add(outcome.sha256);
    if (paths.has(outcome.path)) {
      throw new Error("Publication recovery proof outcome paths must be unique.");
    }
    paths.add(outcome.path);
    const runAttempt = `${outcome.recoveryRun.runId}:${outcome.recoveryRun.runAttempt}`;
    if (runAttempts.has(runAttempt)) {
      throw new Error("Publication recovery proof run attempts must be unique.");
    }
    runAttempts.add(runAttempt);
    const predecessor = outcomes[index - 1];
    assertEqual(
      outcome.previousOutcomeSha256,
      predecessor?.sha256 ?? null,
      "publication recovery proof predecessor link"
    );
    if (predecessor !== undefined) {
      assertSuccessor(
        {
          recoveryRun: predecessor.recoveryRun,
          outcome: { determinedAt: predecessor.determinedAt }
        },
        { recoveryRun: outcome.recoveryRun }
      );
      if (predecessor.terminal) {
        throw new Error("A terminal recovery proof outcome cannot have a successor.");
      }
    }
  }
}

function assertFileIdentity(value, label, ignoredKeys = []) {
  assertExactKeys(value, [
    "blobSha",
    "bytes",
    "fileName",
    "path",
    "sha256",
    ...ignoredKeys
  ], label);
  return deepFreeze({
    path: assertRepositoryPath(value.path, `${label} path`),
    fileName: assertOutcomeFileName(
      value.fileName,
      value.fileName === ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
        ? "terminal"
        : "attempt"
    ),
    blobSha: requiredCommitSha(value.blobSha, `${label} blob SHA`),
    bytes: requiredPositiveInteger(value.bytes, `${label} bytes`),
    sha256: requiredDigest(value.sha256, `${label} SHA-256`)
  });
}

function assertProofTerminality(status, outcomes, latestOutcome, terminal) {
  if (outcomes.length === 0) {
    if (status !== "empty" || latestOutcome !== null || terminal !== null) {
      throw new Error("An empty recovery chain proof has invalid terminality.");
    }
    return;
  }
  const expectedLatest = outcomes.at(-1);
  if (!isDeepStrictEqual(latestOutcome, expectedLatest)) {
    throw new Error("The recovery chain proof latest outcome does not match its head.");
  }
  if (expectedLatest.terminal) {
    if (
      status !== "terminal" || terminal === null ||
      terminal.sha256 !== expectedLatest.sha256 ||
      terminal.blobSha !== expectedLatest.blobSha ||
      terminal.bytes !== expectedLatest.bytes
    ) throw new Error("The terminal recovery chain proof is incomplete.");
  } else if (status !== "open" || terminal !== null) {
    throw new Error("The open recovery chain proof has invalid terminality.");
  }
}

function assertTerminalProofPath(terminal, transactionId) {
  if (terminal === null) return;
  assertEqual(
    terminal.path,
    electronProductionRecoveryStoreTransactionPaths({ transactionId })
      .recoveryOutcomeTerminalPath,
    "fixed publication recovery terminal proof path"
  );
}

function chainContinuityProjection(proof) {
  return {
    transactionId: proof.transactionId,
    foundation: proof.foundation,
    target: proof.target,
    currentObservation: proof.currentObservation,
    outcomeDirectory: proof.outcomeDirectory,
    terminal: proof.terminal,
    latestOutcome: proof.latestOutcome,
    outcomes: proof.outcomes
  };
}

async function writeCanonicalContract(input, expectedName, maximumBytes, label, parser) {
  assertExactKeys(input, ["outputPath", "value"], `${label} write input`);
  const value = parser(input.value);
  const source = serializeCanonicalJson(value);
  assertSerializedBound(source, maximumBytes, label);
  const outputPath = await resolveCreateNewFile(input.outputPath, expectedName, label);
  await writeExclusive(outputPath, source);
  return readCanonicalContract({
    expectedSha256: sha256(source),
    receiptPath: outputPath
  }, expectedName, maximumBytes, label, parser);
}

async function readCanonicalContract(input, expectedName, maximumBytes, label, parser) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"], `${label} read input`);
  assertEqual(path.basename(input.receiptPath), expectedName, `${label} filename`);
  const file = await readCanonicalJsonFile(input.receiptPath, maximumBytes, label);
  assertEqual(file.sha256, requiredDigest(input.expectedSha256, `${label} SHA-256`),
    `${label} SHA-256`);
  const value = parser(file.value);
  if (!file.source.equals(serializeCanonicalJson(value))) {
    throw new Error(`The ${label} must be canonical.`);
  }
  return deepFreeze({
    value,
    valueIdentity: publicIdentity(input.receiptPath, file),
    valuePath: path.resolve(input.receiptPath)
  });
}

function assertOutcomeFileName(value, role) {
  if (typeof value !== "string" || value.length > 255) {
    throw new Error("The publication recovery outcome filename is invalid.");
  }
  if (role === "terminal") {
    assertEqual(value, ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
      "fixed publication recovery outcome filename");
  } else if (!/^electron-production-publication-recovery-outcome-run-[1-9][0-9]{0,29}-attempt-[0-9]{6}\.json$/u.test(value)) {
    throw new Error("The publication recovery outcome attempt filename is invalid.");
  }
  return value;
}

function assertRepository(value) {
  const [owner, repo, extra] = typeof value === "string" ? value.split("/") : [];
  if (
    extra !== undefined || !owner || owner.length > 39 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
    !repo || repo.length > 100 || !/^[A-Za-z0-9_.-]+$/u.test(repo) ||
    repo === "." || repo === ".."
  ) throw new Error("The publication recovery discovery repository is invalid.");
}

function assertBranch(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 255 ||
    value.startsWith("-") || value.startsWith("/") || value.endsWith("/") ||
    value.endsWith(".") || value.includes("//") || value.includes("..") ||
    value.includes("@{") || [...value].some((character) => {
      const code = character.codePointAt(0);
      return code === undefined || code <= 32 || code === 127 ||
        FORBIDDEN_REF_CHARACTERS.has(character);
    }) ||
    value.split("/").some((part) =>
      part === "." || part === ".." || part.endsWith(".lock")
    )
  ) throw new Error(`The ${label} is invalid.`);
}

function assertRepositoryPath(value, label) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 1024 ||
    value.startsWith("/") || value.endsWith("/") || value.includes("\\") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error(`The ${label} is invalid.`);
  return value;
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  return value;
}

function requiredRunId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,29}$/u.test(value)) {
    throw new Error("The publication recovery run ID is invalid.");
  }
  return value;
}

function requiredNonemptyString(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > maximumLength) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function decodeStrictBase64(value, maximumBytes) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > Math.ceil(maximumBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("The publication recovery outcome base64 is invalid.");
  }
  const source = Buffer.from(value, "base64");
  if (source.length === 0 || source.length > maximumBytes ||
      source.toString("base64") !== value) {
    throw new Error("The publication recovery outcome base64 is not canonical.");
  }
  return source;
}

function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function assertSerializedBound(source, maximumBytes, label) {
  if (source.length > maximumBytes) {
    throw new Error(`The ${label} exceeds its canonical byte bound.`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
