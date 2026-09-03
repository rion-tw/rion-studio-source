import {
  assertEqual,
  assertExactKeys,
  requiredDigest,
  requiredRfc3339
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export function assertRecoveryOutcomeProofMutation(value) {
  const possiblySubmitted = value?.submitted === "possibly";
  const markerRejected = value?.kind === "rollback" &&
    value?.submitted === false;
  assertExactKeys(value, [
    "acknowledgement",
    "kind",
    ...(possiblySubmitted || markerRejected
      ? ["reservation", "reservedAt"]
      : []),
    "resultRecordedAt",
    "submitted",
    "submittedAt"
  ], "publication recovery outcome proof mutation");
  if (value.kind === "none") {
    for (const [actual, expected, label] of [
      [value.submitted, false, "submission"],
      [value.acknowledgement, null, "acknowledgement"],
      [value.submittedAt, null, "submission time"],
      [value.resultRecordedAt, null, "result time"]
    ]) assertEqual(actual, expected,
      `publication recovery proof no-op mutation ${label}`);
    return deepFreeze({
      kind: "none",
      submitted: false,
      acknowledgement: null,
      submittedAt: null,
      resultRecordedAt: null
    });
  }
  assertEqual(value.kind, "rollback",
    "publication recovery proof mutation kind");
  if (markerRejected) {
    assertEqual(value.acknowledgement, "rejected",
      "publication recovery proof unsubmitted rollback acknowledgement");
    assertEqual(value.submittedAt, null,
      "publication recovery proof unsubmitted rollback time");
    const reservedAt = requiredRfc3339(
      value.reservedAt,
      "publication recovery proof rollback reservation time"
    );
    const resultRecordedAt = requiredRfc3339(
      value.resultRecordedAt,
      "publication recovery proof rollback precondition result time"
    );
    if (Date.parse(resultRecordedAt) < Date.parse(reservedAt)) {
      throw new Error(
        "The publication recovery proof rollback result precedes reservation."
      );
    }
    return deepFreeze({
      kind: "rollback",
      submitted: false,
      acknowledgement: "rejected",
      reservedAt,
      submittedAt: null,
      resultRecordedAt,
      reservation: assertProofMarkerAuthority(value.reservation, "rollback")
    });
  }
  if (possiblySubmitted) {
    assertEqual(value.acknowledgement, "unknown",
      "publication recovery proof possibly-submitted acknowledgement");
    assertEqual(value.submittedAt, null,
      "publication recovery proof possibly-submitted time");
    const reservedAt = requiredRfc3339(
      value.reservedAt,
      "publication recovery proof rollback reservation time"
    );
    const resultRecordedAt = requiredRfc3339(
      value.resultRecordedAt,
      "publication recovery proof rollback reservation result time"
    );
    if (Date.parse(resultRecordedAt) < Date.parse(reservedAt)) {
      throw new Error(
        "The publication recovery proof rollback result precedes reservation."
      );
    }
    return deepFreeze({
      kind: "rollback",
      submitted: "possibly",
      acknowledgement: "unknown",
      reservedAt,
      submittedAt: null,
      resultRecordedAt,
      reservation: assertProofMarkerAuthority(value.reservation, "rollback")
    });
  }
  assertEqual(value.submitted, true,
    "publication recovery proof rollback submission");
  if (!["confirmed", "rejected", "unknown"].includes(
    value.acknowledgement
  )) {
    throw new Error(
      "The publication recovery proof rollback acknowledgement is invalid."
    );
  }
  const submittedAt = requiredRfc3339(
    value.submittedAt,
    "publication recovery proof rollback submission time"
  );
  const resultRecordedAt = requiredRfc3339(
    value.resultRecordedAt,
    "publication recovery proof rollback result time"
  );
  if (Date.parse(resultRecordedAt) < Date.parse(submittedAt)) {
    throw new Error(
      "The publication recovery proof rollback result precedes submission."
    );
  }
  return deepFreeze({
    kind: "rollback",
    submitted: true,
    acknowledgement: value.acknowledgement,
    submittedAt,
    resultRecordedAt
  });
}

export function assertRecoveryOutcomeProofLeaseRelease(value) {
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
  ], "publication recovery outcome proof lease release");
  if (markerRejected) {
    for (const field of [
      "attemptedAt",
      "operationSha256",
      "successorEventSha256"
    ]) {
      assertEqual(value[field], null,
        `publication recovery proof rejected marker lease ${field}`);
    }
    const reservedAt = requiredRfc3339(
      value.reservedAt,
      "publication recovery proof lease reservation time"
    );
    const resolvedAt = requiredRfc3339(
      value.resolvedAt,
      "publication recovery proof lease precondition result time"
    );
    if (Date.parse(resolvedAt) < Date.parse(reservedAt)) {
      throw new Error(
        "The proof lease precondition result precedes its reservation."
      );
    }
    return deepFreeze({
      attempted: false,
      acknowledgement: "rejected",
      attemptedAt: null,
      operationSha256: null,
      reservation: assertProofMarkerAuthority(
        value.reservation,
        "lease release"
      ),
      reservedAt,
      resolvedAt,
      successorEventSha256: null
    });
  }
  if (value.attempted === false) {
    for (const field of [
      "acknowledgement",
      "attemptedAt",
      "operationSha256",
      "resolvedAt",
      "successorEventSha256"
    ]) {
      assertEqual(value[field], null,
        `publication recovery proof unattempted lease ${field}`);
    }
    return deepFreeze({
      attempted: false,
      acknowledgement: null,
      attemptedAt: null,
      operationSha256: null,
      resolvedAt: null,
      successorEventSha256: null
    });
  }
  if (markerReconciliation) {
    if (!["confirmed", "unknown"].includes(value.acknowledgement)) {
      throw new Error(
        "The publication recovery proof marker lease acknowledgement is invalid."
      );
    }
    assertEqual(value.operationSha256, null,
      "publication recovery proof marker transport operation SHA-256");
    const resolvedAt = requiredRfc3339(
      value.resolvedAt,
      "publication recovery proof marker lease resolution time"
    );
    if (value.acknowledgement === "unknown") {
      assertEqual(value.attemptedAt, null,
        "publication recovery proof unresolved marker attempt time");
      assertEqual(value.successorEventSha256, null,
        "publication recovery proof unresolved marker successor event");
      return deepFreeze({
        attempted: "possibly",
        acknowledgement: "unknown",
        attemptedAt: null,
        operationSha256: null,
        reservation: assertProofMarkerAuthority(
          value.reservation,
          "lease release"
        ),
        resolvedAt,
        successorEventSha256: null
      });
    }
    const attemptedAt = requiredRfc3339(
      value.attemptedAt,
      "publication recovery proof reconciled successor time"
    );
    if (Date.parse(resolvedAt) < Date.parse(attemptedAt)) {
      throw new Error(
        "The proof marker lease resolution precedes its successor event."
      );
    }
    return deepFreeze({
      attempted: "possibly",
      acknowledgement: "confirmed",
      attemptedAt,
      operationSha256: null,
      reservation: assertProofMarkerAuthority(
        value.reservation,
        "lease release"
      ),
      resolvedAt,
      successorEventSha256: requiredDigest(
        value.successorEventSha256,
        "publication recovery proof reconciled successor event SHA-256"
      )
    });
  }
  assertEqual(value.attempted, true,
    "publication recovery proof lease release attempted");
  if (!["confirmed", "rejected", "unknown"].includes(value.acknowledgement)) {
    throw new Error(
      "The publication recovery proof lease acknowledgement is invalid."
    );
  }
  const attemptedAt = requiredRfc3339(value.attemptedAt,
    "publication recovery proof lease attempt time");
  const resolvedAt = requiredRfc3339(value.resolvedAt,
    "publication recovery proof lease resolution time");
  if (Date.parse(resolvedAt) < Date.parse(attemptedAt)) {
    throw new Error("The proof lease resolution cannot precede its attempt.");
  }
  const successorEventSha256 = value.acknowledgement === "confirmed"
    ? requiredDigest(
        value.successorEventSha256,
        "publication recovery proof lease successor event SHA-256"
      )
    : value.successorEventSha256;
  if (value.acknowledgement !== "confirmed" && successorEventSha256 !== null) {
    throw new Error(
      "An unconfirmed publication recovery proof lease cannot claim a successor."
    );
  }
  return deepFreeze({
    attempted: true,
    acknowledgement: value.acknowledgement,
    attemptedAt,
    operationSha256: requiredDigest(
      value.operationSha256,
      "publication recovery proof lease operation SHA-256"
    ),
    resolvedAt,
    successorEventSha256
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

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
