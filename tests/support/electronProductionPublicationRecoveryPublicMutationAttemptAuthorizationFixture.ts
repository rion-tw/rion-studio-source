import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createElectronProductionPublicLatestRecoveryObservation,
  electronProductionPublicLatestRecoveryObservationSha256
} from "../../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  createElectronProductionPublicationRecoveryPublicMutationAttempt,
  createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization,
  createElectronProductionPublicationRecoveryPublicMutationAttemptHistory,
  electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256,
  electronProductionPublicationRecoveryPublicMutationAttemptHistorySha256,
  electronProductionPublicationRecoveryPublicMutationAttemptSha256,
  serializeElectronProductionPublicationRecoveryPublicMutationAttempt,
  type ElectronProductionPublicationRecoveryPublicMutationAttempt
} from "../../scripts/electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  electronProductionRecoveryStoreRemoteOperationReceiptSha256,
  electronProductionRecoveryStoreRemoteReadOperationReceiptSha256
} from "../../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  createLeaseReleaseAuthorizationFixture
} from "./electronProductionPublicationRecoveryLeaseReleaseAuthorizationFixture";
import {
  createOutcomeDiscoveryFixture
} from "./electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

export async function createPublicMutationAttemptAuthorizationFixture(
  input: Readonly<{
    operation: "release-held-lease" | "rollback-public-latest";
    outputRoot?: string;
  }>
) {
  const root = input.outputRoot ?? await mkdtemp(
    path.join(tmpdir(), "rion-public-mutation-operation-")
  );
  const fixture = await createOutcomeDiscoveryFixture(root);
  const pre = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T00:03:00Z",
    fixture,
    freshEntries: [],
    initialEntries: [],
    mode: "created-now",
    outputRoot: root,
    recoveryRunStartedAt: "2026-09-01T00:02:30Z",
    suffix: `${input.operation}-pre`,
    verifiedAt: "2026-09-01T00:04:00Z"
  });
  const classification = input.operation === "release-held-lease"
    ? "source"
    : "target";
  const publicObservation = observation(fixture, pre, classification, "00:04:30");
  const attempt =
    createElectronProductionPublicationRecoveryPublicMutationAttempt({
      authorization: pre.authorization,
      authorizationSha256: pre.sha256,
      operation: input.operation,
      publicObservation,
      publicObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(
          publicObservation
        ),
      reservedAt: "2026-09-01T00:04:45Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
  const attemptSha256 =
    electronProductionPublicationRecoveryPublicMutationAttemptSha256(attempt);
  const attemptSource =
    serializeElectronProductionPublicationRecoveryPublicMutationAttempt(
      attempt
    );
  const createdEvidence = remoteEvidence(
    attempt,
    attemptSource,
    attemptSha256,
    { commit: "7", parent: "1", tree: "8" }
  );
  const createdPost = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: pre.intent.authorizedAt,
    currentObservation: { head: "7", parent: "1", tree: "8" },
    currentRun: pre.authorization.currentRun,
    fixture,
    freshEntries: [],
    intent: pre.intent,
    mode: "resumed-existing",
    outputRoot: root,
    recoveryRunStartedAt: pre.intent.recoveryRun.startedAt,
    suffix: `${input.operation}-created-post`,
    verifiedAt: "2026-09-01T00:05:30Z"
  });
  const createdAuthorization =
    createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
      attempt,
      attemptSha256,
      preMarkerAuthorization: pre.authorization,
      preMarkerAuthorizationSha256: pre.sha256,
      createOperation: createdEvidence.createOperation,
      createOperationSha256: createdEvidence.createOperationSha256,
      attemptHistoryProof: null,
      attemptHistoryProofSha256: null,
      attemptReadOperation: createdEvidence.readOperation,
      attemptReadOperationSha256: createdEvidence.readOperationSha256,
      postMarkerAuthorization: createdPost.authorization,
      postMarkerAuthorizationSha256: createdPost.sha256,
      verifiedAt: "2026-09-01T00:06:00Z"
    });
  const resumedEvidence = remoteEvidence(
    attempt,
    attemptSource,
    attemptSha256,
    { commit: "9", parent: "8", tree: "a" }
  );
  const history =
    createElectronProductionPublicationRecoveryPublicMutationAttemptHistory({
      attemptBlobSha: gitBlobSha(attemptSource),
      attemptCommitSha: "7".repeat(40),
      attemptTreeSha: "8".repeat(40),
      initialHeadCommitSha: "1".repeat(40),
      currentObservation: {
        headCommitSha: "9".repeat(40),
        treeSha: "a".repeat(40),
        parentCommitShas: ["8".repeat(40)]
      },
      path: attempt.privateStore.path,
      pathHistory: {
        reachableFromHeadCommitSha: "9".repeat(40),
        commitSha: "7".repeat(40),
        resultCount: 1,
        nextPage: false
      },
      target: attempt.privateStore.target,
      observedAt: "2026-09-01T00:07:00Z"
    });
  const resumedRun = {
    repository: "rion-tw/rion-studio-source" as const,
    workflow:
      ".github/workflows/electron-production-provisional-recovery.yml" as const,
    runId: "9904",
    runAttempt: 2,
    controlSha: "0".repeat(40),
    startedAt: "2026-09-01T00:06:30Z"
  };
  const resumedPost = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: pre.intent.authorizedAt,
    currentObservation: { head: "9", parent: "8", tree: "a" },
    currentRun: resumedRun,
    fixture,
    freshEntries: [],
    intent: pre.intent,
    mode: "resumed-existing",
    outputRoot: root,
    recoveryRunStartedAt: pre.intent.recoveryRun.startedAt,
    suffix: `${input.operation}-resumed-post`,
    verifiedAt: "2026-09-01T00:07:30Z"
  });
  const resumedAuthorization =
    createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
      attempt,
      attemptSha256,
      preMarkerAuthorization: null,
      preMarkerAuthorizationSha256: null,
      createOperation: null,
      createOperationSha256: null,
      attemptHistoryProof: history,
      attemptHistoryProofSha256:
        electronProductionPublicationRecoveryPublicMutationAttemptHistorySha256(
          history
        ),
      attemptReadOperation: resumedEvidence.readOperation,
      attemptReadOperationSha256: resumedEvidence.readOperationSha256,
      postMarkerAuthorization: resumedPost.authorization,
      postMarkerAuthorizationSha256: resumedPost.sha256,
      verifiedAt: "2026-09-01T00:08:00Z"
    });
  return {
    ...fixture,
    attempt,
    attemptSha256,
    createdAuthorization,
    createdAuthorizationSha256:
      electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256(
        createdAuthorization
      ),
    pre,
    publicObservation,
    resumedAuthorization,
    resumedAuthorizationSha256:
      electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationSha256(
        resumedAuthorization
      ),
    root
  };
}

function observation(
  fixture: Awaited<ReturnType<typeof createOutcomeDiscoveryFixture>>,
  pre: Awaited<ReturnType<typeof createLeaseReleaseAuthorizationFixture>>,
  classification: "source" | "target",
  time: string
) {
  const snapshot = classification === "source"
    ? fixture.source
    : fixture.observedTarget;
  return createElectronProductionPublicLatestRecoveryObservation({
    observedAt: `2026-09-01T${time}Z`,
    result: {
      outcome: "observed",
      latest: {
        releaseId: snapshot.release.id,
        updatedAt: "2026-09-01T00:00:00Z"
      },
      snapshot
    },
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256: pre.intent.foundation.sourceSnapshotSha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256: pre.intent.foundation.targetSnapshotSha256
  });
}

function remoteEvidence(
  attempt: ElectronProductionPublicationRecoveryPublicMutationAttempt,
  source: Buffer,
  sourceSha256: string,
  observation: Readonly<{ commit: string; parent: string; tree: string }>
) {
  const [owner, repo] = attempt.privateStore.target.repository.split("/");
  const target = {
    owner,
    repo,
    ref: attempt.privateStore.target.ref,
    repositoryPolicy: attempt.privateStore.target.repositoryPolicy,
    path: attempt.privateStore.path
  };
  const createRequest = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: attempt.privateStore.expectedHeadCommitSha,
    packageIdentity: {
      fileName: path.posix.basename(attempt.privateStore.path),
      byteLength: source.length,
      sha256: sourceSha256
    },
    target
  });
  const createOperation =
    createElectronProductionRecoveryStoreRemoteOperationReceipt({
      request: createRequest,
      result: {
        outcome: "applied",
        parentSha: attempt.privateStore.expectedHeadCommitSha,
        commitSha: observation.commit.repeat(40),
        treeSha: observation.tree.repeat(40),
        blobSha: gitBlobSha(source),
        byteLength: source.length
      }
    });
  const readRequest = createElectronProductionRecoveryStoreRemoteReadRequest({
    expectedContent: { byteLength: source.length, sha256: sourceSha256 },
    target
  });
  const readOperation =
    createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      request: readRequest,
      content: source,
      result: {
        outcome: "present",
        blobSha: gitBlobSha(source),
        byteLength: source.length,
        commitMessage: "recovery marker readback",
        contentBase64: source.toString("base64"),
        headSha: observation.commit.repeat(40),
        parentShas: [observation.parent.repeat(40)],
        treeSha: observation.tree.repeat(40)
      }
    });
  return {
    createOperation,
    createOperationSha256:
      electronProductionRecoveryStoreRemoteOperationReceiptSha256(
        createOperation
      ),
    readOperation,
    readOperationSha256:
      electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(
        readOperation
      )
  };
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}
