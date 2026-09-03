import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  observeElectronProductionUpdaterTerminalReceipt
} from "../scripts/electronProductionUpdaterTerminalReceiptObserver.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater terminal receipt observer", () => {
  it.each([
    ["darwin-aarch64", "restartPending", "update-install-8"],
    [
      "windows-x86_64",
      "installerHandoff",
      "update-install-10000000-0000-4000-8000-000000000002"
    ]
  ] as const)("captures the product-authored %s terminal authority", async (
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
        filename: join("app-update-terminal-receipts", `${fixture.journalSha256}.json`)
      };
    };

    const capture = await observeElectronProductionUpdaterTerminalReceipt({
      outputPath: fixture.outputPath,
      platform,
      signal: new AbortController().signal,
      sourceJournalPath: fixture.sourceJournalPath,
      targetUserDataDirectory: fixture.userDataDirectory,
      targetVersion: "8.6.0"
    }, { watchDirectory: events });

    expect(capture).toMatchObject({
      authority: "target-first-boot-journal-reconciliation",
      platform,
      sourceInstallAttemptId: attemptId,
      terminalOutcome: "applied",
      receipt: {
        bytes: receiptSource.length,
        sha256: sha256(receiptSource)
      }
    });
    expect(await readFile(fixture.outputPath)).toEqual(receiptSource);
  });

  it("rejects a receipt that does not bind the raw captured journal", async () => {
    const fixture = await createFixture({
      attemptId: "update-install-9",
      sourcePhase: "restartPending"
    });
    await mkdir(fixture.productReceiptDirectory);
    const forged = JSON.parse(productReceiptSource(fixture).toString("utf8"));
    forged.sourceJournalSha256 = "f".repeat(64);
    await writeFile(fixture.productReceiptPath, JSON.stringify(forged));

    await expect(observeElectronProductionUpdaterTerminalReceipt({
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: new AbortController().signal,
      sourceJournalPath: fixture.sourceJournalPath,
      targetUserDataDirectory: fixture.userDataDirectory,
      targetVersion: "8.6.0"
    })).rejects.toThrow("source journal SHA-256 does not match");
  });

  it("turns external cancellation into non-success instead of Applied", async () => {
    const fixture = await createFixture({
      attemptId: "update-install-10",
      sourcePhase: "restartPending"
    });
    const controller = new AbortController();
    controller.abort(new Error("external acknowledgement unknown"));

    await expect(observeElectronProductionUpdaterTerminalReceipt({
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: controller.signal,
      sourceJournalPath: fixture.sourceJournalPath,
      targetUserDataDirectory: fixture.userDataDirectory,
      targetVersion: "8.6.0"
    })).rejects.toThrow("cancelled before authoritative receipt");
  });
});

async function createFixture(input: { attemptId: string; sourcePhase: string }) {
  const root = await mkdtemp(join(tmpdir(), "rion-product-terminal-observer-"));
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
