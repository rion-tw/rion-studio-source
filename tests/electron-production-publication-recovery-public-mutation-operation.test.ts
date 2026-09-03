import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  electronProductionPublicLatestLeaseEventSha256,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  createElectronProductionPublicLatestLeaseReleaseOperation,
  electronProductionPublicLatestLeaseReleaseOperationSha256
} from "../scripts/electronProductionPublicLatestLeaseReleaseOperation.mjs";
import {
  createElectronProductionPublicLatestRecoveryObservation,
  createElectronProductionPublicLatestRecoveryRollback,
  electronProductionPublicLatestRecoveryObservationSha256,
  electronProductionPublicLatestRecoveryRollbackSha256
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  assertElectronProductionPublicationRecoveryPublicMutationOperationBindings,
  createElectronProductionPublicationRecoveryPublicMutationOperation,
  electronProductionPublicationRecoveryPublicMutationOperationOutcomeEvidence
} from "../scripts/electronProductionPublicationRecoveryPublicMutationOperation.mjs";
import {
  createPublicMutationAttemptAuthorizationFixture
} from "./support/electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("marker-bound public mutation operation", () => {
  it("records a resumed rollback as possibly submitted without a transport receipt", async () => {
    const fixture = await mutationFixture("rollback-public-latest");
    const final = recoveryObservation(fixture, "source", "00:08:30");
    const operation = createOperation(fixture, {
      authorization: "resumed",
      before: fixture.publicObservation,
      final,
      mode: "marker-reconciliation",
      resolvedAt: "2026-09-01T00:08:40Z"
    });

    expect(operation.result).toMatchObject({
      mutation: {
        kind: "rollback",
        submitted: "possibly",
        acknowledgement: "unknown",
        submittedAt: null,
        reservation: {
          attemptSha256: fixture.attemptSha256,
          authorizationSha256: fixture.resumedAuthorizationSha256
        }
      },
      leaseRelease: { attempted: false }
    });
    expect(operation.transport).toBeNull();
    expect(bindOperation(fixture, operation, "resumed")).toEqual(operation);
    expect(outcomeEvidence(fixture, operation, "resumed").mutation.submitted)
      .toBe("possibly");
    expect(() => createOperation(fixture, {
      authorization: "created",
      before: fixture.publicObservation,
      final,
      mode: "marker-reconciliation",
      resolvedAt: "2026-09-01T00:08:40Z"
    })).toThrow("head-transition mode");
  });

  it("records created-now precondition rejection without claiming PATCH or PUT", async () => {
    const rollback = await mutationFixture("rollback-public-latest");
    const rollbackFinal = recoveryObservation(rollback, "target", "00:06:30");
    const rejectedRollback = createOperation(rollback, {
      authorization: "created",
      before: rollback.publicObservation,
      final: rollbackFinal,
      mode: "precondition-rejected",
      resolvedAt: "2026-09-01T00:06:40Z"
    });
    expect(rejectedRollback.result.mutation).toMatchObject({
      submitted: false,
      acknowledgement: "rejected",
      submittedAt: null
    });
    expect(rejectedRollback.transport).toBeNull();

    const release = await mutationFixture("release-held-lease");
    const releaseFinal = recoveryObservation(release, "unknown", "00:06:30");
    const rejectedRelease = createOperation(release, {
      authorization: "created",
      before: release.publicObservation,
      final: releaseFinal,
      mode: "precondition-rejected",
      resolvedAt: "2026-09-01T00:06:40Z"
    });
    expect(rejectedRelease.result.leaseRelease).toMatchObject({
      attempted: false,
      acknowledgement: "rejected",
      attemptedAt: null,
      operationSha256: null
    });
    expect(rejectedRelease.transport).toBeNull();
    expect(bindOperation(release, rejectedRelease, "created"))
      .toEqual(rejectedRelease);
  });

  it("reconciles only an exact direct released successor after reservation", async () => {
    const fixture = await mutationFixture("release-held-lease");
    const final = recoveryObservation(fixture, "source", "00:08:30");
    const successor = releasedSuccessor(fixture, "2026-09-01T00:08:20Z");
    const operation = createOperation(fixture, {
      authorization: "resumed",
      before: fixture.publicObservation,
      final,
      mode: "marker-reconciliation",
      resolvedAt: "2026-09-01T00:08:40Z",
      successor
    });

    expect(operation.result.leaseRelease).toMatchObject({
      attempted: "possibly",
      acknowledgement: "confirmed",
      attemptedAt: "2026-09-01T00:08:20Z",
      operationSha256: null,
      successorEventSha256: successor.eventSha256
    });
    expect(outcomeEvidence(fixture, operation, "resumed").leaseRelease)
      .toEqual(operation.result.leaseRelease);

    const stale = releasedSuccessor(fixture, "2026-09-01T00:04:40Z");
    expect(() => createOperation(fixture, {
      authorization: "resumed",
      before: fixture.publicObservation,
      final,
      mode: "marker-reconciliation",
      resolvedAt: "2026-09-01T00:08:40Z",
      successor: stale
    })).toThrow("cannot precede its durable mutation reservation");
  });

  it("binds actual rollback and lease PUT receipts to the created marker authority", async () => {
    const rollbackFixture = await mutationFixture("rollback-public-latest");
    const rollbackBefore = recoveryObservation(
      rollbackFixture,
      "target",
      "00:06:10"
    );
    const rollbackFinal = recoveryObservation(
      rollbackFixture,
      "source",
      "00:06:30"
    );
    const rollbackTransport = createElectronProductionPublicLatestRecoveryRollback({
      finalObservation: rollbackFinal,
      finalObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(rollbackFinal),
      heldLease: rollbackFixture.heldLease,
      mutation: {
        submitted: true,
        releaseId: rollbackFixture.source.release.id,
        makeLatest: true,
        acknowledgement: "confirmed",
        submittedAt: "2026-09-01T00:06:15Z",
        resultRecordedAt: "2026-09-01T00:06:20Z",
        reason: "applied-response",
        httpStatus: 200
      },
      preObservation: rollbackBefore,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(rollbackBefore),
      ...snapshotBindings(rollbackFixture)
    });
    const rollback = createOperation(rollbackFixture, {
      authorization: "created",
      before: rollbackBefore,
      final: rollbackFinal,
      mode: "actual-transport",
      resolvedAt: "2026-09-01T00:06:30Z",
      transportOperation: rollbackTransport,
      transportOperationSha256:
        electronProductionPublicLatestRecoveryRollbackSha256(rollbackTransport)
    });
    expect(rollback.result.mutation.submitted).toBe(true);
    expect(rollback.authority.authorizationSha256)
      .toBe(rollbackFixture.createdAuthorizationSha256);

    const staleBefore = recoveryObservation(
      rollbackFixture,
      "target",
      "00:05:30"
    );
    const staleTransport = createElectronProductionPublicLatestRecoveryRollback({
      finalObservation: rollbackFinal,
      finalObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(rollbackFinal),
      heldLease: rollbackFixture.heldLease,
      mutation: {
        submitted: true,
        releaseId: rollbackFixture.source.release.id,
        makeLatest: true,
        acknowledgement: "confirmed",
        submittedAt: "2026-09-01T00:05:35Z",
        resultRecordedAt: "2026-09-01T00:05:40Z",
        reason: "applied-response",
        httpStatus: 200
      },
      preObservation: staleBefore,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(staleBefore),
      ...snapshotBindings(rollbackFixture)
    });
    expect(() => createOperation(rollbackFixture, {
      authorization: "created",
      before: staleBefore,
      final: rollbackFinal,
      mode: "actual-transport",
      resolvedAt: "2026-09-01T00:06:30Z",
      transportOperation: staleTransport,
      transportOperationSha256:
        electronProductionPublicLatestRecoveryRollbackSha256(staleTransport)
    })).toThrow("before observation cannot precede authorization");

    const releaseFixture = await mutationFixture("release-held-lease");
    const releaseBefore = recoveryObservation(
      releaseFixture,
      "source",
      "00:06:10"
    );
    const releaseTransport = actualLeaseRelease(
      releaseFixture,
      releaseBefore,
      "2026-09-01T00:06:20Z"
    );
    const release = createOperation(releaseFixture, {
      authorization: "created",
      before: releaseBefore,
      final: releaseBefore,
      mode: "actual-transport",
      resolvedAt: "2026-09-01T00:06:20Z",
      transportOperation: releaseTransport,
      transportOperationSha256:
        electronProductionPublicLatestLeaseReleaseOperationSha256(
          releaseTransport
        )
    });
    expect(release.result.leaseRelease.attempted).toBe(true);
    expect(release.authority.attemptSha256).toBe(releaseFixture.attemptSha256);

    const staleReleaseBefore = recoveryObservation(
      releaseFixture,
      "source",
      "00:05:30"
    );
    const staleReleaseTransport = actualLeaseRelease(
      releaseFixture,
      staleReleaseBefore,
      "2026-09-01T00:05:40Z"
    );
    expect(() => createOperation(releaseFixture, {
      authorization: "created",
      before: staleReleaseBefore,
      final: staleReleaseBefore,
      mode: "actual-transport",
      resolvedAt: "2026-09-01T00:05:40Z",
      transportOperation: staleReleaseTransport,
      transportOperationSha256:
        electronProductionPublicLatestLeaseReleaseOperationSha256(
          staleReleaseTransport
        )
    })).toThrow("final observation cannot precede its authorization");

    expect(() => createOperation(releaseFixture, {
      authorization: "resumed",
      before: releaseBefore,
      final: releaseBefore,
      mode: "actual-transport",
      resolvedAt: "2026-09-01T00:06:20Z",
      transportOperation: releaseTransport,
      transportOperationSha256:
        electronProductionPublicLatestLeaseReleaseOperationSha256(
          releaseTransport
        )
    })).toThrow("head-transition mode");

    const tampered = structuredClone(release) as unknown as {
      authority: { authorizationSha256: string };
    };
    tampered.authority.authorizationSha256 = "f".repeat(64);
    expect(() => bindOperation(releaseFixture, tampered, "created"))
      .toThrow("operation authority does not match");
  });
});

async function mutationFixture(
  operation: "release-held-lease" | "rollback-public-latest"
) {
  const fixture = await createPublicMutationAttemptAuthorizationFixture({
    operation
  });
  temporaryDirectories.push(fixture.root);
  return fixture;
}

function createOperation(
  fixture: Awaited<ReturnType<typeof mutationFixture>>,
  input: Readonly<{
    authorization: "created" | "resumed";
    before: ReturnType<typeof recoveryObservation>;
    final: ReturnType<typeof recoveryObservation>;
    mode: "actual-transport" | "marker-reconciliation" |
      "precondition-rejected";
    resolvedAt: string;
    successor?: ReturnType<typeof releasedSuccessor> | null;
    transportOperation?: Parameters<
      typeof createElectronProductionPublicationRecoveryPublicMutationOperation
    >[0]["transportOperation"];
    transportOperationSha256?: string | null;
  }>
) {
  const authorization = input.authorization === "created"
    ? fixture.createdAuthorization
    : fixture.resumedAuthorization;
  const authorizationSha256 = input.authorization === "created"
    ? fixture.createdAuthorizationSha256
    : fixture.resumedAuthorizationSha256;
  return createElectronProductionPublicationRecoveryPublicMutationOperation({
    authorization,
    authorizationSha256,
    beforeObservation: input.before,
    beforeObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(input.before),
    finalObservation: input.final,
    finalObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(input.final),
    heldLease: fixture.heldLease,
    heldLeaseFileSha256: fixture.foundation.heldLeaseSha256,
    mode: input.mode,
    resolvedAt: input.resolvedAt,
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256:
      fixture.attempt.authority.foundation.sourceSnapshotSha256,
    successor: input.successor ?? null,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256:
      fixture.attempt.authority.foundation.targetSnapshotSha256,
    transportOperation: input.transportOperation ?? null,
    transportOperationSha256: input.transportOperationSha256 ?? null
  });
}

function bindOperation(
  fixture: Awaited<ReturnType<typeof mutationFixture>>,
  operation: unknown,
  authorizationMode: "created" | "resumed"
) {
  const authorization = authorizationMode === "created"
    ? fixture.createdAuthorization
    : fixture.resumedAuthorization;
  return assertElectronProductionPublicationRecoveryPublicMutationOperationBindings({
    authorization,
    authorizationSha256: authorizationMode === "created"
      ? fixture.createdAuthorizationSha256
      : fixture.resumedAuthorizationSha256,
    heldLease: fixture.heldLease,
    heldLeaseFileSha256: fixture.foundation.heldLeaseSha256,
    operation,
    ...snapshotBindings(fixture)
  });
}

function outcomeEvidence(
  fixture: Awaited<ReturnType<typeof mutationFixture>>,
  operation: unknown,
  authorizationMode: "created" | "resumed"
) {
  const authorization = authorizationMode === "created"
    ? fixture.createdAuthorization
    : fixture.resumedAuthorization;
  return electronProductionPublicationRecoveryPublicMutationOperationOutcomeEvidence({
    authorization,
    authorizationSha256: authorizationMode === "created"
      ? fixture.createdAuthorizationSha256
      : fixture.resumedAuthorizationSha256,
    heldLease: fixture.heldLease,
    heldLeaseFileSha256: fixture.foundation.heldLeaseSha256,
    operation,
    ...snapshotBindings(fixture)
  });
}

function snapshotBindings(fixture: Awaited<ReturnType<typeof mutationFixture>>) {
  return {
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256:
      fixture.attempt.authority.foundation.sourceSnapshotSha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256:
      fixture.attempt.authority.foundation.targetSnapshotSha256
  };
}

function recoveryObservation(
  fixture: Awaited<ReturnType<typeof mutationFixture>>,
  classification: "source" | "target" | "unknown",
  time: string
) {
  const snapshot = classification === "source"
    ? fixture.source
    : classification === "target" ? fixture.observedTarget : null;
  const result = snapshot === null
    ? {
        outcome: "indeterminate" as const,
        reason: "transport" as const,
        status: null,
        latest: null
      }
    : {
        outcome: "observed" as const,
        latest: {
          releaseId: snapshot.release.id,
          updatedAt: "2026-09-01T00:00:00Z"
        },
        snapshot
      };
  return createElectronProductionPublicLatestRecoveryObservation({
    observedAt: `2026-09-01T${time}Z`,
    result,
    ...snapshotBindings(fixture)
  });
}

function releasedSuccessor(
  fixture: Awaited<ReturnType<typeof mutationFixture>>,
  recordedAt: string
) {
  const lease = releaseElectronProductionPublicLatestLease(fixture.heldLease, {
    transactionId: fixture.heldLease.transactionId,
    leaseId: fixture.heldLease.leaseId,
    generation: fixture.heldLease.generation,
    sourceStateSha256: fixture.heldLease.source.stateSha256,
    targetStateSha256: fixture.heldLease.target.stateSha256,
    recordedAt
  });
  const source = serializeElectronProductionPublicLatestLease(lease);
  return {
    lease,
    eventSha256: electronProductionPublicLatestLeaseEventSha256(lease),
    bytes: source.length,
    fileSha256: sha256(source),
    blobSha: gitBlobSha(source)
  };
}

function actualLeaseRelease(
  fixture: Awaited<ReturnType<typeof mutationFixture>>,
  observation: ReturnType<typeof recoveryObservation>,
  attemptedAt: string
) {
  const successor = releasedSuccessor(fixture, attemptedAt);
  const remoteOperation = {
    schemaVersion: 1 as const,
    kind: "rion-electron-production-public-latest-lease-remote-operation" as const,
    command: "release" as const,
    request: {
      attemptedAt,
      held: {
        transactionId: fixture.heldLease.transactionId,
        leaseId: fixture.heldLease.leaseId,
        generation: fixture.heldLease.generation,
        revision: fixture.heldLease.revision,
        eventSha256:
          electronProductionPublicLatestLeaseEventSha256(fixture.heldLease),
        sourceStateSha256: fixture.heldLease.source.stateSha256,
        targetStateSha256: fixture.heldLease.target.stateSha256
      }
    },
    outcome: "applied" as const,
    reason: null,
    httpStatus: 200,
    remote: {
      repository: "rion-tw/rion-studio" as const,
      ref: "main" as const,
      path: "releases/electron-production-public-latest-lease.json" as const,
      blobSha: successor.blobSha
    },
    lease: {
      transactionId: successor.lease.transactionId,
      leaseId: successor.lease.leaseId,
      generation: successor.lease.generation,
      revision: successor.lease.revision,
      status: "released" as const,
      eventSha256: successor.eventSha256
    },
    output: {
      bytes: successor.bytes,
      fileName: "electron-production-public-latest-lease.json" as const,
      sha256: successor.fileSha256
    }
  };
  return createElectronProductionPublicLatestLeaseReleaseOperation({
    heldLease: fixture.heldLease,
    preReleaseObservation: observation,
    recoveryOperation: {
      kind: "rion-electron-production-public-latest-recovery-observation",
      sha256: electronProductionPublicLatestRecoveryObservationSha256(
        observation
      )
    },
    remoteOperation,
    resolvedAt: attemptedAt
  });
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function sha256(source: Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
