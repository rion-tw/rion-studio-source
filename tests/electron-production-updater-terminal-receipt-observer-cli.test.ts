import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_OBSERVER_CLI_SUMMARY_KIND,
  runElectronProductionUpdaterTerminalReceiptObserverCli
} from "../scripts/electronProductionUpdaterTerminalReceiptObserverCli.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater terminal-receipt observer CLI", () => {
  it.each([
    ["darwin-aarch64", "restartPending", "update-install-8"],
    [
      "windows-x86_64",
      "installerHandoff",
      "update-install-10000000-0000-4000-8000-000000000002"
    ]
  ] as const)("observes and verifies product authority for %s", async (
    platform,
    sourcePhase,
    attemptId
  ) => {
    const fixture = await createFixture({ attemptId, sourcePhase });
    const receiptSource = productReceiptSource(fixture);
    const events = async function* () {
      await mkdir(fixture.productReceiptDirectory);
      await writeFile(fixture.productReceiptPath, receiptSource, { flag: "wx" });
      yield {
        eventType: "rename",
        filename: join(
          "app-update-terminal-receipts",
          `${fixture.journalSha256}.json`
        )
      };
    };
    let stdout = Buffer.alloc(0);
    const observed = await runElectronProductionUpdaterTerminalReceiptObserverCli(
      observeArguments(fixture, platform),
      {
        signal: new AbortController().signal,
        watchDirectory: events,
        writeStdout: (source) => { stdout = Buffer.from(source); }
      }
    );

    expect(observed).toEqual({
      schemaVersion: 1,
      kind:
        ELECTRON_PRODUCTION_UPDATER_TERMINAL_RECEIPT_OBSERVER_CLI_SUMMARY_KIND,
      command: "observe",
      status: "captured",
      authority: "target-first-boot-journal-reconciliation",
      platform,
      reconciledAt: "2026-09-02T00:00:03Z",
      sourceInstallAttemptId: attemptId,
      terminalOutcome: "applied",
      receipt: {
        bytes: receiptSource.byteLength,
        fileName: "product-terminal-receipt.json",
        sha256: sha256(receiptSource)
      }
    });
    expect(stdout).toEqual(serializeCanonicalJson(observed));
    expect(await readFile(fixture.outputPath)).toEqual(receiptSource);

    stdout = Buffer.alloc(0);
    const verified = await runElectronProductionUpdaterTerminalReceiptObserverCli([
      "verify",
      "--platform", platform,
      "--source-journal", fixture.sourceJournalPath,
      "--target-version", "8.6.0",
      "--receipt", fixture.outputPath,
      "--expected-sha256", observed.receipt.sha256
    ], {
      writeStdout: (source) => { stdout = Buffer.from(source); }
    });
    expect(verified).toEqual({
      ...observed,
      command: "verify",
      status: "verified"
    });
    expect(stdout).toEqual(serializeCanonicalJson(verified));
  });

  it("keeps observe event-bound and cancellation non-success", async () => {
    const fixture = await createFixture({
      attemptId: "update-install-9",
      sourcePhase: "restartPending"
    });
    const argumentsList = observeArguments(fixture, "darwin-aarch64");

    await expect(runElectronProductionUpdaterTerminalReceiptObserverCli(
      argumentsList,
      { writeStdout: () => undefined }
    )).rejects.toThrow("caller must provide an AbortSignal");

    const controller = new AbortController();
    controller.abort(new Error("external liveness ended"));
    await expect(runElectronProductionUpdaterTerminalReceiptObserverCli(
      argumentsList,
      { signal: controller.signal, writeStdout: () => undefined }
    )).rejects.toThrow("cancelled before authoritative receipt");
    await expect(readFile(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects producer-authored authority flags and closed-option violations", async () => {
    const fixture = await createFixture({
      attemptId: "update-install-10",
      sourcePhase: "restartPending"
    });
    const argumentsList = observeArguments(fixture, "darwin-aarch64");

    await expect(runElectronProductionUpdaterTerminalReceiptObserverCli([
      ...argumentsList,
      "--terminal-outcome", "applied"
    ])).rejects.toThrow("Unknown observe terminal-receipt option --terminal-outcome");
    await expect(runElectronProductionUpdaterTerminalReceiptObserverCli([
      ...argumentsList,
      "--output", fixture.outputPath
    ])).rejects.toThrow("Duplicate observe terminal-receipt option --output");
    await expect(runElectronProductionUpdaterTerminalReceiptObserverCli([
      "verify",
      "--platform", "darwin-aarch64",
      "--source-journal", fixture.sourceJournalPath,
      "--target-version", "8.6.0",
      "--receipt", fixture.outputPath,
      "--expected-sha256", "0".repeat(64),
      "--authority", "target-first-boot-journal-reconciliation"
    ])).rejects.toThrow("Unknown verify terminal-receipt option --authority");
  });

  it("verifies raw product authority instead of trusting an expected digest alone", async () => {
    const fixture = await createFixture({
      attemptId: "update-install-11",
      sourcePhase: "restartPending"
    });
    const forged = JSON.parse(productReceiptSource(fixture).toString("utf8"));
    forged.terminalOutcome = "failed";
    const forgedSource = Buffer.from(JSON.stringify(forged));
    await writeFile(fixture.outputPath, forgedSource);

    await expect(runElectronProductionUpdaterTerminalReceiptObserverCli([
      "verify",
      "--platform", "darwin-aarch64",
      "--source-journal", fixture.sourceJournalPath,
      "--target-version", "8.6.0",
      "--receipt", fixture.outputPath,
      "--expected-sha256", sha256(forgedSource)
    ], { writeStdout: () => undefined })).rejects.toThrow(
      "product terminal outcome does not match"
    );
  });
});

async function createFixture(input: { attemptId: string; sourcePhase: string }) {
  const root = await mkdtemp(join(tmpdir(), "rion-product-terminal-cli-"));
  temporaryDirectories.push(root);
  const userDataDirectory = join(root, "target-user-data");
  const outputDirectory = join(root, "parent-output");
  await Promise.all([mkdir(userDataDirectory), mkdir(outputDirectory)]);
  const sourceJournal = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    attempt: {
      attemptId: input.attemptId,
      targetVersion: "8.6.0",
      phase: input.sourcePhase,
      startedAt: "2026-09-02T00:00:01Z",
      updatedAt: "2026-09-02T00:00:02Z"
    }
  }));
  const sourceJournalPath = join(outputDirectory, "source-install-journal.json");
  await writeFile(sourceJournalPath, sourceJournal);
  const journalSha256 = sha256(sourceJournal);
  const productReceiptDirectory = join(
    userDataDirectory,
    "app-update-terminal-receipts"
  );
  return {
    attemptId: input.attemptId,
    journalSha256,
    outputPath: join(outputDirectory, "product-terminal-receipt.json"),
    productReceiptDirectory,
    productReceiptPath: join(productReceiptDirectory, `${journalSha256}.json`),
    sourceJournal,
    sourceJournalPath,
    sourcePhase: input.sourcePhase,
    userDataDirectory
  };
}

function observeArguments(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  platform: "darwin-aarch64" | "windows-x86_64"
) {
  return [
    "observe",
    "--platform", platform,
    "--source-journal", fixture.sourceJournalPath,
    "--target-user-data", fixture.userDataDirectory,
    "--target-version", "8.6.0",
    "--output", fixture.outputPath
  ];
}

function productReceiptSource(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: "rion-updater-install-terminal",
    authority: "target-first-boot-journal-reconciliation",
    sourceJournalBytes: fixture.sourceJournal.length,
    sourceJournalSha256: fixture.journalSha256,
    sourcePhase: fixture.sourcePhase,
    runningVersion: "8.6.0",
    terminalOutcome: "applied",
    reconciledAt: "2026-09-02T00:00:03Z",
    attempt: {
      attemptId: fixture.attemptId,
      targetVersion: "8.6.0",
      phase: "applied",
      startedAt: "2026-09-02T00:00:01Z",
      updatedAt: "2026-09-02T00:00:03Z"
    }
  }));
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
