import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
  assertElectronProductionPublicLatestLeaseRemoteOperationSummary
} from "./electronProductionPublicLatestLeaseRemoteCli.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
  assertElectronProductionPublicLatestRecoveryObservation,
  assertElectronProductionPublicLatestRecoveryObservationBindings,
  electronProductionPublicLatestRecoveryObservationSha256
} from "./electronProductionPublicLatestRecovery.mjs";
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

export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND =
  "rion-electron-production-public-latest-lease-release-operation";
export const ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE =
  "electron-production-public-latest-lease-release-operation.json";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

export function createElectronProductionPublicLatestLeaseReleaseOperation(input) {
  assertExactKeys(input, [
    "heldLease",
    "preReleaseObservation",
    "recoveryOperation",
    "remoteOperation",
    "resolvedAt"
  ], "public-latest lease release operation input");
  const heldLease = assertHeldLease(input.heldLease);
  const preReleaseObservation = createPreReleaseObservation(
    input.preReleaseObservation,
    heldIdentity(heldLease)
  );
  const recoveryOperation = assertRecoveryOperation(input.recoveryOperation);
  const remoteOperation =
    assertElectronProductionPublicLatestLeaseRemoteOperationSummary(
      input.remoteOperation
    );
  return assertElectronProductionPublicLatestLeaseReleaseOperation({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND,
    operation: remoteOperation.command === "observe-release"
      ? "reconcile-released-lease"
      : "release-held-lease",
    held: heldIdentity(heldLease),
    preReleaseObservation,
    recoveryOperation,
    attemptedAt: remoteOperation.request?.attemptedAt,
    resolvedAt: input.resolvedAt,
    remoteOperation: {
      kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
      sha256: sha256(serializeCanonicalJson(remoteOperation)),
      receipt: remoteOperation
    },
    acknowledgement: acknowledgementFromRemote(remoteOperation),
    successor: acknowledgementFromRemote(remoteOperation) === "confirmed"
      ? remoteOperationSuccessor(remoteOperation, heldLease)
      : null
  });
}

export function assertElectronProductionPublicLatestLeaseReleaseOperation(value) {
  assertExactKeys(value, [
    "acknowledgement",
    "attemptedAt",
    "held",
    "kind",
    "operation",
    "preReleaseObservation",
    "recoveryOperation",
    "remoteOperation",
    "resolvedAt",
    "schemaVersion",
    "successor"
  ], "public-latest lease release operation");
  assertEqual(value.schemaVersion, 1,
    "public-latest lease release operation schema version");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND,
    "public-latest lease release operation kind");
  if (
    value.operation !== "release-held-lease" &&
    value.operation !== "reconcile-released-lease"
  ) throw new Error("The public-latest lease release operation is invalid.");
  const held = assertHeldIdentity(value.held);
  const preReleaseObservation = assertPreReleaseObservation(
    value.preReleaseObservation,
    held
  );
  const recoveryOperation = assertRecoveryOperation(value.recoveryOperation);
  const attemptedAt = requiredRfc3339(
    value.attemptedAt,
    "public-latest lease release attempt time"
  );
  const resolvedAt = requiredRfc3339(
    value.resolvedAt,
    "public-latest lease release resolution time"
  );
  const remoteOperation = assertRemoteOperation(value.remoteOperation);
  if (recoveryOperation.kind ===
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND) {
    assertEqual(
      recoveryOperation.sha256,
      preReleaseObservation.sha256,
      "source no-op recovery observation binding"
    );
  }
  assertEqual(
    value.operation,
    remoteOperation.receipt.command === "observe-release"
      ? "reconcile-released-lease"
      : "release-held-lease",
    "public-latest lease release operation identity"
  );
  assertRemoteRequestBinding(remoteOperation.receipt, held, attemptedAt);
  assertResolutionTime(
    value.operation,
    attemptedAt,
    resolvedAt,
    preReleaseObservation.receipt.observedAt
  );
  const acknowledgement = acknowledgementFromRemote(remoteOperation.receipt);
  assertEqual(value.acknowledgement, acknowledgement,
    "public-latest lease release acknowledgement");
  const successor = acknowledgement === "confirmed"
    ? assertSuccessor(value.successor, held, attemptedAt, remoteOperation.receipt)
    : assertNoSuccessor(value.successor);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND,
    operation: value.operation,
    held,
    preReleaseObservation,
    recoveryOperation,
    attemptedAt,
    resolvedAt,
    remoteOperation,
    acknowledgement,
    successor
  });
}

function assertResolutionTime(operation, attemptedAt, resolvedAt, observedAt) {
  if (Date.parse(resolvedAt) < Date.parse(attemptedAt)) {
    throw new Error("Lease release resolution cannot precede its original attempt.");
  }
  if (Date.parse(resolvedAt) < Date.parse(observedAt)) {
    throw new Error("Lease release resolution cannot precede its fresh observation.");
  }
  if (operation === "release-held-lease") {
    assertEqual(resolvedAt, attemptedAt, "direct lease release resolution time");
  } else {
    assertEqual(resolvedAt, observedAt,
      "reconciled lease release observation time");
  }
}

export function assertElectronProductionPublicLatestLeaseReleaseOperationBindings(
  input
) {
  assertExactKeys(input, [
    "heldLease",
    "operation",
    "recoveryOperation",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "public-latest lease release operation bindings");
  const operation =
    assertElectronProductionPublicLatestLeaseReleaseOperation(input.operation);
  const heldLease = assertHeldLease(input.heldLease);
  assertDeepEqual(operation.held, heldIdentity(heldLease),
    "public-latest lease release held binding");
  assertDeepEqual(
    operation.recoveryOperation,
    assertRecoveryOperation(input.recoveryOperation),
    "public-latest lease release recovery-operation binding"
  );
  assertElectronProductionPublicLatestRecoveryObservationBindings({
    observation: operation.preReleaseObservation.receipt,
    sourceSnapshot: input.sourceSnapshot,
    sourceSnapshotFileSha256: input.sourceSnapshotFileSha256,
    targetSnapshot: input.targetSnapshot,
    targetSnapshotFileSha256: input.targetSnapshotFileSha256
  });
  if (operation.acknowledgement === "confirmed") {
    const expected = releaseElectronProductionPublicLatestLease(
      heldLease,
      releaseInput(heldLease, operation.attemptedAt)
    );
    assertDeepEqual(operation.successor.lease, expected,
      "public-latest lease released successor binding");
  }
  return operation;
}

function createPreReleaseObservation(value, held) {
  const receipt = assertElectronProductionPublicLatestRecoveryObservation(value);
  return assertPreReleaseObservation({
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    sha256: electronProductionPublicLatestRecoveryObservationSha256(receipt),
    receipt
  }, held);
}

function assertPreReleaseObservation(value, held) {
  assertExactKeys(value, ["kind", "receipt", "sha256"],
    "pre-release public-latest observation");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    "pre-release public-latest observation kind"
  );
  const receipt = assertElectronProductionPublicLatestRecoveryObservation(
    value.receipt
  );
  const digest = requiredDigest(
    value.sha256,
    "pre-release public-latest observation SHA-256"
  );
  assertEqual(
    digest,
    electronProductionPublicLatestRecoveryObservationSha256(receipt),
    "pre-release public-latest observation SHA-256"
  );
  if (
    receipt.transport.outcome !== "observed" ||
    receipt.observation.classification !== "source" ||
    receipt.basis.source.stateSha256 !== held.sourceStateSha256 ||
    receipt.basis.target.stateSha256 !== held.targetStateSha256
  ) {
    throw new Error(
      "Lease release requires a bound last-moment exact source observation."
    );
  }
  return {
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    sha256: digest,
    receipt
  };
}

export function electronProductionPublicLatestLeaseReleaseOperationSha256(value) {
  return sha256(serializeElectronProductionPublicLatestLeaseReleaseOperation(value));
}

export function serializeElectronProductionPublicLatestLeaseReleaseOperation(value) {
  return serializeCanonicalJson(
    assertElectronProductionPublicLatestLeaseReleaseOperation(value)
  );
}

export async function writeElectronProductionPublicLatestLeaseReleaseOperation(
  input
) {
  assertExactKeys(input, ["operation", "outputPath"],
    "public-latest lease release operation write input");
  const operation =
    assertElectronProductionPublicLatestLeaseReleaseOperation(input.operation);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE,
    "public-latest lease release operation"
  );
  await writeExclusive(
    outputPath,
    serializeElectronProductionPublicLatestLeaseReleaseOperation(operation)
  );
  return readElectronProductionPublicLatestLeaseReleaseOperation({
    expectedSha256:
      electronProductionPublicLatestLeaseReleaseOperationSha256(operation),
    operationPath: outputPath
  });
}

export async function readElectronProductionPublicLatestLeaseReleaseOperation(input) {
  assertExactKeys(input, ["expectedSha256", "operationPath"],
    "public-latest lease release operation read input");
  assertEqual(
    path.basename(input.operationPath),
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE,
    "public-latest lease release operation filename"
  );
  const file = await readCanonicalJsonFile(
    input.operationPath,
    MAX_RECEIPT_BYTES,
    "public-latest lease release operation"
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedSha256,
      "public-latest lease release operation SHA-256"),
    "public-latest lease release operation SHA-256"
  );
  const operation =
    assertElectronProductionPublicLatestLeaseReleaseOperation(file.value);
  if (!file.source.equals(
    serializeElectronProductionPublicLatestLeaseReleaseOperation(operation)
  )) throw new Error("The public-latest lease release operation must be canonical.");
  return deepFreeze({
    operation,
    operationIdentity: publicIdentity(input.operationPath, file),
    operationPath: input.operationPath
  });
}

function assertHeldLease(value) {
  const lease = assertElectronProductionPublicLatestLease(value);
  assertEqual(lease.status, "held", "public-latest release held lease status");
  return lease;
}

function heldIdentity(lease) {
  return {
    transactionId: lease.transactionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    revision: lease.revision,
    eventSha256: electronProductionPublicLatestLeaseEventSha256(lease),
    sourceStateSha256: lease.source.stateSha256,
    targetStateSha256: lease.target.stateSha256
  };
}

function assertHeldIdentity(value) {
  assertExactKeys(value, [
    "eventSha256",
    "generation",
    "leaseId",
    "revision",
    "sourceStateSha256",
    "targetStateSha256",
    "transactionId"
  ], "public-latest lease release held identity");
  return {
    transactionId: requiredUuid(value.transactionId, "release transaction ID"),
    leaseId: requiredUuid(value.leaseId, "release lease ID"),
    generation: requiredPositiveInteger(value.generation, "release generation"),
    revision: requiredPositiveInteger(value.revision, "release held revision"),
    eventSha256: requiredDigest(value.eventSha256, "release held event SHA-256"),
    sourceStateSha256: requiredDigest(value.sourceStateSha256,
      "release source state SHA-256"),
    targetStateSha256: requiredDigest(value.targetStateSha256,
      "release target state SHA-256")
  };
}

function assertRecoveryOperation(value) {
  assertExactKeys(value, ["kind", "sha256"],
    "lease release recovery operation");
  if (
    value.kind !== ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND &&
    value.kind !== ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND
  ) throw new Error("The lease release recovery operation kind is invalid.");
  return {
    kind: value.kind,
    sha256: requiredDigest(value.sha256, "lease release recovery operation SHA-256")
  };
}

function assertRemoteOperation(value) {
  assertExactKeys(value, ["kind", "receipt", "sha256"],
    "embedded remote lease operation");
  assertEqual(value.kind,
    ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
    "embedded remote lease operation kind");
  const receipt =
    assertElectronProductionPublicLatestLeaseRemoteOperationSummary(value.receipt);
  const digest = requiredDigest(value.sha256, "remote lease operation SHA-256");
  assertEqual(digest, sha256(serializeCanonicalJson(receipt)),
    "embedded remote lease operation SHA-256");
  return {
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_REMOTE_OPERATION_KIND,
    sha256: digest,
    receipt
  };
}

function assertRemoteRequestBinding(receipt, held, attemptedAt) {
  if (receipt.command !== "release" && receipt.command !== "observe-release") {
    throw new Error("The remote lease release command is invalid.");
  }
  assertEqual(receipt.request.attemptedAt, attemptedAt,
    "remote lease release attempt time binding");
  assertDeepEqual(receipt.request.held, held,
    "remote lease release held request binding");
}

function acknowledgementFromRemote(receipt) {
  if (receipt.command !== "release" && receipt.command !== "observe-release") {
    throw new Error("The remote lease release command is invalid.");
  }
  if (
    (receipt.command === "release" && receipt.outcome === "applied") ||
    (receipt.command === "observe-release" && receipt.outcome === "observed")
  ) return "confirmed";
  if (receipt.outcome === "rejected") return "rejected";
  if (receipt.outcome === "indeterminate") return "unknown";
  throw new Error("A lease observation cannot acknowledge release.");
}

function remoteOperationSuccessor(remoteOperation, heldLease) {
  const output = remoteOperation.output;
  const released = releaseElectronProductionPublicLatestLease(
    heldLease,
    releaseInput(heldLease, remoteOperation.request.attemptedAt)
  );
  const source = serializeElectronProductionPublicLatestLease(released);
  assertEqual(output.bytes, source.length, "released lease output bytes");
  assertEqual(output.sha256, sha256(source), "released lease output SHA-256");
  assertEqual(remoteOperation.lease.eventSha256,
    electronProductionPublicLatestLeaseEventSha256(released),
    "released lease event SHA-256");
  return {
    lease: released,
    eventSha256: electronProductionPublicLatestLeaseEventSha256(released),
    bytes: source.length,
    fileSha256: sha256(source),
    blobSha: remoteOperation.remote.blobSha
  };
}

function assertSuccessor(value, held, attemptedAt, remoteOperation) {
  assertExactKeys(value, ["blobSha", "bytes", "eventSha256", "fileSha256", "lease"],
    "released public-latest lease successor");
  const lease = assertElectronProductionPublicLatestLease(value.lease);
  assertEqual(lease.status, "released", "released public-latest lease status");
  for (const [actual, expected, label] of [
    [lease.transactionId, held.transactionId, "transaction ID"],
    [lease.leaseId, held.leaseId, "lease ID"],
    [lease.generation, held.generation, "generation"],
    [lease.revision, held.revision + 1, "revision"],
    [lease.previousEventSha256, held.eventSha256, "previous event SHA-256"],
    [lease.source.stateSha256, held.sourceStateSha256, "source state SHA-256"],
    [lease.target.stateSha256, held.targetStateSha256, "target state SHA-256"],
    [lease.recordedAt, attemptedAt, "recorded time"]
  ]) assertEqual(actual, expected, `released lease successor ${label}`);
  const source = serializeElectronProductionPublicLatestLease(lease);
  const eventSha256 = electronProductionPublicLatestLeaseEventSha256(lease);
  const fileSha256 = sha256(source);
  for (const [actual, expected, label] of [
    [value.eventSha256, eventSha256, "event SHA-256"],
    [value.bytes, source.length, "bytes"],
    [value.fileSha256, fileSha256, "file SHA-256"],
    [value.blobSha, remoteOperation.remote.blobSha, "remote blob SHA"],
    [remoteOperation.lease.eventSha256, eventSha256, "remote event SHA-256"],
    [remoteOperation.output.sha256, fileSha256, "remote output SHA-256"],
    [remoteOperation.output.bytes, source.length, "remote output bytes"]
  ]) assertEqual(actual, expected, `released lease successor ${label}`);
  return {
    lease,
    eventSha256,
    bytes: source.length,
    fileSha256,
    blobSha: value.blobSha
  };
}

function assertNoSuccessor(value) {
  assertEqual(value, null, "unconfirmed lease release successor");
  return null;
}

function releaseInput(heldLease, attemptedAt) {
  return {
    transactionId: heldLease.transactionId,
    leaseId: heldLease.leaseId,
    generation: heldLease.generation,
    sourceStateSha256: heldLease.source.stateSha256,
    targetStateSha256: heldLease.target.stateSha256,
    recordedAt: attemptedAt
  };
}

function requiredUuid(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)
  ) throw new Error(`The ${label} is invalid.`);
  return value;
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
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
