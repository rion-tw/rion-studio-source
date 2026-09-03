import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  electronProductionPublicLatestLeaseEventSha256,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  createElectronProductionPublicLatestRecoveryObservation,
  createElectronProductionPublicLatestRecoveryRollback,
  electronProductionPublicLatestRecoveryObservationSha256
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE,
  readElectronProductionPublicationRecoveryPublicMutationOperation
} from "../scripts/electronProductionPublicationRecoveryPublicMutationOperation.mjs";
import {
  ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure,
  runElectronProductionPublicationRecoveryPublicMutationExecutionCli
} from "../scripts/electronProductionPublicationRecoveryPublicMutationExecutionCli.mjs";
import {
  writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization
} from "../scripts/electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  createPublicMutationAttemptAuthorizationFixture
} from "./support/electronProductionPublicationRecoveryPublicMutationAttemptAuthorizationFixture";
import {
  writeOutcomeDiscoveryFoundation
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("marker-bound public mutation execution CLI", () => {
  it("executes one created-now rollback and records the exact transport", async () => {
    const fixture = await executionFixture("rollback-public-latest", "created");
    const pre = observation(fixture, "target", "00:06:10");
    const final = observation(fixture, "source", "00:06:30");
    const rollback = createElectronProductionPublicLatestRecoveryRollback({
      finalObservation: final,
      finalObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(final),
      heldLease: fixture.base.heldLease,
      mutation: {
        submitted: true,
        releaseId: fixture.base.source.release.id,
        makeLatest: true,
        acknowledgement: "confirmed",
        submittedAt: "2026-09-01T00:06:15Z",
        resultRecordedAt: "2026-09-01T00:06:20Z",
        reason: "applied-response",
        httpStatus: 200
      },
      preObservation: pre,
      preObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(pre),
      ...snapshotBindings(fixture)
    });
    const rollbackRecovery = vi.fn(async () => ({
      preObservation: pre,
      finalObservation: final,
      rollback
    }));

    const summary = await runCaptured([
      "execute",
      ...baseArguments(fixture)
    ], {
      clock: sequenceClock("2026-09-01T00:06:40Z"),
      rollbackRecovery
    });

    expect(rollbackRecovery).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      command: "execute",
      operation: "rollback-public-latest",
      mode: "actual-transport",
      acknowledgement: "confirmed",
      finalObservation: "source"
    });
    const operation = await readOutput(fixture, summary.output.sha256);
    expect(operation.value.transport?.receipt).toEqual(rollback);

    const verified = await runCaptured([
      "verify",
      ...foundationArguments(fixture),
      "--operation", fixture.output,
      "--operation-sha256", summary.output.sha256
    ]);
    expect(verified).toMatchObject({
      command: "verify",
      status: "verified",
      output: summary.output
    });
    await expect(runCaptured([
      "verify",
      ...foundationArguments(fixture),
      "--operation", fixture.output,
      "--operation-sha256", "f".repeat(64)
    ])).rejects.toThrow("expected SHA-256");

    const secondRollback = vi.fn();
    await expect(runCaptured([
      "execute",
      ...baseArguments(fixture)
    ], {
      clock: sequenceClock("2026-09-01T00:07:00Z"),
      rollbackRecovery: secondRollback
    })).rejects.toThrow("must be create-new");
    expect(secondRollback).not.toHaveBeenCalled();
  });

  it("never mutates for a resumed rollback marker", async () => {
    const fixture = await executionFixture("rollback-public-latest", "resumed");
    const final = observation(fixture, "target", "00:08:30");
    const rollbackRecovery = vi.fn();
    const runLeaseRemote = vi.fn();
    const failure = await runFailure([
      "execute",
      ...baseArguments(fixture)
    ], {
      clock: sequenceClock("2026-09-01T00:08:40Z"),
      observeRecovery: async () => final,
      rollbackRecovery,
      runLeaseRemote
    });

    expect(rollbackRecovery).not.toHaveBeenCalled();
    expect(runLeaseRemote).not.toHaveBeenCalled();
    expect(failure.summary).toMatchObject({
      mode: "marker-reconciliation",
      acknowledgement: "unknown"
    });
    const operation = await readOutput(
      fixture,
      failure.summary.output.sha256
    );
    expect(operation.value.transport).toBeNull();
    expect(operation.value.result.mutation.submitted).toBe("possibly");
  });

  it("executes one created-now release PUT only after an exact source read", async () => {
    const fixture = await executionFixture("release-held-lease", "created");
    const before = observation(fixture, "source", "00:06:20");
    const remote = releaseRemoteSummary(fixture, "2026-09-01T00:06:20Z");
    const runLeaseRemote = vi.fn(async () => remote);
    const releasedDirectory = path.join(fixture.root, "released");
    await mkdir(releasedDirectory);
    const summary = await runCaptured([
      "execute",
      ...baseArguments(fixture),
      "--released-lease-output", path.join(releasedDirectory,
        "electron-production-public-latest-lease.json")
    ], {
      clock: sequenceClock(
        "2026-09-01T00:06:20Z",
        "2026-09-01T00:06:30Z"
      ),
      observeRecovery: async () => before,
      runLeaseRemote
    });

    expect(runLeaseRemote).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      mode: "actual-transport",
      acknowledgement: "confirmed",
      finalObservation: "source"
    });
  });

  it("records a created precondition rejection without a release request", async () => {
    const fixture = await executionFixture("release-held-lease", "created");
    const runLeaseRemote = vi.fn();
    const releasedDirectory = path.join(fixture.root, "released");
    await mkdir(releasedDirectory);
    const failure = await runFailure([
      "execute",
      ...baseArguments(fixture),
      "--released-lease-output", path.join(releasedDirectory,
        "electron-production-public-latest-lease.json")
    ], {
      clock: sequenceClock("2026-09-01T00:06:30Z"),
      observeRecovery: async () => observation(fixture, "target", "00:06:20"),
      runLeaseRemote
    });

    expect(runLeaseRemote).not.toHaveBeenCalled();
    expect(failure.summary).toMatchObject({
      mode: "precondition-rejected",
      acknowledgement: "rejected",
      finalObservation: "target"
    });
  });

  it("reconciles an exact post-reservation released successor with zero PUT", async () => {
    const fixture = await executionFixture("release-held-lease", "resumed");
    const successor = releasedSuccessor(fixture, "2026-09-01T00:08:20Z");
    const runLeaseRemote = vi.fn();
    const summary = await runCaptured([
      "execute",
      ...baseArguments(fixture)
    ], {
      clock: sequenceClock("2026-09-01T00:08:40Z"),
      observeRecovery: async () => observation(fixture, "source", "00:08:30"),
      observeLeaseSuccessor: async () => ({
        outcome: "observed" as const,
        blobSha: successor.blobSha,
        bytes: successor.bytes,
        lease: successor.lease
      }),
      runLeaseRemote
    });

    expect(runLeaseRemote).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      mode: "marker-reconciliation",
      acknowledgement: "confirmed",
      finalObservation: "source"
    });
  });

  it("does not attribute a released successor that predates the marker", async () => {
    const fixture = await executionFixture("release-held-lease", "resumed");
    const successor = releasedSuccessor(fixture, "2026-09-01T00:04:40Z");
    const failure = await runFailure([
      "execute",
      ...baseArguments(fixture)
    ], {
      clock: sequenceClock("2026-09-01T00:08:40Z"),
      observeRecovery: async () => observation(fixture, "source", "00:08:30"),
      observeLeaseSuccessor: async () => ({
        outcome: "observed" as const,
        blobSha: successor.blobSha,
        bytes: successor.bytes,
        lease: successor.lease
      })
    });

    expect(failure.summary).toMatchObject({
      mode: "marker-reconciliation",
      acknowledgement: "unknown"
    });
  });

  it("rejects caller-selected event times and cross-run replay before network", async () => {
    const fixture = await executionFixture("rollback-public-latest", "created");
    const rollbackRecovery = vi.fn();
    await expect(runCaptured([
      "execute",
      ...baseArguments(fixture),
      "--resolved-at", "2026-09-01T00:07:00Z"
    ], { rollbackRecovery })).rejects.toThrow("Unknown execute option");
    expect(rollbackRecovery).not.toHaveBeenCalled();

    const replay = baseArguments(fixture);
    const runIdIndex = replay.indexOf("--current-run-id") + 1;
    replay[runIdIndex] = "another-run";
    await expect(runCaptured([
      "execute",
      ...replay
    ], { rollbackRecovery })).rejects.toThrow(
      "current public-mutation run does not match"
    );
    expect(rollbackRecovery).not.toHaveBeenCalled();
  });
});

async function executionFixture(
  operation: "release-held-lease" | "rollback-public-latest",
  mode: "created" | "resumed"
) {
  const base = await createPublicMutationAttemptAuthorizationFixture({ operation });
  temporaryDirectories.push(base.root);
  const foundation = await writeOutcomeDiscoveryFoundation(base.root, base);
  const authorization = mode === "created"
    ? base.createdAuthorization
    : base.resumedAuthorization;
  await mkdir(path.join(base.root, "authorization"));
  const authorizationFile =
    await writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
      outputPath: path.join(base.root, "authorization",
        "electron-production-publication-recovery-public-mutation-attempt-authorization.json"),
      value: authorization
    });
  return {
    authorization,
    authorizationFile,
    base,
    foundation,
    root: base.root,
    output: path.join(base.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_PUBLIC_MUTATION_OPERATION_FILE)
  };
}

function baseArguments(
  fixture: Awaited<ReturnType<typeof executionFixture>>
) {
  return [
    ...foundationArguments(fixture),
    "--output", fixture.output
  ];
}

function foundationArguments(
  fixture: Awaited<ReturnType<typeof executionFixture>>
) {
  const run = fixture.authorization.currentRun;
  return [
    "--authorization", fixture.authorizationFile.valuePath,
    "--authorization-sha256", fixture.authorizationFile.valueIdentity.sha256,
    "--held-lease", fixture.foundation.heldLease,
    "--held-lease-sha256", fixture.foundation.heldLeaseSha256,
    "--source-snapshot", fixture.foundation.sourceSnapshot,
    "--source-snapshot-sha256", fixture.foundation.sourceSnapshotSha256,
    "--target-snapshot", fixture.foundation.targetSnapshot,
    "--target-snapshot-sha256", fixture.foundation.targetSnapshotSha256,
    "--current-run-repository", run.repository,
    "--current-run-workflow", run.workflow,
    "--current-run-id", run.runId,
    "--current-run-attempt", String(run.runAttempt),
    "--current-control-sha", run.controlSha,
    "--current-run-started-at", run.startedAt
  ];
}

function snapshotBindings(
  fixture: Awaited<ReturnType<typeof executionFixture>>
) {
  return {
    sourceSnapshot: fixture.base.source,
    sourceSnapshotFileSha256: fixture.foundation.sourceSnapshotSha256,
    targetSnapshot: fixture.base.target,
    targetSnapshotFileSha256: fixture.foundation.targetSnapshotSha256
  };
}

function observation(
  fixture: Awaited<ReturnType<typeof executionFixture>>,
  classification: "source" | "target",
  time: string
) {
  const snapshot = classification === "source"
    ? fixture.base.source
    : fixture.base.observedTarget;
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
    ...snapshotBindings(fixture)
  });
}

function releasedSuccessor(
  fixture: Awaited<ReturnType<typeof executionFixture>>,
  recordedAt: string
) {
  const held = fixture.base.heldLease;
  const lease = releaseElectronProductionPublicLatestLease(held, {
    transactionId: held.transactionId,
    leaseId: held.leaseId,
    generation: held.generation,
    sourceStateSha256: held.source.stateSha256,
    targetStateSha256: held.target.stateSha256,
    recordedAt
  });
  const source = serializeElectronProductionPublicLatestLease(lease);
  return {
    lease,
    bytes: source.length,
    fileSha256: digest(source),
    blobSha: createHash("sha1")
      .update(`blob ${source.length}\0`).update(source).digest("hex")
  };
}

function releaseRemoteSummary(
  fixture: Awaited<ReturnType<typeof executionFixture>>,
  attemptedAt: string
) {
  const held = fixture.base.heldLease;
  const successor = releasedSuccessor(fixture, attemptedAt);
  return {
    schemaVersion: 1 as const,
    kind: "rion-electron-production-public-latest-lease-remote-operation" as const,
    command: "release" as const,
    request: {
      attemptedAt,
      held: {
        transactionId: held.transactionId,
        leaseId: held.leaseId,
        generation: held.generation,
        revision: held.revision,
        eventSha256: electronProductionPublicLatestLeaseEventSha256(held),
        sourceStateSha256: held.source.stateSha256,
        targetStateSha256: held.target.stateSha256
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
      eventSha256:
        electronProductionPublicLatestLeaseEventSha256(successor.lease)
    },
    output: {
      bytes: successor.bytes,
      fileName: "electron-production-public-latest-lease.json" as const,
      sha256: successor.fileSha256
    }
  };
}

async function readOutput(
  fixture: Awaited<ReturnType<typeof executionFixture>>,
  sha256: string
) {
  return readElectronProductionPublicationRecoveryPublicMutationOperation({
    expectedSha256: sha256,
    receiptPath: fixture.output
  });
}

async function runCaptured(
  argumentsList: readonly string[],
  overrides: Parameters<
    typeof runElectronProductionPublicationRecoveryPublicMutationExecutionCli
  >[1] = {}
) {
  return runElectronProductionPublicationRecoveryPublicMutationExecutionCli(
    argumentsList,
    {
      environment: { GH_TOKEN: "test-token" },
      writeStdout: () => undefined,
      ...overrides
    }
  );
}

async function runFailure(
  argumentsList: readonly string[],
  overrides: Parameters<
    typeof runElectronProductionPublicationRecoveryPublicMutationExecutionCli
  >[1] = {}
) {
  try {
    await runCaptured(argumentsList, overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(
      ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure
    );
    return error as ElectronProductionPublicationRecoveryPublicMutationExecutionCliFailure;
  }
  throw new Error("Expected the public mutation execution to fail closed.");
}

function digest(source: Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function sequenceClock(...values: string[]) {
  let index = 0;
  return vi.fn(() => {
    const value = values[index];
    if (value === undefined) throw new Error("The test clock was exhausted.");
    index += 1;
    return value;
  });
}
