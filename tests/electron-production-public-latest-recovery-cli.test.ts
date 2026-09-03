import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  acquireElectronProductionPublicLatestLease,
  releaseElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease,
  type ElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE,
  assertElectronProductionPublicLatestLeaseReleaseOperationBindings,
  readElectronProductionPublicLatestLeaseReleaseOperation
} from "../scripts/electronProductionPublicLatestLeaseReleaseOperation.mjs";
import type {
  ElectronProductionPublicLatestLeaseRemoteFetch
} from "../scripts/electronProductionPublicLatestLeaseRemote.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE,
  electronProductionPublicLatestRecoveryObservationSha256,
  readElectronProductionPublicLatestRecoveryObservation,
  readElectronProductionPublicLatestRecoveryRollback
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_CLI_SUMMARY_KIND,
  ElectronProductionPublicLatestRecoveryCliFailure,
  runElectronProductionPublicLatestRecoveryCli,
  type ElectronProductionPublicLatestRecoveryCliSummary,
  type ElectronProductionPublicLatestRecoveryObservationCliSummary
} from "../scripts/electronProductionPublicLatestRecoveryCli.mjs";
import {
  type ElectronProductionPublicLatestRecoveryFetch
} from "../scripts/electronProductionPublicLatestRecoveryRemote.mjs";
import {
  electronProductionPublicationRecoveryOutcomeAttemptFileName,
  writeElectronProductionPublicationRecoveryOutcomeAttempt
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  RECOVERY_FIXTURE_TOKEN,
  githubTagReference
} from "./support/electronProductionPublicLatestRecoveryFixture";
import {
  assetResponses,
  createPublicLatestRecoveryCliFixture,
  jsonResponse,
  leaseContentResponse,
  leaseJsonResponse,
  repositoryResponse,
  sequenceFetch,
  sequenceLeaseFetch
} from "./support/electronProductionPublicLatestRecoveryCliRemote";
import {
  createLeaseReleaseAuthorizationFixture
} from "./support/electronProductionPublicationRecoveryLeaseReleaseAuthorizationFixture";

const temporaryDirectories: string[] = [];
type AuthorizationFile = Awaited<
  ReturnType<typeof createLeaseReleaseAuthorizationFixture>
>["authorizationFile"];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production public-latest recovery CLI", () => {
  it("writes a canonical exact observation with redacted stdout", async () => {
    const fixture = await fixtureWithFiles();
    const remote = targetObservationRemote(fixture);
    const stdout: Buffer[] = [];
    const outputRoot = path.join(fixture.root, "observation-output");
    await mkdir(outputRoot);
    const output = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    );

    const summary = observationSummary(
      await runElectronProductionPublicLatestRecoveryCli(
      observeArgs(fixture, output),
      dependencies(remote.fetchImpl, stdout)
      )
    );

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_CLI_SUMMARY_KIND,
      command: "observe",
      status: "recorded",
      evidence: {
        observation: "target",
        observationTransport: "observed",
        rollbackAcknowledgement: null
      },
      outputs: {
        observation: {
          fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
        },
        rollback: null
      }
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]!.toString("utf8")).not.toContain(RECOVERY_FIXTURE_TOKEN);
    expect(stdout[0]!.toString("utf8")).not.toContain(
      fixture.heldLease.transactionId
    );
    const receipt = await readElectronProductionPublicLatestRecoveryObservation({
      expectedSha256: summary.outputs.observation.sha256,
      receiptPath: output
    });
    expect(receipt.receipt.observation.classification).toBe("target");
    await expect(runElectronProductionPublicLatestRecoveryCli(
      observeArgs(fixture, output),
      dependencies(targetObservationRemote(fixture).fetchImpl, [])
    )).rejects.toThrow("must be create-new");
  });

  it("records one exact rollback mutation and a fresh source observation", async () => {
    const fixture = await fixtureWithFiles();
    const preRoot = path.join(fixture.root, "pre-observation");
    await mkdir(preRoot);
    const prePath = path.join(
      preRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    );
    const preSummary = observationSummary(
      await runElectronProductionPublicLatestRecoveryCli(
      observeArgs(fixture, prePath),
      dependencies(targetObservationRemote(fixture).fetchImpl, [])
      )
    );
    const outputRoot = path.join(fixture.root, "rollback-output");
    await mkdir(outputRoot);
    const finalPath = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    );
    const rollbackPath = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_FILE
    );
    const remote = sequenceFetch(
      repositoryResponse(),
      jsonResponse(fixture.targetApi),
      jsonResponse(githubTagReference(fixture.target)),
      ...assetResponses(fixture.target, fixture.targetSources),
      repositoryResponse(),
      leaseContentResponse(fixture.heldLease),
      jsonResponse({
        id: Number(fixture.source.release.id),
        tag_name: fixture.source.release.tag,
        draft: false,
        prerelease: false
      }),
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources)
    );
    const stdout: Buffer[] = [];

    const summary = observationSummary(
      await runElectronProductionPublicLatestRecoveryCli([
      "rollback",
      "--source-snapshot", fixture.sourceFile.path,
      "--source-snapshot-sha256", fixture.sourceFile.sha256,
      "--target-snapshot", fixture.targetFile.path,
      "--target-snapshot-sha256", fixture.targetFile.sha256,
      "--held-lease", fixture.leaseFile.path,
      "--held-lease-sha256", fixture.leaseFile.sha256,
      "--pre-observation", prePath,
      "--pre-observation-sha256", preSummary.outputs.observation.sha256,
      "--submitted-at", "2026-09-01T00:05:00Z",
      "--result-recorded-at", "2026-09-01T00:06:00Z",
      "--final-observed-at", "2026-09-01T00:07:00Z",
      "--final-observation-output", finalPath,
      "--output", rollbackPath
      ], dependencies(remote.fetchImpl, stdout))
    );

    expect(summary.evidence).toEqual({
      observation: "source",
      observationTransport: "observed",
      rollbackAcknowledgement: "confirmed"
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]!.toString("utf8")).not.toContain(RECOVERY_FIXTURE_TOKEN);
    const receipt = await readElectronProductionPublicLatestRecoveryRollback({
      expectedSha256: summary.outputs.rollback!.sha256,
      receiptPath: rollbackPath
    });
    expect(receipt.receipt.mutation).toMatchObject({
      acknowledgement: "confirmed",
      releaseId: fixture.source.release.id,
      makeLatest: true
    });
    expect(receipt.receipt.final.classification).toBe("source");
    expect(Object.hasOwn(receipt.receipt, "terminal")).toBe(false);
    expect(Object.hasOwn(receipt.receipt, "safeToReleaseLease")).toBe(false);
    const patchCalls = remote.calls.filter(({ init }) => init.method === "PATCH");
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]!.init.body).toBe(JSON.stringify({ make_latest: "true" }));

    const retryRoot = path.join(fixture.root, "rollback-preflight-retry");
    await mkdir(retryRoot);
    const unused = sequenceFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli([
      "rollback",
      "--source-snapshot", fixture.sourceFile.path,
      "--source-snapshot-sha256", fixture.sourceFile.sha256,
      "--target-snapshot", fixture.targetFile.path,
      "--target-snapshot-sha256", fixture.targetFile.sha256,
      "--held-lease", fixture.leaseFile.path,
      "--held-lease-sha256", fixture.leaseFile.sha256,
      "--pre-observation", prePath,
      "--pre-observation-sha256", preSummary.outputs.observation.sha256,
      "--submitted-at", "2026-09-01T00:08:00Z",
      "--result-recorded-at", "2026-09-01T00:09:00Z",
      "--final-observed-at", "2026-09-01T00:10:00Z",
      "--final-observation-output", path.join(
        retryRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
      ),
      "--output", rollbackPath
    ], dependencies(unused.fetchImpl, []))).rejects.toThrow("must be create-new");
    expect(unused.calls).toEqual([]);
  });

  it("reuses the lease CAS authority and records an exact released successor", async () => {
    const fixture = await fixtureWithFiles();
    const attemptedAt = "2026-09-01T00:10:00Z";
    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      {
        transactionId: fixture.heldLease.transactionId,
        leaseId: fixture.heldLease.leaseId,
        generation: fixture.heldLease.generation,
        sourceStateSha256: fixture.heldLease.source.stateSha256,
        targetStateSha256: fixture.heldLease.target.stateSha256,
        recordedAt: attemptedAt
      }
    );
    const remote = sequenceLeaseFetch(
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources),
      leaseContentResponse(fixture.heldLease),
      leaseJsonResponse({}, 200),
      leaseContentResponse(released)
    );
    const outputRoot = path.join(fixture.root, "lease-release-output");
    await mkdir(outputRoot);
    const releasedPath = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
    );
    const operationPath = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
    );
    const stdout: Buffer[] = [];

    const summary = await runElectronProductionPublicLatestRecoveryCli([
      "release-lease",
      "--source-snapshot", fixture.sourceFile.path,
      "--source-snapshot-sha256", fixture.sourceFile.sha256,
      "--target-snapshot", fixture.targetFile.path,
      "--target-snapshot-sha256", fixture.targetFile.sha256,
      "--held-lease", fixture.leaseFile.path,
      "--held-lease-sha256", fixture.leaseFile.sha256,
      "--release-authorization", fixture.authorizationFile.path,
      "--release-authorization-sha256", fixture.authorizationFile.sha256,
      ...currentRunArgs(fixture.authorizationFile.currentRun),
      "--attempted-at", attemptedAt,
      "--released-lease-output", releasedPath,
      "--output", operationPath
    ], dependencies(remote.fetchImpl, stdout));

    expect(summary).toMatchObject({
      command: "release-lease",
      status: "recorded",
      evidence: { acknowledgement: "confirmed" },
      outputs: {
        operation: {
          fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
        },
        releasedLease: { fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE }
      }
    });
    if (summary.command !== "release-lease") {
      throw new Error("Expected a lease-release CLI summary.");
    }
    const operation = await readElectronProductionPublicLatestLeaseReleaseOperation({
      expectedSha256: summary.outputs.operation.sha256,
      operationPath
    });
    expect(operation.operation.acknowledgement).toBe("confirmed");
    expect(operation.operation.successor?.lease).toEqual(released);
    expect(operation.operation.recoveryOperation.sha256).toBe(
      operation.operation.preReleaseObservation.sha256
    );
    expect(operation.operation.recoveryOperation.sha256).toBe(
      electronProductionPublicLatestRecoveryObservationSha256(
        operation.operation.preReleaseObservation.receipt
      )
    );
    expect(operation.operation.preReleaseObservation.receipt.observation)
      .toMatchObject({ classification: "source" });
    const replayLease = acquireElectronProductionPublicLatestLease({
      holder: fixture.heldLease.holder,
      leaseId: "70000000-0000-4000-8000-000000000007",
      previous: null,
      purpose: fixture.heldLease.purpose,
      recordedAt: fixture.heldLease.recordedAt,
      source: fixture.heldLease.source,
      target: fixture.heldLease.target,
      transactionId: "80000000-0000-4000-8000-000000000008",
      vacantGeneration: 0
    });
    expect(() =>
      assertElectronProductionPublicLatestLeaseReleaseOperationBindings({
        heldLease: replayLease,
        operation: operation.operation,
        recoveryOperation: operation.operation.recoveryOperation,
        sourceSnapshot: fixture.source,
        sourceSnapshotFileSha256: fixture.sourceFile.sha256,
        targetSnapshot: fixture.target,
        targetSnapshotFileSha256: fixture.targetFile.sha256
      })
    ).toThrow("held binding");
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]!.toString("utf8")).not.toContain(RECOVERY_FIXTURE_TOKEN);
    expect(remote.calls.filter(({ init }) => init.method === "PUT")).toHaveLength(1);

    const secondLeaseRoot = path.join(outputRoot, "second-lease");
    await mkdir(secondLeaseRoot);
    const noMutation = sequenceLeaseFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli([
      "release-lease",
      "--source-snapshot", fixture.sourceFile.path,
      "--source-snapshot-sha256", fixture.sourceFile.sha256,
      "--target-snapshot", fixture.targetFile.path,
      "--target-snapshot-sha256", fixture.targetFile.sha256,
      "--held-lease", fixture.leaseFile.path,
      "--held-lease-sha256", fixture.leaseFile.sha256,
      "--release-authorization", fixture.authorizationFile.path,
      "--release-authorization-sha256", fixture.authorizationFile.sha256,
      ...currentRunArgs(fixture.authorizationFile.currentRun),
      "--attempted-at", "2026-09-01T00:11:00Z",
      "--released-lease-output", path.join(
        secondLeaseRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
      ),
      "--output", operationPath
    ], dependencies(noMutation.fetchImpl, []))).rejects.toThrow("must be create-new");
    expect(noMutation.calls).toEqual([]);

    const mismatchedRoot = path.join(fixture.root, "mismatched-held-lease");
    await mkdir(mismatchedRoot);
    const mismatchedLease = acquireElectronProductionPublicLatestLease({
      holder: fixture.heldLease.holder,
      leaseId: fixture.heldLease.leaseId,
      previous: null,
      purpose: fixture.heldLease.purpose,
      recordedAt: fixture.heldLease.recordedAt,
      source: fixture.heldLease.source,
      target: {
        ...fixture.heldLease.target,
        stateSha256: "f".repeat(64)
      },
      transactionId: fixture.heldLease.transactionId,
      vacantGeneration: 0
    });
    const mismatchedFile = await writeElectronProductionPublicLatestLease({
      lease: mismatchedLease,
      outputPath: path.join(
        mismatchedRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
      )
    });
    const unused = sequenceLeaseFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli([
      "release-lease",
      "--source-snapshot", fixture.sourceFile.path,
      "--source-snapshot-sha256", fixture.sourceFile.sha256,
      "--target-snapshot", fixture.targetFile.path,
      "--target-snapshot-sha256", fixture.targetFile.sha256,
      "--held-lease", mismatchedFile.leasePath,
      "--held-lease-sha256", mismatchedFile.leaseIdentity.sha256,
      "--release-authorization", fixture.authorizationFile.path,
      "--release-authorization-sha256", fixture.authorizationFile.sha256,
      ...currentRunArgs(fixture.authorizationFile.currentRun),
      "--attempted-at", attemptedAt,
      "--released-lease-output", path.join(
        mismatchedRoot,
        "released",
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
      ),
      "--output", path.join(
        mismatchedRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
      )
    ], dependencies(unused.fetchImpl, []))).rejects.toThrow(
      "held event SHA-256 does not match"
    );
    expect(unused.calls).toEqual([]);
  });

  it("persists a rejected lease-release operation without claiming a successor", async () => {
    const fixture = await fixtureWithFiles();
    const outputRoot = path.join(fixture.root, "rejected-release-output");
    await mkdir(outputRoot);
    const releasedPath = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
    );
    const operationPath = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
    );
    const remote = sequenceLeaseFetch(
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources),
      leaseContentResponse(fixture.heldLease),
      leaseJsonResponse({ message: "conflict secret" }, 409)
    );
    const stdout: Buffer[] = [];
    const exitCodes: number[] = [];
    let failure: unknown;
    try {
      await runElectronProductionPublicLatestRecoveryCli([
        "release-lease",
        "--source-snapshot", fixture.sourceFile.path,
        "--source-snapshot-sha256", fixture.sourceFile.sha256,
        "--target-snapshot", fixture.targetFile.path,
        "--target-snapshot-sha256", fixture.targetFile.sha256,
        "--held-lease", fixture.leaseFile.path,
        "--held-lease-sha256", fixture.leaseFile.sha256,
        "--release-authorization", fixture.authorizationFile.path,
        "--release-authorization-sha256", fixture.authorizationFile.sha256,
        ...currentRunArgs(fixture.authorizationFile.currentRun),
        "--attempted-at", "2026-09-01T00:10:00Z",
        "--released-lease-output", releasedPath,
        "--output", operationPath
      ], dependencies(remote.fetchImpl, stdout, exitCodes));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ElectronProductionPublicLatestRecoveryCliFailure);
    expect(exitCodes).toEqual([1]);
    const summary = (failure as ElectronProductionPublicLatestRecoveryCliFailure)
      .summary;
    if (summary.command !== "release-lease") {
      throw new Error("Expected a lease-release failure summary.");
    }
    expect(summary.evidence.acknowledgement).toBe("rejected");
    const operation = await readElectronProductionPublicLatestLeaseReleaseOperation({
      expectedSha256: summary.outputs.operation.sha256,
      operationPath
    });
    expect(operation.operation.successor).toBeNull();
    expect(Object.hasOwn(operation.operation, "terminal")).toBe(false);
    await expect(readFile(releasedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(stdout[0]!.toString("utf8")).not.toContain("conflict secret");
  });

  it("reconciles an unknown release acknowledgement by exact reread without PUT", async () => {
    const fixture = await fixtureWithFiles();
    const attemptedAt = "2026-09-01T00:10:00Z";
    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      {
        transactionId: fixture.heldLease.transactionId,
        leaseId: fixture.heldLease.leaseId,
        generation: fixture.heldLease.generation,
        sourceStateSha256: fixture.heldLease.source.stateSha256,
        targetStateSha256: fixture.heldLease.target.stateSha256,
        recordedAt: attemptedAt
      }
    );
    const firstRoot = path.join(fixture.root, "unknown-release-attempt");
    await mkdir(firstRoot);
    const firstOperationPath = path.join(
      firstRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
    );
    const firstRemote = sequenceLeaseFetch(
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources),
      leaseContentResponse(fixture.heldLease),
      new Error("ambiguous write acknowledgement"),
      leaseContentResponse(fixture.heldLease)
    );
    let firstFailure: unknown;
    try {
      await runElectronProductionPublicLatestRecoveryCli([
        "release-lease",
        "--source-snapshot", fixture.sourceFile.path,
        "--source-snapshot-sha256", fixture.sourceFile.sha256,
        "--target-snapshot", fixture.targetFile.path,
        "--target-snapshot-sha256", fixture.targetFile.sha256,
        "--held-lease", fixture.leaseFile.path,
        "--held-lease-sha256", fixture.leaseFile.sha256,
        "--release-authorization", fixture.authorizationFile.path,
        "--release-authorization-sha256", fixture.authorizationFile.sha256,
        ...currentRunArgs(fixture.authorizationFile.currentRun),
        "--attempted-at", attemptedAt,
        "--released-lease-output", path.join(
          firstRoot,
          ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
        ),
        "--output", firstOperationPath
      ], dependencies(firstRemote.fetchImpl, []));
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(
      ElectronProductionPublicLatestRecoveryCliFailure
    );
    const firstSummary = (firstFailure as
      ElectronProductionPublicLatestRecoveryCliFailure).summary;
    if (firstSummary.command !== "release-lease") {
      throw new Error("Expected an unknown lease-release summary.");
    }
    expect(firstSummary.evidence.acknowledgement).toBe("unknown");
    const firstOperation =
      await readElectronProductionPublicLatestLeaseReleaseOperation({
        expectedSha256: firstSummary.outputs.operation.sha256,
        operationPath: firstOperationPath
      });
    const unknownOutcome = fixture.createOutcome({
      runId: "9401",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: attemptedAt,
      determinedAt: "2026-09-01T00:11:00Z",
      recoveryOperation: firstOperation.operation.recoveryOperation,
      leaseRelease: {
        attempted: true,
        acknowledgement: "unknown",
        attemptedAt,
        operationSha256: firstSummary.outputs.operation.sha256,
        resolvedAt: firstOperation.operation.resolvedAt,
        successorEventSha256: null
      }
    });
    const outcomeRoot = path.join(fixture.root, "durable-unknown-outcome");
    await mkdir(outcomeRoot);
    const outcomeFile =
      await writeElectronProductionPublicationRecoveryOutcomeAttempt({
        outputPath: path.join(
          outcomeRoot,
          electronProductionPublicationRecoveryOutcomeAttemptFileName(
            unknownOutcome.recoveryRun
          )
        ),
        receipt: unknownOutcome
      });
    const resumedAuthority = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.releaseIntent.authorizedAt,
      fixture,
      freshEntries: [fixture.entry(unknownOutcome)],
      intent: fixture.releaseIntent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.releaseIntent.recoveryRun.startedAt,
      suffix: "unknown-reconcile",
      verifiedAt: "2026-09-01T00:11:30Z"
    });

    const heldRoot = path.join(fixture.root, "held-release-reconciliation");
    await mkdir(heldRoot);
    const heldRemote = sourceAndLeaseRemote(fixture, fixture.heldLease);
    let heldFailure: unknown;
    try {
      await runElectronProductionPublicLatestRecoveryCli([
        ...reconcileArgs(fixture, resumedAuthority.authorizationFile,
          heldRoot, "2026-09-01T00:11:45Z"),
        "--previous-outcome", outcomeFile.receiptPath,
        "--previous-outcome-sha256", outcomeFile.receiptIdentity.sha256
      ], dependencies(heldRemote.fetchImpl, []));
    } catch (error) {
      heldFailure = error;
    }
    expect(heldFailure).toBeInstanceOf(
      ElectronProductionPublicLatestRecoveryCliFailure
    );
    expect((heldFailure as ElectronProductionPublicLatestRecoveryCliFailure)
      .summary).toMatchObject({
      command: "reconcile-lease-release",
      evidence: { acknowledgement: "unknown" }
    });
    expect(heldRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);

    const secondRoot = path.join(fixture.root, "release-reconciliation");
    await mkdir(secondRoot);
    const secondRemote = sequenceLeaseFetch(
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources),
      leaseContentResponse(released)
    );
    const reconciled = await runElectronProductionPublicLatestRecoveryCli([
      "reconcile-lease-release",
      "--source-snapshot", fixture.sourceFile.path,
      "--source-snapshot-sha256", fixture.sourceFile.sha256,
      "--target-snapshot", fixture.targetFile.path,
      "--target-snapshot-sha256", fixture.targetFile.sha256,
      "--held-lease", fixture.leaseFile.path,
      "--held-lease-sha256", fixture.leaseFile.sha256,
      "--release-authorization", resumedAuthority.authorizationFile.path,
      "--release-authorization-sha256",
      resumedAuthority.authorizationFile.sha256,
      ...currentRunArgs(resumedAuthority.authorizationFile.currentRun),
      "--previous-outcome", outcomeFile.receiptPath,
      "--previous-outcome-sha256", outcomeFile.receiptIdentity.sha256,
      "--observed-at", "2026-09-01T00:12:00Z",
      "--released-lease-output", path.join(
        secondRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
      ),
      "--output", path.join(
        secondRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
      )
    ], dependencies(secondRemote.fetchImpl, []));

    expect(reconciled).toMatchObject({
      command: "reconcile-lease-release",
      evidence: { acknowledgement: "confirmed" }
    });
    expect(secondRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);
  });

  it("taints the durable chain when an accepted release is overtaken on readback", async () => {
    const fixture = await fixtureWithFiles();
    const attemptedAt = "2026-09-01T00:10:00Z";
    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      releaseInput(fixture, attemptedAt)
    );
    const laterHeld = acquireElectronProductionPublicLatestLease({
      holder: fixture.heldLease.holder,
      leaseId: "70000000-0000-4000-8000-000000000007",
      previous: released,
      purpose: fixture.heldLease.purpose,
      recordedAt: "2026-09-01T00:10:30Z",
      source: fixture.heldLease.source,
      target: fixture.heldLease.target,
      transactionId: "80000000-0000-4000-8000-000000000008",
      vacantGeneration: released.generation
    });
    const firstRoot = path.join(fixture.root, "accepted-overtaken-release");
    await mkdir(firstRoot);
    const operationPath = path.join(
      firstRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
    );
    const remote = sequenceLeaseFetch(
      repositoryResponse(),
      jsonResponse(fixture.sourceApi),
      jsonResponse(githubTagReference(fixture.source)),
      ...assetResponses(fixture.source, fixture.sourceSources),
      leaseContentResponse(fixture.heldLease),
      leaseJsonResponse({}, 200),
      leaseContentResponse(laterHeld)
    );
    let failure: unknown;
    try {
      await runElectronProductionPublicLatestRecoveryCli(
        releaseArgs(
          fixture,
          fixture.authorizationFile,
          firstRoot,
          attemptedAt
        ),
        dependencies(remote.fetchImpl, [])
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(
      ElectronProductionPublicLatestRecoveryCliFailure
    );
    const summary = (failure as ElectronProductionPublicLatestRecoveryCliFailure)
      .summary;
    if (summary.command !== "release-lease") {
      throw new Error("Expected an unknown lease-release summary.");
    }
    expect(summary.evidence.acknowledgement).toBe("unknown");
    expect(remote.calls.filter(({ init }) => init.method === "PUT"))
      .toHaveLength(1);
    const operation =
      await readElectronProductionPublicLatestLeaseReleaseOperation({
        expectedSha256: summary.outputs.operation.sha256,
        operationPath
      });
    expect(operation.operation.acknowledgement).toBe("unknown");

    const unknownOutcome = fixture.createOutcome({
      runId: "9431",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: attemptedAt,
      determinedAt: "2026-09-01T00:11:00Z",
      recoveryOperation: operation.operation.recoveryOperation,
      leaseRelease: {
        attempted: true,
        acknowledgement: "unknown",
        attemptedAt,
        operationSha256: summary.outputs.operation.sha256,
        resolvedAt: operation.operation.resolvedAt,
        successorEventSha256: null
      }
    });
    const outcomeRoot = path.join(fixture.root, "accepted-overtaken-outcome");
    await mkdir(outcomeRoot);
    const outcomeFile =
      await writeElectronProductionPublicationRecoveryOutcomeAttempt({
        outputPath: path.join(
          outcomeRoot,
          electronProductionPublicationRecoveryOutcomeAttemptFileName(
            unknownOutcome.recoveryRun
          )
        ),
        receipt: unknownOutcome
      });
    const resumed = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.releaseIntent.authorizedAt,
      fixture,
      freshEntries: [fixture.entry(unknownOutcome)],
      intent: fixture.releaseIntent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.releaseIntent.recoveryRun.startedAt,
      suffix: "accepted-overtaken-taint",
      verifiedAt: "2026-09-01T00:11:30Z"
    });
    const retryRoot = path.join(fixture.root, "accepted-overtaken-retry");
    await mkdir(retryRoot);
    const unused = sequenceLeaseFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli([
      ...releaseArgs(fixture, resumed.authorizationFile,
        retryRoot, "2026-09-01T00:12:00Z"),
      "--previous-outcome", outcomeFile.receiptPath,
      "--previous-outcome-sha256", outcomeFile.receiptIdentity.sha256
    ], dependencies(unused.fetchImpl, []))).rejects.toThrow(
      "historically unknown release acknowledgement"
    );
    expect(unused.calls).toEqual([]);
  });

  it("reconciles a zero-chain released successor but rejects pre-intent and overtaken leases without PUT", async () => {
    const fixture = await fixtureWithFiles();
    const attemptedAt = "2026-09-01T00:10:00Z";
    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      releaseInput(fixture, attemptedAt)
    );
    const confirmedRoot = path.join(fixture.root, "zero-chain-confirmed");
    await mkdir(confirmedRoot);
    const confirmedRemote = sourceAndLeaseRemote(fixture, released);
    const confirmed = await runElectronProductionPublicLatestRecoveryCli([
      ...reconcileArgs(fixture, fixture.authorizationFile,
        confirmedRoot, "2026-09-01T00:12:00Z")
    ], dependencies(confirmedRemote.fetchImpl, []));

    expect(confirmed).toMatchObject({
      command: "reconcile-lease-release",
      evidence: { acknowledgement: "confirmed" }
    });
    expect(confirmedRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);

    const preIntentReleased = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      releaseInput(fixture, "2026-09-01T00:02:45Z")
    );
    const preIntentRoot = path.join(fixture.root, "zero-chain-pre-intent");
    await mkdir(preIntentRoot);
    const preIntentRemote = sourceAndLeaseRemote(fixture, preIntentReleased);
    await expect(runElectronProductionPublicLatestRecoveryCli(
      reconcileArgs(fixture, fixture.authorizationFile,
        preIntentRoot, "2026-09-01T00:13:00Z"),
      dependencies(preIntentRemote.fetchImpl, [])
    )).rejects.toThrow("precedes its durable intent");
    expect(preIntentRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);

    const laterHeld = acquireElectronProductionPublicLatestLease({
      holder: fixture.heldLease.holder,
      leaseId: "70000000-0000-4000-8000-000000000007",
      previous: released,
      purpose: fixture.heldLease.purpose,
      recordedAt: "2026-09-01T00:11:00Z",
      source: fixture.heldLease.source,
      target: fixture.heldLease.target,
      transactionId: "80000000-0000-4000-8000-000000000008",
      vacantGeneration: released.generation
    });
    const overtakenRoot = path.join(fixture.root, "zero-chain-overtaken");
    await mkdir(overtakenRoot);
    const overtakenRemote = sourceAndLeaseRemote(fixture, laterHeld);
    await expect(runElectronProductionPublicLatestRecoveryCli(
      reconcileArgs(fixture, fixture.authorizationFile,
        overtakenRoot, "2026-09-01T00:14:00Z"),
      dependencies(overtakenRemote.fetchImpl, [])
    )).rejects.toThrow("did not observe a released successor");
    expect(overtakenRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);
  });

  it("routes exact held and released states read-only and blocks a later successor with durable observation", async () => {
    const fixture = await fixtureWithFiles();
    const heldRoot = path.join(fixture.root, "route-held");
    await mkdir(heldRoot);
    const heldRemote = sourceAndLeaseRemote(fixture, fixture.heldLease);
    const held = await runElectronProductionPublicLatestRecoveryCli(
      routeArgs(fixture, fixture.authorizationFile,
        heldRoot, "2026-09-01T00:10:00Z"),
      dependencies(heldRemote.fetchImpl, [])
    );
    expect(held).toMatchObject({
      command: "route-lease-release",
      outputs: {
        observation: {
          fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
        }
      },
      evidence: {
        leaseObservation: "held",
        route: "release-held",
        reason: "exact-held"
      }
    });
    expect(heldRemote.calls.some(({ init }) => init.method === "PUT")).toBe(false);

    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      releaseInput(fixture, "2026-09-01T00:11:00Z")
    );
    const releasedRoot = path.join(fixture.root, "route-released");
    await mkdir(releasedRoot);
    const releasedRemote = sourceAndLeaseRemote(fixture, released);
    const routedReleased = await runElectronProductionPublicLatestRecoveryCli(
      routeArgs(fixture, fixture.authorizationFile,
        releasedRoot, "2026-09-01T00:12:00Z"),
      dependencies(releasedRemote.fetchImpl, [])
    );
    expect(routedReleased).toMatchObject({
      command: "route-lease-release",
      evidence: {
        leaseObservation: "released",
        route: "reconcile-released",
        reason: "exact-direct-successor"
      }
    });

    const laterHeld = acquireElectronProductionPublicLatestLease({
      holder: fixture.heldLease.holder,
      leaseId: "70000000-0000-4000-8000-000000000007",
      previous: released,
      purpose: fixture.heldLease.purpose,
      recordedAt: "2026-09-01T00:12:30Z",
      source: fixture.heldLease.source,
      target: fixture.heldLease.target,
      transactionId: "80000000-0000-4000-8000-000000000008",
      vacantGeneration: released.generation
    });
    const blockedRoot = path.join(fixture.root, "route-overtaken");
    await mkdir(blockedRoot);
    const blockedRemote = sourceAndLeaseRemote(fixture, laterHeld);
    let failure: unknown;
    try {
      await runElectronProductionPublicLatestRecoveryCli(
        routeArgs(fixture, fixture.authorizationFile,
          blockedRoot, "2026-09-01T00:13:00Z"),
        dependencies(blockedRemote.fetchImpl, [])
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ElectronProductionPublicLatestRecoveryCliFailure);
    expect((failure as ElectronProductionPublicLatestRecoveryCliFailure).summary)
      .toMatchObject({
        command: "route-lease-release",
        outputs: {
          observation: {
            fileName: ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
          }
        },
        evidence: {
          leaseObservation: "foreign",
          route: "blocked",
          reason: "lease-conflict"
        }
      });
    expect(blockedRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);
  });

  it("blocks resumed empty-chain and cross-attempt first-release replay before any request", async () => {
    const fixture = await fixtureWithFiles();
    const resumed = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.releaseIntent.authorizedAt,
      fixture,
      freshEntries: [],
      intent: fixture.releaseIntent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.releaseIntent.recoveryRun.startedAt,
      suffix: "resumed-empty",
      verifiedAt: "2026-09-01T00:05:00Z"
    });
    const routeRoot = path.join(fixture.root, "resumed-empty-route");
    await mkdir(routeRoot);
    const routeRemote = sourceAndLeaseRemote(fixture, fixture.heldLease);
    let routeFailure: unknown;
    try {
      await runElectronProductionPublicLatestRecoveryCli(
        routeArgs(fixture, resumed.authorizationFile,
          routeRoot, "2026-09-01T00:06:00Z"),
        dependencies(routeRemote.fetchImpl, [])
      );
    } catch (error) {
      routeFailure = error;
    }
    expect(routeFailure).toBeInstanceOf(
      ElectronProductionPublicLatestRecoveryCliFailure
    );
    expect((routeFailure as ElectronProductionPublicLatestRecoveryCliFailure)
      .summary).toMatchObject({
      command: "route-lease-release",
      evidence: {
        leaseObservation: "held",
        route: "blocked",
        reason: "resumed-empty-chain"
      }
    });
    expect(routeRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);

    const directRoot = path.join(fixture.root, "resumed-empty-direct");
    await mkdir(directRoot);
    const noDirectRequest = sequenceLeaseFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli(
      releaseArgs(fixture, resumed.authorizationFile,
        directRoot, "2026-09-01T00:06:00Z"),
      dependencies(noDirectRequest.fetchImpl, [])
    )).rejects.toThrow("resumed empty recovery chain");
    expect(noDirectRequest.calls).toEqual([]);

    const replayRoot = path.join(fixture.root, "created-auth-replay");
    await mkdir(replayRoot);
    const replayArgs = releaseArgs(
      fixture,
      fixture.authorizationFile,
      replayRoot,
      "2026-09-01T00:10:00Z"
    );
    replaceOption(replayArgs, "current-run-attempt", "2");
    const noReplayRequest = sequenceLeaseFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli(
      replayArgs,
      dependencies(noReplayRequest.fetchImpl, [])
    )).rejects.toThrow("current-run run attempt does not match");
    expect(noReplayRequest.calls).toEqual([]);
  });

  it("reconciles a delayed first release after a resumed empty-chain no-attempt outcome", async () => {
    const fixture = await fixtureWithFiles();
    const noAttempt = fixture.createOutcome({
      runId: "9441",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:06:00Z",
      determinedAt: "2026-09-01T00:07:00Z"
    });
    const authority = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.releaseIntent.authorizedAt,
      currentRun: {
        repository: "rion-tw/rion-studio-source",
        workflow:
          ".github/workflows/electron-production-provisional-recovery.yml",
        runId: "9903",
        runAttempt: 1,
        controlSha: "d".repeat(40),
        startedAt: "2026-09-01T00:07:30Z"
      },
      fixture,
      freshEntries: [fixture.entry(noAttempt)],
      intent: fixture.releaseIntent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.releaseIntent.recoveryRun.startedAt,
      suffix: "resumed-no-attempt-late-release",
      verifiedAt: "2026-09-01T00:08:00Z"
    });
    const outcomeRoot = path.join(fixture.root, "resumed-no-attempt-outcome");
    await mkdir(outcomeRoot);
    const latest = await writeElectronProductionPublicationRecoveryOutcomeAttempt({
      outputPath: path.join(
        outcomeRoot,
        electronProductionPublicationRecoveryOutcomeAttemptFileName(
          noAttempt.recoveryRun
        )
      ),
      receipt: noAttempt
    });
    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      releaseInput(fixture, "2026-09-01T00:06:30Z")
    );
    const previousArgs = [
      "--previous-outcome", latest.receiptPath,
      "--previous-outcome-sha256", latest.receiptIdentity.sha256
    ];

    const routeRoot = path.join(fixture.root, "resumed-late-release-route");
    await mkdir(routeRoot);
    const routeRemote = sourceAndLeaseRemote(fixture, released);
    const routed = await runElectronProductionPublicLatestRecoveryCli([
      ...routeArgs(fixture, authority.authorizationFile,
        routeRoot, "2026-09-01T00:08:30Z"),
      ...previousArgs
    ], dependencies(routeRemote.fetchImpl, []));
    expect(routed).toMatchObject({
      command: "route-lease-release",
      evidence: {
        leaseObservation: "released",
        route: "reconcile-released",
        reason: "exact-direct-successor"
      }
    });
    expect(routeRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);

    const reconcileRoot = path.join(
      fixture.root,
      "resumed-late-release-reconcile"
    );
    await mkdir(reconcileRoot);
    const reconcileRemote = sourceAndLeaseRemote(fixture, released);
    const reconciled = await runElectronProductionPublicLatestRecoveryCli([
      ...reconcileArgs(fixture, authority.authorizationFile,
        reconcileRoot, "2026-09-01T00:09:00Z"),
      ...previousArgs
    ], dependencies(reconcileRemote.fetchImpl, []));
    expect(reconciled).toMatchObject({
      command: "reconcile-lease-release",
      evidence: { acknowledgement: "confirmed" }
    });
    expect(reconcileRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);
  });

  it("reconciles an exact released successor after a rejected-head routing race without PUT", async () => {
    const fixture = await fixtureWithFiles();
    const rejected = fixture.createOutcome({
      runId: "9451",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:10:00Z",
      determinedAt: "2026-09-01T00:11:00Z",
      leaseRelease: releaseEvidence(
        "rejected",
        "2026-09-01T00:10:00Z",
        "2026-09-01T00:10:00Z",
        "c"
      )
    });
    const authority = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.releaseIntent.authorizedAt,
      fixture,
      freshEntries: [fixture.entry(rejected)],
      intent: fixture.releaseIntent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.releaseIntent.recoveryRun.startedAt,
      suffix: "rejected-head-race",
      verifiedAt: "2026-09-01T00:11:30Z"
    });
    const outcomeRoot = path.join(fixture.root, "rejected-head-race-outcome");
    await mkdir(outcomeRoot);
    const latest = await writeElectronProductionPublicationRecoveryOutcomeAttempt({
      outputPath: path.join(
        outcomeRoot,
        electronProductionPublicationRecoveryOutcomeAttemptFileName(
          rejected.recoveryRun
        )
      ),
      receipt: rejected
    });
    const routeRoot = path.join(fixture.root, "rejected-head-route");
    await mkdir(routeRoot);
    const heldRemote = sourceAndLeaseRemote(fixture, fixture.heldLease);
    const routed = await runElectronProductionPublicLatestRecoveryCli([
      ...routeArgs(fixture, authority.authorizationFile,
        routeRoot, "2026-09-01T00:11:45Z"),
      "--previous-outcome", latest.receiptPath,
      "--previous-outcome-sha256", latest.receiptIdentity.sha256
    ], dependencies(heldRemote.fetchImpl, []));
    expect(routed).toMatchObject({
      command: "route-lease-release",
      evidence: { route: "release-held" }
    });

    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      releaseInput(fixture, "2026-09-01T00:12:00Z")
    );
    const reconcileRoot = path.join(fixture.root, "rejected-head-reconcile");
    await mkdir(reconcileRoot);
    const releasedRemote = sourceAndLeaseRemote(fixture, released);
    const reconciled = await runElectronProductionPublicLatestRecoveryCli([
      ...reconcileArgs(fixture, authority.authorizationFile,
        reconcileRoot, "2026-09-01T00:13:00Z"),
      "--previous-outcome", latest.receiptPath,
      "--previous-outcome-sha256", latest.receiptIdentity.sha256
    ], dependencies(releasedRemote.fetchImpl, []));
    expect(reconciled).toMatchObject({
      command: "reconcile-lease-release",
      evidence: { acknowledgement: "confirmed" }
    });
    expect(releasedRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);
  });

  it("routes an exact held lease after an unknown rollback reached source", async () => {
    const fixture = await fixtureWithFiles();
    const rollbackUnknown = fixture.createOutcome({
      beforeClassification: "target",
      beforeObservedAt: "2026-09-01T00:10:00Z",
      determinedAt: "2026-09-01T00:11:00Z",
      finalClassification: "source",
      finalObservedAt: "2026-09-01T00:10:45Z",
      mutation: {
        kind: "rollback",
        submitted: true,
        acknowledgement: "unknown",
        submittedAt: "2026-09-01T00:10:15Z",
        resultRecordedAt: "2026-09-01T00:10:30Z"
      },
      previousOutcomeSha256: null,
      runAttempt: 1,
      runId: "9452",
      startedAt: "2026-09-01T00:10:00Z"
    });
    const authority = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.releaseIntent.authorizedAt,
      fixture,
      freshEntries: [fixture.entry(rollbackUnknown)],
      intent: fixture.releaseIntent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.releaseIntent.recoveryRun.startedAt,
      suffix: "rollback-unknown-source",
      verifiedAt: "2026-09-01T00:11:30Z"
    });
    const outcomeRoot = path.join(fixture.root, "rollback-unknown-outcome");
    await mkdir(outcomeRoot);
    const latest = await writeElectronProductionPublicationRecoveryOutcomeAttempt({
      outputPath: path.join(
        outcomeRoot,
        electronProductionPublicationRecoveryOutcomeAttemptFileName(
          rollbackUnknown.recoveryRun
        )
      ),
      receipt: rollbackUnknown
    });
    const routeRoot = path.join(fixture.root, "rollback-unknown-route");
    await mkdir(routeRoot);
    const remote = sourceAndLeaseRemote(fixture, fixture.heldLease);
    const routed = await runElectronProductionPublicLatestRecoveryCli([
      ...routeArgs(fixture, authority.authorizationFile,
        routeRoot, "2026-09-01T00:11:45Z"),
      "--previous-outcome", latest.receiptPath,
      "--previous-outcome-sha256", latest.receiptIdentity.sha256
    ], dependencies(remote.fetchImpl, []));
    expect(routed).toMatchObject({
      command: "route-lease-release",
      evidence: { leaseObservation: "held", route: "release-held" }
    });
    expect(remote.calls.some(({ init }) => init.method === "PUT")).toBe(false);
  });

  it("keeps a historical unknown attempt tainted across rejected reconciliation and only permits exact readback", async () => {
    const fixture = await fixtureWithFiles();
    const attemptedAt = "2026-09-01T00:10:00Z";
    const unknown = fixture.createOutcome({
      runId: "9501",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: attemptedAt,
      determinedAt: "2026-09-01T00:11:00Z",
      leaseRelease: releaseEvidence("unknown", attemptedAt,
        "2026-09-01T00:10:00Z", "a")
    });
    const unknownEntry = fixture.entry(unknown);
    const rejected = fixture.createOutcome({
      runId: "9502",
      runAttempt: 1,
      previousOutcomeSha256: unknownEntry.sha256,
      startedAt: "2026-09-01T00:12:00Z",
      determinedAt: "2026-09-01T00:14:00Z",
      leaseRelease: releaseEvidence("rejected", attemptedAt,
        "2026-09-01T00:13:00Z", "b")
    });
    const authority = await createLeaseReleaseAuthorizationFixture({
      authorizedAt: fixture.releaseIntent.authorizedAt,
      fixture,
      freshEntries: [unknownEntry, fixture.entry(rejected)],
      intent: fixture.releaseIntent,
      mode: "resumed-existing",
      outputRoot: fixture.root,
      recoveryRunStartedAt: fixture.releaseIntent.recoveryRun.startedAt,
      suffix: "unknown-rejected",
      verifiedAt: "2026-09-01T00:14:30Z"
    });
    const outcomeRoot = path.join(fixture.root, "latest-rejected-outcome");
    await mkdir(outcomeRoot);
    const latest = await writeElectronProductionPublicationRecoveryOutcomeAttempt({
      outputPath: path.join(
        outcomeRoot,
        electronProductionPublicationRecoveryOutcomeAttemptFileName(
          rejected.recoveryRun
        )
      ),
      receipt: rejected
    });
    const routeRoot = path.join(fixture.root, "tainted-route-held");
    await mkdir(routeRoot);
    const heldRouteRemote = sourceAndLeaseRemote(fixture, fixture.heldLease);
    const routed = await runElectronProductionPublicLatestRecoveryCli([
      ...routeArgs(fixture, authority.authorizationFile,
        routeRoot, "2026-09-01T00:14:45Z"),
      "--previous-outcome", latest.receiptPath,
      "--previous-outcome-sha256", latest.receiptIdentity.sha256
    ], dependencies(heldRouteRemote.fetchImpl, []));
    expect(routed).toMatchObject({
      command: "route-lease-release",
      evidence: { route: "reconcile-pending" }
    });
    expect(heldRouteRemote.calls.some(({ init }) => init.method === "PUT"))
      .toBe(false);
    const directRoot = path.join(fixture.root, "tainted-direct-release");
    await mkdir(directRoot);
    const unused = sequenceLeaseFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli([
      ...releaseArgs(fixture, authority.authorizationFile,
        directRoot, "2026-09-01T00:15:00Z"),
      "--previous-outcome", latest.receiptPath,
      "--previous-outcome-sha256", latest.receiptIdentity.sha256
    ], dependencies(unused.fetchImpl, []))).rejects.toThrow(
      "historically unknown release acknowledgement"
    );
    expect(unused.calls).toEqual([]);

    const released = releaseElectronProductionPublicLatestLease(
      fixture.heldLease,
      releaseInput(fixture, attemptedAt)
    );
    const reconcileRoot = path.join(fixture.root, "tainted-reconciliation");
    await mkdir(reconcileRoot);
    const remote = sourceAndLeaseRemote(fixture, released);
    const reconciled = await runElectronProductionPublicLatestRecoveryCli([
      ...reconcileArgs(fixture, authority.authorizationFile,
        reconcileRoot, "2026-09-01T00:15:00Z"),
      "--previous-outcome", latest.receiptPath,
      "--previous-outcome-sha256", latest.receiptIdentity.sha256
    ], dependencies(remote.fetchImpl, []));
    expect(reconciled).toMatchObject({
      command: "reconcile-lease-release",
      evidence: { acknowledgement: "confirmed" }
    });
    expect(remote.calls.some(({ init }) => init.method === "PUT")).toBe(false);
  });

  it("does not call lease CAS when the release-time observation is not source", async () => {
    const fixture = await fixtureWithFiles();
    const changed = targetObservationRemote(fixture);
    const blockedRoot = path.join(fixture.root, "blocked-release");
    await mkdir(blockedRoot);

    await expect(runElectronProductionPublicLatestRecoveryCli([
      "release-lease",
      "--source-snapshot", fixture.sourceFile.path,
      "--source-snapshot-sha256", fixture.sourceFile.sha256,
      "--target-snapshot", fixture.targetFile.path,
      "--target-snapshot-sha256", fixture.targetFile.sha256,
      "--held-lease", fixture.leaseFile.path,
      "--held-lease-sha256", fixture.leaseFile.sha256,
      "--release-authorization", fixture.authorizationFile.path,
      "--release-authorization-sha256", fixture.authorizationFile.sha256,
      ...currentRunArgs(fixture.authorizationFile.currentRun),
      "--attempted-at", "2026-09-01T00:10:00Z",
      "--released-lease-output", path.join(
        blockedRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
      ),
      "--output", path.join(
        blockedRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
      )
    ], dependencies(changed.fetchImpl, []))).rejects.toThrow(
      "fresh exact source observation before CAS"
    );
    expect(changed.calls.every(({ init }) => init.method === "GET")).toBe(true);
  });

  it("records rejected observation evidence, exits fail-closed, and rejects a bad digest before requests", async () => {
    const fixture = await fixtureWithFiles();
    const outputRoot = path.join(fixture.root, "failure-output");
    await mkdir(outputRoot);
    const output = path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    );
    const policyDrift = sequenceFetch(jsonResponse({
      full_name: "rion-tw/rion-studio",
      private: false,
      visibility: "public",
      default_branch: "develop"
    }));
    const stdout: Buffer[] = [];
    const exitCodes: number[] = [];
    let failure: unknown;
    try {
      await runElectronProductionPublicLatestRecoveryCli(
        observeArgs(fixture, output),
        dependencies(policyDrift.fetchImpl, stdout, exitCodes)
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ElectronProductionPublicLatestRecoveryCliFailure);
    expect(exitCodes).toEqual([1]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]!.toString("utf8")).not.toContain(RECOVERY_FIXTURE_TOKEN);
    const summary = observationSummary(
      (failure as ElectronProductionPublicLatestRecoveryCliFailure).summary
    );
    expect(summary.evidence).toMatchObject({
      observation: "unknown",
      observationTransport: "rejected"
    });
    await readElectronProductionPublicLatestRecoveryObservation({
      expectedSha256: summary.outputs.observation.sha256,
      receiptPath: output
    });

    const badOutput = path.join(
      outputRoot,
      "bad",
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    );
    const args = observeArgs(fixture, badOutput);
    replaceOption(args, "source-snapshot-sha256", "f".repeat(64));
    const unused = sequenceFetch();
    await expect(runElectronProductionPublicLatestRecoveryCli(
      args,
      dependencies(unused.fetchImpl, [])
    )).rejects.toThrow("SHA-256 does not match");
    expect(unused.calls).toEqual([]);
    await expect(readFile(badOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixtureWithFiles() {
  const fixture = await createPublicLatestRecoveryCliFixture();
  temporaryDirectories.push(fixture.root);
  return fixture;
}

function releaseArgs(
  fixture: Awaited<ReturnType<typeof fixtureWithFiles>>,
  authorizationFile: AuthorizationFile,
  outputRoot: string,
  attemptedAt: string
) {
  return [
    "release-lease",
    "--source-snapshot", fixture.sourceFile.path,
    "--source-snapshot-sha256", fixture.sourceFile.sha256,
    "--target-snapshot", fixture.targetFile.path,
    "--target-snapshot-sha256", fixture.targetFile.sha256,
    "--held-lease", fixture.leaseFile.path,
    "--held-lease-sha256", fixture.leaseFile.sha256,
    "--release-authorization", authorizationFile.path,
    "--release-authorization-sha256", authorizationFile.sha256,
    ...currentRunArgs(authorizationFile.currentRun),
    "--attempted-at", attemptedAt,
    "--released-lease-output", path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
    ),
    "--output", path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
    )
  ];
}

function reconcileArgs(
  fixture: Awaited<ReturnType<typeof fixtureWithFiles>>,
  authorizationFile: AuthorizationFile,
  outputRoot: string,
  observedAt: string
) {
  return [
    "reconcile-lease-release",
    "--source-snapshot", fixture.sourceFile.path,
    "--source-snapshot-sha256", fixture.sourceFile.sha256,
    "--target-snapshot", fixture.targetFile.path,
    "--target-snapshot-sha256", fixture.targetFile.sha256,
    "--held-lease", fixture.leaseFile.path,
    "--held-lease-sha256", fixture.leaseFile.sha256,
    "--release-authorization", authorizationFile.path,
    "--release-authorization-sha256", authorizationFile.sha256,
    ...currentRunArgs(authorizationFile.currentRun),
    "--observed-at", observedAt,
    "--released-lease-output", path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
    ),
    "--output", path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_RELEASE_OPERATION_FILE
    )
  ];
}

function routeArgs(
  fixture: Awaited<ReturnType<typeof fixtureWithFiles>>,
  authorizationFile: AuthorizationFile,
  outputRoot: string,
  observedAt: string
) {
  return [
    "route-lease-release",
    "--source-snapshot", fixture.sourceFile.path,
    "--source-snapshot-sha256", fixture.sourceFile.sha256,
    "--target-snapshot", fixture.targetFile.path,
    "--target-snapshot-sha256", fixture.targetFile.sha256,
    "--held-lease", fixture.leaseFile.path,
    "--held-lease-sha256", fixture.leaseFile.sha256,
    "--release-authorization", authorizationFile.path,
    "--release-authorization-sha256", authorizationFile.sha256,
    ...currentRunArgs(authorizationFile.currentRun),
    "--observed-at", observedAt,
    "--output", path.join(
      outputRoot,
      ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
    )
  ];
}

function releaseInput(
  fixture: Awaited<ReturnType<typeof fixtureWithFiles>>,
  recordedAt: string
) {
  return {
    transactionId: fixture.heldLease.transactionId,
    leaseId: fixture.heldLease.leaseId,
    generation: fixture.heldLease.generation,
    sourceStateSha256: fixture.heldLease.source.stateSha256,
    targetStateSha256: fixture.heldLease.target.stateSha256,
    recordedAt
  };
}

function currentRunArgs(currentRun: AuthorizationFile["currentRun"]) {
  return [
    "--current-run-repository", currentRun.repository,
    "--current-run-workflow", currentRun.workflow,
    "--current-run-id", currentRun.runId,
    "--current-run-attempt", String(currentRun.runAttempt),
    "--current-control-sha", currentRun.controlSha,
    "--current-run-started-at", currentRun.startedAt
  ];
}

function releaseEvidence(
  acknowledgement: "rejected" | "unknown",
  attemptedAt: string,
  resolvedAt: string,
  digestCharacter: string
) {
  return {
    attempted: true,
    acknowledgement,
    attemptedAt,
    operationSha256: digestCharacter.repeat(64),
    resolvedAt,
    successorEventSha256: null
  } as const;
}

function sourceAndLeaseRemote(
  fixture: Awaited<ReturnType<typeof fixtureWithFiles>>,
  lease: ElectronProductionPublicLatestLease
) {
  return sequenceLeaseFetch(
    repositoryResponse(),
    jsonResponse(fixture.sourceApi),
    jsonResponse(githubTagReference(fixture.source)),
    ...assetResponses(fixture.source, fixture.sourceSources),
    leaseContentResponse(lease)
  );
}

function observeArgs(
  fixture: Awaited<ReturnType<typeof fixtureWithFiles>>,
  output: string
) {
  return [
    "observe",
    "--source-snapshot", fixture.sourceFile.path,
    "--source-snapshot-sha256", fixture.sourceFile.sha256,
    "--target-snapshot", fixture.targetFile.path,
    "--target-snapshot-sha256", fixture.targetFile.sha256,
    "--observed-at", "2026-09-01T00:04:00Z",
    "--output", output
  ];
}

function dependencies(
  fetchImpl:
    | ElectronProductionPublicLatestRecoveryFetch
    | ElectronProductionPublicLatestLeaseRemoteFetch,
  stdout: Buffer[],
  exitCodes: number[] = []
) {
  return {
    environment: { GH_TOKEN: RECOVERY_FIXTURE_TOKEN },
    fetchImpl,
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
    writeStdout: (source: Buffer) => {
      stdout.push(source);
    }
  };
}

function targetObservationRemote(
  fixture: Awaited<ReturnType<typeof fixtureWithFiles>>
) {
  return sequenceFetch(
    repositoryResponse(),
    jsonResponse(fixture.targetApi),
    jsonResponse(githubTagReference(fixture.target)),
    ...assetResponses(fixture.target, fixture.targetSources)
  );
}

function replaceOption(args: string[], name: string, value: string) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) throw new Error(`Missing test option ${name}.`);
  args[index + 1] = value;
}

function observationSummary(
  summary: Readonly<ElectronProductionPublicLatestRecoveryCliSummary>
): Readonly<ElectronProductionPublicLatestRecoveryObservationCliSummary> {
  if (summary.command !== "observe" && summary.command !== "rollback") {
    throw new Error("Expected an observation or rollback CLI summary.");
  }
  return summary;
}
