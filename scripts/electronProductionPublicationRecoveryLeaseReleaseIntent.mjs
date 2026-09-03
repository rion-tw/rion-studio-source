import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY
} from "./electronProductionPublicLatestLeaseRemote.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256,
  serializeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  assertElectronProductionPublicationRecoveryOutcomeChainProof,
  serializeElectronProductionPublicationRecoveryOutcomeChainProof
} from "./electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  assertElectronProductionPublicationRecoveryStoreSeal,
  electronProductionPublicationRecoveryStoreSealSha256
} from "./electronProductionPublicationRecovery.mjs";
import {
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  electronProductionRecoveryStoreRemoteOperationReceiptSha256,
  electronProductionRecoveryStoreRemoteReadOperationReceiptSha256,
  verifyElectronProductionRecoveryStoreRemoteOperationRequest,
  verifyElectronProductionRecoveryStoreRemoteReadOperationRequest
} from "./electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "./electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  assertEqual,
  assertExactKeys,
  canonicalRegularFilePath,
  publicIdentity,
  readCanonicalJsonFile,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_KIND =
  "rion-electron-production-publication-recovery-lease-release-intent";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_KIND =
  "rion-electron-production-publication-recovery-lease-release-authorization";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_KIND =
  "rion-electron-production-publication-recovery-lease-release-intent-history";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE =
  "electron-production-publication-recovery-lease-release-intent.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE =
  "electron-production-publication-recovery-lease-release-authorization.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE =
  "electron-production-publication-recovery-lease-release-intent-history.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_BYTES =
  2 * 1024 * 1024;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_AUTHORIZATION_BYTES =
  16 * 1024 * 1024;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_HISTORY_BYTES =
  1024 * 1024;

export function electronProductionPublicationRecoveryLeaseReleaseIntentPath(
  input
) {
  assertExactKeys(input, ["transactionId"],
    "publication recovery lease-release intent path input");
  const transactionPaths = electronProductionRecoveryStoreTransactionPaths({
    transactionId: input.transactionId
  });
  return path.posix.join(
    path.posix.dirname(path.posix.dirname(
      transactionPaths.recoveryOutcomeTerminalPath
    )),
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE
  );
}

export function createElectronProductionPublicationRecoveryLeaseReleaseIntent(
  input
) {
  assertExactKeys(input, [
    "authorizedAt",
    "chainProof",
    "chainProofSha256",
    "heldLease",
    "heldLeaseSha256",
    "recoveryRun",
    "storeSeal",
    "storeSealSha256"
  ], "publication recovery lease-release intent input");
  const heldLease = assertElectronProductionPublicLatestLease(input.heldLease);
  if (
    heldLease.status !== "held" ||
    heldLease.purpose !== "electron-v23-provisional-publication"
  ) {
    throw new Error(
      "A recovery lease-release intent requires the exact provisional held lease."
    );
  }
  const heldLeaseSha256 = requiredDigest(
    input.heldLeaseSha256,
    "publication recovery intent held-lease SHA-256"
  );
  assertEqual(
    sha256(serializeElectronProductionPublicLatestLease(heldLease)),
    heldLeaseSha256,
    "publication recovery intent held-lease SHA-256"
  );
  const storeSeal = assertElectronProductionPublicationRecoveryStoreSeal(
    input.storeSeal
  );
  const storeSealSha256 = requiredDigest(
    input.storeSealSha256,
    "publication recovery intent store-seal SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryStoreSealSha256(storeSeal),
    storeSealSha256,
    "publication recovery intent store-seal SHA-256"
  );
  const chainProof = assertElectronProductionPublicationRecoveryOutcomeChainProof(
    input.chainProof
  );
  const chainProofSha256 = requiredDigest(
    input.chainProofSha256,
    "publication recovery intent chain-proof SHA-256"
  );
  assertEqual(
    sha256(serializeElectronProductionPublicationRecoveryOutcomeChainProof(
      chainProof
    )),
    chainProofSha256,
    "publication recovery intent chain-proof SHA-256"
  );
  if (chainProof.status === "terminal") {
    throw new Error("A terminal recovery outcome chain cannot authorize release.");
  }
  assertIntentFoundation({ chainProof, heldLease, heldLeaseSha256, storeSeal,
    storeSealSha256 });
  const recoveryRun = assertRecoveryRun(input.recoveryRun);
  const authorizedAt = requiredRfc3339(
    input.authorizedAt,
    "publication recovery lease-release intent authorization time"
  );
  assertTimeDoesNotPrecede(
    authorizedAt,
    recoveryRun.startedAt,
    "A lease-release intent cannot precede its recovery run."
  );
  const intentPath =
    electronProductionPublicationRecoveryLeaseReleaseIntentPath({
      transactionId: heldLease.transactionId
    });
  assertEqual(
    path.posix.dirname(intentPath),
    path.posix.dirname(storeSeal.durableStore.path),
    "publication recovery intent transaction directory"
  );
  return assertElectronProductionPublicationRecoveryLeaseReleaseIntent({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_KIND,
    status: "durable-pre-public-release-authority",
    transactionId: heldLease.transactionId,
    heldLease: {
      leaseId: heldLease.leaseId,
      generation: heldLease.generation,
      revision: heldLease.revision,
      eventSha256: electronProductionPublicLatestLeaseEventSha256(heldLease),
      fileSha256: heldLeaseSha256,
      sourceStateSha256: heldLease.source.stateSha256,
      targetStateSha256: heldLease.target.stateSha256
    },
    foundation: {
      storeSealSha256,
      sourceSnapshotSha256: chainProof.foundation.sourceSnapshotSha256,
      targetSnapshotSha256: chainProof.foundation.targetSnapshotSha256,
      temporalFloor: {
        storeSealedAt: storeSeal.sealedAt,
        previousOutcomeDeterminedAt:
          chainProof.latestOutcome?.determinedAt ?? null
      },
      capsule: {
        path: storeSeal.durableStore.path,
        fileName: storeSeal.capsuleFileName,
        byteLength: storeSeal.capsuleBytes,
        sha256: storeSeal.capsuleSha256
      },
      storeSeal: {
        path: electronProductionRecoveryStoreTransactionPaths({
          transactionId: heldLease.transactionId
        }).storeSealPath,
        fileName: "electron-production-publication-recovery-store-seal.json",
        sha256: storeSealSha256
      }
    },
    privateStore: {
      target: chainProof.target,
      path: intentPath,
      expectedHeadCommitSha: chainProof.currentObservation.headCommitSha
    },
    outcomeChain: { sha256: chainProofSha256, proof: chainProof },
    publicLatest: {
      repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
      ref: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
      path: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
      requiredTerminalObservation: "source",
      operations: ["rollback-public-latest", "release-held-lease"],
      overtakePolicy: "forbidden-until-terminal-outcome"
    },
    recoveryRun,
    authorizedAt
  });
}

export function assertElectronProductionPublicationRecoveryLeaseReleaseIntent(
  value
) {
  assertExactKeys(value, [
    "authorizedAt",
    "foundation",
    "heldLease",
    "kind",
    "outcomeChain",
    "privateStore",
    "publicLatest",
    "recoveryRun",
    "schemaVersion",
    "status",
    "transactionId"
  ], "publication recovery lease-release intent");
  assertEqual(value.schemaVersion, 1,
    "publication recovery lease-release intent schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_KIND,
    "publication recovery lease-release intent kind"
  );
  assertEqual(value.status, "durable-pre-public-release-authority",
    "publication recovery lease-release intent status");
  const transactionId = requiredUuid(
    value.transactionId,
    "publication recovery lease-release intent transaction ID"
  );
  const heldLease = assertHeldFence(value.heldLease);
  const foundation = assertIntentFoundationIdentity(value.foundation);
  const outcomeChain = assertEmbeddedChain(value.outcomeChain, transactionId);
  const privateStore = assertPrivateStore(
    value.privateStore,
    transactionId,
    outcomeChain.proof
  );
  const publicLatest = assertPublicLatestPolicy(value.publicLatest);
  const recoveryRun = assertRecoveryRun(value.recoveryRun);
  const authorizedAt = requiredRfc3339(
    value.authorizedAt,
    "publication recovery lease-release intent authorization time"
  );
  assertTimeDoesNotPrecede(
    authorizedAt,
    recoveryRun.startedAt,
    "A lease-release intent cannot precede its recovery run."
  );
  assertTimeDoesNotPrecede(
    recoveryRun.startedAt,
    foundation.temporalFloor.storeSealedAt,
    "A lease-release intent run cannot precede its durable store seal."
  );
  if (foundation.temporalFloor.previousOutcomeDeterminedAt !== null) {
    assertTimeDoesNotPrecede(
      recoveryRun.startedAt,
      foundation.temporalFloor.previousOutcomeDeterminedAt,
      "A lease-release intent run cannot precede its chain predecessor."
    );
    assertEqual(
      foundation.temporalFloor.previousOutcomeDeterminedAt,
      outcomeChain.proof.latestOutcome?.determinedAt ?? null,
      "publication recovery intent predecessor time floor"
    );
  } else {
    assertEqual(outcomeChain.proof.latestOutcome, null,
      "publication recovery intent empty predecessor time floor");
  }
  assertEqual(outcomeChain.proof.status === "terminal", false,
    "publication recovery intent open outcome chain");
  for (const [actual, expected, label] of [
    [outcomeChain.proof.foundation.transactionId, transactionId,
      "chain transaction ID"],
    [outcomeChain.proof.foundation.leaseId, heldLease.leaseId, "chain lease ID"],
    [outcomeChain.proof.foundation.generation, heldLease.generation,
      "chain lease generation"],
    [outcomeChain.proof.foundation.heldLeaseEventSha256,
      heldLease.eventSha256, "chain held event SHA-256"],
    [outcomeChain.proof.foundation.heldLeaseSha256,
      heldLease.fileSha256, "chain held file SHA-256"],
    [outcomeChain.proof.foundation.storeSealSha256,
      foundation.storeSealSha256, "chain store-seal SHA-256"],
    [outcomeChain.proof.foundation.sourceSnapshotSha256,
      foundation.sourceSnapshotSha256, "chain source snapshot SHA-256"],
    [outcomeChain.proof.foundation.targetSnapshotSha256,
      foundation.targetSnapshotSha256, "chain target snapshot SHA-256"],
    [outcomeChain.proof.foundation.sourceStateSha256,
      heldLease.sourceStateSha256, "chain source state SHA-256"],
    [outcomeChain.proof.foundation.targetStateSha256,
      heldLease.targetStateSha256, "chain target state SHA-256"]
  ]) assertEqual(actual, expected, `publication recovery intent ${label}`);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_KIND,
    status: "durable-pre-public-release-authority",
    transactionId,
    heldLease,
    foundation,
    privateStore,
    outcomeChain,
    publicLatest,
    recoveryRun,
    authorizedAt
  });
}

export function createElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  input
) {
  assertExactKeys(input, [
    "createOperation",
    "createOperationSha256",
    "currentRun",
    "foundationReadback",
    "freshChainProof",
    "freshChainProofSha256",
    "intentHistoryProof",
    "intentHistoryProofSha256",
    "intent",
    "intentReadOperation",
    "intentReadOperationSha256",
    "intentSha256",
    "verifiedAt"
  ], "publication recovery lease-release authorization input");
  return buildAuthorization(input);
}

export function createElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  input
) {
  assertExactKeys(input, [
    "currentObservation",
    "initialHeadCommitSha",
    "intentBlobSha",
    "intentCommitSha",
    "intentTreeSha",
    "observedAt",
    "path",
    "pathHistory",
    "target"
  ], "publication recovery lease-release intent history input");
  return assertElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_KIND,
    status: "verified-exact-create-and-reachable-path-history",
    target: input.target,
    path: input.path,
    initialHeadCommitSha: input.initialHeadCommitSha,
    intentCommit: {
      commitSha: input.intentCommitSha,
      treeSha: input.intentTreeSha,
      parentCommitSha: input.initialHeadCommitSha,
      blobSha: input.intentBlobSha
    },
    currentObservation: input.currentObservation,
    pathHistory: input.pathHistory,
    observedAt: input.observedAt
  });
}

export function assertElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  value
) {
  assertExactKeys(value, [
    "currentObservation",
    "initialHeadCommitSha",
    "intentCommit",
    "kind",
    "observedAt",
    "path",
    "pathHistory",
    "schemaVersion",
    "status",
    "target"
  ], "publication recovery lease-release intent history");
  assertEqual(value.schemaVersion, 1,
    "publication recovery intent history schema version");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_KIND,
    "publication recovery intent history kind");
  assertEqual(value.status, "verified-exact-create-and-reachable-path-history",
    "publication recovery intent history status");
  const target = assertPrivateTarget(value.target);
  const intentPath = requiredRepositoryPath(value.path,
    "publication recovery intent history path");
  assertEqual(path.posix.basename(intentPath),
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE,
    "publication recovery intent history filename");
  const initialHeadCommitSha = requiredCommitSha(
    value.initialHeadCommitSha,
    "publication recovery intent history initial head"
  );
  assertExactKeys(value.intentCommit, [
    "blobSha",
    "commitSha",
    "parentCommitSha",
    "treeSha"
  ], "publication recovery intent history create commit");
  const intentCommit = deepFreeze({
    commitSha: requiredCommitSha(value.intentCommit.commitSha,
      "publication recovery intent create commit SHA"),
    treeSha: requiredCommitSha(value.intentCommit.treeSha,
      "publication recovery intent create tree SHA"),
    parentCommitSha: requiredCommitSha(value.intentCommit.parentCommitSha,
      "publication recovery intent create parent SHA"),
    blobSha: requiredCommitSha(value.intentCommit.blobSha,
      "publication recovery intent create blob SHA")
  });
  assertEqual(intentCommit.parentCommitSha, initialHeadCommitSha,
    "publication recovery intent history create parent");
  const currentObservation = assertCurrentObservation(value.currentObservation);
  assertExactKeys(value.pathHistory, [
    "commitSha",
    "nextPage",
    "reachableFromHeadCommitSha",
    "resultCount"
  ], "publication recovery intent fixed-path history");
  assertEqual(value.pathHistory.resultCount, 1,
    "publication recovery intent fixed-path history result count");
  assertEqual(value.pathHistory.nextPage, false,
    "publication recovery intent fixed-path history next page");
  assertEqual(value.pathHistory.commitSha, intentCommit.commitSha,
    "publication recovery intent fixed-path create commit");
  assertEqual(value.pathHistory.reachableFromHeadCommitSha,
    currentObservation.headCommitSha,
    "publication recovery intent fixed-path reachable head");
  const pathHistory = deepFreeze({
    reachableFromHeadCommitSha: requiredCommitSha(
      value.pathHistory.reachableFromHeadCommitSha,
      "publication recovery intent fixed-path reachable head"
    ),
    commitSha: requiredCommitSha(value.pathHistory.commitSha,
      "publication recovery intent fixed-path commit SHA"),
    resultCount: 1,
    nextPage: false
  });
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_KIND,
    status: "verified-exact-create-and-reachable-path-history",
    target,
    path: intentPath,
    initialHeadCommitSha,
    intentCommit,
    currentObservation,
    pathHistory,
    observedAt: requiredRfc3339(value.observedAt,
      "publication recovery intent history observation time")
  });
}

export function assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  value
) {
  assertExactKeys(value, [
    "authority",
    "currentRun",
    "evidence",
    "headTransition",
    "kind",
    "schemaVersion",
    "status",
    "transactionId",
    "verifiedAt"
  ], "publication recovery lease-release authorization");
  assertEqual(value.schemaVersion, 1,
    "publication recovery lease-release authorization schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_KIND,
    "publication recovery lease-release authorization kind"
  );
  assertEqual(value.status, "verified-durable-release-authority",
    "publication recovery lease-release authorization status");
  assertExactKeys(value.authority, ["intent", "sha256"],
    "publication recovery lease-release authorization authority");
  assertExactKeys(value.evidence, [
    "createOperation",
    "foundationReadback",
    "freshChainProof",
    "intentHistoryProof",
    "intentReadOperation"
  ], "publication recovery lease-release authorization evidence");
  for (const [label, embedded] of [
    ["fresh chain proof", value.evidence.freshChainProof],
    ["intent read operation", value.evidence.intentReadOperation]
  ]) {
    assertExactKeys(embedded, ["receipt", "sha256"],
      `publication recovery authorization ${label}`);
  }
  if (value.evidence.createOperation !== null) {
    assertExactKeys(value.evidence.createOperation, ["receipt", "sha256"],
      "publication recovery authorization create operation");
  }
  if (value.evidence.intentHistoryProof !== null) {
    assertExactKeys(value.evidence.intentHistoryProof, ["receipt", "sha256"],
      "publication recovery authorization intent history proof");
  }
  const rebuilt = buildAuthorization({
    intent: value.authority.intent,
    intentSha256: value.authority.sha256,
    createOperation: value.evidence.createOperation?.receipt ?? null,
    createOperationSha256: value.evidence.createOperation?.sha256 ?? null,
    intentReadOperation: value.evidence.intentReadOperation.receipt,
    intentReadOperationSha256: value.evidence.intentReadOperation.sha256,
    freshChainProof: value.evidence.freshChainProof.receipt,
    freshChainProofSha256: value.evidence.freshChainProof.sha256,
    intentHistoryProof:
      value.evidence.intentHistoryProof?.receipt ?? null,
    intentHistoryProofSha256:
      value.evidence.intentHistoryProof?.sha256 ?? null,
    foundationReadback: value.evidence.foundationReadback,
    currentRun: value.currentRun,
    verifiedAt: value.verifiedAt
  });
  assertEqual(value.transactionId, rebuilt.transactionId,
    "publication recovery authorization transaction ID");
  if (!isDeepStrictEqual(value.headTransition, rebuilt.headTransition)) {
    throw new Error(
      "The publication recovery authorization head transition does not match."
    );
  }
  return rebuilt;
}

export function serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryLeaseReleaseIntent(value)
  );
}

export function serializeElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization(value)
  );
}

export function serializeElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(value)
  );
}

export function electronProductionPublicationRecoveryLeaseReleaseIntentSha256(
  value
) {
  return sha256(
    serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(value)
  );
}

export function electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
  value
) {
  return sha256(
    serializeElectronProductionPublicationRecoveryLeaseReleaseAuthorization(value)
  );
}

export function electronProductionPublicationRecoveryLeaseReleaseIntentHistorySha256(
  value
) {
  return sha256(
    serializeElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(value)
  );
}

export async function writeElectronProductionPublicationRecoveryLeaseReleaseIntent(
  input
) {
  return writeContract({
    ...input,
    expectedFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE,
    maximumBytes:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_BYTES,
    label: "publication recovery lease-release intent",
    assertValue: assertElectronProductionPublicationRecoveryLeaseReleaseIntent
  });
}

export async function readElectronProductionPublicationRecoveryLeaseReleaseIntent(
  input
) {
  return readContract({
    ...input,
    expectedFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE,
    maximumBytes:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_BYTES,
    label: "publication recovery lease-release intent",
    assertValue: assertElectronProductionPublicationRecoveryLeaseReleaseIntent
  });
}

export async function writeElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  input
) {
  return writeContract({
    ...input,
    expectedFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE,
    maximumBytes:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_HISTORY_BYTES,
    label: "publication recovery lease-release intent history",
    assertValue:
      assertElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
  });
}

export async function readElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
  input
) {
  return readContract({
    ...input,
    expectedFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_HISTORY_FILE,
    maximumBytes:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_INTENT_HISTORY_BYTES,
    label: "publication recovery lease-release intent history",
    assertValue:
      assertElectronProductionPublicationRecoveryLeaseReleaseIntentHistory
  });
}

export async function writeElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  input
) {
  return writeContract({
    ...input,
    expectedFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE,
    maximumBytes:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_AUTHORIZATION_BYTES,
    label: "publication recovery lease-release authorization",
    assertValue:
      assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization
  });
}

export async function readElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
  input
) {
  return readContract({
    ...input,
    expectedFileName:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE,
    maximumBytes:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_LEASE_RELEASE_AUTHORIZATION_BYTES,
    label: "publication recovery lease-release authorization",
    assertValue:
      assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization
  });
}

function buildAuthorization(input) {
  const intent = assertElectronProductionPublicationRecoveryLeaseReleaseIntent(
    input.intent
  );
  const currentRun = assertRecoveryRun(input.currentRun);
  const intentSource =
    serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(intent);
  const intentSha256 = requiredDigest(
    input.intentSha256,
    "publication recovery lease-release intent SHA-256"
  );
  assertEqual(sha256(intentSource), intentSha256,
    "publication recovery lease-release intent SHA-256");
  const target = remoteTarget(intent.privateStore.target, intent.privateStore.path);
  const createEvidence = verifyOptionalCreateOperation({
    createOperation: input.createOperation,
    createOperationSha256: input.createOperationSha256,
    intent,
    intentSha256,
    intentSource,
    target
  });
  const readRequest = createElectronProductionRecoveryStoreRemoteReadRequest({
    expectedContent: { byteLength: intentSource.length, sha256: intentSha256 },
    target
  });
  const intentReadOperation =
    verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
      receipt: input.intentReadOperation,
      request: readRequest
    });
  const intentReadOperationSha256 = requiredDigest(
    input.intentReadOperationSha256,
    "publication recovery intent read-operation SHA-256"
  );
  assertEqual(
    electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(
      intentReadOperation
    ),
    intentReadOperationSha256,
    "publication recovery intent read-operation SHA-256"
  );
  if (intentReadOperation.terminal.classification !== "present" ||
      intentReadOperation.observed === null) {
    throw new Error("The durable release intent readback is not present.");
  }
  const observed = intentReadOperation.observed;
  const historyEvidence = verifyOptionalIntentHistory({
    createEvidence,
    currentObservation: {
      headCommitSha: observed.headCommitSha,
      treeSha: observed.treeSha,
      parentCommitShas: observed.parentCommitShas
    },
    intent,
    intentHistoryProof: input.intentHistoryProof,
    intentHistoryProofSha256: input.intentHistoryProofSha256,
    intentSource
  });
  if (createEvidence !== null) {
    if (!isDeepStrictEqual(currentRun, intent.recoveryRun)) {
      throw new Error(
        "A newly-created release intent must be authorized by its creating run."
      );
    }
    assertSingleIntentHeadTransition({
      applied: createEvidence.receipt.applied,
      intent,
      observed
    });
  } else {
    assertEqual(observed.blobSha, gitBlobSha(intentSource),
      "resumed publication recovery intent blob SHA");
  }
  const freshChainProof =
    assertElectronProductionPublicationRecoveryOutcomeChainProof(
      input.freshChainProof
    );
  const freshChainProofSha256 = requiredDigest(
    input.freshChainProofSha256,
    "fresh publication recovery chain-proof SHA-256"
  );
  assertEqual(
    sha256(serializeElectronProductionPublicationRecoveryOutcomeChainProof(
      freshChainProof
    )),
    freshChainProofSha256,
    "fresh publication recovery chain-proof SHA-256"
  );
  if (createEvidence === null) {
    assertFreshChainExtends(intent.outcomeChain.proof, freshChainProof, observed);
  } else {
    assertFreshChainUnchanged(intent.outcomeChain.proof, freshChainProof, observed);
  }
  const foundationReadback = assertFoundationReadback(
    input.foundationReadback,
    intent,
    observed
  );
  const verifiedAt = requiredRfc3339(
    input.verifiedAt,
    "publication recovery lease-release authorization verification time"
  );
  assertTimeDoesNotPrecede(
    verifiedAt,
    intent.authorizedAt,
    "A lease-release authorization cannot precede its intent."
  );
  assertTimeDoesNotPrecede(
    verifiedAt,
    currentRun.startedAt,
    "A lease-release authorization cannot precede its current run."
  );
  if (freshChainProof.latestOutcome !== null) {
    assertTimeDoesNotPrecede(
      verifiedAt,
      freshChainProof.latestOutcome.determinedAt,
      "A lease-release authorization cannot precede its fresh chain head."
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_KIND,
    status: "verified-durable-release-authority",
    transactionId: intent.transactionId,
    currentRun,
    authority: { intent, sha256: intentSha256 },
    evidence: {
      createOperation: createEvidence,
      intentHistoryProof: historyEvidence,
      intentReadOperation: {
        receipt: intentReadOperation,
        sha256: intentReadOperationSha256
      },
      freshChainProof: {
        receipt: freshChainProof,
        sha256: freshChainProofSha256
      },
      foundationReadback
    },
    headTransition: {
      mode: createEvidence === null ? "resumed-existing" : "created-now",
      initialHeadCommitSha: intent.privateStore.expectedHeadCommitSha,
      currentHeadCommitSha: observed.headCommitSha,
      intentCommitSha: createEvidence?.receipt.applied.commitSha ?? null,
      treeSha: observed.treeSha,
      parentCommitShas: observed.parentCommitShas,
      intentBlobSha: observed.blobSha
    },
    verifiedAt
  });
}

function verifyOptionalIntentHistory(input) {
  if (input.createEvidence !== null) {
    if (input.intentHistoryProof !== null ||
        input.intentHistoryProofSha256 !== null) {
      throw new Error("A newly-created intent cannot also use resume history.");
    }
    return null;
  }
  if (input.intentHistoryProof === null ||
      input.intentHistoryProofSha256 === null) {
    throw new Error(
      "An existing intent requires durable Git creation and ancestry proof."
    );
  }
  const receipt =
    assertElectronProductionPublicationRecoveryLeaseReleaseIntentHistory(
      input.intentHistoryProof
    );
  const receiptSha256 = requiredDigest(
    input.intentHistoryProofSha256,
    "publication recovery intent history proof SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryLeaseReleaseIntentHistorySha256(
      receipt
    ),
    receiptSha256,
    "publication recovery intent history proof SHA-256"
  );
  for (const [actual, expected, label] of [
    [receipt.target.repository, input.intent.privateStore.target.repository,
      "repository"],
    [receipt.target.ref, input.intent.privateStore.target.ref, "ref"],
    [receipt.path, input.intent.privateStore.path, "path"],
    [receipt.initialHeadCommitSha,
      input.intent.privateStore.expectedHeadCommitSha, "initial head"],
    [receipt.intentCommit.blobSha, gitBlobSha(input.intentSource), "intent blob"]
  ]) assertEqual(actual, expected,
    `publication recovery intent history ${label}`);
  if (!isDeepStrictEqual(
    receipt.currentObservation,
    input.currentObservation
  )) {
    throw new Error(
      "The publication recovery intent history is stale for the reader head."
    );
  }
  return deepFreeze({ receipt, sha256: receiptSha256 });
}

function verifyOptionalCreateOperation(input) {
  if (input.createOperation === null || input.createOperationSha256 === null) {
    if (input.createOperation !== null || input.createOperationSha256 !== null) {
      throw new Error(
        "The intent create operation and digest must both be present or absent."
      );
    }
    return null;
  }
  const request = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: input.intent.privateStore.expectedHeadCommitSha,
    packageIdentity: {
      fileName:
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_INTENT_FILE,
      byteLength: input.intentSource.length,
      sha256: input.intentSha256
    },
    target: input.target
  });
  const receipt = verifyElectronProductionRecoveryStoreRemoteOperationRequest({
    receipt: input.createOperation,
    request
  });
  const receiptSha256 = requiredDigest(
    input.createOperationSha256,
    "publication recovery intent create-operation SHA-256"
  );
  assertEqual(
    electronProductionRecoveryStoreRemoteOperationReceiptSha256(receipt),
    receiptSha256,
    "publication recovery intent create-operation SHA-256"
  );
  if (receipt.terminal.classification !== "applied" || receipt.applied === null) {
    throw new Error("The durable release intent create operation was not applied.");
  }
  assertEqual(receipt.applied.blobSha, gitBlobSha(input.intentSource),
    "publication recovery intent applied blob SHA");
  return deepFreeze({ receipt, sha256: receiptSha256 });
}

function assertIntentFoundation(input) {
  const { chainProof, heldLease, storeSeal } = input;
  for (const [actual, expected, label] of [
    [storeSeal.transactionId, heldLease.transactionId, "transaction ID"],
    [storeSeal.lease.leaseId, heldLease.leaseId, "lease ID"],
    [storeSeal.lease.generation, heldLease.generation, "lease generation"],
    [storeSeal.lease.eventSha256,
      electronProductionPublicLatestLeaseEventSha256(heldLease),
      "held event SHA-256"],
    [storeSeal.source.stateSha256, heldLease.source.stateSha256,
      "source state SHA-256"],
    [storeSeal.target.stateSha256, heldLease.target.stateSha256,
      "target state SHA-256"],
    [chainProof.transactionId, heldLease.transactionId, "chain transaction ID"],
    [chainProof.foundation.heldLeaseSha256, input.heldLeaseSha256,
      "chain held file SHA-256"],
    [chainProof.foundation.storeSealSha256, input.storeSealSha256,
      "chain store-seal SHA-256"],
    [chainProof.target.repository, storeSeal.durableStore.repository,
      "private repository"],
    [chainProof.target.ref, storeSeal.durableStore.ref, "private ref"],
    [chainProof.target.repositoryPolicy.defaultBranch,
      storeSeal.durableStore.repositoryPolicy.defaultBranch,
      "private default branch"],
    [chainProof.target.repositoryPolicy.visibility,
      storeSeal.durableStore.repositoryPolicy.visibility, "private visibility"]
  ]) assertEqual(actual, expected, `publication recovery intent ${label}`);
}

function assertHeldFence(value) {
  assertExactKeys(value, [
    "eventSha256",
    "fileSha256",
    "generation",
    "leaseId",
    "revision",
    "sourceStateSha256",
    "targetStateSha256"
  ], "publication recovery intent held-lease fence");
  return deepFreeze({
    leaseId: requiredUuid(value.leaseId,
      "publication recovery intent lease ID"),
    generation: requiredPositiveInteger(value.generation,
      "publication recovery intent lease generation"),
    revision: requiredPositiveInteger(value.revision,
      "publication recovery intent lease revision"),
    eventSha256: requiredDigest(value.eventSha256,
      "publication recovery intent held event SHA-256"),
    fileSha256: requiredDigest(value.fileSha256,
      "publication recovery intent held file SHA-256"),
    sourceStateSha256: requiredDigest(value.sourceStateSha256,
      "publication recovery intent source state SHA-256"),
    targetStateSha256: requiredDigest(value.targetStateSha256,
      "publication recovery intent target state SHA-256")
  });
}

function assertIntentFoundationIdentity(value) {
  assertExactKeys(value, [
    "capsule",
    "sourceSnapshotSha256",
    "storeSeal",
    "storeSealSha256",
    "targetSnapshotSha256",
    "temporalFloor"
  ], "publication recovery intent foundation");
  const capsule = assertStoredFile(value.capsule,
    "publication recovery intent capsule", true);
  const storeSeal = assertStoredFile(value.storeSeal,
    "publication recovery intent store-seal", false);
  assertEqual(value.storeSealSha256, storeSeal.sha256,
    "publication recovery intent store-seal identity");
  assertExactKeys(value.temporalFloor,
    ["previousOutcomeDeterminedAt", "storeSealedAt"],
    "publication recovery intent temporal floor");
  const temporalFloor = deepFreeze({
    storeSealedAt: requiredRfc3339(value.temporalFloor.storeSealedAt,
      "publication recovery intent store-sealed time"),
    previousOutcomeDeterminedAt:
      value.temporalFloor.previousOutcomeDeterminedAt === null
        ? null
        : requiredRfc3339(value.temporalFloor.previousOutcomeDeterminedAt,
          "publication recovery intent predecessor determined time")
  });
  return deepFreeze({
    storeSealSha256: requiredDigest(value.storeSealSha256,
      "publication recovery intent store-seal SHA-256"),
    sourceSnapshotSha256: requiredDigest(value.sourceSnapshotSha256,
      "publication recovery intent source snapshot SHA-256"),
    targetSnapshotSha256: requiredDigest(value.targetSnapshotSha256,
      "publication recovery intent target snapshot SHA-256"),
    temporalFloor,
    capsule,
    storeSeal
  });
}

function assertStoredFile(value, label, requiresBytes) {
  assertExactKeys(value, requiresBytes
    ? ["byteLength", "fileName", "path", "sha256"]
    : ["fileName", "path", "sha256"], label);
  const fileName = requiredFileName(value.fileName, `${label} filename`);
  const filePath = requiredRepositoryPath(value.path, `${label} path`);
  assertEqual(path.posix.basename(filePath), fileName, `${label} path filename`);
  const result = {
    path: filePath,
    fileName,
    ...(requiresBytes
      ? { byteLength: requiredPositiveInteger(value.byteLength,
        `${label} bytes`) }
      : {}),
    sha256: requiredDigest(value.sha256, `${label} SHA-256`)
  };
  return deepFreeze(result);
}

function assertEmbeddedChain(value, transactionId) {
  assertExactKeys(value, ["proof", "sha256"],
    "publication recovery intent outcome chain");
  const proof = assertElectronProductionPublicationRecoveryOutcomeChainProof(
    value.proof
  );
  assertEqual(proof.transactionId, transactionId,
    "publication recovery intent outcome-chain transaction ID");
  const sha = requiredDigest(value.sha256,
    "publication recovery intent outcome-chain proof SHA-256");
  assertEqual(
    sha256(serializeElectronProductionPublicationRecoveryOutcomeChainProof(proof)),
    sha,
    "publication recovery intent outcome-chain proof SHA-256"
  );
  return deepFreeze({ sha256: sha, proof });
}

function assertPrivateStore(value, transactionId, chainProof) {
  assertExactKeys(value, ["expectedHeadCommitSha", "path", "target"],
    "publication recovery intent private store");
  const target = assertPrivateTarget(value.target);
  const expectedPath =
    electronProductionPublicationRecoveryLeaseReleaseIntentPath({ transactionId });
  assertEqual(value.path, expectedPath,
    "publication recovery lease-release intent private path");
  const expectedHeadCommitSha = requiredCommitSha(
    value.expectedHeadCommitSha,
    "publication recovery intent expected private head"
  );
  assertEqual(expectedHeadCommitSha, chainProof.currentObservation.headCommitSha,
    "publication recovery intent chain head");
  if (!isDeepStrictEqual(target, chainProof.target)) {
    throw new Error("The publication recovery intent private target changed.");
  }
  return deepFreeze({ target, path: expectedPath, expectedHeadCommitSha });
}

function assertPrivateTarget(value) {
  assertExactKeys(value, ["ref", "repository", "repositoryPolicy"],
    "publication recovery intent private target");
  assertExactKeys(value.repositoryPolicy, ["defaultBranch", "visibility"],
    "publication recovery intent private repository policy");
  const repository = requiredRepository(value.repository,
    "publication recovery intent private repository");
  const ref = requiredBranch(value.ref,
    "publication recovery intent private ref");
  const defaultBranch = requiredBranch(value.repositoryPolicy.defaultBranch,
    "publication recovery intent private default branch");
  assertEqual(ref, defaultBranch,
    "publication recovery intent protected default branch");
  assertEqual(value.repositoryPolicy.visibility, "private",
    "publication recovery intent private visibility");
  return deepFreeze({
    repository,
    ref,
    repositoryPolicy: { defaultBranch, visibility: "private" }
  });
}

function assertPublicLatestPolicy(value) {
  assertExactKeys(value, [
    "operations",
    "overtakePolicy",
    "path",
    "ref",
    "repository",
    "requiredTerminalObservation"
  ], "publication recovery intent public-latest policy");
  for (const [actual, expected, label] of [
    [value.repository,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY, "repository"],
    [value.ref, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF, "ref"],
    [value.path, ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH, "path"],
    [value.requiredTerminalObservation, "source", "terminal observation"],
    [value.overtakePolicy, "forbidden-until-terminal-outcome",
      "overtake policy"]
  ]) assertEqual(actual, expected,
    `publication recovery intent public-latest ${label}`);
  if (!isDeepStrictEqual(value.operations, [
    "rollback-public-latest",
    "release-held-lease"
  ])) {
    throw new Error(
      "The publication recovery intent public-latest operations are invalid."
    );
  }
  return deepFreeze({
    repository: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REPOSITORY,
    ref: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_REF,
    path: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_PATH,
    requiredTerminalObservation: "source",
    operations: ["rollback-public-latest", "release-held-lease"],
    overtakePolicy: "forbidden-until-terminal-outcome"
  });
}

function assertRecoveryRun(value) {
  assertExactKeys(value, [
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "startedAt",
    "workflow"
  ], "publication recovery lease-release intent run");
  const repository = requiredNonempty(value.repository,
    "publication recovery intent run repository", 200);
  const workflow = requiredNonempty(value.workflow,
    "publication recovery intent run workflow", 255);
  assertEqual(repository, "rion-tw/rion-studio-source",
    "publication recovery intent run repository");
  assertEqual(
    workflow,
    ".github/workflows/electron-production-provisional-recovery.yml",
    "publication recovery intent run workflow"
  );
  return deepFreeze({
    repository: "rion-tw/rion-studio-source",
    workflow: ".github/workflows/electron-production-provisional-recovery.yml",
    runId: requiredRunId(value.runId),
    runAttempt: requiredPositiveInteger(value.runAttempt,
      "publication recovery intent run attempt"),
    controlSha: requiredCommitSha(value.controlSha,
      "publication recovery intent control SHA"),
    startedAt: requiredRfc3339(value.startedAt,
      "publication recovery intent run start time")
  });
}

function assertSingleIntentHeadTransition(input) {
  const initialHead = input.intent.privateStore.expectedHeadCommitSha;
  for (const [actual, expected, label] of [
    [input.applied.parentCommitSha, initialHead, "applied parent"],
    [input.observed.headCommitSha, input.applied.commitSha, "readback head"],
    [input.observed.treeSha, input.applied.treeSha, "readback tree"],
    [input.observed.blobSha, input.applied.blobSha, "readback blob"]
  ]) assertEqual(actual, expected,
    `publication recovery intent ${label}`);
  if (!isDeepStrictEqual(input.observed.parentCommitShas, [initialHead])) {
    throw new Error(
      "The durable release intent must be the only fresh head transition."
    );
  }
}

function assertFreshChainUnchanged(initial, fresh, observed) {
  for (const [actual, expected, label] of [
    [fresh.transactionId, initial.transactionId, "transaction ID"],
    [fresh.currentObservation.headCommitSha, observed.headCommitSha, "head"],
    [fresh.currentObservation.treeSha, observed.treeSha, "tree"]
  ]) assertEqual(actual, expected,
    `fresh publication recovery outcome chain ${label}`);
  if (!isDeepStrictEqual(
    fresh.currentObservation.parentCommitShas,
    observed.parentCommitShas
  )) throw new Error("The fresh outcome chain parents do not match intent readback.");
  if (!isDeepStrictEqual(chainContentProjection(initial),
    chainContentProjection(fresh))) {
    throw new Error(
      "The publication recovery outcome chain changed while creating its intent."
    );
  }
}

function assertFreshChainExtends(initial, fresh, observed) {
  for (const [actual, expected, label] of [
    [fresh.transactionId, initial.transactionId, "transaction ID"],
    [fresh.currentObservation.headCommitSha, observed.headCommitSha, "head"],
    [fresh.currentObservation.treeSha, observed.treeSha, "tree"]
  ]) assertEqual(actual, expected,
    `resumed publication recovery outcome chain ${label}`);
  if (!isDeepStrictEqual(
    fresh.currentObservation.parentCommitShas,
    observed.parentCommitShas
  )) throw new Error("The resumed outcome chain parents do not match readback.");
  if (fresh.status === "terminal" || fresh.terminal !== null) {
    throw new Error("A terminal recovery chain cannot resume public mutation.");
  }
  for (const field of ["transactionId", "foundation", "target"]) {
    if (!isDeepStrictEqual(fresh[field], initial[field])) {
      throw new Error(`The resumed outcome chain ${field} changed.`);
    }
  }
  if (fresh.outcomes.length < initial.outcomes.length) {
    throw new Error("The resumed outcome chain lost an intent-bound predecessor.");
  }
  for (let index = 0; index < initial.outcomes.length; index += 1) {
    if (!isDeepStrictEqual(fresh.outcomes[index], initial.outcomes[index])) {
      throw new Error("The resumed outcome chain does not preserve its exact prefix.");
    }
  }
}

function chainContentProjection(proof) {
  return {
    status: proof.status,
    transactionId: proof.transactionId,
    foundation: proof.foundation,
    target: proof.target,
    outcomeDirectory: proof.outcomeDirectory,
    terminal: proof.terminal,
    latestOutcome: proof.latestOutcome,
    outcomes: proof.outcomes
  };
}

function assertFoundationReadback(value, intent, intentObservation) {
  assertExactKeys(value, [
    "capsule",
    "currentObservation",
    "historicalCapsuleCreate",
    "kind",
    "paths",
    "schemaVersion",
    "status",
    "storeSeal",
    "target",
    "transactionId"
  ], "publication recovery intent foundation readback");
  assertEqual(value.schemaVersion, 1,
    "publication recovery intent foundation readback schema version");
  assertEqual(value.kind, "rion-electron-production-recovery-store-readback-foundation",
    "publication recovery intent foundation readback kind");
  assertEqual(value.status, "verified-current-readback",
    "publication recovery intent foundation readback status");
  assertEqual(value.transactionId, intent.transactionId,
    "publication recovery intent foundation readback transaction ID");
  const target = assertPrivateTarget(value.target);
  if (!isDeepStrictEqual(target, intent.privateStore.target)) {
    throw new Error("The intent foundation readback target changed.");
  }
  assertExactKeys(value.paths, ["capsule", "storeSeal"],
    "publication recovery intent foundation readback paths");
  assertEqual(value.paths.capsule, intent.foundation.capsule.path,
    "publication recovery intent foundation capsule path");
  assertEqual(value.paths.storeSeal, intent.foundation.storeSeal.path,
    "publication recovery intent foundation store-seal path");
  const currentObservation = assertCurrentObservation(value.currentObservation);
  if (!isDeepStrictEqual(currentObservation, {
    headCommitSha: intentObservation.headCommitSha,
    treeSha: intentObservation.treeSha,
    parentCommitShas: intentObservation.parentCommitShas
  })) throw new Error("The intent foundation readback is not at the intent head.");
  const capsule = assertReadbackFile(value.capsule,
    "publication recovery intent foundation capsule");
  const storeSeal = assertReadbackFile(value.storeSeal,
    "publication recovery intent foundation store-seal");
  for (const [actual, expected, label] of [
    [capsule.file.fileName, intent.foundation.capsule.fileName,
      "capsule filename"],
    [capsule.file.byteLength, intent.foundation.capsule.byteLength,
      "capsule byte length"],
    [capsule.file.sha256, intent.foundation.capsule.sha256, "capsule SHA-256"],
    [storeSeal.file.fileName, intent.foundation.storeSeal.fileName,
      "store-seal filename"],
    [storeSeal.file.sha256, intent.foundation.storeSeal.sha256,
      "store-seal SHA-256"]
  ]) assertEqual(actual, expected,
    `publication recovery intent foundation ${label}`);
  const historicalCapsuleCreate = assertHistoricalCapsuleCreate(
    value.historicalCapsuleCreate
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: "rion-electron-production-recovery-store-readback-foundation",
    status: "verified-current-readback",
    transactionId: intent.transactionId,
    target,
    paths: { ...value.paths },
    currentObservation,
    capsule,
    storeSeal,
    historicalCapsuleCreate
  });
}

function assertReadbackFile(value, label) {
  assertExactKeys(value, ["blobSha", "file", "readReceiptSha256"], label);
  assertExactKeys(value.file, ["byteLength", "fileName", "sha256"],
    `${label} file`);
  return deepFreeze({
    file: {
      fileName: requiredFileName(value.file.fileName, `${label} filename`),
      byteLength: requiredPositiveInteger(value.file.byteLength,
        `${label} byte length`),
      sha256: requiredDigest(value.file.sha256, `${label} SHA-256`)
    },
    blobSha: requiredCommitSha(value.blobSha, `${label} blob SHA`),
    readReceiptSha256: requiredDigest(value.readReceiptSha256,
      `${label} read receipt SHA-256`)
  });
}

function assertHistoricalCapsuleCreate(value) {
  assertExactKeys(value, [
    "authority",
    "commitSha",
    "operationReceiptSha256",
    "parentCommitSha",
    "treeSha"
  ], "publication recovery intent historical capsule create");
  assertEqual(value.authority, "seal-recorded-not-reproved",
    "publication recovery intent historical capsule authority");
  return deepFreeze({
    authority: "seal-recorded-not-reproved",
    parentCommitSha: requiredCommitSha(value.parentCommitSha,
      "historical capsule parent SHA"),
    commitSha: requiredCommitSha(value.commitSha,
      "historical capsule commit SHA"),
    treeSha: requiredCommitSha(value.treeSha, "historical capsule tree SHA"),
    operationReceiptSha256: requiredDigest(value.operationReceiptSha256,
      "historical capsule operation receipt SHA-256")
  });
}

function assertCurrentObservation(value) {
  assertExactKeys(value, ["headCommitSha", "parentCommitShas", "treeSha"],
    "publication recovery intent current observation");
  if (!Array.isArray(value.parentCommitShas) ||
      value.parentCommitShas.length > 16) {
    throw new Error("Publication recovery intent parent commits are invalid.");
  }
  const parentCommitShas = value.parentCommitShas.map((parent) =>
    requiredCommitSha(parent, "publication recovery intent parent SHA")
  );
  if (new Set(parentCommitShas).size !== parentCommitShas.length) {
    throw new Error("Publication recovery intent parent commits must be unique.");
  }
  return deepFreeze({
    headCommitSha: requiredCommitSha(value.headCommitSha,
      "publication recovery intent head SHA"),
    treeSha: requiredCommitSha(value.treeSha,
      "publication recovery intent tree SHA"),
    parentCommitShas
  });
}

function remoteTarget(target, filePath) {
  const [owner, repo, extra] = target.repository.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new Error("The private recovery repository slug is invalid.");
  }
  return {
    owner,
    repo,
    ref: target.ref,
    path: filePath,
    repositoryPolicy: target.repositoryPolicy
  };
}

async function writeContract(input) {
  assertExactKeys(input, [
    "assertValue",
    "expectedFileName",
    "label",
    "maximumBytes",
    "outputPath",
    "value"
  ], `${input.label} write input`);
  const value = input.assertValue(input.value);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    input.expectedFileName,
    input.label
  );
  const source = serializeCanonicalJson(value);
  if (source.length > input.maximumBytes) {
    throw new Error(`The ${input.label} exceeds its byte bound.`);
  }
  await writeExclusive(outputPath, source);
  const reread = await readCanonicalJsonFile(
    outputPath,
    input.maximumBytes,
    input.label
  );
  assertEqual(reread.sha256, sha256(source), `${input.label} stable SHA-256`);
  const rereadValue = input.assertValue(reread.value);
  if (!isDeepStrictEqual(rereadValue, value)) {
    throw new Error(`The ${input.label} changed during its stable reread.`);
  }
  return deepFreeze({
    value: rereadValue,
    valueIdentity: publicIdentity(outputPath, reread),
    valuePath: outputPath
  });
}

async function readContract(input) {
  assertExactKeys(input, [
    "assertValue",
    "expectedFileName",
    "expectedSha256",
    "label",
    "maximumBytes",
    "receiptPath"
  ], `${input.label} read input`);
  assertEqual(path.basename(input.receiptPath), input.expectedFileName,
    `${input.label} filename`);
  const receiptPath = await canonicalRegularFilePath(
    input.receiptPath,
    input.maximumBytes,
    input.label
  );
  const file = await readCanonicalJsonFile(
    receiptPath,
    input.maximumBytes,
    input.label
  );
  assertEqual(file.sha256,
    requiredDigest(input.expectedSha256, `${input.label} SHA-256`),
    `${input.label} SHA-256`);
  return deepFreeze({
    value: input.assertValue(file.value),
    valueIdentity: publicIdentity(receiptPath, file),
    valuePath: receiptPath
  });
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function requiredRepository(value, label) {
  if (typeof value !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) ||
      value.length > 200) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredBranch(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 ||
      value.startsWith("-") || value.startsWith("/") || value.endsWith("/") ||
      value.includes("..") || value.includes("@{") || value.endsWith(".lock") ||
      value.split("").some((character) =>
        character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f ||
        " ~^:?*[\\".includes(character)
      )) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredRepositoryPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 ||
      value.startsWith("/") || value.endsWith("/") || value.includes("\\") ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredFileName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,255}$/u.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredNonempty(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > maximumLength || value.trim() !== value) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredRunId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,29}$/u.test(value)) {
    throw new Error("The publication recovery intent run ID is invalid.");
  }
  return value;
}

function assertTimeDoesNotPrecede(later, earlier, message) {
  if (Date.parse(later) < Date.parse(earlier)) throw new Error(message);
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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
