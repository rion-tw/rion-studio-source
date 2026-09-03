import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  createElectronProductionPublicLatestRecoveryObservation,
  electronProductionPublicLatestRecoveryObservationSha256
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  electronProductionPublicationRecoveryOutcomeAttemptFileName,
  writeElectronProductionPublicationRecoveryOutcomeAttempt
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
  runElectronProductionPublicationRecoveryCli
} from "../scripts/electronProductionPublicationRecoveryCli.mjs";
import {
  createElectronProductionPublicationRecoveryPublicMutationOperation,
  writeElectronProductionPublicationRecoveryPublicMutationOperation
} from "../scripts/electronProductionPublicationRecoveryPublicMutationOperation.mjs";
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

describe("publication recovery marker outcome CLI", () => {
  it("materializes and detached-verifies marker-bound precondition evidence", async () => {
    const fixture = await markerFixture();
    const attemptOutput = path.join(
      fixture.root,
      electronProductionPublicationRecoveryOutcomeAttemptFileName(
        fixture.authorization.currentRun
      )
    );
    const terminalOutput = path.join(
      fixture.root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    );
    const materialized = await runCaptured([
      "materialize-marker-outcome",
      ...foundationArguments(fixture),
      "--input", fixture.input.path,
      "--input-sha256", fixture.input.sha256,
      "--public-mutation-authorization", fixture.authorizationFile.valuePath,
      "--public-mutation-authorization-sha256",
      fixture.authorizationFile.valueIdentity.sha256,
      "--public-mutation-operation", fixture.operationFile.valuePath,
      "--public-mutation-operation-sha256",
      fixture.operationFile.valueIdentity.sha256,
      "--attempt-output", attemptOutput,
      "--terminal-output", terminalOutput
    ]);

    expect(materialized).toMatchObject({
      command: "materialize-marker-outcome",
      status: "materialized",
      outcome: {
        classification: "indeterminate",
        terminal: false,
        safeToReleaseLease: false
      }
    });
    await expect(readFileAbsent(terminalOutput)).resolves.toBe(true);

    const verified = await runCaptured([
      "verify-marker-outcome",
      ...foundationArguments(fixture),
      "--public-mutation-authorization", fixture.authorizationFile.valuePath,
      "--public-mutation-authorization-sha256",
      fixture.authorizationFile.valueIdentity.sha256,
      "--public-mutation-operation", fixture.operationFile.valuePath,
      "--public-mutation-operation-sha256",
      fixture.operationFile.valueIdentity.sha256,
      "--outcome", attemptOutput,
      "--outcome-sha256", materialized.output.sha256
    ]);
    expect(verified).toMatchObject({
      command: "verify-marker-outcome",
      status: "verified",
      output: materialized.output
    });
  });

  it("rejects a detached authorization that did not authorize the operation", async () => {
    const fixture = await markerFixture();
    await mkdir(path.join(fixture.root, "resumed"));
    const resumedFile =
      await writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
        outputPath: path.join(fixture.root, "resumed",
          "electron-production-publication-recovery-public-mutation-attempt-authorization.json"),
        value: fixture.base.resumedAuthorization
      });
    await expect(runElectronProductionPublicationRecoveryCli([
      "materialize-marker-outcome",
      ...foundationArguments(fixture),
      "--input", fixture.input.path,
      "--input-sha256", fixture.input.sha256,
      "--public-mutation-authorization", resumedFile.valuePath,
      "--public-mutation-authorization-sha256",
      resumedFile.valueIdentity.sha256,
      "--public-mutation-operation", fixture.operationFile.valuePath,
      "--public-mutation-operation-sha256",
      fixture.operationFile.valueIdentity.sha256,
      "--attempt-output", path.join(fixture.root,
        electronProductionPublicationRecoveryOutcomeAttemptFileName(
          fixture.authorization.currentRun
        )),
      "--terminal-output", path.join(fixture.root,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE)
    ], { writeStdout: () => undefined })).rejects.toThrow(
      /head-transition mode|operation authority does not match/u
    );
  });

  it("binds the marker run, predecessor, and operation resolution time", async () => {
    const fixture = await markerFixture();
    const output = path.join(
      fixture.root,
      electronProductionPublicationRecoveryOutcomeAttemptFileName(
        fixture.authorization.currentRun
      )
    );
    const baseArguments = [
      "materialize-marker-outcome",
      ...foundationArguments(fixture),
      "--public-mutation-authorization", fixture.authorizationFile.valuePath,
      "--public-mutation-authorization-sha256",
      fixture.authorizationFile.valueIdentity.sha256,
      "--public-mutation-operation", fixture.operationFile.valuePath,
      "--public-mutation-operation-sha256",
      fixture.operationFile.valueIdentity.sha256,
      "--attempt-output", output,
      "--terminal-output", path.join(fixture.root,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE)
    ];
    const wrongRun = await writeCanonical(path.join(fixture.root,
      "marker-outcome-wrong-run.json"), {
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
      recoveryRun: {
        ...fixture.authorization.currentRun,
        controlSha: "f".repeat(40)
      },
      determinedAt: "2026-09-01T00:06:50Z"
    });
    await expect(runCaptured([
      ...baseArguments,
      "--input", wrongRun.path,
      "--input-sha256", wrongRun.sha256
    ])).rejects.toThrow("recovery run does not match");

    const tooEarly = await writeCanonical(path.join(fixture.root,
      "marker-outcome-too-early.json"), {
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
      recoveryRun: fixture.authorization.currentRun,
      determinedAt: "2026-09-01T00:06:35Z"
    });
    await expect(runCaptured([
      ...baseArguments,
      "--input", tooEarly.path,
      "--input-sha256", tooEarly.sha256
    ])).rejects.toThrow("cannot precede operation resolution");

    const previous = fixture.base.createOutcome({
      determinedAt: "2026-09-01T00:03:30Z",
      previousOutcomeSha256: null,
      runAttempt: 1,
      runId: "8801",
      startedAt: "2026-09-01T00:03:00Z"
    });
    const previousFile =
      await writeElectronProductionPublicationRecoveryOutcomeAttempt({
        outputPath: path.join(fixture.root,
          electronProductionPublicationRecoveryOutcomeAttemptFileName(
            previous.recoveryRun
          )),
        receipt: previous
      });
    await expect(runCaptured([
      ...baseArguments,
      "--input", fixture.input.path,
      "--input-sha256", fixture.input.sha256,
      "--previous-outcome", previousFile.receiptPath,
      "--previous-outcome-sha256", previousFile.receiptIdentity.sha256
    ])).rejects.toThrow("marker outcome predecessor SHA-256");

    const materialized = await runCaptured([
      ...baseArguments,
      "--input", fixture.input.path,
      "--input-sha256", fixture.input.sha256
    ]);
    await expect(runCaptured([
      "verify-marker-outcome",
      ...foundationArguments(fixture),
      "--public-mutation-authorization", fixture.authorizationFile.valuePath,
      "--public-mutation-authorization-sha256",
      fixture.authorizationFile.valueIdentity.sha256,
      "--public-mutation-operation", fixture.operationFile.valuePath,
      "--public-mutation-operation-sha256",
      fixture.operationFile.valueIdentity.sha256,
      "--outcome", output,
      "--outcome-sha256", materialized.output.sha256,
      "--previous-outcome", previousFile.receiptPath,
      "--previous-outcome-sha256", previousFile.receiptIdentity.sha256
    ])).rejects.toThrow("marker outcome predecessor SHA-256");
  });
});

async function markerFixture() {
  const base = await createPublicMutationAttemptAuthorizationFixture({
    operation: "release-held-lease"
  });
  temporaryDirectories.push(base.root);
  const foundation = await writeOutcomeDiscoveryFoundation(base.root, base);
  const finalObservation = createElectronProductionPublicLatestRecoveryObservation({
    observedAt: "2026-09-01T00:06:30Z",
    result: {
      outcome: "indeterminate",
      reason: "transport",
      status: null,
      latest: null
    },
    sourceSnapshot: base.source,
    sourceSnapshotFileSha256: base.foundation.sourceSnapshotSha256,
    targetSnapshot: base.target,
    targetSnapshotFileSha256: base.foundation.targetSnapshotSha256
  });
  const operation =
    createElectronProductionPublicationRecoveryPublicMutationOperation({
      authorization: base.createdAuthorization,
      authorizationSha256: base.createdAuthorizationSha256,
      beforeObservation: base.publicObservation,
      beforeObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(
          base.publicObservation
        ),
      finalObservation,
      finalObservationSha256:
        electronProductionPublicLatestRecoveryObservationSha256(
          finalObservation
        ),
      heldLease: base.heldLease,
      heldLeaseFileSha256: base.foundation.heldLeaseSha256,
      mode: "precondition-rejected",
      resolvedAt: "2026-09-01T00:06:40Z",
      sourceSnapshot: base.source,
      sourceSnapshotFileSha256: base.foundation.sourceSnapshotSha256,
      successor: null,
      targetSnapshot: base.target,
      targetSnapshotFileSha256: base.foundation.targetSnapshotSha256,
      transportOperation: null,
      transportOperationSha256: null
    });
  await mkdir(path.join(base.root, "created"));
  const authorizationFile =
    await writeElectronProductionPublicationRecoveryPublicMutationAttemptAuthorization({
      outputPath: path.join(base.root, "created",
        "electron-production-publication-recovery-public-mutation-attempt-authorization.json"),
      value: base.createdAuthorization
    });
  const operationFile =
    await writeElectronProductionPublicationRecoveryPublicMutationOperation({
      outputPath: path.join(base.root,
        "electron-production-publication-recovery-public-mutation-operation.json"),
      value: operation
    });
  const input = await writeCanonical(path.join(base.root,
    "marker-outcome-materialization.json"), {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_INPUT_KIND,
    recoveryRun: base.createdAuthorization.currentRun,
    determinedAt: "2026-09-01T00:06:50Z"
  });
  return {
    authorization: base.createdAuthorization,
    authorizationFile,
    base,
    foundation,
    input,
    operationFile,
    root: base.root
  };
}

function foundationArguments(
  fixture: Awaited<ReturnType<typeof markerFixture>>
) {
  return [
    "--held-lease", fixture.foundation.heldLease,
    "--held-lease-sha256", fixture.foundation.heldLeaseSha256,
    "--source-snapshot", fixture.foundation.sourceSnapshot,
    "--source-snapshot-sha256", fixture.foundation.sourceSnapshotSha256,
    "--target-snapshot", fixture.foundation.targetSnapshot,
    "--target-snapshot-sha256", fixture.foundation.targetSnapshotSha256,
    "--store-seal", fixture.foundation.storeSeal,
    "--store-seal-sha256", fixture.foundation.storeSealSha256
  ];
}

async function writeCanonical(filePath: string, value: unknown) {
  const source = serializeCanonicalJson(value);
  await writeFile(filePath, source, { flag: "wx" });
  return {
    path: filePath,
    sha256: createHash("sha256").update(source).digest("hex")
  };
}

async function runCaptured(argumentsList: readonly string[]) {
  return runElectronProductionPublicationRecoveryCli(argumentsList, {
    writeStdout: () => undefined
  });
}

async function readFileAbsent(filePath: string) {
  try {
    await import("node:fs/promises").then(({ stat }) => stat(filePath));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
