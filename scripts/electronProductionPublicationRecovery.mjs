import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "./electronProductionRecoveryCapsule.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES
} from "./electronProductionRecoveryStoreRemote.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256
} from "./electronProductionPublicLatestLease.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  classifyElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  electronProductionPublicationEventSha256
} from "./electronProductionPublicationReceipt.mjs";
import {
  assertRecoveryOutcomeDecision,
  deriveRecoveryDecision
} from "./electronProductionPublicationRecoveryDecision.mjs";
import {
  assertElectronProductionPublicationSnapshotBindings
} from "./electronProductionPublicationTransaction.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertSemanticVersionIsNewer,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  requiredSemanticVersion
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  assertCapsuleFileName,
  assertCapsuleIdentity,
  assertDeepEqual,
  assertMarkerAuthority,
  assertRepositoryPolicy,
  assertSourceSnapshot,
  assertTargetSnapshot,
  assertTimeOrder,
  deepFreeze,
  optionalDigest,
  readRecoveryFile,
  requiredEnum,
  requiredBranch,
  requiredReleaseId,
  requiredRepository,
  requiredRepositoryPath,
  requiredRunId,
  requiredUuid,
  requiredWorkflow,
  sameObservation,
  sha256,
  writeRecoveryFile
} from "./electronProductionPublicationRecoveryValidation.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_KIND =
  "rion-electron-production-publication-recovery-store-seal";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_KIND =
  "rion-electron-production-publication-recovery-outcome";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND =
  "rion-electron-production-publication-recovery-public-mutation-operation";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE =
  "electron-production-publication-recovery-store-seal.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE =
  "electron-production-publication-recovery-outcome.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_ATTEMPT_PREFIX =
  "electron-production-publication-recovery-outcome-run-";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const OBSERVATION_CLASSIFICATIONS = new Set([
  "source",
  "target",
  "foreign",
  "unknown"
]);
const MUTATION_ACKNOWLEDGEMENTS = new Set(["confirmed", "rejected", "unknown"]);

export function createElectronProductionPublicationRecoveryStoreSeal(input) {
  assertExactKeys(input, [
    "capsuleBytes",
    "capsuleManifestSha256",
    "capsuleManifestBytes",
    "capsuleSha256",
    "durableStore",
    "heldLease",
    "publicationIntent",
    "sealedAt",
    "sourceSnapshot",
    "targetSnapshot",
    "writer"
  ], "publication recovery store-seal input");
  const foundation = assertPublicationFoundation(input);
  const durableStore = assertDurableStore(input.durableStore);
  const writer = assertRunIdentity(input.writer, "recovery-store writer");
  const sealedAt = requiredRfc3339(input.sealedAt, "recovery store-seal time");
  assertTimeOrder(
    durableStore.committedAt,
    sealedAt,
    "The recovery store seal cannot precede its durable commit."
  );
  return assertElectronProductionPublicationRecoveryStoreSeal({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_KIND,
    status: "durably-stored-pre-mutation",
    transactionId: foundation.transactionId,
    lease: foundation.lease,
    source: foundation.source,
    target: foundation.target,
    publicationIntentEventSha256: foundation.publicationIntentEventSha256,
    capsuleFileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    capsuleBytes: requiredPositiveInteger(input.capsuleBytes,
      "recovery capsule bytes"),
    capsuleSha256: requiredDigest(input.capsuleSha256,
      "recovery capsule SHA-256"),
    capsuleManifestBytes: requiredPositiveInteger(
      input.capsuleManifestBytes,
      "recovery capsule manifest bytes"
    ),
    capsuleManifestSha256: requiredDigest(
      input.capsuleManifestSha256,
      "recovery capsule manifest SHA-256"
    ),
    publisher: foundation.publisher,
    writer,
    durableStore,
    sealedAt
  });
}

export function assertElectronProductionPublicationRecoveryStoreSeal(value) {
  assertExactKeys(value, [
    "capsuleBytes",
    "capsuleFileName",
    "capsuleManifestSha256",
    "capsuleManifestBytes",
    "capsuleSha256",
    "durableStore",
    "kind",
    "lease",
    "publicationIntentEventSha256",
    "publisher",
    "schemaVersion",
    "sealedAt",
    "source",
    "status",
    "target",
    "transactionId",
    "writer"
  ], "publication recovery store seal");
  assertEqual(value.schemaVersion, 1, "publication recovery store-seal schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_KIND,
    "publication recovery store-seal kind"
  );
  assertEqual(
    value.status,
    "durably-stored-pre-mutation",
    "publication recovery store-seal status"
  );
  const transactionId = requiredUuid(value.transactionId, "recovery transaction ID");
  const lease = assertLeaseFence(value.lease);
  const source = assertSourceState(value.source);
  const target = assertTargetState(value.target, source);
  assertDistinctState(source, target);
  const durableStore = assertDurableStore(value.durableStore);
  const capsuleBytes = requiredPositiveInteger(value.capsuleBytes,
    "recovery capsule bytes");
  assertEqual(durableStore.byteLength, capsuleBytes,
    "durable recovery store capsule byte length");
  const capsuleSha256 = requiredDigest(value.capsuleSha256,
    "recovery capsule SHA-256");
  const capsuleManifestBytes = requiredPositiveInteger(
    value.capsuleManifestBytes,
    "recovery capsule manifest bytes"
  );
  const capsuleManifestSha256 = requiredDigest(
    value.capsuleManifestSha256,
    "recovery capsule manifest SHA-256"
  );
  assertCapsuleIdentity(
    capsuleBytes,
    capsuleSha256,
    capsuleManifestBytes,
    capsuleManifestSha256
  );
  const sealedAt = requiredRfc3339(value.sealedAt, "recovery store-seal time");
  assertTimeOrder(
    durableStore.committedAt,
    sealedAt,
    "The recovery store seal cannot precede its durable commit."
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_KIND,
    status: "durably-stored-pre-mutation",
    transactionId,
    lease,
    source,
    target,
    publicationIntentEventSha256: requiredDigest(
      value.publicationIntentEventSha256,
      "publication intent event SHA-256"
    ),
    capsuleFileName: assertCapsuleFileName(value.capsuleFileName),
    capsuleBytes,
    capsuleSha256,
    capsuleManifestBytes,
    capsuleManifestSha256,
    publisher: assertRunIdentity(value.publisher, "recovery capsule publisher"),
    writer: assertRunIdentity(value.writer, "recovery-store writer"),
    durableStore,
    sealedAt
  });
}

export function assertElectronProductionPublicationRecoveryStoreSealBindings(input) {
  assertExactKeys(input, [
    "heldLease",
    "publicationIntent",
    "seal",
    "sourceSnapshot",
    "targetSnapshot"
  ], "publication recovery store-seal bindings");
  const seal = assertElectronProductionPublicationRecoveryStoreSeal(input.seal);
  const expected = assertPublicationFoundation(input);
  assertEqual(seal.transactionId, expected.transactionId,
    "recovery store-seal transaction ID binding");
  assertDeepEqual(seal.lease, expected.lease, "recovery store-seal lease binding");
  assertDeepEqual(seal.source, expected.source, "recovery store-seal source binding");
  assertDeepEqual(seal.target, expected.target, "recovery store-seal target binding");
  assertEqual(
    seal.publicationIntentEventSha256,
    expected.publicationIntentEventSha256,
    "recovery store-seal publication intent binding"
  );
  assertDeepEqual(
    seal.publisher,
    expected.publisher,
    "recovery store-seal publisher binding"
  );
  return seal;
}

export function createElectronProductionPublicationRecoveryOutcome(input) {
  assertExactKeys(input, [
    "beforeMutation",
    "determinedAt",
    "finalObservation",
    "heldLease",
    "leaseRelease",
    "mutation",
    "previousOutcomeSha256",
    "recoveryOperation",
    "recoveryRun",
    "sourceSnapshot",
    "storeSeal",
    "targetSnapshot"
  ], "publication recovery outcome input");
  const foundation = assertRecoveryFoundation(input);
  const recoveryRun = assertRecoveryRun(input.recoveryRun);
  const previousOutcomeSha256 = optionalDigest(
    input.previousOutcomeSha256,
    "previous publication recovery outcome SHA-256"
  );
  assertTimeOrder(
    foundation.storeSeal.sealedAt,
    recoveryRun.startedAt,
    "A recovery run cannot precede its durable store seal."
  );
  const beforeMutation = createObservation(
    input.beforeMutation,
    foundation.sourceSnapshot,
    foundation.targetSnapshot,
    "pre-mutation recovery observation"
  );
  const mutation = assertMutation(input.mutation, beforeMutation.observedAt);
  const recoveryOperation = assertRecoveryOperation(
    input.recoveryOperation,
    mutation.kind
  );
  if (mutation.kind === "rollback" && beforeMutation.classification !== "target") {
    throw new Error("Rollback requires an exact target observation under the held lease.");
  }
  const finalObservation = createObservation(
    input.finalObservation,
    foundation.sourceSnapshot,
    foundation.targetSnapshot,
    "final recovery observation"
  );
  assertTimeOrder(
    mutation.resultRecordedAt ?? beforeMutation.observedAt,
    finalObservation.observedAt,
    "The final recovery observation cannot precede the mutation result."
  );
  if (mutation.kind === "none" &&
      !sameObservation(beforeMutation, finalObservation) &&
      !allowsMarkerReleaseDrift(recoveryOperation)) {
    throw new Error("A recovery run without mutation cannot claim a changed public state.");
  }
  const leaseRelease = assertLeaseRelease(
    input.leaseRelease,
    finalObservation.observedAt,
    beforeMutation.observedAt
  );
  assertRecoveryObservationRunOrder(
    recoveryRun,
    beforeMutation,
    finalObservation,
    mutation,
    leaseRelease
  );
  assertRecoveryOperationAuthority(
    recoveryOperation,
    mutation,
    leaseRelease,
    beforeMutation
  );
  const decision = deriveRecoveryDecision({
    beforeMutation,
    finalObservation,
    leaseRelease,
    mutation
  });
  const determinedAt = requiredRfc3339(
    input.determinedAt,
    "publication recovery outcome time"
  );
  assertTimeOrder(
    leaseRelease.resolvedAt ?? finalObservation.observedAt,
    determinedAt,
    "The recovery outcome cannot precede its final authoritative event."
  );
  return assertElectronProductionPublicationRecoveryOutcome({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_KIND,
    status: "closed-recovery-observation",
    transactionId: foundation.storeSeal.transactionId,
    lease: foundation.storeSeal.lease,
    source: foundation.storeSeal.source,
    target: foundation.storeSeal.target,
    publicationIntentEventSha256:
      foundation.storeSeal.publicationIntentEventSha256,
    capsuleFileName: foundation.storeSeal.capsuleFileName,
    capsuleBytes: foundation.storeSeal.capsuleBytes,
    capsuleSha256: foundation.storeSeal.capsuleSha256,
    capsuleManifestBytes: foundation.storeSeal.capsuleManifestBytes,
    capsuleManifestSha256: foundation.storeSeal.capsuleManifestSha256,
    durableStore: {
      ...foundation.storeSeal.durableStore,
      sealedAt: foundation.storeSeal.sealedAt,
      sealSha256: electronProductionPublicationRecoveryStoreSealSha256(
        foundation.storeSeal
      )
    },
    previousOutcomeSha256,
    recoveryRun,
    recoveryOperation,
    observation: { beforeMutation, final: finalObservation },
    mutation,
    leaseRelease,
    outcome: { ...decision, determinedAt }
  });
}

export function assertElectronProductionPublicationRecoveryOutcome(value) {
  assertExactKeys(value, [
    "capsuleBytes",
    "capsuleFileName",
    "capsuleManifestSha256",
    "capsuleManifestBytes",
    "capsuleSha256",
    "durableStore",
    "kind",
    "lease",
    "leaseRelease",
    "mutation",
    "observation",
    "outcome",
    "previousOutcomeSha256",
    "publicationIntentEventSha256",
    "recoveryRun",
    "recoveryOperation",
    "schemaVersion",
    "source",
    "status",
    "target",
    "transactionId"
  ], "publication recovery outcome");
  assertEqual(value.schemaVersion, 1, "publication recovery outcome schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_KIND,
    "publication recovery outcome kind"
  );
  assertEqual(
    value.status,
    "closed-recovery-observation",
    "publication recovery outcome status"
  );
  const transactionId = requiredUuid(value.transactionId, "recovery transaction ID");
  const lease = assertLeaseFence(value.lease);
  const source = assertSourceState(value.source);
  const target = assertTargetState(value.target, source);
  assertDistinctState(source, target);
  const durableStore = assertOutcomeDurableStore(value.durableStore);
  const capsuleBytes = requiredPositiveInteger(value.capsuleBytes,
    "recovery capsule bytes");
  assertEqual(durableStore.byteLength, capsuleBytes,
    "recovery outcome durable-store capsule byte length");
  const capsuleSha256 = requiredDigest(value.capsuleSha256,
    "recovery capsule SHA-256");
  const capsuleManifestBytes = requiredPositiveInteger(
    value.capsuleManifestBytes,
    "recovery capsule manifest bytes"
  );
  const capsuleManifestSha256 = requiredDigest(
    value.capsuleManifestSha256,
    "recovery capsule manifest SHA-256"
  );
  assertCapsuleIdentity(
    capsuleBytes,
    capsuleSha256,
    capsuleManifestBytes,
    capsuleManifestSha256
  );
  const recoveryRun = assertRecoveryRun(value.recoveryRun);
  const previousOutcomeSha256 = optionalDigest(
    value.previousOutcomeSha256,
    "previous publication recovery outcome SHA-256"
  );
  assertTimeOrder(
    durableStore.sealedAt,
    recoveryRun.startedAt,
    "A recovery run cannot precede its durable store seal."
  );
  assertExactKeys(value.observation, ["beforeMutation", "final"],
    "publication recovery observations");
  const beforeMutation = assertObservation(
    value.observation.beforeMutation,
    source,
    target,
    "pre-mutation recovery observation"
  );
  const mutation = assertMutation(value.mutation, beforeMutation.observedAt);
  const recoveryOperation = assertRecoveryOperation(
    value.recoveryOperation,
    mutation.kind
  );
  if (mutation.kind === "rollback" && beforeMutation.classification !== "target") {
    throw new Error("Rollback requires an exact target observation under the held lease.");
  }
  const finalObservation = assertObservation(
    value.observation.final,
    source,
    target,
    "final recovery observation"
  );
  assertTimeOrder(
    mutation.resultRecordedAt ?? beforeMutation.observedAt,
    finalObservation.observedAt,
    "The final recovery observation cannot precede the mutation result."
  );
  if (mutation.kind === "none" &&
      !sameObservation(beforeMutation, finalObservation) &&
      !allowsMarkerReleaseDrift(recoveryOperation)) {
    throw new Error("A recovery run without mutation cannot claim a changed public state.");
  }
  const leaseRelease = assertLeaseRelease(
    value.leaseRelease,
    finalObservation.observedAt,
    beforeMutation.observedAt
  );
  assertRecoveryObservationRunOrder(
    recoveryRun,
    beforeMutation,
    finalObservation,
    mutation,
    leaseRelease
  );
  assertRecoveryOperationAuthority(
    recoveryOperation,
    mutation,
    leaseRelease,
    beforeMutation
  );
  const expectedDecision = deriveRecoveryDecision({
    beforeMutation,
    finalObservation,
    leaseRelease,
    mutation
  });
  const outcome = assertRecoveryOutcomeDecision(value.outcome, expectedDecision);
  assertTimeOrder(
    leaseRelease.resolvedAt ?? finalObservation.observedAt,
    outcome.determinedAt,
    "The recovery outcome cannot precede its final authoritative event."
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_KIND,
    status: "closed-recovery-observation",
    transactionId,
    lease,
    source,
    target,
    publicationIntentEventSha256: requiredDigest(
      value.publicationIntentEventSha256,
      "publication intent event SHA-256"
    ),
    capsuleFileName: assertCapsuleFileName(value.capsuleFileName),
    capsuleBytes,
    capsuleSha256,
    capsuleManifestBytes,
    capsuleManifestSha256,
    durableStore,
    previousOutcomeSha256,
    recoveryRun,
    recoveryOperation,
    observation: { beforeMutation, final: finalObservation },
    mutation,
    leaseRelease,
    outcome
  });
}

export function assertElectronProductionPublicationRecoveryOutcomeBindings(input) {
  assertExactKeys(input, [
    "heldLease",
    "outcome",
    "sourceSnapshot",
    "storeSeal",
    "targetSnapshot"
  ], "publication recovery outcome bindings");
  const outcome = assertElectronProductionPublicationRecoveryOutcome(input.outcome);
  const foundation = assertRecoveryFoundation(input);
  const seal = foundation.storeSeal;
  for (const [actual, expected, label] of [
    [outcome.transactionId, seal.transactionId, "transaction ID"],
    [outcome.publicationIntentEventSha256, seal.publicationIntentEventSha256,
      "publication intent event SHA-256"],
    [outcome.capsuleFileName, seal.capsuleFileName, "capsule filename"],
    [outcome.capsuleBytes, seal.capsuleBytes, "capsule bytes"],
    [outcome.capsuleSha256, seal.capsuleSha256, "capsule SHA-256"],
    [outcome.capsuleManifestBytes, seal.capsuleManifestBytes,
      "capsule manifest bytes"],
    [outcome.capsuleManifestSha256, seal.capsuleManifestSha256,
      "capsule manifest SHA-256"],
    [outcome.durableStore.sealSha256,
      electronProductionPublicationRecoveryStoreSealSha256(seal),
      "store-seal SHA-256"]
  ]) assertEqual(actual, expected, `recovery outcome ${label} binding`);
  assertDeepEqual(outcome.lease, seal.lease, "recovery outcome lease binding");
  assertDeepEqual(outcome.source, seal.source, "recovery outcome source binding");
  assertDeepEqual(outcome.target, seal.target, "recovery outcome target binding");
  assertEqual(outcome.durableStore.sealedAt, seal.sealedAt,
    "recovery outcome store-seal time binding");
  const {
    sealSha256: _sealSha256,
    sealedAt: _sealedAt,
    ...storedReference
  } = outcome.durableStore;
  assertDeepEqual(
    storedReference,
    seal.durableStore,
    "recovery outcome durable-store binding"
  );
  return outcome;
}

export function electronProductionPublicationRecoveryStoreSealSha256(value) {
  return sha256(serializeElectronProductionPublicationRecoveryStoreSeal(value));
}

export function electronProductionPublicationRecoveryOutcomeSha256(value) {
  return sha256(serializeElectronProductionPublicationRecoveryOutcome(value));
}

export function electronProductionPublicationRecoveryOutcomeAttemptFileName(
  recoveryRun
) {
  const run = assertRecoveryRun(recoveryRun);
  return `${ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_ATTEMPT_PREFIX}` +
    `${run.runId}-attempt-${String(run.runAttempt).padStart(6, "0")}.json`;
}

export function serializeElectronProductionPublicationRecoveryStoreSeal(value) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryStoreSeal(value)
  );
}

export function serializeElectronProductionPublicationRecoveryOutcome(value) {
  return serializeCanonicalJson(assertElectronProductionPublicationRecoveryOutcome(value));
}

export async function writeElectronProductionPublicationRecoveryStoreSeal(input) {
  return writeRecoveryFile(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE,
    "publication recovery store seal",
    assertElectronProductionPublicationRecoveryStoreSeal
  );
}

export async function writeElectronProductionPublicationRecoveryOutcome(input) {
  const receipt = assertElectronProductionPublicationRecoveryOutcome(
    input.receipt
  );
  if (!receipt.outcome.terminal) {
    throw new Error(
      "The fixed publication recovery outcome path is terminal-only."
    );
  }
  return writeRecoveryFile(
    { ...input, receipt },
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
    "publication recovery outcome",
    assertElectronProductionPublicationRecoveryOutcome
  );
}

export async function writeElectronProductionPublicationRecoveryOutcomeAttempt(
  input
) {
  const receipt = assertElectronProductionPublicationRecoveryOutcome(
    input.receipt
  );
  return writeRecoveryFile(
    { ...input, receipt },
    electronProductionPublicationRecoveryOutcomeAttemptFileName(
      receipt.recoveryRun
    ),
    "publication recovery outcome attempt",
    assertElectronProductionPublicationRecoveryOutcome
  );
}

export async function readElectronProductionPublicationRecoveryStoreSeal(input) {
  return readRecoveryFile(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE,
    "publication recovery store seal",
    assertElectronProductionPublicationRecoveryStoreSeal
  );
}

export async function readElectronProductionPublicationRecoveryOutcome(input) {
  const file = await readRecoveryFile(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
    "publication recovery outcome",
    assertElectronProductionPublicationRecoveryOutcome
  );
  if (!file.receipt.outcome.terminal) {
    throw new Error(
      "The fixed publication recovery outcome path is terminal-only."
    );
  }
  return file;
}

export async function readElectronProductionPublicationRecoveryOutcomeAttempt(
  input
) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "publication recovery outcome attempt read input");
  const receiptPath = requiredAbsolutePath(
    input.receiptPath,
    "publication recovery outcome attempt"
  );
  const file = await readCanonicalJsonFile(
    receiptPath,
    MAX_RECEIPT_BYTES,
    "publication recovery outcome attempt"
  );
  assertEqual(
    file.sha256,
    requiredDigest(
      input.expectedSha256,
      "publication recovery outcome attempt SHA-256"
    ),
    "publication recovery outcome attempt SHA-256"
  );
  const receipt = assertElectronProductionPublicationRecoveryOutcome(file.value);
  assertEqual(
    path.basename(receiptPath),
    electronProductionPublicationRecoveryOutcomeAttemptFileName(
      receipt.recoveryRun
    ),
    "publication recovery outcome attempt filename"
  );
  if (!file.source.equals(
    serializeElectronProductionPublicationRecoveryOutcome(receipt)
  )) throw new Error("The publication recovery outcome attempt must be canonical.");
  return deepFreeze({
    receipt,
    receiptIdentity: publicIdentity(receiptPath, file),
    receiptPath
  });
}

function assertPublicationFoundation(input) {
  const sourceSnapshot = assertSourceSnapshot(input.sourceSnapshot);
  const targetSnapshot = assertTargetSnapshot(input.targetSnapshot);
  const publicationIntent = assertElectronProductionPublicationSnapshotBindings({
    receipt: input.publicationIntent,
    sourceSnapshot,
    targetSnapshot
  });
  assertEqual(publicationIntent.phase, "intent", "recovery publication receipt phase");
  assertEqual(publicationIntent.terminal, false,
    "recovery publication intent terminality");
  assertEqual(publicationIntent.publication.acknowledgement, null,
    "recovery publication intent acknowledgement");
  const heldLease = assertElectronProductionPublicLatestLease(input.heldLease);
  assertEqual(heldLease.status, "held", "recovery public-latest lease status");
  assertEqual(
    heldLease.purpose,
    "electron-v23-provisional-publication",
    "recovery public-latest lease purpose"
  );
  for (const [actual, expected, label] of [
    [heldLease.transactionId, publicationIntent.transactionId, "transaction ID"],
    [heldLease.leaseId, publicationIntent.lease.id, "lease ID"],
    [heldLease.generation, publicationIntent.lease.generation, "lease generation"],
    [heldLease.source.runtime, publicationIntent.baseline.runtime, "source runtime"],
    [heldLease.source.version, publicationIntent.baseline.version, "source version"],
    [heldLease.source.stateSha256, publicationIntent.baseline.stateSha256,
      "source state SHA-256"],
    [heldLease.target.runtime, publicationIntent.target.runtime, "target runtime"],
    [heldLease.target.version, publicationIntent.target.version, "target version"],
    [heldLease.target.stateSha256, publicationIntent.target.stateSha256,
      "target state SHA-256"]
  ]) assertEqual(actual, expected, `recovery foundation ${label}`);
  return {
    transactionId: heldLease.transactionId,
    lease: {
      leaseId: heldLease.leaseId,
      generation: heldLease.generation,
      eventSha256: electronProductionPublicLatestLeaseEventSha256(heldLease)
    },
    source: sourceState(publicationIntent, sourceSnapshot),
    target: targetState(publicationIntent, targetSnapshot),
    publicationIntentEventSha256:
      electronProductionPublicationEventSha256(publicationIntent),
    publisher: {
      repository: heldLease.holder.repository,
      workflow: heldLease.holder.workflow,
      runId: heldLease.holder.runId,
      runAttempt: heldLease.holder.runAttempt,
      controlSha: heldLease.holder.headSha
    }
  };
}

function assertRecoveryFoundation(input) {
  const storeSeal = assertElectronProductionPublicationRecoveryStoreSeal(
    input.storeSeal
  );
  const heldLease = assertElectronProductionPublicLatestLease(input.heldLease);
  assertEqual(heldLease.status, "held", "recovery public-latest lease status");
  assertEqual(heldLease.transactionId, storeSeal.transactionId,
    "recovery held-lease transaction ID");
  assertEqual(heldLease.leaseId, storeSeal.lease.leaseId,
    "recovery held-lease ID");
  assertEqual(heldLease.generation, storeSeal.lease.generation,
    "recovery held-lease generation");
  assertEqual(
    electronProductionPublicLatestLeaseEventSha256(heldLease),
    storeSeal.lease.eventSha256,
    "recovery held-lease event SHA-256"
  );
  const sourceSnapshot = assertSourceSnapshot(input.sourceSnapshot);
  const targetSnapshot = assertTargetSnapshot(input.targetSnapshot);
  assertDeepEqual(
    sourceStateFromSeal(storeSeal.source, sourceSnapshot),
    storeSeal.source,
    "recovery source snapshot binding"
  );
  assertDeepEqual(
    targetStateFromSeal(storeSeal.target, targetSnapshot),
    storeSeal.target,
    "recovery target snapshot binding"
  );
  return { heldLease, sourceSnapshot, storeSeal, targetSnapshot };
}

function sourceState(publication, snapshot) {
  return {
    runtime: "tauri-v22",
    version: publication.baseline.version,
    releaseId: snapshot.release.id,
    releaseTag: publication.baseline.releaseTag,
    sourceSha: publication.baseline.sourceSha,
    manifestSha256: publication.baseline.manifestSha256,
    stateSha256: publication.baseline.stateSha256,
    snapshotSha256: snapshot.snapshotSha256
  };
}

function targetState(publication, snapshot) {
  return {
    runtime: "electron-v23",
    version: publication.target.version,
    releaseId: snapshot.release.id,
    releaseTag: publication.target.releaseTag,
    sourceSha: publication.target.sourceSha,
    candidateReceiptSha256: publication.target.candidateReceiptSha256,
    manifestSha256: publication.target.manifestSha256,
    stateSha256: publication.target.stateSha256,
    snapshotSha256: snapshot.snapshotSha256
  };
}

function sourceStateFromSeal(sealed, snapshot) {
  return {
    ...sealed,
    version: snapshot.latestJson.version,
    releaseId: snapshot.release.id,
    releaseTag: snapshot.release.tag,
    manifestSha256: snapshot.latestJson.sha256,
    stateSha256: snapshot.stateSha256,
    snapshotSha256: snapshot.snapshotSha256
  };
}

function targetStateFromSeal(sealed, snapshot) {
  return {
    ...sealed,
    version: snapshot.latestJson.version,
    releaseId: snapshot.release.id,
    releaseTag: snapshot.release.tag,
    sourceSha: snapshot.candidateReceipt.sourceSha,
    candidateReceiptSha256: snapshot.candidateReceipt.sha256,
    manifestSha256: snapshot.latestJson.sha256,
    stateSha256: snapshot.stateSha256,
    snapshotSha256: snapshot.snapshotSha256
  };
}

function assertSourceState(value) {
  assertExactKeys(value, [
    "manifestSha256",
    "releaseId",
    "releaseTag",
    "runtime",
    "snapshotSha256",
    "sourceSha",
    "stateSha256",
    "version"
  ], "publication recovery source state");
  const version = requiredSemanticVersion(value.version, "recovery source version");
  assertEqual(value.runtime, "tauri-v22", "recovery source runtime");
  assertEqual(value.releaseTag, `v${version}`, "recovery source release tag");
  return {
    runtime: "tauri-v22",
    version,
    releaseId: requiredReleaseId(value.releaseId, "recovery source release ID"),
    releaseTag: value.releaseTag,
    sourceSha: requiredCommitSha(value.sourceSha, "recovery source SHA"),
    manifestSha256: requiredDigest(value.manifestSha256,
      "recovery source manifest SHA-256"),
    stateSha256: requiredDigest(value.stateSha256, "recovery source state SHA-256"),
    snapshotSha256: requiredDigest(value.snapshotSha256,
      "recovery source snapshot SHA-256")
  };
}

function assertTargetState(value, source) {
  assertExactKeys(value, [
    "candidateReceiptSha256",
    "manifestSha256",
    "releaseId",
    "releaseTag",
    "runtime",
    "snapshotSha256",
    "sourceSha",
    "stateSha256",
    "version"
  ], "publication recovery target state");
  const version = requiredSemanticVersion(value.version, "recovery target version");
  assertSemanticVersionIsNewer(version, source.version, "recovery target version");
  assertEqual(value.runtime, "electron-v23", "recovery target runtime");
  assertEqual(value.releaseTag, `v${version}`, "recovery target release tag");
  return {
    runtime: "electron-v23",
    version,
    releaseId: requiredReleaseId(value.releaseId, "recovery target release ID"),
    releaseTag: value.releaseTag,
    sourceSha: requiredCommitSha(value.sourceSha, "recovery target source SHA"),
    candidateReceiptSha256: requiredDigest(
      value.candidateReceiptSha256,
      "recovery target candidate receipt SHA-256"
    ),
    manifestSha256: requiredDigest(value.manifestSha256,
      "recovery target manifest SHA-256"),
    stateSha256: requiredDigest(value.stateSha256, "recovery target state SHA-256"),
    snapshotSha256: requiredDigest(value.snapshotSha256,
      "recovery target snapshot SHA-256")
  };
}

function assertDistinctState(source, target) {
  if (
    source.releaseId === target.releaseId ||
    source.stateSha256 === target.stateSha256 ||
    source.snapshotSha256 === target.snapshotSha256
  ) throw new Error("Recovery source and target identities must be distinct.");
}

function assertLeaseFence(value) {
  assertExactKeys(value, ["eventSha256", "generation", "leaseId"],
    "publication recovery lease fence");
  return {
    leaseId: requiredUuid(value.leaseId, "recovery lease ID"),
    generation: requiredPositiveInteger(value.generation, "recovery lease generation"),
    eventSha256: requiredDigest(value.eventSha256, "recovery lease event SHA-256")
  };
}

function assertDurableStore(value) {
  assertExactKeys(value, [
    "blobSha",
    "byteLength",
    "commitSha",
    "committedAt",
    "parentCommitSha",
    "path",
    "ref",
    "remoteReceiptSha256",
    "repository",
    "repositoryPolicy",
    "treeSha"
  ], "durable recovery store");
  const repository = requiredRepository(
    value.repository,
    "durable recovery store repository"
  );
  const ref = requiredBranch(value.ref, "durable recovery store ref");
  const repositoryPolicy = assertRepositoryPolicy(value.repositoryPolicy);
  assertEqual(ref, repositoryPolicy.defaultBranch,
    "durable recovery store default-branch ref");
  const storePath = requiredRepositoryPath(value.path);
  assertEqual(
    path.posix.basename(storePath),
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    "durable recovery store capsule filename"
  );
  const commitSha = requiredCommitSha(value.commitSha,
    "durable recovery store commit SHA");
  const parentCommitSha = requiredCommitSha(value.parentCommitSha,
    "durable recovery store parent SHA");
  const treeSha = requiredCommitSha(value.treeSha,
    "durable recovery store tree SHA");
  const blobSha = requiredCommitSha(value.blobSha,
    "durable recovery store blob SHA");
  if (new Set([commitSha, parentCommitSha, treeSha, blobSha]).size !== 4) {
    throw new Error("Durable recovery Git object identities must be distinct.");
  }
  const byteLength = requiredPositiveInteger(
    value.byteLength,
    "durable recovery store blob bytes"
  );
  if (byteLength > ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_MAX_BLOB_BYTES) {
    throw new Error("The durable recovery store blob exceeds its bounded transport.");
  }
  return {
    repository,
    ref,
    path: storePath,
    repositoryPolicy,
    byteLength,
    blobSha,
    treeSha,
    parentCommitSha,
    commitSha,
    remoteReceiptSha256: requiredDigest(
      value.remoteReceiptSha256,
      "durable recovery store remote receipt SHA-256"
    ),
    committedAt: requiredRfc3339(value.committedAt, "durable recovery store commit time")
  };
}

function assertOutcomeDurableStore(value) {
  assertExactKeys(value, [
    "blobSha",
    "byteLength",
    "commitSha",
    "committedAt",
    "parentCommitSha",
    "path",
    "ref",
    "remoteReceiptSha256",
    "repository",
    "repositoryPolicy",
    "sealSha256",
    "sealedAt",
    "treeSha"
  ], "recovery outcome durable store");
  const store = assertDurableStore({
    repository: value.repository,
    ref: value.ref,
    path: value.path,
    repositoryPolicy: value.repositoryPolicy,
    byteLength: value.byteLength,
    blobSha: value.blobSha,
    treeSha: value.treeSha,
    parentCommitSha: value.parentCommitSha,
    commitSha: value.commitSha,
    remoteReceiptSha256: value.remoteReceiptSha256,
    committedAt: value.committedAt
  });
  const sealedAt = requiredRfc3339(value.sealedAt, "recovery store-seal time");
  assertTimeOrder(
    store.committedAt,
    sealedAt,
    "The recovery store seal cannot precede its durable commit."
  );
  return {
    ...store,
    sealedAt,
    sealSha256: requiredDigest(value.sealSha256, "recovery store-seal SHA-256")
  };
}

function assertRunIdentity(value, label) {
  assertExactKeys(value, [
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], label);
  return {
    repository: requiredRepository(value.repository, `${label} repository`),
    workflow: requiredWorkflow(value.workflow, `${label} workflow`),
    runId: requiredRunId(value.runId, `${label} run ID`),
    runAttempt: requiredPositiveInteger(value.runAttempt, `${label} run attempt`),
    controlSha: requiredCommitSha(value.controlSha, `${label} control SHA`)
  };
}

function assertRecoveryRun(value) {
  assertExactKeys(value, [
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "startedAt",
    "workflow"
  ], "publication recovery run");
  return {
    ...assertRunIdentity({
      repository: value.repository,
      workflow: value.workflow,
      runId: value.runId,
      runAttempt: value.runAttempt,
      controlSha: value.controlSha
    }, "publication recovery run"),
    startedAt: requiredRfc3339(value.startedAt, "publication recovery run start time")
  };
}

function assertRecoveryOperation(value, mutationKind) {
  const markerOperation = value?.kind ===
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND;
  assertExactKeys(value, markerOperation
    ? ["authority", "kind", "mode", "operation", "sha256"]
    : ["kind", "sha256"], "publication recovery authoritative operation");
  if (markerOperation) {
    const operation = requiredEnum(
      value.operation,
      new Set(["release-held-lease", "rollback-public-latest"]),
      "publication recovery public-mutation operation"
    );
    const expectedOperation = mutationKind === "rollback"
      ? "rollback-public-latest"
      : "release-held-lease";
    assertEqual(operation, expectedOperation,
      "publication recovery public-mutation operation kind");
    return {
      kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND,
      operation,
      mode: requiredEnum(
        value.mode,
        new Set([
          "actual-transport",
          "marker-reconciliation",
          "precondition-rejected"
        ]),
        "publication recovery public-mutation operation mode"
      ),
      authority: assertMarkerAuthority(
        value.authority,
        "public-mutation operation"
      ),
      sha256: requiredDigest(
        value.sha256,
        "publication recovery public-mutation operation SHA-256"
      )
    };
  }
  const expectedKind = mutationKind === "rollback"
    ? ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND
    : ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND;
  assertEqual(value.kind, expectedKind,
    "publication recovery authoritative operation kind");
  return {
    kind: expectedKind,
    sha256: requiredDigest(
      value.sha256,
      "publication recovery authoritative operation SHA-256"
    )
  };
}

function assertRecoveryOperationAuthority(
  operation,
  mutation,
  leaseRelease,
  beforeMutation
) {
  const markerOperation = operation.kind ===
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND;
  const possiblyRecorded = mutation.submitted === "possibly" ||
    leaseRelease.attempted === "possibly" ||
    (mutation.kind === "rollback" && mutation.submitted === false) ||
    (leaseRelease.attempted === false &&
      leaseRelease.acknowledgement === "rejected");
  if (!markerOperation) {
    if (possiblyRecorded) {
      throw new Error(
        "A possibly-submitted public mutation requires marker authority."
      );
    }
    return;
  }
  if (operation.operation === "rollback-public-latest") {
    if (mutation.kind !== "rollback" || leaseRelease.attempted !== false) {
      throw new Error(
        "A rollback marker operation cannot also record a lease release."
      );
    }
    const expectedMode = mutation.submitted === "possibly"
      ? "marker-reconciliation"
      : mutation.submitted === false
        ? "precondition-rejected"
        : "actual-transport";
    assertEqual(operation.mode, expectedMode,
      "publication recovery rollback marker operation mode");
    if (mutation.submitted !== true) {
      assertDeepEqual(mutation.reservation, operation.authority,
        "publication recovery rollback marker authority");
    }
    return;
  }
  if (mutation.kind !== "none" || (
    leaseRelease.attempted === false &&
    leaseRelease.acknowledgement !== "rejected"
  )) {
    throw new Error(
      "A lease-release marker operation requires a no-op public-latest mutation."
    );
  }
  assertEqual(beforeMutation.classification, "source",
    "publication recovery marker lease-release source observation");
  const expectedMode = leaseRelease.attempted === "possibly"
    ? "marker-reconciliation"
    : leaseRelease.attempted === false
      ? "precondition-rejected"
      : "actual-transport";
  assertEqual(operation.mode, expectedMode,
    "publication recovery lease-release marker operation mode");
  if (leaseRelease.attempted !== true) {
    assertDeepEqual(leaseRelease.reservation, operation.authority,
      "publication recovery lease-release marker authority");
  }
}

function allowsMarkerReleaseDrift(operation) {
  return operation.kind ===
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND &&
    operation.operation === "release-held-lease" &&
    operation.mode !== "actual-transport";
}

function assertRecoveryObservationRunOrder(
  recoveryRun,
  beforeMutation,
  finalObservation,
  mutation,
  leaseRelease
) {
  if (mutation.submitted === "possibly") {
    assertTimeOrder(
      recoveryRun.startedAt,
      mutation.resultRecordedAt,
      "A marker reconciliation result cannot precede its recovery run."
    );
    return;
  }
  if (leaseRelease.attempted === "possibly") {
    assertTimeOrder(
      recoveryRun.startedAt,
      finalObservation.observedAt,
      "A marker lease reconciliation observation cannot precede its recovery run."
    );
    assertTimeOrder(
      recoveryRun.startedAt,
      leaseRelease.resolvedAt,
      "A marker lease reconciliation result cannot precede its recovery run."
    );
    return;
  }
  if (mutation.submitted !== "possibly") {
    assertTimeOrder(
      recoveryRun.startedAt,
      beforeMutation.observedAt,
      "A recovery observation cannot precede its recovery run."
    );
  }
}

function createObservation(input, sourceSnapshot, targetSnapshot, label) {
  if (Object.hasOwn(input ?? {}, "classification")) {
    assertExactKeys(input, ["classification", "observedAt", "stateSha256"],
      `${label} authoritative input`);
    return assertObservation(
      input,
      { stateSha256: sourceSnapshot.stateSha256 },
      { stateSha256: targetSnapshot.stateSha256 },
      label
    );
  }
  assertExactKeys(input, ["observedAt", "snapshot"], `${label} input`);
  const observedAt = requiredRfc3339(input.observedAt, `${label} time`);
  if (input.snapshot === null) {
    return { classification: "unknown", stateSha256: null, observedAt };
  }
  const snapshot = assertElectronProductionPublicLatestSnapshot(input.snapshot);
  assertEqual(snapshot.observationKind, "observed-release", `${label} kind`);
  const classification = classifyElectronProductionPublicLatestSnapshot({
    observed: snapshot,
    source: sourceSnapshot,
    target: targetSnapshot
  });
  return {
    classification,
    stateSha256: snapshot.stateSha256,
    observedAt
  };
}

function assertObservation(value, source, target, label) {
  assertExactKeys(value, ["classification", "observedAt", "stateSha256"], label);
  const classification = requiredEnum(
    value.classification,
    OBSERVATION_CLASSIFICATIONS,
    `${label} classification`
  );
  const observedAt = requiredRfc3339(value.observedAt, `${label} time`);
  if (classification === "unknown") {
    assertEqual(value.stateSha256, null, `${label} unknown-state SHA-256`);
    return { classification, stateSha256: null, observedAt };
  }
  const stateSha256 = requiredDigest(value.stateSha256, `${label} state SHA-256`);
  if (classification === "source") {
    assertEqual(stateSha256, source.stateSha256, `${label} source state SHA-256`);
  } else if (classification === "target") {
    assertEqual(stateSha256, target.stateSha256, `${label} target state SHA-256`);
  } else if (
    stateSha256 === source.stateSha256 || stateSha256 === target.stateSha256
  ) {
    throw new Error(`The ${label} foreign state must differ from known states.`);
  }
  return { classification, stateSha256, observedAt };
}

function assertMutation(value, previousAt) {
  const possiblySubmitted = value?.submitted === "possibly";
  const markerRejected = value?.kind === "rollback" &&
    value?.submitted === false;
  assertExactKeys(value, [
    "acknowledgement",
    "kind",
    ...(possiblySubmitted || markerRejected ? ["reservation"] : []),
    "resultRecordedAt",
    "submitted",
    "submittedAt",
    ...(possiblySubmitted || markerRejected ? ["reservedAt"] : [])
  ], "publication recovery mutation");
  if (value.kind === "none") {
    if (
      value.submitted !== false || value.acknowledgement !== null ||
      value.submittedAt !== null || value.resultRecordedAt !== null
    ) throw new Error("A no-op recovery mutation must contain explicit null evidence.");
    return {
      kind: "none",
      submitted: false,
      acknowledgement: null,
      submittedAt: null,
      resultRecordedAt: null
    };
  }
  assertEqual(value.kind, "rollback", "publication recovery mutation kind");
  if (markerRejected) {
    assertEqual(value.acknowledgement, "rejected",
      "unsubmitted rollback acknowledgement");
    assertEqual(value.submittedAt, null,
      "unsubmitted rollback submission time");
    const reservedAt = requiredRfc3339(
      value.reservedAt,
      "rollback reservation time"
    );
    const resultRecordedAt = requiredRfc3339(
      value.resultRecordedAt,
      "rollback precondition result time"
    );
    assertTimeOrder(previousAt, reservedAt,
      "Rollback reservation cannot precede the target observation.");
    assertTimeOrder(reservedAt, resultRecordedAt,
      "Rollback precondition result cannot precede reservation.");
    return {
      kind: "rollback",
      submitted: false,
      acknowledgement: "rejected",
      reservedAt,
      submittedAt: null,
      resultRecordedAt,
      reservation: assertMarkerAuthority(value.reservation, "rollback")
    };
  }
  if (possiblySubmitted) {
    assertEqual(value.acknowledgement, "unknown",
      "possibly-submitted rollback acknowledgement");
    assertEqual(value.submittedAt, null,
      "possibly-submitted rollback submission time");
    const reservedAt = requiredRfc3339(
      value.reservedAt,
      "rollback reservation time"
    );
    const resultRecordedAt = requiredRfc3339(
      value.resultRecordedAt,
      "rollback reservation resolution time"
    );
    assertTimeOrder(previousAt, reservedAt,
      "Rollback reservation cannot precede the target observation.");
    assertTimeOrder(reservedAt, resultRecordedAt,
      "Rollback reservation resolution cannot precede reservation.");
    return {
      kind: "rollback",
      submitted: "possibly",
      acknowledgement: "unknown",
      reservedAt,
      submittedAt: null,
      resultRecordedAt,
      reservation: assertMarkerAuthority(value.reservation, "rollback")
    };
  }
  assertEqual(value.submitted, true, "rollback mutation submission");
  const submittedAt = requiredRfc3339(value.submittedAt, "rollback submission time");
  const resultRecordedAt = requiredRfc3339(
    value.resultRecordedAt,
    "rollback acknowledgement result time"
  );
  assertTimeOrder(previousAt, submittedAt,
    "Rollback submission cannot precede the target observation.");
  assertTimeOrder(submittedAt, resultRecordedAt,
    "Rollback acknowledgement cannot precede submission.");
  return {
    kind: "rollback",
    submitted: true,
    acknowledgement: requiredEnum(
      value.acknowledgement,
      MUTATION_ACKNOWLEDGEMENTS,
      "rollback acknowledgement"
    ),
    submittedAt,
    resultRecordedAt
  };
}

function assertLeaseRelease(value, previousAt, beforeAt) {
  const markerReconciliation = value?.attempted === "possibly";
  const markerRejected = value?.attempted === false &&
    value?.acknowledgement === "rejected";
  assertExactKeys(value, [
    "acknowledgement",
    "attempted",
    "attemptedAt",
    "operationSha256",
    ...(markerReconciliation
      ? ["reservation"]
      : markerRejected ? ["reservation", "reservedAt"] : []),
    "resolvedAt",
    "successorEventSha256"
  ],
    "publication recovery lease release");
  if (markerRejected) {
    assertEqual(value.attemptedAt, null,
      "unattempted marker lease-release attempt time");
    assertEqual(value.operationSha256, null,
      "unattempted marker lease-release operation SHA-256");
    assertEqual(value.successorEventSha256, null,
      "unattempted marker lease-release successor event");
    const reservedAt = requiredRfc3339(
      value.reservedAt,
      "lease-release reservation time"
    );
    const resolvedAt = requiredRfc3339(
      value.resolvedAt,
      "lease-release precondition result time"
    );
    assertTimeOrder(beforeAt, reservedAt,
      "Lease-release reservation cannot precede its source observation.");
    assertTimeOrder(reservedAt, previousAt,
      "Lease-release final observation cannot precede reservation.");
    assertTimeOrder(previousAt, resolvedAt,
      "Lease-release precondition result cannot precede final observation.");
    return {
      attempted: false,
      acknowledgement: "rejected",
      attemptedAt: null,
      operationSha256: null,
      reservation: assertMarkerAuthority(value.reservation, "lease release"),
      reservedAt,
      resolvedAt,
      successorEventSha256: null
    };
  }
  if (value.attempted === false) {
    if (
      value.acknowledgement !== null || value.attemptedAt !== null ||
      value.operationSha256 !== null || value.resolvedAt !== null ||
      value.successorEventSha256 !== null
    ) {
      throw new Error("An unattempted lease release must contain explicit null evidence.");
    }
    return {
      attempted: false,
      acknowledgement: null,
      attemptedAt: null,
      operationSha256: null,
      resolvedAt: null,
      successorEventSha256: null
    };
  }
  if (markerReconciliation) {
    const acknowledgement = requiredEnum(
      value.acknowledgement,
      new Set(["confirmed", "unknown"]),
      "marker lease-release acknowledgement"
    );
    assertEqual(value.operationSha256, null,
      "marker lease-release transport operation SHA-256");
    const resolvedAt = requiredRfc3339(
      value.resolvedAt,
      "marker lease-release resolution time"
    );
    assertTimeOrder(previousAt, resolvedAt,
      "Marker lease-release resolution cannot precede final observation.");
    const attemptedAt = acknowledgement === "confirmed"
      ? requiredRfc3339(
          value.attemptedAt,
          "reconciled released successor time"
        )
      : value.attemptedAt;
    if (acknowledgement === "unknown" && attemptedAt !== null) {
      throw new Error(
        "An unresolved marker lease release cannot claim an attempt time."
      );
    }
    if (acknowledgement === "confirmed") {
      assertTimeOrder(attemptedAt, resolvedAt,
        "Released successor observation cannot precede its recorded time.");
    }
    const successorEventSha256 = acknowledgement === "confirmed"
      ? requiredDigest(
          value.successorEventSha256,
          "reconciled released successor event SHA-256"
        )
      : value.successorEventSha256;
    if (acknowledgement === "unknown" && successorEventSha256 !== null) {
      throw new Error(
        "An unresolved marker lease release cannot claim a successor event."
      );
    }
    return {
      attempted: "possibly",
      acknowledgement,
      attemptedAt,
      operationSha256: null,
      reservation: assertMarkerAuthority(value.reservation, "lease release"),
      resolvedAt,
      successorEventSha256
    };
  }
  assertEqual(value.attempted, true, "lease-release attempt");
  const acknowledgement = requiredEnum(
    value.acknowledgement,
    MUTATION_ACKNOWLEDGEMENTS,
    "lease-release acknowledgement"
  );
  const attemptedAt = requiredRfc3339(value.attemptedAt, "lease-release attempt time");
  const resolvedAt = requiredRfc3339(
    value.resolvedAt,
    "lease-release resolution time"
  );
  assertTimeOrder(attemptedAt, resolvedAt,
    "Lease-release resolution cannot precede its attempt.");
  assertTimeOrder(previousAt, resolvedAt,
    "Lease-release resolution cannot precede the final recovery observation.");
  const successorEventSha256 = acknowledgement === "confirmed"
    ? requiredDigest(value.successorEventSha256,
      "released lease successor event SHA-256")
    : value.successorEventSha256;
  if (acknowledgement !== "confirmed" && successorEventSha256 !== null) {
    throw new Error("An unconfirmed lease release cannot claim a successor event.");
  }
  return {
    attempted: true,
    acknowledgement,
    attemptedAt,
    resolvedAt,
    operationSha256: requiredDigest(
      value.operationSha256,
      "lease-release operation SHA-256"
    ),
    successorEventSha256
  };
}
