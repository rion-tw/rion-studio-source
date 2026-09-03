import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "./electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND,
  assertElectronProductionPublicLatestLeaseReleaseOperation,
  assertElectronProductionPublicLatestLeaseReleaseOperationBindings,
  electronProductionPublicLatestLeaseReleaseOperationSha256
} from "./electronProductionPublicLatestLeaseReleaseOperation.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
  assertElectronProductionPublicLatestRecoveryObservation,
  assertElectronProductionPublicLatestRecoveryObservationBindings,
  assertElectronProductionPublicLatestRecoveryRollback,
  assertElectronProductionPublicLatestRecoveryRollbackFoundationBindings,
  electronProductionPublicLatestRecoveryObservationSha256,
  electronProductionPublicLatestRecoveryRollbackSha256
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  assertElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND
} from "./electronProductionPublicationRecovery.mjs";
import {
  assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization,
  electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256,
  electronProductionPublicationRecoveryPublicMutationAttemptSha256
} from "./electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
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

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE =
  "electron-production-publication-recovery-public-mutation-operation.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_OPERATION_BYTES =
  4 * 1024 * 1024;

const MODES = new Set([
  "actual-transport",
  "marker-reconciliation",
  "precondition-rejected"
]);

export function createElectronProductionPublicationRecoveryPublicMutationOperation(
  input
) {
  assertExactKeys(input, [
    "authorization",
    "authorizationSha256",
    "beforeObservation",
    "beforeObservationSha256",
    "finalObservation",
    "finalObservationSha256",
    "heldLease",
    "heldLeaseFileSha256",
    "mode",
    "resolvedAt",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "successor",
    "targetSnapshot",
    "targetSnapshotFileSha256",
    "transportOperation",
    "transportOperationSha256"
  ], "publication recovery public-mutation operation input");
  const foundation = assertFoundation(input);
  const authorization =
    assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
      input.authorization
    );
  const authorizationSha256 = requiredDigest(
    input.authorizationSha256,
    "publication recovery public-mutation authorization SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256(
      authorization
    ),
    authorizationSha256,
    "publication recovery public-mutation authorization SHA-256"
  );
  const attempt = authorization.authority.attempt;
  const attemptSha256 = authorization.authority.sha256;
  assertEqual(
    electronProductionPublicationRecoveryPublicMutationAttemptSha256(attempt),
    attemptSha256,
    "publication recovery public-mutation attempt SHA-256"
  );
  const mode = requiredMode(input.mode);
  assertAuthorizationMode(authorization, mode);
  const before = assertObservationFile({
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    receipt: input.beforeObservation,
    sha256: input.beforeObservationSha256
  }, foundation, "before");
  const final = assertObservationFile({
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    receipt: input.finalObservation,
    sha256: input.finalObservationSha256
  }, foundation, "final");
  const resolvedAt = requiredRfc3339(
    input.resolvedAt,
    "publication recovery public-mutation resolution time"
  );
  assertTimeOrder(final.receipt.observedAt, resolvedAt,
    "Public-mutation resolution cannot precede its final observation.");
  const authority = createAuthoritySummary(
    authorization,
    authorizationSha256,
    attempt,
    attemptSha256
  );
  const derived = deriveOperationResult({
    attempt,
    authorization,
    before,
    final,
    foundation,
    mode,
    resolvedAt,
    successor: input.successor,
    transportOperation: input.transportOperation,
    transportOperationSha256: input.transportOperationSha256
  });
  return assertElectronProductionPublicationRecoveryPublicMutationOperation({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND,
    status: "closed-marker-bound-public-mutation-observation",
    transactionId: attempt.transactionId,
    operation: attempt.operation,
    mode,
    authority,
    before,
    final,
    transport: derived.transport,
    successor: derived.successor,
    result: derived.result,
    resolvedAt
  });
}

export function assertElectronProductionPublicationRecoveryPublicMutationOperation(
  value
) {
  assertExactKeys(value, [
    "authority",
    "before",
    "final",
    "kind",
    "mode",
    "operation",
    "resolvedAt",
    "result",
    "schemaVersion",
    "status",
    "successor",
    "transactionId",
    "transport"
  ], "publication recovery public-mutation operation");
  assertEqual(value.schemaVersion, 1,
    "publication recovery public-mutation operation schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND,
    "publication recovery public-mutation operation kind"
  );
  assertEqual(
    value.status,
    "closed-marker-bound-public-mutation-observation",
    "publication recovery public-mutation operation status"
  );
  const operation = requiredOperation(value.operation);
  const mode = requiredMode(value.mode);
  const authority = assertAuthoritySummary(value.authority);
  const before = assertObservationFileShape(value.before, "before");
  const final = assertObservationFileShape(value.final, "final");
  const transport = assertTransportShape(value.transport, operation, mode);
  const successor = assertSuccessorShape(value.successor);
  const result = assertResultShape(value.result, operation, mode);
  const resolvedAt = requiredRfc3339(
    value.resolvedAt,
    "publication recovery public-mutation resolution time"
  );
  assertTimeOrder(final.receipt.observedAt, resolvedAt,
    "Public-mutation resolution cannot precede its final observation.");
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND,
    status: "closed-marker-bound-public-mutation-observation",
    transactionId: requiredUuid(
      value.transactionId,
      "publication recovery public-mutation transaction ID"
    ),
    operation,
    mode,
    authority,
    before,
    final,
    transport,
    successor,
    result,
    resolvedAt
  });
}

export function assertElectronProductionPublicationRecoveryPublicMutationOperationBindings(
  input
) {
  assertExactKeys(input, [
    "authorization",
    "authorizationSha256",
    "heldLease",
    "heldLeaseFileSha256",
    "operation",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "publication recovery public-mutation operation bindings");
  const operation =
    assertElectronProductionPublicationRecoveryPublicMutationOperation(
      input.operation
    );
  const { authorization, authorizationSha256, foundation } =
    assertAuthorizationFoundation(input);
  const attempt = authorization.authority.attempt;
  const expectedAuthority = createAuthoritySummary(
    authorization,
    authorizationSha256,
    attempt,
    authorization.authority.sha256
  );
  assertDeepEqual(operation.authority, expectedAuthority,
    "publication recovery public-mutation operation authority");
  for (const [actual, expected, label] of [
    [operation.transactionId, attempt.transactionId, "transaction ID"],
    [operation.operation, attempt.operation, "operation"]
  ]) assertEqual(actual, expected,
    `publication recovery public-mutation ${label} binding`);
  assertAuthorizationMode(authorization, operation.mode);
  const before = assertObservationFile(operation.before, foundation, "before");
  const final = assertObservationFile(operation.final, foundation, "final");
  const derived = deriveOperationResult({
    attempt,
    authorization,
    before,
    final,
    foundation,
    mode: operation.mode,
    resolvedAt: operation.resolvedAt,
    successor: operation.successor,
    transportOperation: operation.transport?.receipt ?? null,
    transportOperationSha256: operation.transport?.sha256 ?? null
  });
  assertDeepEqual(operation.transport, derived.transport,
    "publication recovery public-mutation transport evidence");
  assertDeepEqual(operation.successor, derived.successor,
    "publication recovery public-mutation successor evidence");
  assertDeepEqual(operation.result, derived.result,
    "publication recovery public-mutation result evidence");
  return operation;
}

export function assertElectronProductionPublicationRecoveryPublicMutationAuthorizationBindings(
  input
) {
  assertExactKeys(input, [
    "authorization",
    "authorizationSha256",
    "heldLease",
    "heldLeaseFileSha256",
    "sourceSnapshot",
    "sourceSnapshotFileSha256",
    "targetSnapshot",
    "targetSnapshotFileSha256"
  ], "publication recovery public-mutation authorization bindings");
  return assertAuthorizationFoundation(input).authorization;
}

function assertAuthorizationFoundation(input) {
  const authorization =
    assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
      input.authorization
    );
  const authorizationSha256 = requiredDigest(
    input.authorizationSha256,
    "publication recovery public-mutation authorization SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256(
      authorization
    ),
    authorizationSha256,
    "publication recovery public-mutation authorization SHA-256"
  );
  const foundation = assertFoundation(input);
  const attempt = authorization.authority.attempt;
  for (const [actual, expected, label] of [
    [foundation.heldLease.transactionId, attempt.transactionId,
      "held-lease transaction ID"],
    [foundation.heldLease.leaseId, attempt.authority.heldLease.leaseId,
      "held-lease ID"],
    [foundation.heldLease.generation, attempt.authority.heldLease.generation,
      "held-lease generation"],
    [foundation.heldLease.revision, attempt.authority.heldLease.revision,
      "held-lease revision"],
    [electronProductionPublicLatestLeaseEventSha256(foundation.heldLease),
      attempt.authority.heldLease.eventSha256, "held-lease event SHA-256"]
    , [foundation.heldLease.source.stateSha256,
      attempt.authority.heldLease.sourceStateSha256,
      "held-lease source state SHA-256"]
    , [foundation.heldLease.target.stateSha256,
      attempt.authority.heldLease.targetStateSha256,
      "held-lease target state SHA-256"]
    , [foundation.heldLeaseFileSha256,
      attempt.authority.heldLease.fileSha256, "held-lease file SHA-256"]
    , [foundation.sourceSnapshotFileSha256,
      attempt.authority.foundation.sourceSnapshotSha256,
      "source snapshot file SHA-256"]
    , [foundation.targetSnapshotFileSha256,
      attempt.authority.foundation.targetSnapshotSha256,
      "target snapshot file SHA-256"]
  ]) assertEqual(actual, expected,
    `publication recovery public-mutation ${label} binding`);
  return { authorization, authorizationSha256, foundation };
}

export function electronProductionPublicationRecoveryPublicMutationOperationOutcomeEvidence(
  input
) {
  const operation =
    assertElectronProductionPublicationRecoveryPublicMutationOperationBindings(
      input
    );
  return deepFreeze({
    beforeMutation: observationToCore(operation.before.receipt),
    finalObservation: observationToCore(operation.final.receipt),
    mutation: operation.result.mutation,
    leaseRelease: operation.result.leaseRelease,
    recoveryOperation: {
      kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_KIND,
      operation: operation.operation,
      mode: operation.mode,
      authority: {
        attemptSha256: operation.authority.attemptSha256,
        authorizationSha256: operation.authority.authorizationSha256
      },
      sha256:
        electronProductionPublicationRecoveryPublicMutationOperationSha256(
          operation
        )
    }
  });
}

export function serializeElectronProductionPublicationRecoveryPublicMutationOperation(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryPublicMutationOperation(value)
  );
}

export function electronProductionPublicationRecoveryPublicMutationOperationSha256(
  value
) {
  return sha256(
    serializeElectronProductionPublicationRecoveryPublicMutationOperation(value)
  );
}

export async function writeElectronProductionPublicationRecoveryPublicMutationOperation(
  input
) {
  assertExactKeys(input, ["outputPath", "value"],
    "publication recovery public-mutation operation write input");
  const value =
    assertElectronProductionPublicationRecoveryPublicMutationOperation(
      input.value
    );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE,
    "publication recovery public-mutation operation"
  );
  await writeExclusive(outputPath, serializeCanonicalJson(value));
  const reread = await readCanonicalJsonFile(
    outputPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_OPERATION_BYTES,
    "publication recovery public-mutation operation"
  );
  const parsed =
    assertElectronProductionPublicationRecoveryPublicMutationOperation(
      reread.value
    );
  const identity = publicIdentity(outputPath, reread);
  assertEqual(
    identity.sha256,
    electronProductionPublicationRecoveryPublicMutationOperationSha256(parsed),
    "publication recovery public-mutation operation reread SHA-256"
  );
  return deepFreeze({ value: parsed, valueIdentity: identity, valuePath: outputPath });
}

export async function readElectronProductionPublicationRecoveryPublicMutationOperation(
  input
) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "publication recovery public-mutation operation read input");
  const file = await readCanonicalJsonFile(
    input.receiptPath,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_OPERATION_BYTES,
    "publication recovery public-mutation operation"
  );
  const value =
    assertElectronProductionPublicationRecoveryPublicMutationOperation(
      file.value
    );
  const identity = publicIdentity(input.receiptPath, file);
  assertEqual(
    identity.fileName,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE,
    "publication recovery public-mutation operation filename"
  );
  assertEqual(
    identity.sha256,
    requiredDigest(
      input.expectedSha256,
      "publication recovery public-mutation operation expected SHA-256"
    ),
    "publication recovery public-mutation operation expected SHA-256"
  );
  return deepFreeze({ value, valueIdentity: identity, valuePath: input.receiptPath });
}

function deriveOperationResult(input) {
  assertObservationAuthority(input.attempt, input.before, input.mode);
  for (const [floor, label] of [
    [input.attempt.reservedAt, "reservation"],
    [input.authorization.verifiedAt, "authorization"]
  ]) assertTimeOrder(floor, input.final.receipt.observedAt,
    `Public-mutation final observation cannot precede its ${label}.`);
  if (input.attempt.operation === "rollback-public-latest") {
    return deriveRollbackResult(input);
  }
  return deriveLeaseReleaseResult(input);
}

function deriveRollbackResult(input) {
  assertEqual(input.before.receipt.observation.classification, "target",
    "marker-bound rollback before observation");
  assertEqual(input.successor, null,
    "marker-bound rollback released-lease successor");
  if (input.mode === "actual-transport") {
    const rollback = assertElectronProductionPublicLatestRecoveryRollback(
      input.transportOperation
    );
    const rollbackSha256 = requiredDigest(
      input.transportOperationSha256,
      "marker-bound rollback transport SHA-256"
    );
    assertEqual(
      electronProductionPublicLatestRecoveryRollbackSha256(rollback),
      rollbackSha256,
      "marker-bound rollback transport SHA-256"
    );
    assertElectronProductionPublicLatestRecoveryRollbackFoundationBindings({
      heldLease: input.foundation.heldLease,
      rollback,
      sourceSnapshot: input.foundation.sourceSnapshot,
      sourceSnapshotFileSha256: input.foundation.sourceSnapshotFileSha256,
      targetSnapshot: input.foundation.targetSnapshot,
      targetSnapshotFileSha256: input.foundation.targetSnapshotFileSha256
    });
    for (const [time, label] of [
      [input.before.receipt.observedAt, "before observation"],
      [rollback.mutation.submittedAt, "submission"]
    ]) {
      assertTimeOrder(input.attempt.reservedAt, time,
        `Marker-bound rollback ${label} cannot precede reservation.`);
      assertTimeOrder(input.authorization.verifiedAt, time,
        `Marker-bound rollback ${label} cannot precede authorization.`);
    }
    for (const [actual, expected, label] of [
      [rollback.before.observationSha256, input.before.sha256,
        "before observation SHA-256"],
      [rollback.final.observationSha256, input.final.sha256,
        "final observation SHA-256"]
    ]) assertEqual(actual, expected, `marker-bound rollback ${label}`);
    return deepFreeze({
      transport: {
        kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND,
        sha256: rollbackSha256,
        receipt: rollback
      },
      successor: null,
      result: {
        mutation: {
          kind: "rollback",
          submitted: true,
          acknowledgement: rollback.mutation.acknowledgement,
          submittedAt: rollback.mutation.submittedAt,
          resultRecordedAt: rollback.mutation.resultRecordedAt
        },
        leaseRelease: noLeaseRelease()
      }
    });
  }
  assertNullTransport(input);
  const authority = markerAuthority(input.authorization);
  return deepFreeze({
    transport: null,
    successor: null,
    result: {
      mutation: {
        kind: "rollback",
        submitted: input.mode === "marker-reconciliation" ? "possibly" : false,
        acknowledgement: input.mode === "marker-reconciliation"
          ? "unknown"
          : "rejected",
        reservedAt: input.attempt.reservedAt,
        submittedAt: null,
        resultRecordedAt: input.final.receipt.observedAt,
        reservation: authority
      },
      leaseRelease: noLeaseRelease()
    }
  });
}

function deriveLeaseReleaseResult(input) {
  assertEqual(input.before.receipt.observation.classification, "source",
    "marker-bound lease-release before observation");
  if (input.mode === "actual-transport") {
    const release = assertElectronProductionPublicLatestLeaseReleaseOperation(
      input.transportOperation
    );
    assertEqual(release.operation, "release-held-lease",
      "marker-bound actual lease-release transport operation");
    const releaseSha256 = requiredDigest(
      input.transportOperationSha256,
      "marker-bound lease-release transport SHA-256"
    );
    assertEqual(
      electronProductionPublicLatestLeaseReleaseOperationSha256(release),
      releaseSha256,
      "marker-bound lease-release transport SHA-256"
    );
    assertElectronProductionPublicLatestLeaseReleaseOperationBindings({
      heldLease: input.foundation.heldLease,
      operation: release,
      recoveryOperation: release.recoveryOperation,
      sourceSnapshot: input.foundation.sourceSnapshot,
      sourceSnapshotFileSha256: input.foundation.sourceSnapshotFileSha256,
      targetSnapshot: input.foundation.targetSnapshot,
      targetSnapshotFileSha256: input.foundation.targetSnapshotFileSha256
    });
    for (const [time, label] of [
      [input.before.receipt.observedAt, "before observation"],
      [release.attemptedAt, "attempt"]
    ]) {
      assertTimeOrder(input.attempt.reservedAt, time,
        `Marker-bound lease-release ${label} cannot precede reservation.`);
      assertTimeOrder(input.authorization.verifiedAt, time,
        `Marker-bound lease-release ${label} cannot precede authorization.`);
    }
    assertEqual(release.preReleaseObservation.sha256, input.before.sha256,
      "marker-bound lease-release before observation SHA-256");
    assertEqual(input.final.sha256, input.before.sha256,
      "marker-bound actual lease-release final observation SHA-256");
    const successor = release.successor === null
      ? null
      : assertSuccessorEvidence(release.successor, input);
    return deepFreeze({
      transport: {
        kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND,
        sha256: releaseSha256,
        receipt: release
      },
      successor,
      result: {
        mutation: noMutation(),
        leaseRelease: {
          attempted: true,
          acknowledgement: release.acknowledgement,
          attemptedAt: release.attemptedAt,
          operationSha256: releaseSha256,
          resolvedAt: release.resolvedAt,
          successorEventSha256: successor?.eventSha256 ?? null
        }
      }
    });
  }
  assertNullTransport(input);
  const authority = markerAuthority(input.authorization);
  if (input.mode === "precondition-rejected") {
    assertEqual(input.successor, null,
      "marker-bound rejected lease-release successor");
    return deepFreeze({
      transport: null,
      successor: null,
      result: {
        mutation: noMutation(),
        leaseRelease: {
          attempted: false,
          acknowledgement: "rejected",
          attemptedAt: null,
          operationSha256: null,
          reservation: authority,
          reservedAt: input.attempt.reservedAt,
          resolvedAt: input.resolvedAt,
          successorEventSha256: null
        }
      }
    });
  }
  const successor = input.successor === null
    ? null
    : assertSuccessorEvidence(input.successor, input);
  return deepFreeze({
    transport: null,
    successor,
    result: {
      mutation: noMutation(),
      leaseRelease: successor === null
        ? {
            attempted: "possibly",
            acknowledgement: "unknown",
            attemptedAt: null,
            operationSha256: null,
            reservation: authority,
            resolvedAt: input.resolvedAt,
            successorEventSha256: null
          }
        : {
            attempted: "possibly",
            acknowledgement: "confirmed",
            attemptedAt: successor.lease.recordedAt,
            operationSha256: null,
            reservation: authority,
            resolvedAt: input.resolvedAt,
            successorEventSha256: successor.eventSha256
          }
    }
  });
}

function assertObservationAuthority(attempt, before, mode) {
  if (mode === "actual-transport") return;
  assertEqual(
    before.sha256,
    attempt.publicMutation.observation.sha256,
    "marker-bound original public observation SHA-256"
  );
  assertDeepEqual(
    before.receipt,
    attempt.publicMutation.observation.receipt,
    "marker-bound original public observation"
  );
}

function assertAuthorizationMode(authorization, mode) {
  const expected = mode === "marker-reconciliation"
    ? "resumed-existing"
    : "created-now";
  assertEqual(
    authorization.headTransition.mode,
    expected,
    "public-mutation authorization head-transition mode"
  );
}

function createAuthoritySummary(authorization, authorizationSha256, attempt,
  attemptSha256) {
  return deepFreeze({
    attemptSha256,
    authorizationSha256,
    attemptPath: attempt.privateStore.path,
    previousOutcomeSha256:
      attempt.authority.predecessor?.sha256 ?? null,
    reservedAt: attempt.reservedAt,
    currentRun: authorization.currentRun
  });
}

function assertAuthoritySummary(value) {
  assertExactKeys(value, [
    "attemptPath",
    "attemptSha256",
    "authorizationSha256",
    "currentRun",
    "previousOutcomeSha256",
    "reservedAt"
  ], "publication recovery public-mutation operation authority");
  return deepFreeze({
    attemptSha256: requiredDigest(value.attemptSha256,
      "public-mutation attempt SHA-256"),
    authorizationSha256: requiredDigest(value.authorizationSha256,
      "public-mutation authorization SHA-256"),
    attemptPath: requiredStorePath(value.attemptPath),
    previousOutcomeSha256: value.previousOutcomeSha256 === null
      ? null
      : requiredDigest(value.previousOutcomeSha256,
          "public-mutation predecessor SHA-256"),
    reservedAt: requiredRfc3339(value.reservedAt,
      "public-mutation reservation time"),
    currentRun: assertRunIdentity(value.currentRun)
  });
}

function assertFoundation(input) {
  const heldLease = assertElectronProductionPublicLatestLease(input.heldLease);
  if (heldLease.status !== "held" ||
      heldLease.purpose !== "electron-v23-provisional-publication") {
    throw new Error("A public-mutation operation requires its exact held lease.");
  }
  const sourceSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.sourceSnapshot
  );
  const targetSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.targetSnapshot
  );
  return {
    heldLease,
    heldLeaseFileSha256: requiredDigest(
      input.heldLeaseFileSha256,
      "public-mutation held-lease file SHA-256"
    ),
    sourceSnapshot,
    sourceSnapshotFileSha256: requiredDigest(
      input.sourceSnapshotFileSha256,
      "public-mutation source snapshot file SHA-256"
    ),
    targetSnapshot,
    targetSnapshotFileSha256: requiredDigest(
      input.targetSnapshotFileSha256,
      "public-mutation target snapshot file SHA-256"
    )
  };
}

function assertObservationFile(value, foundation, label) {
  const observation = assertObservationFileShape(value, label);
  assertElectronProductionPublicLatestRecoveryObservationBindings({
    observation: observation.receipt,
    sourceSnapshot: foundation.sourceSnapshot,
    sourceSnapshotFileSha256: foundation.sourceSnapshotFileSha256,
    targetSnapshot: foundation.targetSnapshot,
    targetSnapshotFileSha256: foundation.targetSnapshotFileSha256
  });
  return observation;
}

function assertObservationFileShape(value, label) {
  assertExactKeys(value, ["kind", "receipt", "sha256"],
    `publication recovery public-mutation ${label} observation`);
  assertEqual(value.kind, ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    `publication recovery public-mutation ${label} observation kind`);
  const receipt = assertElectronProductionPublicLatestRecoveryObservation(
    value.receipt
  );
  const sha256Value = requiredDigest(value.sha256,
    `publication recovery public-mutation ${label} observation SHA-256`);
  assertEqual(
    electronProductionPublicLatestRecoveryObservationSha256(receipt),
    sha256Value,
    `publication recovery public-mutation ${label} observation SHA-256`
  );
  return deepFreeze({
    kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
    sha256: sha256Value,
    receipt
  });
}

function assertTransportShape(value, operation, mode) {
  if (mode !== "actual-transport") {
    assertEqual(value, null, "non-transport public-mutation operation evidence");
    return null;
  }
  assertExactKeys(value, ["kind", "receipt", "sha256"],
    "publication recovery public-mutation transport");
  const expectedKind = operation === "rollback-public-latest"
    ? ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND
    : ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_KIND;
  assertEqual(value.kind, expectedKind,
    "publication recovery public-mutation transport kind");
  const receipt = operation === "rollback-public-latest"
    ? assertElectronProductionPublicLatestRecoveryRollback(value.receipt)
    : assertElectronProductionPublicLatestLeaseReleaseOperation(value.receipt);
  const expectedSha256 = operation === "rollback-public-latest"
    ? electronProductionPublicLatestRecoveryRollbackSha256(receipt)
    : electronProductionPublicLatestLeaseReleaseOperationSha256(receipt);
  const receiptSha256 = requiredDigest(value.sha256,
    "publication recovery public-mutation transport SHA-256");
  assertEqual(receiptSha256, expectedSha256,
    "publication recovery public-mutation transport SHA-256");
  return deepFreeze({ kind: expectedKind, sha256: receiptSha256, receipt });
}

function assertSuccessorShape(value) {
  if (value === null) return null;
  assertExactKeys(value, [
    "blobSha",
    "bytes",
    "eventSha256",
    "fileSha256",
    "lease"
  ], "publication recovery public-mutation released successor");
  return deepFreeze({
    lease: assertElectronProductionPublicLatestLease(value.lease),
    eventSha256: requiredDigest(value.eventSha256,
      "released successor event SHA-256"),
    bytes: requiredPositiveInteger(value.bytes, "released successor bytes"),
    fileSha256: requiredDigest(value.fileSha256,
      "released successor file SHA-256"),
    blobSha: requiredCommitSha(value.blobSha, "released successor blob SHA")
  });
}

function assertSuccessorEvidence(value, input) {
  const successor = assertSuccessorShape(value);
  const expected = releaseElectronProductionPublicLatestLease(
    input.foundation.heldLease,
    {
      transactionId: input.foundation.heldLease.transactionId,
      leaseId: input.foundation.heldLease.leaseId,
      generation: input.foundation.heldLease.generation,
      sourceStateSha256: input.foundation.heldLease.source.stateSha256,
      targetStateSha256: input.foundation.heldLease.target.stateSha256,
      recordedAt: successor.lease.recordedAt
    }
  );
  assertDeepEqual(successor.lease, expected,
    "publication recovery released successor transition");
  const lease = assertElectronProductionPublicLatestLease(successor.lease);
  assertEqual(lease.status, "released", "public-mutation successor status");
  const source = serializeElectronProductionPublicLatestLease(lease);
  for (const [actual, expected, label] of [
    [successor.eventSha256,
      electronProductionPublicLatestLeaseEventSha256(lease), "event SHA-256"],
    [successor.bytes, source.length, "bytes"],
    [successor.fileSha256, sha256(source), "file SHA-256"],
    [successor.blobSha, gitBlobSha(source), "blob SHA"]
  ]) assertEqual(actual, expected,
    `publication recovery released successor ${label}`);
  assertTimeOrder(input.attempt.reservedAt, lease.recordedAt,
    "A released successor cannot precede its durable mutation reservation.");
  return deepFreeze({ ...successor, lease });
}

function assertResultShape(value, operation, mode) {
  assertExactKeys(value, ["leaseRelease", "mutation"],
    "publication recovery public-mutation result");
  if (operation === "rollback-public-latest") {
    return deepFreeze({
      mutation: assertRollbackResult(value.mutation, mode),
      leaseRelease: assertNoLeaseRelease(value.leaseRelease)
    });
  }
  return deepFreeze({
    mutation: assertNoMutation(value.mutation),
    leaseRelease: assertLeaseReleaseResult(value.leaseRelease, mode)
  });
}

function assertRollbackResult(value, mode) {
  const markerOnly = mode !== "actual-transport";
  assertExactKeys(value, [
    "acknowledgement",
    "kind",
    ...(markerOnly ? ["reservation", "reservedAt"] : []),
    "resultRecordedAt",
    "submitted",
    "submittedAt"
  ], "publication recovery public-mutation rollback result");
  assertEqual(value.kind, "rollback", "public-mutation rollback result kind");
  if (mode === "actual-transport") {
    assertEqual(value.submitted, true,
      "public-mutation rollback transport submission");
    if (!["confirmed", "rejected", "unknown"].includes(value.acknowledgement)) {
      throw new Error("The public-mutation rollback acknowledgement is invalid.");
    }
    return deepFreeze({
      kind: "rollback",
      submitted: true,
      acknowledgement: value.acknowledgement,
      submittedAt: requiredRfc3339(value.submittedAt,
        "public-mutation rollback submission time"),
      resultRecordedAt: requiredRfc3339(value.resultRecordedAt,
        "public-mutation rollback result time")
    });
  }
  const submitted = mode === "marker-reconciliation" ? "possibly" : false;
  const acknowledgement = mode === "marker-reconciliation"
    ? "unknown"
    : "rejected";
  assertEqual(value.submitted, submitted,
    "public-mutation marker rollback submission");
  assertEqual(value.acknowledgement, acknowledgement,
    "public-mutation marker rollback acknowledgement");
  assertEqual(value.submittedAt, null,
    "public-mutation marker rollback submission time");
  return deepFreeze({
    kind: "rollback",
    submitted,
    acknowledgement,
    reservedAt: requiredRfc3339(value.reservedAt,
      "public-mutation rollback reservation time"),
    submittedAt: null,
    resultRecordedAt: requiredRfc3339(value.resultRecordedAt,
      "public-mutation rollback result time"),
    reservation: assertMarkerAuthority(value.reservation)
  });
}

function assertLeaseReleaseResult(value, mode) {
  const markerOnly = mode !== "actual-transport";
  assertExactKeys(value, [
    "acknowledgement",
    "attempted",
    "attemptedAt",
    "operationSha256",
    ...(markerOnly ? ["reservation"] : []),
    ...(mode === "precondition-rejected" ? ["reservedAt"] : []),
    "resolvedAt",
    "successorEventSha256"
  ], "publication recovery public-mutation lease-release result");
  if (mode === "actual-transport") {
    assertEqual(value.attempted, true,
      "public-mutation lease-release transport attempt");
    if (!["confirmed", "rejected", "unknown"].includes(value.acknowledgement)) {
      throw new Error("The public-mutation lease acknowledgement is invalid.");
    }
    return deepFreeze({
      attempted: true,
      acknowledgement: value.acknowledgement,
      attemptedAt: requiredRfc3339(value.attemptedAt,
        "public-mutation lease-release attempt time"),
      operationSha256: requiredDigest(value.operationSha256,
        "public-mutation lease-release operation SHA-256"),
      resolvedAt: requiredRfc3339(value.resolvedAt,
        "public-mutation lease-release resolution time"),
      successorEventSha256: value.successorEventSha256 === null
        ? null
        : requiredDigest(value.successorEventSha256,
            "public-mutation lease-release successor event SHA-256")
    });
  }
  if (mode === "precondition-rejected") {
    assertEqual(value.attempted, false,
      "public-mutation rejected lease-release attempt");
    assertEqual(value.acknowledgement, "rejected",
      "public-mutation rejected lease-release acknowledgement");
  } else {
    assertEqual(value.attempted, "possibly",
      "public-mutation marker lease-release attempt");
    if (!["confirmed", "unknown"].includes(value.acknowledgement)) {
      throw new Error("The marker lease-release acknowledgement is invalid.");
    }
  }
  assertEqual(value.operationSha256, null,
    "public-mutation marker lease-release operation SHA-256");
  return deepFreeze({
    attempted: mode === "precondition-rejected" ? false : "possibly",
    acknowledgement: value.acknowledgement,
    attemptedAt: value.attemptedAt === null
      ? null
      : requiredRfc3339(value.attemptedAt,
          "public-mutation reconciled successor time"),
    operationSha256: null,
    reservation: assertMarkerAuthority(value.reservation),
    ...(mode === "precondition-rejected"
      ? { reservedAt: requiredRfc3339(value.reservedAt,
          "public-mutation lease reservation time") }
      : {}),
    resolvedAt: requiredRfc3339(value.resolvedAt,
      "public-mutation lease resolution time"),
    successorEventSha256: value.successorEventSha256 === null
      ? null
      : requiredDigest(value.successorEventSha256,
          "public-mutation lease successor event SHA-256")
  });
}

function assertNoMutation(value) {
  assertExactKeys(value, [
    "acknowledgement",
    "kind",
    "resultRecordedAt",
    "submitted",
    "submittedAt"
  ], "publication recovery no-op mutation result");
  assertDeepEqual(value, noMutation(), "public-mutation no-op result");
  return noMutation();
}

function assertNoLeaseRelease(value) {
  assertExactKeys(value, [
    "acknowledgement",
    "attempted",
    "attemptedAt",
    "operationSha256",
    "resolvedAt",
    "successorEventSha256"
  ], "publication recovery unattempted lease-release result");
  assertDeepEqual(value, noLeaseRelease(),
    "public-mutation unattempted lease-release result");
  return noLeaseRelease();
}

function assertMarkerAuthority(value) {
  assertExactKeys(value, ["attemptSha256", "authorizationSha256"],
    "publication recovery public-mutation marker authority");
  return deepFreeze({
    attemptSha256: requiredDigest(value.attemptSha256,
      "public-mutation result attempt SHA-256"),
    authorizationSha256: requiredDigest(value.authorizationSha256,
      "public-mutation result authorization SHA-256")
  });
}

function assertNullTransport(input) {
  assertEqual(input.transportOperation, null,
    "marker-only public-mutation transport operation");
  assertEqual(input.transportOperationSha256, null,
    "marker-only public-mutation transport operation SHA-256");
}

function markerAuthority(authorization) {
  return deepFreeze({
    attemptSha256: authorization.authority.sha256,
    authorizationSha256:
      electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256(
        authorization
      )
  });
}

function observationToCore(observation) {
  const classification = observation.observation.classification;
  return deepFreeze({
    classification,
    observedAt: observation.observedAt,
    stateSha256: observation.observation.snapshot?.stateSha256 ?? null
  });
}

function noMutation() {
  return deepFreeze({
    kind: "none",
    submitted: false,
    acknowledgement: null,
    submittedAt: null,
    resultRecordedAt: null
  });
}

function noLeaseRelease() {
  return deepFreeze({
    attempted: false,
    acknowledgement: null,
    attemptedAt: null,
    operationSha256: null,
    resolvedAt: null,
    successorEventSha256: null
  });
}

function requiredMode(value) {
  if (typeof value !== "string" || !MODES.has(value)) {
    throw new Error("The publication recovery public-mutation mode is invalid.");
  }
  return value;
}

function requiredOperation(value) {
  if (value !== "rollback-public-latest" && value !== "release-held-lease") {
    throw new Error("The publication recovery public-mutation operation is invalid.");
  }
  return value;
}

function requiredStorePath(value) {
  if (typeof value !== "string" || value.startsWith("/") ||
      value.split("/").some((segment) => segment === "" || segment === "." ||
        segment === "..")) {
    throw new Error("The public-mutation attempt path is invalid.");
  }
  return value;
}

function assertRunIdentity(value) {
  assertExactKeys(value, [
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "startedAt",
    "workflow"
  ], "publication recovery public-mutation current run");
  if (typeof value.runId !== "string" || !/^[1-9][0-9]*$/u.test(value.runId)) {
    throw new Error("The public-mutation current run ID is invalid.");
  }
  return deepFreeze({
    repository: requiredExactString(value.repository,
      "rion-tw/rion-studio-source", "current-run repository"),
    workflow: requiredExactString(
      value.workflow,
      ".github/workflows/electron-production-provisional-recovery.yml",
      "current-run workflow"
    ),
    runId: value.runId,
    runAttempt: requiredPositiveInteger(value.runAttempt,
      "public-mutation current run attempt"),
    controlSha: requiredCommitSha(value.controlSha,
      "public-mutation current run control SHA"),
    startedAt: requiredRfc3339(value.startedAt,
      "public-mutation current run start time")
  });
}

function requiredExactString(value, expected, label) {
  assertEqual(value, expected, `publication recovery ${label}`);
  return expected;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
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
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
