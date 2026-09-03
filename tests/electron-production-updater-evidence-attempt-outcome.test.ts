import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  assertElectronProductionUpdaterEvidenceAttemptOutcome,
  createElectronProductionUpdaterEvidenceAttemptOutcome,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW,
  electronProductionUpdaterEvidenceAttemptOutcomeArtifactName,
  readElectronProductionUpdaterEvidenceAttemptOutcome,
  serializeElectronProductionUpdaterEvidenceAttemptOutcome,
  type ElectronProductionUpdaterEvidenceAttemptOutcome,
  type ElectronProductionUpdaterEvidenceAttemptOutcomeCell,
  type ElectronProductionUpdaterEvidenceAttemptOutcomeStatus
} from "../scripts/electronProductionUpdaterEvidenceAttemptOutcome.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterEvidenceAttemptOutcomeCli
} from "../scripts/electronProductionUpdaterEvidenceAttemptOutcomeCli.mjs";

const EVIDENCE_ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const ALTERNATE_EVIDENCE_ATTEMPT_ID = "10000000-0000-4000-8000-000000000002";
const ELECTRON_SOURCE_INSTALL_ATTEMPT_ID =
  "update-install-abcdef12-3456-4789-8abc-def012345678";
const ATTEMPT_PLAN_SHA256 = "a".repeat(64);
const CONTROL_SHA = "b".repeat(40);
const RUN_ID = "123456";
const RUN_ATTEMPT = 2;
const OBSERVED_AT = "2026-09-02T12:00:00+08:00";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater evidence attempt outcome", () => {
  it.each(["failed", "cancelled", "indeterminate"] as const)(
    "creates and expected-SHA re-verifies the canonical %s receipt",
    async (outcome) => {
      const fixture = await createFixture(outcome);
      const written = await createElectronProductionUpdaterEvidenceAttemptOutcome(
        fixture.input
      );

      expect(written.value).toEqual(receiptValue(outcome));
      expect(written.value).toMatchObject({
        schemaVersion: 1,
        kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND,
        cutoverEligible: false,
        terminal: true,
        deadlineUsedAsSuccess: false,
        outcome
      });
      expect(await readFile(written.valuePath)).toEqual(
        serializeElectronProductionUpdaterEvidenceAttemptOutcome(written.value)
      );
      await expect(readElectronProductionUpdaterEvidenceAttemptOutcome({
        expectedSha256: written.valueIdentity.sha256,
        receiptPath: written.valuePath
      })).resolves.toEqual(written);
      await expect(createElectronProductionUpdaterEvidenceAttemptOutcome(fixture.input))
        .rejects.toThrow("create-new");
    }
  );

  it("rejects unknown keys, applied, and deadline-derived success", () => {
    const unknown = { ...receiptValue(), producerApplied: false };
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(unknown))
      .toThrow("unexpected schema");
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receiptValue(),
      outcome: "applied"
    })).toThrow("outcome is unsupported");
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receiptValue(),
      deadlineUsedAsSuccess: true
    })).toThrow("deadline-as-success flag");
  });

  it("preserves pre-invocation failure state without inventing an install ID", () => {
    const value = assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receiptValue("cancelled"),
      sourceUpdaterInvoked: false,
      sourceInstallAttemptId: null,
      observationArtifact: null
    });
    expect(value).toMatchObject({
      outcome: "cancelled",
      sourceUpdaterInvoked: false,
      sourceInstallAttemptId: null,
      observationArtifact: null
    });
  });

  it("accepts only transition-typed source install attempt IDs", () => {
    for (const sourceInstallAttemptId of [
      "update-install-1",
      "update-install-18446744073709551615"
    ]) {
      expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(
        receiptValue("failed", { sourceInstallAttemptId })
      )).not.toThrow();
    }
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(
      receiptValue("failed", { sourceInstallAttemptId: null })
    )).not.toThrow();
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(
      receiptValue("failed", {
        transitionKind: "electron-v23-to-electron-v23",
        sourceInstallAttemptId: ELECTRON_SOURCE_INSTALL_ATTEMPT_ID
      })
    )).not.toThrow();
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(
      receiptValue("failed", {
        transitionKind: "electron-v23-to-electron-v23",
        sourceInstallAttemptId: null
      })
    )).not.toThrow();
  });

  it("rejects cross-transition, out-of-range, and uninvoked source attempt IDs", () => {
    for (const sourceInstallAttemptId of [
      "update-install-0",
      "update-install-18446744073709551616",
      ELECTRON_SOURCE_INSTALL_ATTEMPT_ID
    ]) {
      expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(
        receiptValue("failed", { sourceInstallAttemptId })
      )).toThrow("Tauri v22 source install attempt ID");
    }
    for (const sourceInstallAttemptId of [
      "update-install-1",
      "update-install-" + ELECTRON_SOURCE_INSTALL_ATTEMPT_ID
        .slice("update-install-".length)
        .toUpperCase()
    ]) {
      expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(
        receiptValue("failed", {
          transitionKind: "electron-v23-to-electron-v23",
          sourceInstallAttemptId
        })
      )).toThrow("Electron v23 source install attempt ID");
    }
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome(
      receiptValue("failed", {
        sourceUpdaterInvoked: false,
        sourceInstallAttemptId: "update-install-1"
      })
    )).toThrow("requires source-updater invocation");
  });

  it("rejects foreign workflow and any self-reported artifact/run/cell identity drift", () => {
    const receipt = receiptValue();
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receipt,
      producer: { ...receipt.producer, workflow: ".github/workflows/foreign.yml" }
    })).toThrow("producer workflow");
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receipt,
      producer: { ...receipt.producer, artifactName: "foreign-artifact" }
    })).toThrow("producer artifact name");
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receipt,
      producer: { ...receipt.producer, runAttempt: RUN_ATTEMPT + 1 }
    })).toThrow("producer artifact name");
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receipt,
      producer: { ...receipt.producer, runId: "654321" }
    })).toThrow("producer artifact name");
    expect(() => assertElectronProductionUpdaterEvidenceAttemptOutcome({
      ...receipt,
      cell: { ...receipt.cell, evidenceAttemptId: ALTERNATE_EVIDENCE_ATTEMPT_ID }
    })).toThrow("producer artifact name");
  });

  it("rejects canonical tampering even when the receipt still has a valid schema", async () => {
    const fixture = await createFixture();
    const written = await createElectronProductionUpdaterEvidenceAttemptOutcome(
      fixture.input
    );
    const tampered = { ...written.value, reasonCode: "SOURCE_CANCELLED" };
    await writeFile(written.valuePath, serializeCanonicalJson(tampered));

    await expect(readElectronProductionUpdaterEvidenceAttemptOutcome({
      expectedSha256: written.valueIdentity.sha256,
      receiptPath: written.valuePath
    })).rejects.toThrow("receipt SHA-256");
  });

  it("rejects hardlinked and symlinked receipts", async () => {
    const hardlinkFixture = await createFixture();
    const hardlinked = await createElectronProductionUpdaterEvidenceAttemptOutcome(
      hardlinkFixture.input
    );
    await link(hardlinked.valuePath, `${hardlinked.valuePath}.second-link`);
    await expect(readElectronProductionUpdaterEvidenceAttemptOutcome({
      expectedSha256: hardlinked.valueIdentity.sha256,
      receiptPath: hardlinked.valuePath
    })).rejects.toThrow("single-link regular file");

    const symlinkFixture = await createFixture();
    const target = await createElectronProductionUpdaterEvidenceAttemptOutcome(
      symlinkFixture.input
    );
    const symlinkDirectory = path.join(path.dirname(target.valuePath), "symlink");
    await mkdir(symlinkDirectory);
    const symlinkPath = path.join(
      symlinkDirectory,
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE
    );
    await symlink(target.valuePath, symlinkPath);
    await expect(readElectronProductionUpdaterEvidenceAttemptOutcome({
      expectedSha256: target.valueIdentity.sha256,
      receiptPath: symlinkPath
    })).rejects.toThrow("single-link regular file");
  });

  it("CLI create and verify emit canonical summaries without accepting artifact names", async () => {
    const root = await temporaryDirectory();
    const observationSource = Buffer.from("observed source-updater failure\n", "utf8");
    const observationPath = path.join(root, "source-updater-observation.json");
    await writeFile(observationPath, observationSource);
    const outputPath = path.join(
      root,
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE
    );
    const createStdout: Buffer[] = [];
    const createSummary = await runElectronProductionUpdaterEvidenceAttemptOutcomeCli(
      createCliArguments(outputPath, observationPath),
      { writeStdout: (source) => { createStdout.push(source); } }
    );
    expect(createSummary).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_CLI_SUMMARY_KIND,
      command: "create",
      status: "created",
      outcome: "failed",
      receipt: { fileName: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE }
    });
    expect(Buffer.concat(createStdout)).toEqual(serializeCanonicalJson(createSummary));
    const created = await readElectronProductionUpdaterEvidenceAttemptOutcome({
      expectedSha256: createSummary.receipt.sha256,
      receiptPath: outputPath
    });
    expect(created.value.observationArtifact).toEqual({
      fileName: path.basename(observationPath),
      bytes: observationSource.length,
      sha256: sha256(observationSource)
    });

    const verifyStdout: Buffer[] = [];
    const verifySummary = await runElectronProductionUpdaterEvidenceAttemptOutcomeCli([
      "verify",
      "--receipt", outputPath,
      "--expected-sha256", createSummary.receipt.sha256
    ], { writeStdout: (source) => { verifyStdout.push(source); } });
    expect(verifySummary).toMatchObject({ command: "verify", status: "verified" });
    expect(Buffer.concat(verifyStdout)).toEqual(serializeCanonicalJson(verifySummary));

    const noObservationRoot = path.join(root, "without-observation");
    await mkdir(noObservationRoot);
    const noObservationOutput = path.join(
      noObservationRoot,
      ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE
    );
    const noObservationSummary =
      await runElectronProductionUpdaterEvidenceAttemptOutcomeCli(
        createCliArguments(noObservationOutput),
        { writeStdout: () => undefined }
      );
    const noObservation = await readElectronProductionUpdaterEvidenceAttemptOutcome({
      expectedSha256: noObservationSummary.receipt.sha256,
      receiptPath: noObservationOutput
    });
    expect(noObservation.value.observationArtifact).toBeNull();
  });

  it("CLI rejects relative, hardlinked, and symlinked observation artifacts", async () => {
    const root = await temporaryDirectory();
    const sourcePath = path.join(root, "observation.json");
    await writeFile(sourcePath, "observed\n");
    await expect(runElectronProductionUpdaterEvidenceAttemptOutcomeCli(
      createCliArguments(
        path.join(root, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE),
        "relative-observation.json"
      ),
      { writeStdout: () => undefined }
    )).rejects.toThrow("absolute path");

    const hardlinkPath = path.join(root, "observation-hardlink.json");
    await link(sourcePath, hardlinkPath);
    await expect(runElectronProductionUpdaterEvidenceAttemptOutcomeCli(
      createCliArguments(
        path.join(root, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE),
        sourcePath
      ),
      { writeStdout: () => undefined }
    )).rejects.toThrow("single-link regular file");

    await rm(hardlinkPath);
    const symlinkPath = path.join(root, "observation-symlink.json");
    await symlink(sourcePath, symlinkPath);
    await expect(runElectronProductionUpdaterEvidenceAttemptOutcomeCli(
      createCliArguments(
        path.join(root, ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE),
        symlinkPath
      ),
      { writeStdout: () => undefined }
    )).rejects.toThrow("single-link regular file");
  });

  it("CLI rejects duplicate and unknown options", async () => {
    await expect(runElectronProductionUpdaterEvidenceAttemptOutcomeCli([
      "verify",
      "--receipt", "/first",
      "--receipt", "/second",
      "--expected-sha256", ATTEMPT_PLAN_SHA256
    ], { writeStdout: () => undefined })).rejects.toThrow("Duplicate");
    await expect(runElectronProductionUpdaterEvidenceAttemptOutcomeCli([
      "create",
      "--observation-artifact-file-name", "self-reported.json"
    ], { writeStdout: () => undefined })).rejects.toThrow("Unknown create");
  });
});

async function createFixture(
  outcome: ElectronProductionUpdaterEvidenceAttemptOutcomeStatus = "failed"
) {
  const root = await temporaryDirectory();
  return {
    input: {
      attemptPlanSha256: ATTEMPT_PLAN_SHA256,
      cell: cell(),
      deadlineUsedAsSuccess: false,
      observationArtifact: observationArtifact(),
      observedAt: OBSERVED_AT,
      outcome,
      outputPath: path.join(
        root,
        ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_FILE
      ),
      producer: producer(),
      reasonCode: "SOURCE_UPDATER_FAILED",
      sourceInstallAttemptId: "update-install-1",
      sourceUpdaterInvoked: true
    }
  };
}

function receiptValue(
  outcome: ElectronProductionUpdaterEvidenceAttemptOutcomeStatus = "failed",
  options: Readonly<{
    sourceInstallAttemptId?: string | null;
    sourceUpdaterInvoked?: boolean;
    transitionKind?: ElectronProductionUpdaterEvidenceAttemptOutcomeCell["transitionKind"];
  }> = {}
): ElectronProductionUpdaterEvidenceAttemptOutcome {
  const transitionKind = options.transitionKind ?? "tauri-v22-to-electron-v23";
  const outcomeCell = cell(transitionKind);
  return {
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_KIND,
    cutoverEligible: false,
    terminal: true,
    outcome,
    deadlineUsedAsSuccess: false,
    cell: outcomeCell,
    attemptPlanSha256: ATTEMPT_PLAN_SHA256,
    producer: producer(outcomeCell),
    sourceUpdaterInvoked: options.sourceUpdaterInvoked ?? true,
    sourceInstallAttemptId: options.sourceInstallAttemptId === undefined
      ? transitionKind === "tauri-v22-to-electron-v23"
        ? "update-install-1"
        : ELECTRON_SOURCE_INSTALL_ATTEMPT_ID
      : options.sourceInstallAttemptId,
    reasonCode: "SOURCE_UPDATER_FAILED",
    observedAt: OBSERVED_AT,
    observationArtifact: observationArtifact()
  };
}

function cell(
  transitionKind:
    ElectronProductionUpdaterEvidenceAttemptOutcomeCell["transitionKind"] =
      "tauri-v22-to-electron-v23"
): ElectronProductionUpdaterEvidenceAttemptOutcomeCell {
  return {
    transitionKind,
    platform: "darwin-aarch64",
    evidenceAttemptId: EVIDENCE_ATTEMPT_ID
  };
}

function producer(outcomeCell = cell()) {
  return {
    repository: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_REPOSITORY,
    workflow: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_ATTEMPT_OUTCOME_WORKFLOW,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    controlSha: CONTROL_SHA,
    artifactName: electronProductionUpdaterEvidenceAttemptOutcomeArtifactName({
      cell: outcomeCell,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT
    })
  } as const;
}

function observationArtifact() {
  return {
    fileName: "source-updater-observation.json",
    bytes: 321,
    sha256: sha256("source-updater-observation")
  } as const;
}

function createCliArguments(outputPath: string, observationPath?: string) {
  const argumentsList = [
    "create",
    "--output", outputPath,
    "--attempt-plan-sha256", ATTEMPT_PLAN_SHA256,
    "--transition-kind", "tauri-v22-to-electron-v23",
    "--platform", "darwin-aarch64",
    "--evidence-attempt-id", EVIDENCE_ATTEMPT_ID,
    "--outcome", "failed",
    "--run-id", RUN_ID,
    "--run-attempt", String(RUN_ATTEMPT),
    "--control-sha", CONTROL_SHA,
    "--source-updater-invoked", "true",
    "--source-install-attempt-id", "update-install-1",
    "--reason-code", "SOURCE_UPDATER_FAILED",
    "--observed-at", OBSERVED_AT
  ];
  if (observationPath !== undefined) {
    argumentsList.push("--observation-artifact", observationPath);
  }
  return argumentsList;
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-evidence-outcome-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
