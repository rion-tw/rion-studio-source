import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256
} from "./electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
  assertElectronProductionPublicLatestSnapshot,
  classifyElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND =
  "rion-electron-production-public-latest-recovery-observation";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND =
  "rion-electron-production-public-latest-recovery-rollback-operation";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE =
  "electron-production-public-latest-recovery-observation.json";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE =
  "electron-production-public-latest-recovery-rollback-operation.json";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const OBSERVE_REJECTED_REASONS = new Set([
  "github-rejected",
  "malformed-record",
  "repository-policy-mismatch",
  "snapshot-mismatch"
]);
const OBSERVE_INDETERMINATE_REASONS = new Set([
  "server-error",
  "transport",
  "unexpected-response"
]);
const MUTATION_ACKNOWLEDGEMENTS = new Set([
  "confirmed",
  "rejected",
  "unknown"
]);
const MUTATION_REASONS = new Set([
  "applied-response",
  "github-rejected",
  "server-error",
  "transport",
  "unexpected-response"
]);

export function createElectronProductionPublicLatestRecoveryObservation(input) {
  assertExactKeys(input, [
    "observedAt",
    "result",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "public-latest recovery observation input");
  const basis = basisFromSnapshots(input);
  const observedAt = requiredRfc3339(
    input.observedAt,
    "public-latest recovery observation time"
  );
  const result = normalizeObservationResult(input.result, basis);
  return assertElectronProductionPublicLatestRecoveryObservation({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    operation: "observe-latest",
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    basis: basis.identity,
    observedAt,
    latest: result.latest,
    observation: result.observation,
    transport: result.transport
  });
}

export function assertElectronProductionPublicLatestRecoveryObservation(value) {
  assertExactKeys(value, [
    "basis",
    "kind",
    "latest",
    "observation",
    "observedAt",
    "operation",
    "repository",
    "schemaVersion",
    "transport"
  ], "public-latest recovery observation");
  assertEqual(value.schemaVersion, 1,
    "public-latest recovery observation schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    "public-latest recovery observation kind"
  );
  assertEqual(value.operation, "observe-latest",
    "public-latest recovery observation operation");
  assertEqual(value.repository, ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    "public-latest recovery observation repository");
  const basis = assertBasis(value.basis);
  const observedAt = requiredRfc3339(
    value.observedAt,
    "public-latest recovery observation time"
  );
  const latest = value.latest === null ? null : assertLatest(value.latest);
  const transport = assertObservationTransport(value.transport);
  const observation = assertObservationEvidence(
    value.observation,
    basis,
    latest,
    transport
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    operation: "observe-latest",
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    basis,
    observedAt,
    latest,
    observation,
    transport
  });
}

export function assertElectronProductionPublicLatestRecoveryObservationBindings(input) {
  assertExactKeys(input, [
    "observation",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "public-latest recovery observation bindings");
  const observation = assertElectronProductionPublicLatestRecoveryObservation(
    input.observation
  );
  const expected = basisFromSnapshots(input).identity;
  assertDeepEqual(
    observation.basis,
    expected,
    "public-latest recovery observation basis binding"
  );
  return observation;
}

export function createElectronProductionPublicLatestRecoveryRollback(input) {
  assertExactKeys(input, [
    "finalObservation",
    "finalObservationSha256",
    "heldLease",
    "mutation",
    "preObservation",
    "preObservationSha256",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "public-latest recovery rollback input");
  const basis = basisFromSnapshots(input);
  const heldLease = assertHeldLease(input.heldLease, basis);
  const before = assertElectronProductionPublicLatestRecoveryObservationBindings({
    observation: input.preObservation,
    sourceSnapshot: basis.sourceSnapshot,
    sourceSnapshotFileSha256: basis.identity.source.fileSha256,
    targetSnapshot: basis.targetSnapshot,
    targetSnapshotFileSha256: basis.identity.target.fileSha256
  });
  if (
    before.transport.outcome !== "observed" ||
    before.observation.classification !== "target"
  ) {
    throw new Error(
      "Rollback requires a fresh exact target observation under the held lease."
    );
  }
  const final = assertElectronProductionPublicLatestRecoveryObservationBindings({
    observation: input.finalObservation,
    sourceSnapshot: basis.sourceSnapshot,
    sourceSnapshotFileSha256: basis.identity.source.fileSha256,
    targetSnapshot: basis.targetSnapshot,
    targetSnapshotFileSha256: basis.identity.target.fileSha256
  });
  const mutation = assertRollbackMutation(
    input.mutation,
    before.observedAt,
    basis.identity.source.releaseId
  );
  assertTimeOrder(
    mutation.resultRecordedAt,
    final.observedAt,
    "The final public-latest observation cannot precede the rollback result."
  );
  return assertElectronProductionPublicLatestRecoveryRollback({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
    status: "rollback-attempt-recorded",
    operation: "rollback-public-latest",
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    transactionId: heldLease.transactionId,
    lease: {
      id: heldLease.leaseId,
      generation: heldLease.generation,
      eventSha256: electronProductionPublicLatestLeaseEventSha256(heldLease)
    },
    basis: basis.identity,
    before: observationReference(
      before,
      requiredDigest(input.preObservationSha256,
        "pre-rollback observation SHA-256")
    ),
    mutation,
    final: observationReference(
      final,
      requiredDigest(input.finalObservationSha256,
        "final rollback observation SHA-256")
    )
  });
}

export function assertElectronProductionPublicLatestRecoveryRollback(value) {
  assertExactKeys(value, [
    "basis",
    "before",
    "final",
    "kind",
    "lease",
    "mutation",
    "operation",
    "repository",
    "schemaVersion",
    "status",
    "transactionId"
  ], "public-latest recovery rollback operation");
  assertEqual(value.schemaVersion, 1,
    "public-latest recovery rollback schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
    "public-latest recovery rollback kind");
  assertEqual(value.status, "rollback-attempt-recorded",
    "public-latest recovery rollback status");
  assertEqual(value.operation, "rollback-public-latest",
    "public-latest recovery rollback operation");
  assertEqual(value.repository, ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    "public-latest recovery rollback repository");
  const basis = assertBasis(value.basis);
  const transactionId = requiredUuid(
    value.transactionId,
    "public-latest recovery transaction ID"
  );
  const lease = assertLeaseFence(value.lease);
  const before = assertObservationReference(value.before, basis,
    "pre-rollback observation reference");
  if (
    before.transport.outcome !== "observed" ||
    before.classification !== "target"
  ) {
    throw new Error("A rollback operation must begin from an exact target observation.");
  }
  const mutation = assertRollbackMutation(
    value.mutation,
    before.observedAt,
    basis.source.releaseId
  );
  const final = assertObservationReference(value.final, basis,
    "final rollback observation reference");
  assertTimeOrder(
    mutation.resultRecordedAt,
    final.observedAt,
    "The final public-latest observation cannot precede the rollback result."
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
    status: "rollback-attempt-recorded",
    operation: "rollback-public-latest",
    repository: ELECTRON_PRODUCTION_PUBLIC_RELEASE_REPOSITORY,
    transactionId,
    lease,
    basis,
    before,
    mutation,
    final
  });
}

export function assertElectronProductionPublicLatestRecoveryRollbackBindings(input) {
  assertExactKeys(input, [
    "finalObservation",
    "finalObservationSha256",
    "heldLease",
    "preObservation",
    "preObservationSha256",
    "rollback",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "public-latest recovery rollback bindings");
  const rollback = assertElectronProductionPublicLatestRecoveryRollbackFoundationBindings({
    heldLease: input.heldLease,
    rollback: input.rollback,
    sourceSnapshot: input.sourceSnapshot,
    sourceSnapshotFileSha256: input.sourceSnapshotFileSha256,
    targetSnapshot: input.targetSnapshot,
    targetSnapshotFileSha256: input.targetSnapshotFileSha256
  });
  const basis = basisFromSnapshots(input);
  for (const [actual, receipt, digestValue, label] of [
    [rollback.before, input.preObservation, input.preObservationSha256, "before"],
    [rollback.final, input.finalObservation, input.finalObservationSha256, "final"]
  ]) {
    const observation = assertElectronProductionPublicLatestRecoveryObservationBindings({
      observation: receipt,
      sourceSnapshot: basis.sourceSnapshot,
      sourceSnapshotFileSha256: basis.identity.source.fileSha256,
      targetSnapshot: basis.targetSnapshot,
      targetSnapshotFileSha256: basis.identity.target.fileSha256
    });
    assertDeepEqual(
      actual,
      observationReference(
        observation,
        requiredDigest(digestValue, `${label} observation SHA-256`)
      ),
      `public-latest recovery rollback ${label} observation binding`
    );
  }
  return rollback;
}

export function assertElectronProductionPublicLatestRecoveryRollbackFoundationBindings(
  input
) {
  assertExactKeys(input, [
    "heldLease",
    "rollback",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "public-latest recovery rollback foundation bindings");
  const rollback = assertElectronProductionPublicLatestRecoveryRollback(
    input.rollback
  );
  const basis = basisFromSnapshots(input);
  const heldLease = assertHeldLease(input.heldLease, basis);
  assertDeepEqual(rollback.basis, basis.identity,
    "public-latest recovery rollback basis binding");
  assertEqual(rollback.transactionId, heldLease.transactionId,
    "public-latest recovery rollback transaction binding");
  assertDeepEqual(rollback.lease, {
    id: heldLease.leaseId,
    generation: heldLease.generation,
    eventSha256: electronProductionPublicLatestLeaseEventSha256(heldLease)
  }, "public-latest recovery rollback lease binding");
  return rollback;
}

export function electronProductionPublicLatestRecoveryObservationSha256(value) {
  return sha256(serializeElectronProductionPublicLatestRecoveryObservation(value));
}

export function electronProductionPublicLatestRecoveryRollbackSha256(value) {
  return sha256(serializeElectronProductionPublicLatestRecoveryRollback(value));
}

export function serializeElectronProductionPublicLatestRecoveryObservation(value) {
  return serializeCanonicalJson(
    assertElectronProductionPublicLatestRecoveryObservation(value)
  );
}

export function serializeElectronProductionPublicLatestRecoveryRollback(value) {
  return serializeCanonicalJson(
    assertElectronProductionPublicLatestRecoveryRollback(value)
  );
}

export async function writeElectronProductionPublicLatestRecoveryObservation(input) {
  return writeReceipt(
    input,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
    "public-latest recovery observation",
    assertElectronProductionPublicLatestRecoveryObservation
  );
}

export async function readElectronProductionPublicLatestRecoveryObservation(input) {
  return readReceipt(
    input,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
    "public-latest recovery observation",
    assertElectronProductionPublicLatestRecoveryObservation
  );
}

export async function writeElectronProductionPublicLatestRecoveryRollback(input) {
  return writeReceipt(
    input,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE,
    "public-latest recovery rollback operation",
    assertElectronProductionPublicLatestRecoveryRollback
  );
}

export async function readElectronProductionPublicLatestRecoveryRollback(input) {
  return readReceipt(
    input,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE,
    "public-latest recovery rollback operation",
    assertElectronProductionPublicLatestRecoveryRollback
  );
}

function normalizeObservationResult(value, basis) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The public-latest recovery observation result is invalid.");
  }
  if (value.outcome === "observed") {
    assertExactKeys(value, ["latest", "outcome", "snapshot"],
      "observed public-latest recovery result");
    const latest = assertLatest(value.latest);
    if (value.snapshot === null) {
      if (
        latest.releaseId === basis.identity.source.releaseId ||
        latest.releaseId === basis.identity.target.releaseId
      ) {
        throw new Error("A known latest release requires its exact rebuilt snapshot.");
      }
      return {
        latest,
        observation: { classification: "foreign", snapshot: null },
        transport: { outcome: "observed", reason: null, httpStatus: 200 }
      };
    }
    const snapshot = assertElectronProductionPublicLatestSnapshot(value.snapshot);
    const classification = classifyElectronProductionPublicLatestSnapshot({
      observed: snapshot,
      source: basis.sourceSnapshot,
      target: basis.targetSnapshot
    });
    if (classification === "foreign") {
      throw new Error("A rebuilt known-release snapshot must match source or target.");
    }
    const identity = classification === "source"
      ? basis.identity.source
      : basis.identity.target;
    assertEqual(latest.releaseId, identity.releaseId,
      "observed public-latest recovery release ID");
    return {
      latest,
      observation: { classification, snapshot: identity },
      transport: { outcome: "observed", reason: null, httpStatus: 200 }
    };
  }
  assertExactKeys(value, ["latest", "outcome", "reason", "status"],
    "failed public-latest recovery result");
  if (value.outcome !== "rejected" && value.outcome !== "indeterminate") {
    throw new Error("The public-latest recovery observation outcome is invalid.");
  }
  const reasons = value.outcome === "rejected"
    ? OBSERVE_REJECTED_REASONS
    : OBSERVE_INDETERMINATE_REASONS;
  return {
    latest: value.latest === null ? null : assertLatest(value.latest),
    observation: { classification: "unknown", snapshot: null },
    transport: {
      outcome: value.outcome,
      reason: requiredEnum(value.reason, reasons,
        "public-latest recovery observation reason"),
      httpStatus: optionalHttpStatus(value.status)
    }
  };
}

function assertObservationTransport(value) {
  assertExactKeys(value, ["httpStatus", "outcome", "reason"],
    "public-latest recovery observation transport");
  if (value.outcome === "observed") {
    assertEqual(value.reason, null,
      "observed public-latest recovery transport reason");
    assertEqual(value.httpStatus, 200,
      "observed public-latest recovery HTTP status");
    return { outcome: "observed", reason: null, httpStatus: 200 };
  }
  if (value.outcome !== "rejected" && value.outcome !== "indeterminate") {
    throw new Error("The public-latest recovery transport outcome is invalid.");
  }
  return {
    outcome: value.outcome,
    reason: requiredEnum(
      value.reason,
      value.outcome === "rejected"
        ? OBSERVE_REJECTED_REASONS
        : OBSERVE_INDETERMINATE_REASONS,
      "public-latest recovery transport reason"
    ),
    httpStatus: optionalHttpStatus(value.httpStatus)
  };
}

function assertObservationEvidence(value, basis, latest, transport) {
  assertExactKeys(value, ["classification", "snapshot"],
    "public-latest recovery observation evidence");
  if (transport.outcome !== "observed") {
    assertEqual(value.classification, "unknown",
      "failed public-latest recovery observation classification");
    assertEqual(value.snapshot, null,
      "failed public-latest recovery snapshot identity");
    return { classification: "unknown", snapshot: null };
  }
  if (latest === null) {
    throw new Error("An observed public-latest release requires latest identity.");
  }
  if (value.classification === "foreign") {
    assertEqual(value.snapshot, null,
      "foreign public-latest recovery snapshot identity");
    if (
      latest.releaseId === basis.source.releaseId ||
      latest.releaseId === basis.target.releaseId
    ) throw new Error("A foreign observation must identify a different release.");
    return { classification: "foreign", snapshot: null };
  }
  if (value.classification !== "source" && value.classification !== "target") {
    throw new Error("The observed public-latest recovery classification is invalid.");
  }
  const identity = basis[value.classification];
  assertDeepEqual(value.snapshot, identity,
    `public-latest recovery ${value.classification} snapshot identity`);
  assertEqual(latest.releaseId, identity.releaseId,
    `public-latest recovery ${value.classification} latest release ID`);
  return { classification: value.classification, snapshot: identity };
}

function observationReference(observationValue, receiptSha256) {
  const observation = assertElectronProductionPublicLatestRecoveryObservation(
    observationValue
  );
  const digest = requiredDigest(
    receiptSha256,
    "public-latest recovery observation SHA-256"
  );
  assertEqual(
    digest,
    electronProductionPublicLatestRecoveryObservationSha256(observation),
    "public-latest recovery observation receipt SHA-256"
  );
  return deepFreeze({
    observationSha256: digest,
    observedAt: observation.observedAt,
    latest: observation.latest,
    classification: observation.observation.classification,
    snapshot: observation.observation.snapshot,
    transport: observation.transport
  });
}

function assertObservationReference(value, basis, label) {
  assertExactKeys(value, [
    "classification",
    "latest",
    "observationSha256",
    "observedAt",
    "snapshot",
    "transport"
  ], label);
  const latest = value.latest === null ? null : assertLatest(value.latest);
  const transport = assertObservationTransport(value.transport);
  const evidence = assertObservationEvidence({
    classification: value.classification,
    snapshot: value.snapshot
  }, basis, latest, transport);
  return {
    observationSha256: requiredDigest(value.observationSha256,
      `${label} SHA-256`),
    observedAt: requiredRfc3339(value.observedAt, `${label} time`),
    latest,
    classification: evidence.classification,
    snapshot: evidence.snapshot,
    transport
  };
}

function basisFromSnapshots(input) {
  const sourceSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.sourceSnapshot
  );
  const targetSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.targetSnapshot
  );
  if (
    sourceSnapshot.observationKind !== "observed-release" ||
    sourceSnapshot.release.isLatest !== true
  ) throw new Error("The recovery source must be an observed latest snapshot.");
  if (
    targetSnapshot.observationKind !== "expected-latest-projection" ||
    targetSnapshot.release.isLatest !== true
  ) throw new Error("The recovery target must be an expected latest projection.");
  if (
    sourceSnapshot.release.id === targetSnapshot.release.id ||
    sourceSnapshot.stateSha256 === targetSnapshot.stateSha256
  ) throw new Error("The recovery source and target snapshots must be distinct.");
  return {
    sourceSnapshot,
    targetSnapshot,
    identity: {
      source: snapshotIdentity(
        sourceSnapshot,
        input.sourceSnapshotFileSha256,
        "source"
      ),
      target: snapshotIdentity(
        targetSnapshot,
        input.targetSnapshotFileSha256,
        "target"
      )
    }
  };
}

function snapshotIdentity(snapshot, fileSha256, label) {
  return {
    releaseId: snapshot.release.id,
    stateSha256: snapshot.stateSha256,
    snapshotSha256: snapshot.snapshotSha256,
    fileSha256: requiredDigest(fileSha256,
      `public-latest recovery ${label} snapshot file SHA-256`)
  };
}

function assertBasis(value) {
  assertExactKeys(value, ["source", "target"],
    "public-latest recovery snapshot basis");
  const source = assertSnapshotIdentity(value.source, "source");
  const target = assertSnapshotIdentity(value.target, "target");
  if (
    source.releaseId === target.releaseId ||
    source.stateSha256 === target.stateSha256 ||
    source.snapshotSha256 === target.snapshotSha256 ||
    source.fileSha256 === target.fileSha256
  ) throw new Error("The public-latest recovery basis identities must be distinct.");
  return { source, target };
}

function assertSnapshotIdentity(value, label) {
  assertExactKeys(value, [
    "fileSha256",
    "releaseId",
    "snapshotSha256",
    "stateSha256"
  ], `public-latest recovery ${label} snapshot identity`);
  return {
    releaseId: requiredDecimalId(value.releaseId,
      `public-latest recovery ${label} release ID`),
    stateSha256: requiredDigest(value.stateSha256,
      `public-latest recovery ${label} state SHA-256`),
    snapshotSha256: requiredDigest(value.snapshotSha256,
      `public-latest recovery ${label} snapshot SHA-256`),
    fileSha256: requiredDigest(value.fileSha256,
      `public-latest recovery ${label} snapshot file SHA-256`)
  };
}

function assertHeldLease(value, basis) {
  const lease = assertElectronProductionPublicLatestLease(value);
  assertEqual(lease.status, "held", "public-latest recovery held lease status");
  assertEqual(lease.purpose, "electron-v23-provisional-publication",
    "public-latest recovery held lease purpose");
  for (const [actual, expected, label] of [
    [lease.source.stateSha256, basis.identity.source.stateSha256, "source state"],
    [lease.target.stateSha256, basis.identity.target.stateSha256, "target state"]
  ]) assertEqual(actual, expected, `public-latest recovery lease ${label} binding`);
  return lease;
}

function assertLeaseFence(value) {
  assertExactKeys(value, ["eventSha256", "generation", "id"],
    "public-latest recovery lease fence");
  return {
    id: requiredUuid(value.id, "public-latest recovery lease ID"),
    generation: requiredPositiveInteger(value.generation,
      "public-latest recovery lease generation"),
    eventSha256: requiredDigest(value.eventSha256,
      "public-latest recovery lease event SHA-256")
  };
}

function assertRollbackMutation(value, previousAt, sourceReleaseId) {
  assertExactKeys(value, [
    "acknowledgement",
    "httpStatus",
    "makeLatest",
    "reason",
    "releaseId",
    "resultRecordedAt",
    "submitted",
    "submittedAt"
  ], "public-latest rollback mutation");
  assertEqual(value.submitted, true, "public-latest rollback submission");
  assertEqual(value.makeLatest, true, "public-latest rollback make-latest operation");
  assertEqual(
    requiredDecimalId(value.releaseId, "public-latest rollback release ID"),
    sourceReleaseId,
    "public-latest rollback source release ID"
  );
  const submittedAt = requiredRfc3339(value.submittedAt,
    "public-latest rollback submission time");
  const resultRecordedAt = requiredRfc3339(value.resultRecordedAt,
    "public-latest rollback result time");
  assertTimeOrder(previousAt, submittedAt,
    "Rollback submission cannot precede its target observation.");
  assertTimeOrder(submittedAt, resultRecordedAt,
    "Rollback result cannot precede submission.");
  const acknowledgement = requiredEnum(
    value.acknowledgement,
    MUTATION_ACKNOWLEDGEMENTS,
    "public-latest rollback acknowledgement"
  );
  const reason = requiredEnum(
    value.reason,
    MUTATION_REASONS,
    "public-latest rollback result reason"
  );
  if (acknowledgement === "confirmed") {
    assertEqual(reason, "applied-response",
      "confirmed public-latest rollback reason");
    assertEqual(value.httpStatus, 200,
      "confirmed public-latest rollback HTTP status");
  } else if (acknowledgement === "rejected") {
    assertEqual(reason, "github-rejected",
      "rejected public-latest rollback reason");
    const status = optionalHttpStatus(value.httpStatus);
    if (status === null || status < 400 || status >= 500) {
      throw new Error("A rejected rollback requires a 4xx HTTP status.");
    }
  } else if (reason === "github-rejected" || reason === "applied-response") {
    throw new Error("An unknown rollback acknowledgement has an invalid reason.");
  }
  return {
    submitted: true,
    releaseId: sourceReleaseId,
    makeLatest: true,
    acknowledgement,
    submittedAt,
    resultRecordedAt,
    reason,
    httpStatus: optionalHttpStatus(value.httpStatus)
  };
}

function assertLatest(value) {
  assertExactKeys(value, ["releaseId", "updatedAt"],
    "authoritative latest release identity");
  return {
    releaseId: requiredDecimalId(value.releaseId,
      "authoritative latest release ID"),
    updatedAt: requiredRfc3339(value.updatedAt,
      "authoritative latest release update time")
  };
}

async function writeReceipt(input, expectedName, label, assertion) {
  assertExactKeys(input, ["outputPath", "receipt"], `${label} write input`);
  const receipt = assertion(input.receipt);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    expectedName,
    label
  );
  const source = serializeCanonicalJson(receipt);
  await writeExclusive(outputPath, source);
  const reread = await readCanonicalJsonFile(outputPath, MAX_RECEIPT_BYTES, label);
  assertEqual(reread.sha256, sha256(source), `${label} stable reread SHA-256`);
  const rereadReceipt = assertion(reread.value);
  if (!isDeepStrictEqual(rereadReceipt, receipt)) {
    throw new Error(`The ${label} changed during its stable reread.`);
  }
  return deepFreeze({
    receipt: rereadReceipt,
    receiptIdentity: publicIdentity(outputPath, reread),
    receiptPath: outputPath
  });
}

async function readReceipt(input, expectedName, label, assertion) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"], `${label} read input`);
  assertEqual(path.basename(input.receiptPath), expectedName, `${label} filename`);
  const file = await readCanonicalJsonFile(
    input.receiptPath,
    MAX_RECEIPT_BYTES,
    label
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256, `${label} SHA-256`),
    `${label} SHA-256`
  );
  return deepFreeze({
    receipt: assertion(file.value),
    receiptIdentity: publicIdentity(input.receiptPath, file),
    receiptPath: path.resolve(input.receiptPath)
  });
}

function requiredEnum(value, values, label) {
  if (typeof value !== "string" || !values.has(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function optionalHttpStatus(value) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("The public-latest recovery HTTP status is invalid.");
  }
  return value;
}

function requiredDecimalId(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} must be a positive decimal string.`);
  }
  return value;
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)
  ) throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  return value;
}

function assertTimeOrder(previous, next, message) {
  if (Date.parse(next) < Date.parse(previous)) throw new Error(message);
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
