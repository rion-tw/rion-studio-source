import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestRecoveryObservation,
  assertElectronProductionPublicLatestRecoveryObservationBindings,
  electronProductionPublicLatestRecoveryObservationSha256
} from "./electronProductionPublicLatestRecovery.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  serializeElectronProductionPublicLatestSnapshot
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256
} from "./electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
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
  assertTimeDoesNotPrecede,
  deepFreeze,
  gitBlobSha,
  requiredBranch,
  requiredFileName,
  requiredNonempty,
  requiredPositiveInteger,
  requiredRepository,
  requiredRepositoryPath,
  requiredUuid,
  sha256
} from "./electronProductionPublicationRecoveryPublicMutationAttemptValidation.mjs";
import {
  assertEqual,
  assertExactKeys,
  canonicalRegularFilePath,
  publicIdentity,
  readCanonicalJsonFile,
  requiredCommitSha,
  requiredDigest,
  requiredRfc3339,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_KIND =
  "rion-electron-production-publication-recovery-public-mutation-attempt";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_KIND =
  "rion-electron-production-publication-recovery-public-mutation-attempt-authorization";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_KIND =
  "rion-electron-production-publication-recovery-public-mutation-attempt-history";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE =
  "electron-production-publication-recovery-public-mutation-attempt-authorization.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE =
  "electron-production-publication-recovery-public-mutation-attempt-history.json";
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_BYTES =
  2 * 1024 * 1024;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_BYTES =
  32 * 1024 * 1024;
export const ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_HISTORY_BYTES =
  1024 * 1024;

const OPERATIONS = new Set([
  "rollback-public-latest",
  "release-held-lease"
]);

export function electronProductionPublicationRecoveryPublicMutationAttemptFileName(
  input
) {
  assertExactKeys(input, ["previousOutcomeSha256"],
    "publication recovery public-mutation attempt filename input");
  const predecessor = input.previousOutcomeSha256 === null
    ? "genesis"
    : requiredDigest(
        input.previousOutcomeSha256,
        "publication recovery public-mutation predecessor SHA-256"
      );
  return `electron-production-public-latest-mutation-attempt-${predecessor}.json`;
}

export function electronProductionPublicationRecoveryPublicMutationAttemptPath(
  input
) {
  assertExactKeys(input, [
    "previousOutcomeSha256",
    "transactionId"
  ], "publication recovery public-mutation attempt path input");
  const paths = electronProductionRecoveryStoreTransactionPaths({
    transactionId: input.transactionId
  });
  const transactionRoot = path.posix.dirname(
    path.posix.dirname(paths.recoveryOutcomeTerminalPath)
  );
  return path.posix.join(
    transactionRoot,
    "public-mutation-attempts",
    electronProductionPublicationRecoveryPublicMutationAttemptFileName({
      previousOutcomeSha256: input.previousOutcomeSha256
    })
  );
}

export function createElectronProductionPublicationRecoveryPublicMutationAttempt(
  input
) {
  assertExactKeys(input, [
    "authorization",
    "authorizationSha256",
    "operation",
    "publicObservation",
    "publicObservationSha256",
    "reservedAt",
    "sourceSnapshot",
    "targetSnapshot"
  ], "publication recovery public-mutation attempt input");
  const authorization =
    assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
      input.authorization
    );
  const authorizationSha256 = requiredDigest(
    input.authorizationSha256,
    "publication recovery public-mutation base authorization SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
      authorization
    ),
    authorizationSha256,
    "publication recovery public-mutation base authorization SHA-256"
  );
  const operation = assertOperation(input.operation);
  const reservedAt = requiredRfc3339(
    input.reservedAt,
    "publication recovery public-mutation reservation time"
  );
  assertTimeDoesNotPrecede(
    reservedAt,
    authorization.verifiedAt,
    "A public-mutation reservation cannot precede its base authorization."
  );
  const sourceSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.sourceSnapshot
  );
  const targetSnapshot = assertElectronProductionPublicLatestSnapshot(
    input.targetSnapshot
  );
  const intent = authorization.authority.intent;
  assertEqual(
    sha256(serializeElectronProductionPublicLatestSnapshot(sourceSnapshot)),
    intent.foundation.sourceSnapshotSha256,
    "publication recovery public-mutation source snapshot SHA-256"
  );
  assertEqual(
    sha256(serializeElectronProductionPublicLatestSnapshot(targetSnapshot)),
    intent.foundation.targetSnapshotSha256,
    "publication recovery public-mutation target snapshot SHA-256"
  );
  const publicObservation =
    assertElectronProductionPublicLatestRecoveryObservationBindings({
      observation: input.publicObservation,
      sourceSnapshot,
      sourceSnapshotFileSha256: intent.foundation.sourceSnapshotSha256,
      targetSnapshot,
      targetSnapshotFileSha256: intent.foundation.targetSnapshotSha256
    });
  const publicObservationSha256 = requiredDigest(
    input.publicObservationSha256,
    "publication recovery public-mutation observation SHA-256"
  );
  assertEqual(
    electronProductionPublicLatestRecoveryObservationSha256(publicObservation),
    publicObservationSha256,
    "publication recovery public-mutation observation SHA-256"
  );
  const requiredObservation = operation === "rollback-public-latest"
    ? "target"
    : "source";
  if (publicObservation.transport.outcome !== "observed" ||
      publicObservation.observation.classification !== requiredObservation) {
    throw new Error(
      `A ${operation} marker requires a fresh exact ${requiredObservation} observation.`
    );
  }
  assertTimeDoesNotPrecede(
    reservedAt,
    publicObservation.observedAt,
    "A public-mutation reservation cannot precede its bound observation."
  );
  const proof = authorization.evidence.freshChainProof.receipt;
  if (proof.status === "terminal") {
    throw new Error("A terminal recovery chain cannot reserve public mutation.");
  }
  assertMutationEligibility(operation, proof);
  const previousOutcomeSha256 = proof.latestOutcome?.sha256 ?? null;
  const attemptPath =
    electronProductionPublicationRecoveryPublicMutationAttemptPath({
      transactionId: authorization.transactionId,
      previousOutcomeSha256
    });
  return assertElectronProductionPublicationRecoveryPublicMutationAttempt({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_KIND,
    status: "durable-one-shot-public-mutation-reservation",
    transactionId: authorization.transactionId,
    operation,
    reservedAt,
    currentRun: authorization.currentRun,
    authority: {
      authorizationSha256,
      intentSha256: authorization.authority.sha256,
      chainProofSha256: authorization.evidence.freshChainProof.sha256,
      heldLease: intent.heldLease,
      foundation: {
        storeSealSha256: intent.foundation.storeSealSha256,
        sourceSnapshotSha256: intent.foundation.sourceSnapshotSha256,
        targetSnapshotSha256: intent.foundation.targetSnapshotSha256
      },
      predecessor: proof.latestOutcome === null
        ? null
        : {
            path: proof.latestOutcome.path,
            fileName: proof.latestOutcome.fileName,
            sha256: proof.latestOutcome.sha256,
            bytes: proof.latestOutcome.bytes,
            blobSha: proof.latestOutcome.blobSha,
            determinedAt: proof.latestOutcome.determinedAt
          }
    },
    privateStore: {
      target: intent.privateStore.target,
      path: attemptPath,
      expectedHeadCommitSha: proof.currentObservation.headCommitSha
    },
    publicMutation: {
      observation: {
        kind: publicObservation.kind,
        receipt: publicObservation,
        sha256: publicObservationSha256,
        observedAt: publicObservation.observedAt,
        classification: publicObservation.observation.classification,
        stateSha256: publicObservation.observation.snapshot.stateSha256
      },
      requiredBeforeObservation:
        operation === "rollback-public-latest" ? "target" : "source",
      requiredAfterObservation: "source",
      source: {
        releaseId: sourceSnapshot.release.id,
        releaseTag: sourceSnapshot.release.tag,
        stateSha256: sourceSnapshot.stateSha256
      },
      target: {
        releaseId: targetSnapshot.release.id,
        releaseTag: targetSnapshot.release.tag,
        stateSha256: targetSnapshot.stateSha256
      }
    }
  });
}

export function assertElectronProductionPublicationRecoveryPublicMutationAttempt(
  value
) {
  assertExactKeys(value, [
    "authority",
    "currentRun",
    "kind",
    "operation",
    "privateStore",
    "publicMutation",
    "reservedAt",
    "schemaVersion",
    "status",
    "transactionId"
  ], "publication recovery public-mutation attempt");
  assertEqual(value.schemaVersion, 1,
    "publication recovery public-mutation attempt schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_KIND,
    "publication recovery public-mutation attempt kind"
  );
  assertEqual(
    value.status,
    "durable-one-shot-public-mutation-reservation",
    "publication recovery public-mutation attempt status"
  );
  const operation = assertOperation(value.operation);
  const transactionId = requiredUuid(
    value.transactionId,
    "publication recovery public-mutation transaction ID"
  );
  const currentRun = assertRun(value.currentRun);
  const reservedAt = requiredRfc3339(
    value.reservedAt,
    "publication recovery public-mutation reservation time"
  );
  assertTimeDoesNotPrecede(
    reservedAt,
    currentRun.startedAt,
    "A public-mutation reservation cannot precede its current run."
  );
  const authority = assertAuthority(value.authority, transactionId);
  const privateStore = assertPrivateStore(
    value.privateStore,
    transactionId,
    authority.predecessor?.sha256 ?? null
  );
  const publicMutation = assertPublicMutation(
    value.publicMutation,
    operation,
    authority
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_KIND,
    status: "durable-one-shot-public-mutation-reservation",
    transactionId,
    operation,
    reservedAt,
    currentRun,
    authority,
    privateStore,
    publicMutation
  });
}

export function createElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input
) {
  assertExactKeys(input, [
    "attemptBlobSha",
    "attemptCommitSha",
    "attemptTreeSha",
    "currentObservation",
    "initialHeadCommitSha",
    "observedAt",
    "path",
    "pathHistory",
    "target"
  ], "publication recovery public-mutation attempt history input");
  return assertElectronProductionPublicationRecoveryPublicMutationAttemptHistory({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_KIND,
    status: "verified-exact-create-and-reachable-path-history",
    target: input.target,
    path: input.path,
    initialHeadCommitSha: input.initialHeadCommitSha,
    attemptCommit: {
      commitSha: input.attemptCommitSha,
      treeSha: input.attemptTreeSha,
      parentCommitSha: input.initialHeadCommitSha,
      blobSha: input.attemptBlobSha
    },
    currentObservation: input.currentObservation,
    pathHistory: input.pathHistory,
    observedAt: input.observedAt
  });
}

export function assertElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  value
) {
  assertExactKeys(value, [
    "attemptCommit",
    "currentObservation",
    "initialHeadCommitSha",
    "kind",
    "observedAt",
    "path",
    "pathHistory",
    "schemaVersion",
    "status",
    "target"
  ], "publication recovery public-mutation attempt history");
  assertEqual(value.schemaVersion, 1,
    "publication recovery public-mutation history schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_KIND,
    "publication recovery public-mutation history kind"
  );
  assertEqual(value.status, "verified-exact-create-and-reachable-path-history",
    "publication recovery public-mutation history status");
  const target = assertTarget(value.target);
  const attemptPath = requiredRepositoryPath(
    value.path,
    "publication recovery public-mutation history path"
  );
  const initialHeadCommitSha = requiredCommitSha(
    value.initialHeadCommitSha,
    "publication recovery public-mutation history initial head"
  );
  assertExactKeys(value.attemptCommit, [
    "blobSha",
    "commitSha",
    "parentCommitSha",
    "treeSha"
  ], "publication recovery public-mutation history create commit");
  const attemptCommit = deepFreeze({
    commitSha: requiredCommitSha(value.attemptCommit.commitSha,
      "publication recovery public-mutation create commit SHA"),
    treeSha: requiredCommitSha(value.attemptCommit.treeSha,
      "publication recovery public-mutation create tree SHA"),
    parentCommitSha: requiredCommitSha(value.attemptCommit.parentCommitSha,
      "publication recovery public-mutation create parent SHA"),
    blobSha: requiredCommitSha(value.attemptCommit.blobSha,
      "publication recovery public-mutation create blob SHA")
  });
  assertEqual(attemptCommit.parentCommitSha, initialHeadCommitSha,
    "publication recovery public-mutation history create parent");
  const currentObservation = assertCurrentObservation(value.currentObservation);
  assertExactKeys(value.pathHistory, [
    "commitSha",
    "nextPage",
    "reachableFromHeadCommitSha",
    "resultCount"
  ], "publication recovery public-mutation fixed-path history");
  assertEqual(value.pathHistory.resultCount, 1,
    "publication recovery public-mutation path-history result count");
  assertEqual(value.pathHistory.nextPage, false,
    "publication recovery public-mutation path-history pagination");
  assertEqual(value.pathHistory.commitSha, attemptCommit.commitSha,
    "publication recovery public-mutation path-history commit");
  assertEqual(
    value.pathHistory.reachableFromHeadCommitSha,
    currentObservation.headCommitSha,
    "publication recovery public-mutation reachable head"
  );
  return deepFreeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_KIND,
    status: "verified-exact-create-and-reachable-path-history",
    target,
    path: attemptPath,
    initialHeadCommitSha,
    attemptCommit,
    currentObservation,
    pathHistory: {
      reachableFromHeadCommitSha: requiredCommitSha(
        value.pathHistory.reachableFromHeadCommitSha,
        "publication recovery public-mutation reachable head"
      ),
      commitSha: requiredCommitSha(
        value.pathHistory.commitSha,
        "publication recovery public-mutation path-history commit"
      ),
      resultCount: 1,
      nextPage: false
    },
    observedAt: requiredRfc3339(
      value.observedAt,
      "publication recovery public-mutation history observation time"
    )
  });
}

export function createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  input
) {
  assertExactKeys(input, [
    "attempt",
    "attemptHistoryProof",
    "attemptHistoryProofSha256",
    "attemptReadOperation",
    "attemptReadOperationSha256",
    "attemptSha256",
    "createOperation",
    "createOperationSha256",
    "postMarkerAuthorization",
    "postMarkerAuthorizationSha256",
    "preMarkerAuthorization",
    "preMarkerAuthorizationSha256",
    "verifiedAt"
  ], "publication recovery public-mutation attempt authorization input");
  return buildAttemptAuthorization(input);
}

function buildAttemptAuthorization(input) {
  const attempt =
    assertElectronProductionPublicationRecoveryPublicMutationAttempt(
      input.attempt
    );
  const attemptSource =
    serializeElectronProductionPublicationRecoveryPublicMutationAttempt(attempt);
  const attemptSha256 = requiredDigest(
    input.attemptSha256,
    "publication recovery public-mutation attempt SHA-256"
  );
  assertEqual(sha256(attemptSource), attemptSha256,
    "publication recovery public-mutation attempt SHA-256");
  const postAuthorization = assertBaseAuthorization(
    input.postMarkerAuthorization,
    input.postMarkerAuthorizationSha256,
    "post-marker"
  );
  const target = remoteTarget(
    attempt.privateStore.target,
    attempt.privateStore.path
  );
  const createEvidence = verifyOptionalCreateOperation({
    attempt,
    attemptSha256,
    attemptSource,
    createOperation: input.createOperation,
    createOperationSha256: input.createOperationSha256,
    target
  });
  const preAuthorization = createEvidence === null
    ? assertAbsentPreMarkerAuthorization(input)
    : assertRequiredPreMarkerAuthorization(input, attempt);
  assertAttemptMatchesFreshAuthorization(attempt, postAuthorization.value);
  if (preAuthorization !== null) {
    assertEqual(postAuthorization.value.authority.sha256,
      preAuthorization.value.authority.sha256,
      "publication recovery public-mutation fixed intent SHA-256");
    if (!isDeepStrictEqual(
      postAuthorization.value.authority.intent,
      preAuthorization.value.authority.intent
    )) {
      throw new Error("The public-mutation marker changed its fixed intent.");
    }
  }
  const readRequest = createElectronProductionRecoveryStoreRemoteReadRequest({
    expectedContent: {
      byteLength: attemptSource.length,
      sha256: attemptSha256
    },
    target
  });
  const readOperation =
    verifyElectronProductionRecoveryStoreRemoteReadOperationRequest({
      receipt: input.attemptReadOperation,
      request: readRequest
    });
  const readOperationSha256 = requiredDigest(
    input.attemptReadOperationSha256,
    "publication recovery public-mutation read-operation SHA-256"
  );
  assertEqual(
    electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(
      readOperation
    ),
    readOperationSha256,
    "publication recovery public-mutation read-operation SHA-256"
  );
  if (readOperation.terminal.classification !== "present" ||
      readOperation.observed === null) {
    throw new Error("The durable public-mutation marker readback is not present.");
  }
  const observed = readOperation.observed;
  assertEqual(observed.blobSha, gitBlobSha(attemptSource),
    "publication recovery public-mutation marker blob SHA");
  const historyEvidence = verifyOptionalHistory({
    attempt,
    attemptHistoryProof: input.attemptHistoryProof,
    attemptHistoryProofSha256: input.attemptHistoryProofSha256,
    attemptSource,
    createEvidence,
    currentObservation: currentObservationFromRead(observed)
  });
  if (createEvidence !== null) {
    if (!isDeepStrictEqual(
      postAuthorization.value.currentRun,
      attempt.currentRun
    )) {
      throw new Error(
        "A newly-created public-mutation marker must use its creating run."
      );
    }
    assertSingleCreateTransition(attempt, createEvidence.receipt.applied, observed);
  }
  assertPostMarkerAuthorization({
    attempt,
    observed,
    postAuthorization: postAuthorization.value,
    preAuthorization: preAuthorization?.value ?? null
  });
  const verifiedAt = requiredRfc3339(
    input.verifiedAt,
    "publication recovery public-mutation authorization verification time"
  );
  assertTimeDoesNotPrecede(
    verifiedAt,
    attempt.reservedAt,
    "A public-mutation marker authorization cannot precede its reservation."
  );
  assertTimeDoesNotPrecede(
    verifiedAt,
    postAuthorization.value.verifiedAt,
    "A public-mutation marker authorization cannot precede post-marker proof."
  );
  if (historyEvidence !== null) assertTimeDoesNotPrecede(
    verifiedAt,
    historyEvidence.receipt.observedAt,
    "A resumed marker authorization cannot precede its history proof."
  );
  return deepFreeze({
    schemaVersion: 1,
    kind:
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_KIND,
    status: "verified-durable-one-shot-public-mutation-authority",
    transactionId: attempt.transactionId,
    operation: attempt.operation,
    currentRun: postAuthorization.value.currentRun,
    authority: { attempt, sha256: attemptSha256 },
    evidence: {
      preMarkerAuthorization: preAuthorization,
      createOperation: createEvidence,
      attemptHistoryProof: historyEvidence,
      attemptReadOperation: {
        receipt: readOperation,
        sha256: readOperationSha256
      },
      postMarkerAuthorization: postAuthorization
    },
    headTransition: {
      mode: createEvidence === null ? "resumed-existing" : "created-now",
      initialHeadCommitSha: attempt.privateStore.expectedHeadCommitSha,
      currentHeadCommitSha: observed.headCommitSha,
      attemptCommitSha: createEvidence?.receipt.applied.commitSha ?? null,
      treeSha: observed.treeSha,
      parentCommitShas: observed.parentCommitShas,
      attemptBlobSha: observed.blobSha
    },
    verifiedAt
  });
}

export function assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  value
) {
  assertExactKeys(value, [
    "authority",
    "currentRun",
    "evidence",
    "headTransition",
    "kind",
    "operation",
    "schemaVersion",
    "status",
    "transactionId",
    "verifiedAt"
  ], "publication recovery public-mutation attempt authorization");
  assertEqual(value.schemaVersion, 1,
    "publication recovery public-mutation authorization schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_KIND,
    "publication recovery public-mutation authorization kind"
  );
  assertEqual(
    value.status,
    "verified-durable-one-shot-public-mutation-authority",
    "publication recovery public-mutation authorization status"
  );
  assertExactKeys(value.authority, ["attempt", "sha256"],
    "publication recovery public-mutation authorization authority");
  assertExactKeys(value.evidence, [
    "attemptHistoryProof",
    "attemptReadOperation",
    "createOperation",
    "postMarkerAuthorization",
    "preMarkerAuthorization"
  ], "publication recovery public-mutation authorization evidence");
  if (value.evidence.preMarkerAuthorization !== null) {
    assertExactKeys(value.evidence.preMarkerAuthorization, ["sha256", "value"],
      "publication recovery pre-marker authorization");
  }
  assertExactKeys(value.evidence.postMarkerAuthorization, ["sha256", "value"],
    "publication recovery post-marker authorization");
  assertExactKeys(value.evidence.attemptReadOperation, ["receipt", "sha256"],
    "publication recovery marker read operation");
  if (value.evidence.createOperation !== null) {
    assertExactKeys(value.evidence.createOperation, ["receipt", "sha256"],
      "publication recovery marker create operation");
  }
  if (value.evidence.attemptHistoryProof !== null) {
    assertExactKeys(value.evidence.attemptHistoryProof, ["receipt", "sha256"],
      "publication recovery marker history proof");
  }
  const rebuilt = buildAttemptAuthorization({
    attempt: value.authority.attempt,
    attemptSha256: value.authority.sha256,
    preMarkerAuthorization:
      value.evidence.preMarkerAuthorization?.value ?? null,
    preMarkerAuthorizationSha256:
      value.evidence.preMarkerAuthorization?.sha256 ?? null,
    createOperation: value.evidence.createOperation?.receipt ?? null,
    createOperationSha256: value.evidence.createOperation?.sha256 ?? null,
    attemptHistoryProof:
      value.evidence.attemptHistoryProof?.receipt ?? null,
    attemptHistoryProofSha256:
      value.evidence.attemptHistoryProof?.sha256 ?? null,
    attemptReadOperation: value.evidence.attemptReadOperation.receipt,
    attemptReadOperationSha256: value.evidence.attemptReadOperation.sha256,
    postMarkerAuthorization: value.evidence.postMarkerAuthorization.value,
    postMarkerAuthorizationSha256:
      value.evidence.postMarkerAuthorization.sha256,
    verifiedAt: value.verifiedAt
  });
  assertEqual(value.transactionId, rebuilt.transactionId,
    "publication recovery public-mutation authorization transaction ID");
  assertEqual(value.operation, rebuilt.operation,
    "publication recovery public-mutation authorization operation");
  if (!isDeepStrictEqual(value.currentRun, rebuilt.currentRun) ||
      !isDeepStrictEqual(value.headTransition, rebuilt.headTransition)) {
    throw new Error(
      "The publication recovery public-mutation authorization projection changed."
    );
  }
  return rebuilt;
}

export function serializeElectronProductionPublicationRecoveryPublicMutationAttempt(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryPublicMutationAttempt(value)
  );
}

export function serializeElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryPublicMutationAttemptHistory(value)
  );
}

export function serializeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  value
) {
  return serializeCanonicalJson(
    assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
      value
    )
  );
}

export function electronProductionPublicationRecoveryPublicMutationAttemptSha256(
  value
) {
  return sha256(
    serializeElectronProductionPublicationRecoveryPublicMutationAttempt(value)
  );
}

export function electronProductionPublicationRecoveryPublicMutationAttemptHistorySha256(
  value
) {
  return sha256(
    serializeElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
      value
    )
  );
}

export function electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256(
  value
) {
  return sha256(
    serializeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
      value
    )
  );
}

export async function writeElectronProductionPublicationRecoveryPublicMutationAttempt(
  input
) {
  return writeContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_BYTES,
    electronProductionPublicationRecoveryPublicMutationAttemptFileName({
      previousOutcomeSha256:
        input.value.authority.predecessor?.sha256 ?? null
    }),
    "publication recovery public-mutation attempt",
    assertElectronProductionPublicationRecoveryPublicMutationAttempt
  );
}

export async function readElectronProductionPublicationRecoveryPublicMutationAttempt(
  input
) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    "publication recovery public-mutation attempt read input");
  return readContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_BYTES,
    path.basename(input.receiptPath),
    "publication recovery public-mutation attempt",
    assertElectronProductionPublicationRecoveryPublicMutationAttempt
  );
}

export async function writeElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input
) {
  return writeContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_HISTORY_BYTES,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE,
    "publication recovery public-mutation attempt history",
    assertElectronProductionPublicationRecoveryPublicMutationAttemptHistory
  );
}

export async function readElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
  input
) {
  return readContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_HISTORY_BYTES,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_HISTORY_FILE,
    "publication recovery public-mutation attempt history",
    assertElectronProductionPublicationRecoveryPublicMutationAttemptHistory
  );
}

export async function writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  input
) {
  return writeContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_BYTES,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE,
    "publication recovery public-mutation attempt authorization",
    assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
  );
}

export async function readElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
  input
) {
  return readContract(
    input,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_MAX_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_BYTES,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_ATTEMPT_AUTHORIZATION_FILE,
    "publication recovery public-mutation attempt authorization",
    assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
  );
}

function assertMutationEligibility(operation, proof) {
  if (proof.outcomes.some((outcome) =>
    outcome.leaseRelease.acknowledgement === "unknown"
  )) {
    throw new Error(
      "A historically unknown lease release forbids every public mutation."
    );
  }
  if (operation === "rollback-public-latest") {
    const historicalRollback = proof.outcomes.filter((outcome) =>
      outcome.mutation.kind === "rollback"
    );
    if (historicalRollback.some((outcome) =>
      outcome.mutation.acknowledgement === "unknown"
    )) {
      throw new Error(
        "A historically unknown rollback permanently forbids another PATCH."
      );
    }
    if (historicalRollback.some((outcome) =>
      outcome.mutation.acknowledgement === "confirmed"
    )) {
      throw new Error(
        "A confirmed rollback permanently forbids another rollback PATCH."
      );
    }
    const latest = proof.latestOutcome;
    if (latest !== null && !(
      latest.mutation.kind === "none" ||
      (latest.mutation.kind === "rollback" &&
        latest.mutation.acknowledgement === "rejected")
    )) {
      throw new Error(
        "A rollback marker requires genesis, pure observation, or rejected rollback."
      );
    }
    return;
  }
}

function assertAttemptMatchesAuthorization(attempt, authorization) {
  const proof = authorization.evidence.freshChainProof;
  assertEqual(
    attempt.authority.authorizationSha256,
    electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
      authorization
    ),
    "publication recovery public-mutation creator authorization SHA-256"
  );
  assertEqual(attempt.authority.chainProofSha256, proof.sha256,
    "publication recovery public-mutation creator chain proof SHA-256");
  assertEqual(
    attempt.privateStore.expectedHeadCommitSha,
    proof.receipt.currentObservation.headCommitSha,
    "publication recovery public-mutation creator expected head"
  );
  assertAttemptMatchesFreshAuthorization(attempt, authorization);
  if (!isDeepStrictEqual(attempt.currentRun, authorization.currentRun)) {
    throw new Error("The public-mutation marker creator run changed.");
  }
}

function assertAttemptMatchesFreshAuthorization(attempt, authorization) {
  const intent = authorization.authority.intent;
  const proof = authorization.evidence.freshChainProof.receipt;
  for (const [actual, expected, label] of [
    [attempt.transactionId, authorization.transactionId, "transaction ID"],
    [attempt.authority.intentSha256, authorization.authority.sha256,
      "intent SHA-256"],
    [attempt.authority.heldLease.eventSha256,
      intent.heldLease.eventSha256, "held event SHA-256"],
    [attempt.authority.heldLease.fileSha256,
      intent.heldLease.fileSha256, "held file SHA-256"],
    [attempt.authority.heldLease.leaseId,
      intent.heldLease.leaseId, "lease ID"],
    [attempt.authority.heldLease.generation,
      intent.heldLease.generation, "lease generation"],
    [attempt.authority.heldLease.revision,
      intent.heldLease.revision, "held revision"],
    [attempt.authority.heldLease.sourceStateSha256,
      intent.heldLease.sourceStateSha256, "held source state SHA-256"],
    [attempt.authority.heldLease.targetStateSha256,
      intent.heldLease.targetStateSha256, "held target state SHA-256"],
    [attempt.authority.foundation.storeSealSha256,
      intent.foundation.storeSealSha256, "store-seal SHA-256"],
    [attempt.authority.foundation.sourceSnapshotSha256,
      intent.foundation.sourceSnapshotSha256, "source snapshot SHA-256"],
    [attempt.authority.foundation.targetSnapshotSha256,
      intent.foundation.targetSnapshotSha256, "target snapshot SHA-256"],
    [attempt.authority.predecessor?.sha256 ?? null,
      proof.latestOutcome?.sha256 ?? null, "predecessor SHA-256"]
  ]) assertEqual(actual, expected,
    `publication recovery public-mutation ${label}`);
  const latest = proof.latestOutcome === null
    ? null
    : {
        path: proof.latestOutcome.path,
        fileName: proof.latestOutcome.fileName,
        sha256: proof.latestOutcome.sha256,
        bytes: proof.latestOutcome.bytes,
        blobSha: proof.latestOutcome.blobSha,
        determinedAt: proof.latestOutcome.determinedAt
      };
  if (!isDeepStrictEqual(attempt.authority.predecessor, latest) ||
      !isDeepStrictEqual(attempt.privateStore.target, proof.target) ||
      !isDeepStrictEqual(attempt.privateStore.target, intent.privateStore.target)) {
    throw new Error(
      "The public-mutation marker predecessor or private target changed."
    );
  }
}

function assertPostMarkerAuthorization(input) {
  const postProof = input.postAuthorization.evidence.freshChainProof.receipt;
  if (input.preAuthorization !== null && !isDeepStrictEqual(
    chainContent(input.preAuthorization.evidence.freshChainProof.receipt),
    chainContent(postProof)
  )) {
    throw new Error(
      "The recovery outcome chain changed while creating its mutation marker."
    );
  }
  const observed = currentObservationFromRead(input.observed);
  if (!isDeepStrictEqual(postProof.currentObservation, observed)) {
    throw new Error(
      "The post-marker recovery chain is not at the marker readback head."
    );
  }
  assertEqual(
    input.postAuthorization.headTransition.currentHeadCommitSha,
    observed.headCommitSha,
    "publication recovery post-marker authorization head"
  );
  assertEqual(
    input.attempt.authority.predecessor?.sha256 ?? null,
    postProof.latestOutcome?.sha256 ?? null,
    "publication recovery post-marker predecessor SHA-256"
  );
}

function assertAbsentPreMarkerAuthorization(input) {
  if (input.preMarkerAuthorization !== null ||
      input.preMarkerAuthorizationSha256 !== null) {
    throw new Error(
      "A resumed public-mutation marker cannot depend on creator artifacts."
    );
  }
  return null;
}

function assertRequiredPreMarkerAuthorization(input, attempt) {
  if (input.preMarkerAuthorization === null ||
      input.preMarkerAuthorizationSha256 === null) {
    throw new Error(
      "A newly-created public-mutation marker requires its base authorization."
    );
  }
  const authorization = assertBaseAuthorization(
    input.preMarkerAuthorization,
    input.preMarkerAuthorizationSha256,
    "pre-marker"
  );
  assertAttemptMatchesAuthorization(attempt, authorization.value);
  return authorization;
}

function verifyOptionalCreateOperation(input) {
  if (input.createOperation === null || input.createOperationSha256 === null) {
    if (input.createOperation !== null || input.createOperationSha256 !== null) {
      throw new Error(
        "The marker create operation and digest must both be present or absent."
      );
    }
    return null;
  }
  const request = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: input.attempt.privateStore.expectedHeadCommitSha,
    packageIdentity: {
      fileName: path.posix.basename(input.attempt.privateStore.path),
      byteLength: input.attemptSource.length,
      sha256: input.attemptSha256
    },
    target: input.target
  });
  const receipt = verifyElectronProductionRecoveryStoreRemoteOperationRequest({
    receipt: input.createOperation,
    request
  });
  const receiptSha256 = requiredDigest(
    input.createOperationSha256,
    "publication recovery public-mutation create-operation SHA-256"
  );
  assertEqual(
    electronProductionRecoveryStoreRemoteOperationReceiptSha256(receipt),
    receiptSha256,
    "publication recovery public-mutation create-operation SHA-256"
  );
  if (receipt.terminal.classification !== "applied" || receipt.applied === null) {
    throw new Error("The public-mutation marker create operation was not applied.");
  }
  assertEqual(receipt.applied.blobSha, gitBlobSha(input.attemptSource),
    "publication recovery public-mutation applied blob SHA");
  return deepFreeze({ receipt, sha256: receiptSha256 });
}

function verifyOptionalHistory(input) {
  if (input.createEvidence !== null) {
    if (input.attemptHistoryProof !== null ||
        input.attemptHistoryProofSha256 !== null) {
      throw new Error("A newly-created marker cannot also use resume history.");
    }
    return null;
  }
  if (input.attemptHistoryProof === null ||
      input.attemptHistoryProofSha256 === null) {
    throw new Error("An existing marker requires durable Git history proof.");
  }
  const receipt =
    assertElectronProductionPublicationRecoveryPublicMutationAttemptHistory(
      input.attemptHistoryProof
    );
  const sha = requiredDigest(
    input.attemptHistoryProofSha256,
    "publication recovery public-mutation history SHA-256"
  );
  assertEqual(
    electronProductionPublicationRecoveryPublicMutationAttemptHistorySha256(
      receipt
    ),
    sha,
    "publication recovery public-mutation history SHA-256"
  );
  for (const [actual, expected, label] of [
    [receipt.target.repository, input.attempt.privateStore.target.repository,
      "repository"],
    [receipt.target.ref, input.attempt.privateStore.target.ref, "ref"],
    [receipt.path, input.attempt.privateStore.path, "path"],
    [receipt.initialHeadCommitSha,
      input.attempt.privateStore.expectedHeadCommitSha, "initial head"],
    [receipt.attemptCommit.blobSha, gitBlobSha(input.attemptSource),
      "marker blob"]
  ]) assertEqual(actual, expected,
    `publication recovery public-mutation history ${label}`);
  if (!isDeepStrictEqual(
    receipt.currentObservation,
    input.currentObservation
  )) {
    throw new Error("The public-mutation marker history is stale.");
  }
  return deepFreeze({ receipt, sha256: sha });
}

function assertSingleCreateTransition(attempt, applied, observed) {
  for (const [actual, expected, label] of [
    [applied.parentCommitSha, attempt.privateStore.expectedHeadCommitSha,
      "create parent"],
    [applied.commitSha, observed.headCommitSha, "readback head"],
    [applied.treeSha, observed.treeSha, "readback tree"],
    [applied.blobSha, observed.blobSha, "readback blob"],
    [observed.parentCommitShas.length, 1, "readback parent count"],
    [observed.parentCommitShas[0], applied.parentCommitSha,
      "readback parent"]
  ]) assertEqual(actual, expected,
    `publication recovery public-mutation ${label}`);
}

function assertBaseAuthorization(value, shaValue, label) {
  const authorization =
    assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization(value);
  const sha = requiredDigest(
    shaValue,
    `publication recovery ${label} authorization SHA-256`
  );
  assertEqual(
    electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
      authorization
    ),
    sha,
    `publication recovery ${label} authorization SHA-256`
  );
  return deepFreeze({ value: authorization, sha256: sha });
}

function assertAuthority(value, transactionId) {
  assertExactKeys(value, [
    "authorizationSha256",
    "chainProofSha256",
    "foundation",
    "heldLease",
    "intentSha256",
    "predecessor"
  ], "publication recovery public-mutation authority");
  assertExactKeys(value.heldLease, [
    "eventSha256",
    "fileSha256",
    "generation",
    "leaseId",
    "revision",
    "sourceStateSha256",
    "targetStateSha256"
  ], "publication recovery public-mutation held lease");
  assertExactKeys(value.foundation, [
    "sourceSnapshotSha256",
    "storeSealSha256",
    "targetSnapshotSha256"
  ], "publication recovery public-mutation foundation");
  const predecessor = value.predecessor === null
    ? null
    : assertPredecessor(value.predecessor, transactionId);
  return deepFreeze({
    authorizationSha256: requiredDigest(value.authorizationSha256,
      "publication recovery public-mutation authorization SHA-256"),
    intentSha256: requiredDigest(value.intentSha256,
      "publication recovery public-mutation intent SHA-256"),
    chainProofSha256: requiredDigest(value.chainProofSha256,
      "publication recovery public-mutation chain proof SHA-256"),
    heldLease: {
      leaseId: requiredUuid(value.heldLease.leaseId,
        "publication recovery public-mutation lease ID"),
      generation: requiredPositiveInteger(value.heldLease.generation,
        "publication recovery public-mutation lease generation"),
      revision: requiredPositiveInteger(value.heldLease.revision,
        "publication recovery public-mutation held revision"),
      eventSha256: requiredDigest(value.heldLease.eventSha256,
        "publication recovery public-mutation held event SHA-256"),
      fileSha256: requiredDigest(value.heldLease.fileSha256,
        "publication recovery public-mutation held file SHA-256"),
      sourceStateSha256: requiredDigest(value.heldLease.sourceStateSha256,
        "publication recovery public-mutation source state SHA-256"),
      targetStateSha256: requiredDigest(value.heldLease.targetStateSha256,
        "publication recovery public-mutation target state SHA-256")
    },
    foundation: {
      storeSealSha256: requiredDigest(value.foundation.storeSealSha256,
        "publication recovery public-mutation store-seal SHA-256"),
      sourceSnapshotSha256: requiredDigest(
        value.foundation.sourceSnapshotSha256,
        "publication recovery public-mutation source snapshot SHA-256"
      ),
      targetSnapshotSha256: requiredDigest(
        value.foundation.targetSnapshotSha256,
        "publication recovery public-mutation target snapshot SHA-256"
      )
    },
    predecessor
  });
}

function assertPredecessor(value, transactionId) {
  assertExactKeys(value, [
    "blobSha",
    "bytes",
    "determinedAt",
    "fileName",
    "path",
    "sha256"
  ], "publication recovery public-mutation predecessor");
  const fileName = requiredFileName(value.fileName,
    "publication recovery public-mutation predecessor filename");
  const expectedDirectory = path.posix.dirname(
    electronProductionRecoveryStoreTransactionPaths({ transactionId })
      .recoveryOutcomeTerminalPath
  );
  assertEqual(value.path, path.posix.join(expectedDirectory, fileName),
    "publication recovery public-mutation predecessor path");
  return deepFreeze({
    path: value.path,
    fileName,
    sha256: requiredDigest(value.sha256,
      "publication recovery public-mutation predecessor SHA-256"),
    bytes: requiredPositiveInteger(value.bytes,
      "publication recovery public-mutation predecessor bytes"),
    blobSha: requiredCommitSha(value.blobSha,
      "publication recovery public-mutation predecessor blob SHA"),
    determinedAt: requiredRfc3339(value.determinedAt,
      "publication recovery public-mutation predecessor time")
  });
}

function assertPrivateStore(value, transactionId, predecessorSha) {
  assertExactKeys(value, ["expectedHeadCommitSha", "path", "target"],
    "publication recovery public-mutation private store");
  const target = assertTarget(value.target);
  const expectedPath =
    electronProductionPublicationRecoveryPublicMutationAttemptPath({
      transactionId,
      previousOutcomeSha256: predecessorSha
    });
  assertEqual(value.path, expectedPath,
    "publication recovery public-mutation marker path");
  return deepFreeze({
    target,
    path: expectedPath,
    expectedHeadCommitSha: requiredCommitSha(
      value.expectedHeadCommitSha,
      "publication recovery public-mutation expected head"
    )
  });
}

function assertPublicMutation(value, operation, authority) {
  assertExactKeys(value, [
    "requiredAfterObservation",
    "requiredBeforeObservation",
    "observation",
    "source",
    "target"
  ], "publication recovery public-mutation policy");
  assertEqual(
    value.requiredBeforeObservation,
    operation === "rollback-public-latest" ? "target" : "source",
    "publication recovery public-mutation before observation"
  );
  assertEqual(value.requiredAfterObservation, "source",
    "publication recovery public-mutation after observation");
  assertExactKeys(value.observation, [
    "classification",
    "kind",
    "observedAt",
    "receipt",
    "sha256",
    "stateSha256"
  ], "publication recovery public-mutation observation identity");
  assertEqual(
    value.observation.kind,
    "rion-electron-production-public-latest-recovery-observation",
    "publication recovery public-mutation observation kind"
  );
  assertEqual(value.observation.classification,
    value.requiredBeforeObservation,
    "publication recovery public-mutation observation classification");
  const source = assertReleaseState(value.source,
    "publication recovery public-mutation source");
  const target = assertReleaseState(value.target,
    "publication recovery public-mutation target");
  const observationStateSha256 = requiredDigest(
    value.observation.stateSha256,
    "publication recovery public-mutation observation state SHA-256"
  );
  assertEqual(
    observationStateSha256,
    value.observation.classification === "source"
      ? source.stateSha256
      : target.stateSha256,
    "publication recovery public-mutation observed state SHA-256"
  );
  const heldLease = authority.heldLease;
  assertEqual(source.stateSha256, heldLease.sourceStateSha256,
    "publication recovery public-mutation source state SHA-256");
  assertEqual(target.stateSha256, heldLease.targetStateSha256,
    "publication recovery public-mutation target state SHA-256");
  if (source.releaseId === target.releaseId ||
      source.stateSha256 === target.stateSha256) {
    throw new Error("Public-mutation source and target states must differ.");
  }
  const receipt = assertElectronProductionPublicLatestRecoveryObservation(
    value.observation.receipt
  );
  assertEqual(
    electronProductionPublicLatestRecoveryObservationSha256(receipt),
    value.observation.sha256,
    "publication recovery public-mutation embedded observation SHA-256"
  );
  for (const [actual, expected, label] of [
    [receipt.observedAt, value.observation.observedAt, "time"],
    [receipt.observation.classification,
      value.observation.classification, "classification"],
    [receipt.observation.snapshot?.stateSha256 ?? null,
      observationStateSha256, "state SHA-256"],
    [receipt.basis.source.releaseId, source.releaseId, "source release ID"],
    [receipt.basis.source.stateSha256, source.stateSha256, "source state SHA-256"],
    [receipt.basis.source.fileSha256,
      authority.foundation.sourceSnapshotSha256, "source file SHA-256"],
    [receipt.basis.target.releaseId, target.releaseId, "target release ID"],
    [receipt.basis.target.stateSha256, target.stateSha256, "target state SHA-256"],
    [receipt.basis.target.fileSha256,
      authority.foundation.targetSnapshotSha256, "target file SHA-256"]
  ]) assertEqual(actual, expected,
    `publication recovery public-mutation embedded observation ${label}`);
  assertEqual(receipt.transport.outcome, "observed",
    "publication recovery public-mutation embedded observation transport");
  return deepFreeze({
    requiredBeforeObservation: value.requiredBeforeObservation,
    requiredAfterObservation: "source",
    observation: {
      kind: "rion-electron-production-public-latest-recovery-observation",
      receipt,
      sha256: requiredDigest(value.observation.sha256,
        "publication recovery public-mutation observation SHA-256"),
      observedAt: requiredRfc3339(value.observation.observedAt,
        "publication recovery public-mutation observation time"),
      classification: value.observation.classification,
      stateSha256: observationStateSha256
    },
    source,
    target
  });
}

function assertReleaseState(value, label) {
  assertExactKeys(value, ["releaseId", "releaseTag", "stateSha256"], label);
  const releaseId = typeof value.releaseId === "string" &&
      /^[1-9][0-9]*$/u.test(value.releaseId)
    ? value.releaseId
    : null;
  if (releaseId === null) throw new Error(`The ${label} release ID is invalid.`);
  const releaseTag = requiredNonempty(value.releaseTag, `${label} tag`, 255);
  return deepFreeze({
    releaseId,
    releaseTag,
    stateSha256: requiredDigest(value.stateSha256, `${label} state SHA-256`)
  });
}

function assertTarget(value) {
  assertExactKeys(value, ["ref", "repository", "repositoryPolicy"],
    "publication recovery public-mutation private target");
  assertExactKeys(value.repositoryPolicy, ["defaultBranch", "visibility"],
    "publication recovery public-mutation repository policy");
  const repository = requiredRepository(value.repository,
    "publication recovery public-mutation repository");
  const ref = requiredBranch(value.ref,
    "publication recovery public-mutation ref");
  const defaultBranch = requiredBranch(value.repositoryPolicy.defaultBranch,
    "publication recovery public-mutation default branch");
  assertEqual(ref, defaultBranch,
    "publication recovery public-mutation default branch ref");
  assertEqual(value.repositoryPolicy.visibility, "private",
    "publication recovery public-mutation repository visibility");
  return deepFreeze({
    repository,
    ref,
    repositoryPolicy: { defaultBranch, visibility: "private" }
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

function chainContent(proof) {
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

function assertOperation(value) {
  if (!OPERATIONS.has(value)) {
    throw new Error("The publication recovery public-mutation operation is invalid.");
  }
  return value;
}

function assertRun(value) {
  assertExactKeys(value, [
    "controlSha",
    "repository",
    "runAttempt",
    "runId",
    "startedAt",
    "workflow"
  ], "publication recovery public-mutation run");
  const repository = requiredNonempty(value.repository,
    "publication recovery public-mutation run repository", 200);
  const workflow = requiredNonempty(value.workflow,
    "publication recovery public-mutation run workflow", 255);
  assertEqual(repository, "rion-tw/rion-studio-source",
    "publication recovery public-mutation run repository");
  assertEqual(
    workflow,
    ".github/workflows/electron-production-provisional-recovery.yml",
    "publication recovery public-mutation run workflow"
  );
  const runId = typeof value.runId === "string" && /^[1-9][0-9]*$/u.test(value.runId)
    ? value.runId
    : null;
  if (runId === null) throw new Error("The public-mutation run ID is invalid.");
  return deepFreeze({
    repository,
    workflow,
    runId,
    runAttempt: requiredPositiveInteger(value.runAttempt,
      "publication recovery public-mutation run attempt"),
    controlSha: requiredCommitSha(value.controlSha,
      "publication recovery public-mutation control SHA"),
    startedAt: requiredRfc3339(value.startedAt,
      "publication recovery public-mutation run start time")
  });
}

function assertCurrentObservation(value) {
  assertExactKeys(value, [
    "headCommitSha",
    "parentCommitShas",
    "treeSha"
  ], "publication recovery public-mutation current observation");
  if (!Array.isArray(value.parentCommitShas) ||
      value.parentCommitShas.length > 16) {
    throw new Error("Public-mutation current observation parents are invalid.");
  }
  return deepFreeze({
    headCommitSha: requiredCommitSha(value.headCommitSha,
      "publication recovery public-mutation current head"),
    treeSha: requiredCommitSha(value.treeSha,
      "publication recovery public-mutation current tree"),
    parentCommitShas: value.parentCommitShas.map((parentSha) =>
      requiredCommitSha(parentSha,
        "publication recovery public-mutation current parent")
    )
  });
}

function currentObservationFromRead(observed) {
  return {
    headCommitSha: observed.headCommitSha,
    treeSha: observed.treeSha,
    parentCommitShas: observed.parentCommitShas
  };
}

async function writeContract(input, maximumBytes, expectedName, label, parser) {
  assertExactKeys(input, ["outputPath", "value"], `${label} write input`);
  const value = parser(input.value);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    expectedName,
    `${label} output`
  );
  const source = serializeCanonicalJson(value);
  if (source.length === 0 || source.length > maximumBytes) {
    throw new Error(`The ${label} exceeds its bounded size.`);
  }
  await writeExclusive(outputPath, source, `${label} output`);
  const reread = await readCanonicalJsonFile(
    outputPath,
    maximumBytes,
    `${label} output`
  );
  const parsed = parser(reread.value);
  const canonical = serializeCanonicalJson(parsed);
  if (!reread.source.equals(canonical)) {
    throw new Error(`The ${label} output is not canonical JSON.`);
  }
  return deepFreeze({
    value: parsed,
    valueIdentity: publicIdentity(expectedName, {
      bytes: canonical.length,
      sha256: sha256(canonical)
    }),
    valuePath: outputPath
  });
}

async function readContract(input, maximumBytes, expectedName, label, parser) {
  assertExactKeys(input, ["expectedSha256", "receiptPath"],
    `${label} read input`);
  const expectedSha256 = requiredDigest(input.expectedSha256,
    `${label} expected SHA-256`);
  assertEqual(path.basename(input.receiptPath), expectedName, `${label} filename`);
  const receiptPath = await canonicalRegularFilePath(
    input.receiptPath,
    maximumBytes,
    `${label} input`
  );
  const reread = await readCanonicalJsonFile(receiptPath, maximumBytes, label);
  const value = parser(reread.value);
  const source = serializeCanonicalJson(value);
  if (!reread.source.equals(source)) {
    throw new Error(`The ${label} is not canonical JSON.`);
  }
  const identity = publicIdentity(expectedName, {
    bytes: source.length,
    sha256: sha256(source)
  });
  assertEqual(identity.sha256, expectedSha256, `${label} SHA-256`);
  return deepFreeze({ value, valueIdentity: identity, valuePath: receiptPath });
}
