import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createElectronProductionPublicLatestRecoveryObservation,
  electronProductionPublicLatestRecoveryObservationSha256
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  assertElectronProductionPublicationRecoveryPublicMutationAttempt,
  assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization,
  createElectronProductionPublicationRecoveryPublicMutationAttempt,
  createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization,
  createElectronProductionPublicationRecoveryPublicMutationAttemptHistory,
  electronProductionPublicationRecoveryPublicMutationAttemptFileName,
  electronProductionPublicationRecoveryPublicMutationAttemptHistorySha256,
  electronProductionPublicationRecoveryPublicMutationAttemptPath,
  electronProductionPublicationRecoveryPublicMutationAttemptSha256,
  serializeElectronProductionPublicationRecoveryPublicMutationAttempt
} from "../scripts/electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256
} from "../scripts/electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  electronProductionRecoveryStoreRemoteOperationReceiptSha256,
  electronProductionRecoveryStoreRemoteReadOperationReceiptSha256
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  createLeaseReleaseAuthorizationFixture
} from "./support/electronProductionPublicationRecoveryLeaseReleaseAuthorizationFixture";
import {
  createOutcomeDiscoveryFixture
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production public-mutation attempt", () => {
  it("uses one predecessor slot for rollback or release and binds exact observation", async () => {
    const fixture = await baseFixture();
    const releaseObservation = observation(fixture, "source", "00:04:30");
    const release = createElectronProductionPublicationRecoveryPublicMutationAttempt({
      authorization: fixture.pre.authorization,
      authorizationSha256: fixture.pre.sha256,
      operation: "release-held-lease",
      publicObservation: releaseObservation,
      publicObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(
          releaseObservation
        ),
      reservedAt: "2026-09-01T00:04:45Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });
    const targetObservation = observation(fixture, "target", "00:04:30");
    const rollback = createElectronProductionPublicationRecoveryPublicMutationAttempt({
      authorization: fixture.pre.authorization,
      authorizationSha256: fixture.pre.sha256,
      operation: "rollback-public-latest",
      publicObservation: targetObservation,
      publicObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(
          targetObservation
        ),
      reservedAt: "2026-09-01T00:04:45Z",
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    });

    expect(release.privateStore.path).toBe(rollback.privateStore.path);
    expect(path.posix.basename(release.privateStore.path)).toBe(
      electronProductionPublicationRecoveryPublicMutationAttemptFileName({
        previousOutcomeSha256: null
      })
    );
    expect(release.privateStore.path).toBe(
      electronProductionPublicationRecoveryPublicMutationAttemptPath({
        transactionId: fixture.heldLease.transactionId,
        previousOutcomeSha256: null
      })
    );
    expect(release.publicMutation.observation).toMatchObject({
      classification: "source",
      sha256:
        electronProductionPublicLatestRecoveryObservationSha256(
          releaseObservation
        )
    });
    expect(() =>
      createElectronProductionPublicationRecoveryPublicMutationAttempt({
        authorization: fixture.pre.authorization,
        authorizationSha256: fixture.pre.sha256,
        operation: "release-held-lease",
        publicObservation: targetObservation,
        publicObservationSha256:
          electronProductionPublicLatestRecoveryObservationSha256(
            targetObservation
          ),
        reservedAt: "2026-09-01T00:04:45Z",
        sourceSnapshot: fixture.source,
        targetSnapshot: fixture.target
      })
    ).toThrow("fresh exact source observation");
    const tampered = structuredClone(release) as unknown as {
      publicMutation: { observation: { stateSha256: string } };
    };
    tampered.publicMutation.observation.stateSha256 = fixture.target.stateSha256;
    expect(() =>
      assertElectronProductionPublicationRecoveryPublicMutationAttempt(tampered)
    ).toThrow("observed state SHA-256");
  });

  it("cumulatively blocks unknown or confirmed rollback while allowing source release", async () => {
    const unknown = await mutationChainFixture("unknown", "target");
    expect(() => attemptAt(unknown, "rollback-public-latest"))
      .toThrow("historically unknown rollback");
    expect(() => attemptAt(unknown, "release-held-lease")).not.toThrow();

    const confirmed = await mutationChainFixture("confirmed", "source");
    expect(() => attemptAt(confirmed, "rollback-public-latest"))
      .toThrow("confirmed rollback permanently forbids");
  });

  it("allows a rejected rollback predecessor but preserves lease unknown taint", async () => {
    const rejected = await mutationChainFixture("rejected", "target");
    expect(() => attemptAt(rejected, "rollback-public-latest")).not.toThrow();

    const leaseUnknown = await leaseUnknownChainFixture();
    expect(() => attemptAt(leaseUnknown, "release-held-lease"))
      .toThrow("historically unknown lease release");
    expect(() => attemptAt(leaseUnknown, "rollback-public-latest"))
      .toThrow("historically unknown lease release");
  });

  it("authorizes only an exact created-now marker transition", async () => {
    const fixture = await baseFixture();
    const attempt = releaseAttempt(fixture);
    const attemptSource =
      serializeElectronProductionPublicationRecoveryPublicMutationAttempt(
        attempt
      );
    const attemptSha256 =
      electronProductionPublicationRecoveryPublicMutationAttemptSha256(attempt);
    const evidence = remoteEvidence(attempt, attemptSource, attemptSha256, {
      commit: "7",
      parent: "1",
      tree: "8"
    });
    const post = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.pre.intent.authorizedAt,
      currentObservation: { head: "7", parent: "1", tree: "8" },
      currentRun: fixture.pre.authorization.currentRun,
      fixture,
      freshEntries: [],
      intent: fixture.pre.intent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.pre.intent.recoveryRun.startedAt,
      suffix: "post-marker-created",
      verifiedAt: "2026-09-01T00:05:30Z"
    });
    const authorization =
      createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
        attempt,
        attemptSha256,
        preMarkerAuthorization: fixture.pre.authorization,
        preMarkerAuthorizationSha256: fixture.pre.sha256,
        createOperation: evidence.createOperation,
        createOperationSha256: evidence.createOperationSha256,
        attemptHistoryProof: null,
        attemptHistoryProofSha256: null,
        attemptReadOperation: evidence.readOperation,
        attemptReadOperationSha256: evidence.readOperationSha256,
        postMarkerAuthorization: post.authorization,
        postMarkerAuthorizationSha256: post.sha256,
        verifiedAt: "2026-09-01T00:06:00Z"
      });

    expect(authorization.headTransition).toMatchObject({
      mode: "created-now",
      initialHeadCommitSha: "1".repeat(40),
      currentHeadCommitSha: "7".repeat(40),
      attemptCommitSha: "7".repeat(40)
    });
    expect(
      assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
        authorization
      )
    ).toEqual(authorization);
    const tampered = structuredClone(authorization) as unknown as {
      currentRun: { controlSha: string };
    };
    tampered.currentRun.controlSha = "0".repeat(40);
    expect(() =>
      assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
        tampered
      )
    ).toThrow(/does not match|projection changed/u);

    const forged = structuredClone(attempt) as unknown as {
      authority: { heldLease: { sourceStateSha256: string } };
      publicMutation: {
        observation: {
          receipt: {
            basis: { source: { stateSha256: string } };
            observation: { snapshot: { stateSha256: string } };
          };
          sha256: string;
          stateSha256: string;
        };
        source: { stateSha256: string };
      };
    };
    forged.authority.heldLease.sourceStateSha256 = "0".repeat(64);
    forged.publicMutation.observation.stateSha256 = "0".repeat(64);
    forged.publicMutation.source.stateSha256 = "0".repeat(64);
    forged.publicMutation.observation.receipt.basis.source.stateSha256 =
      "0".repeat(64);
    forged.publicMutation.observation.receipt.observation.snapshot.stateSha256 =
      "0".repeat(64);
    forged.publicMutation.observation.sha256 =
      electronProductionPublicLatestRecoveryObservationSha256(
        forged.publicMutation.observation.receipt
      );
    const forgedAttempt = forged as unknown as typeof attempt;
    const forgedSource =
      serializeElectronProductionPublicationRecoveryPublicMutationAttempt(
        forgedAttempt
      );
    const forgedSha256 =
      electronProductionPublicationRecoveryPublicMutationAttemptSha256(
        forgedAttempt
      );
    const forgedEvidence = remoteEvidence(
      forgedAttempt,
      forgedSource,
      forgedSha256,
      { commit: "7", parent: "1", tree: "8" }
    );
    expect(() =>
      createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
        attempt: forgedAttempt,
        attemptSha256: forgedSha256,
        preMarkerAuthorization: fixture.pre.authorization,
        preMarkerAuthorizationSha256: fixture.pre.sha256,
        createOperation: forgedEvidence.createOperation,
        createOperationSha256: forgedEvidence.createOperationSha256,
        attemptHistoryProof: null,
        attemptHistoryProofSha256: null,
        attemptReadOperation: forgedEvidence.readOperation,
        attemptReadOperationSha256: forgedEvidence.readOperationSha256,
        postMarkerAuthorization: post.authorization,
        postMarkerAuthorizationSha256: post.sha256,
        verifiedAt: "2026-09-01T00:06:00Z"
      })
    ).toThrow("held source state SHA-256");
  });

  it("resumes from durable marker history without creator authorization artifacts", async () => {
    const fixture = await baseFixture();
    const attempt = releaseAttempt(fixture);
    const attemptSource =
      serializeElectronProductionPublicationRecoveryPublicMutationAttempt(
        attempt
      );
    const attemptSha256 =
      electronProductionPublicationRecoveryPublicMutationAttemptSha256(attempt);
    const evidence = remoteEvidence(attempt, attemptSource, attemptSha256, {
      commit: "9",
      parent: "8",
      tree: "a"
    });
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
    const currentRun = {
      repository: "rion-tw/rion-studio-source" as const,
      workflow:
        ".github/workflows/electron-production-provisional-recovery.yml" as const,
      runId: "9904",
      runAttempt: 2,
      controlSha: "0".repeat(40),
      startedAt: "2026-09-01T00:06:30Z"
    };
    const post = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.pre.intent.authorizedAt,
      currentObservation: { head: "9", parent: "8", tree: "a" },
      currentRun,
      fixture,
      freshEntries: [],
      intent: fixture.pre.intent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.pre.intent.recoveryRun.startedAt,
      suffix: "post-marker-resumed",
      verifiedAt: "2026-09-01T00:07:30Z"
    });
    const authorization =
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
        attemptReadOperation: evidence.readOperation,
        attemptReadOperationSha256: evidence.readOperationSha256,
        postMarkerAuthorization: post.authorization,
        postMarkerAuthorizationSha256: post.sha256,
        verifiedAt: "2026-09-01T00:08:00Z"
      });

    expect(authorization.headTransition.mode).toBe("resumed-existing");
    expect(authorization.evidence.preMarkerAuthorization).toBeNull();
    expect(authorization.currentRun).toEqual(currentRun);
    expect(
      assertElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization(
        authorization
      )
    ).toEqual(authorization);
    expect(() =>
      createElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
        attempt,
        attemptSha256,
        preMarkerAuthorization: null,
        preMarkerAuthorizationSha256: null,
        createOperation: null,
        createOperationSha256: null,
        attemptHistoryProof: {
          ...history,
          observedAt: "2026-09-01T00:08:30Z"
        },
        attemptHistoryProofSha256:
          electronProductionPublicationRecoveryPublicMutationAttemptHistorySha256({
            ...history,
            observedAt: "2026-09-01T00:08:30Z"
          }),
        attemptReadOperation: evidence.readOperation,
        attemptReadOperationSha256: evidence.readOperationSha256,
        postMarkerAuthorization: post.authorization,
        postMarkerAuthorizationSha256: post.sha256,
        verifiedAt: "2026-09-01T00:08:00Z"
      })
    ).toThrow("cannot precede its history proof");
  });
});

async function baseFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-public-mutation-attempt-"));
  temporaryDirectories.push(root);
  const fixture = await createOutcomeDiscoveryFixture(root);
  const pre = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T00:03:00Z",
    fixture,
    freshEntries: [],
    initialEntries: [],
    mode: "created-now",
    outputRoot: root,
    recoveryRunStartedAt: "2026-09-01T00:02:30Z",
    suffix: "pre-marker",
    verifiedAt: "2026-09-01T00:04:00Z"
  });
  return { ...fixture, pre, root };
}

function releaseAttempt(fixture: Awaited<ReturnType<typeof baseFixture>>) {
  const publicObservation = observation(fixture, "source", "00:04:30");
  return createElectronProductionPublicationRecoveryPublicMutationAttempt({
    authorization: fixture.pre.authorization,
    authorizationSha256:
      electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
        fixture.pre.authorization
      ),
    operation: "release-held-lease",
    publicObservation,
    publicObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(publicObservation),
    reservedAt: "2026-09-01T00:04:45Z",
    sourceSnapshot: fixture.source,
    targetSnapshot: fixture.target
  });
}

function attemptAt(
  fixture: Awaited<ReturnType<typeof mutationChainFixture>>,
  operation: "rollback-public-latest" | "release-held-lease"
) {
  const classification = operation === "rollback-public-latest"
    ? "target"
    : "source";
  const publicObservation = observation(fixture, classification, "00:08:00");
  return createElectronProductionPublicationRecoveryPublicMutationAttempt({
    authorization: fixture.pre.authorization,
    authorizationSha256: fixture.pre.sha256,
    operation,
    publicObservation,
    publicObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(publicObservation),
    reservedAt: "2026-09-01T00:08:15Z",
    sourceSnapshot: fixture.source,
    targetSnapshot: fixture.target
  });
}

async function mutationChainFixture(
  acknowledgement: "confirmed" | "rejected" | "unknown",
  finalClassification: "source" | "target"
) {
  const root = await mkdtemp(path.join(tmpdir(), "rion-mutation-chain-"));
  temporaryDirectories.push(root);
  const fixture = await createOutcomeDiscoveryFixture(root);
  const outcome = fixture.createOutcome({
    determinedAt: "2026-09-01T00:05:30Z",
    beforeClassification: "target",
    beforeObservedAt: "2026-09-01T00:03:30Z",
    finalClassification,
    finalObservedAt: "2026-09-01T00:05:00Z",
    mutation: {
      kind: "rollback",
      submitted: true,
      acknowledgement,
      submittedAt: "2026-09-01T00:04:00Z",
      resultRecordedAt: "2026-09-01T00:04:30Z"
    },
    previousOutcomeSha256: null,
    runAttempt: 1,
    runId: acknowledgement === "confirmed"
      ? "9101"
      : acknowledgement === "rejected" ? "9102" : "9103",
    startedAt: "2026-09-01T00:03:00Z"
  });
  const entry = fixture.entry(outcome);
  const pre = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T00:06:30Z",
    fixture,
    freshEntries: [entry],
    initialEntries: [entry],
    mode: "created-now",
    outputRoot: root,
    recoveryRunStartedAt: "2026-09-01T00:06:00Z",
    suffix: `mutation-${acknowledgement}`,
    verifiedAt: "2026-09-01T00:07:30Z"
  });
  return { ...fixture, outcome, pre, root };
}

async function leaseUnknownChainFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-lease-unknown-chain-"));
  temporaryDirectories.push(root);
  const fixture = await createOutcomeDiscoveryFixture(root);
  const outcome = fixture.createOutcome({
    determinedAt: "2026-09-01T00:05:30Z",
    beforeObservedAt: "2026-09-01T00:03:30Z",
    finalObservedAt: "2026-09-01T00:04:00Z",
    leaseRelease: {
      attempted: true,
      acknowledgement: "unknown",
      attemptedAt: "2026-09-01T00:04:30Z",
      operationSha256: "7".repeat(64),
      resolvedAt: "2026-09-01T00:05:00Z",
      successorEventSha256: null
    },
    previousOutcomeSha256: null,
    runAttempt: 1,
    runId: "9201",
    startedAt: "2026-09-01T00:03:00Z"
  });
  const entry = fixture.entry(outcome);
  const pre = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T00:06:30Z",
    fixture,
    freshEntries: [entry],
    initialEntries: [entry],
    mode: "created-now",
    outputRoot: root,
    recoveryRunStartedAt: "2026-09-01T00:06:00Z",
    suffix: "lease-unknown",
    verifiedAt: "2026-09-01T00:07:30Z"
  });
  return { ...fixture, outcome, pre, root };
}

function observation(
  fixture: Awaited<ReturnType<typeof baseFixture>>,
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
    sourceSnapshotFileSha256:
      fixture.pre.intent.foundation.sourceSnapshotSha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256:
      fixture.pre.intent.foundation.targetSnapshotSha256
  });
}

function remoteEvidence(
  attempt: ReturnType<typeof releaseAttempt>,
  source: Buffer,
  sha256: string,
  observation: Readonly<{ commit: string; parent: string; tree: string }>
) {
  const target = {
    owner: attempt.privateStore.target.repository.split("/")[0]!,
    repo: attempt.privateStore.target.repository.split("/")[1]!,
    ref: attempt.privateStore.target.ref,
    repositoryPolicy: attempt.privateStore.target.repositoryPolicy,
    path: attempt.privateStore.path
  };
  const request = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: attempt.privateStore.expectedHeadCommitSha,
    packageIdentity: {
      fileName: path.posix.basename(attempt.privateStore.path),
      byteLength: source.length,
      sha256
    },
    target
  });
  const createOperation =
    createElectronProductionRecoveryStoreRemoteOperationReceipt({
      request,
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
    expectedContent: { byteLength: source.length, sha256 },
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
