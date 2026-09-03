import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeElectronProductionUpdaterSourceJournal
} from "../scripts/electronProductionUpdaterSourceJournalObserver.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production updater source journal observer", () => {
  it.each([
    ["darwin-aarch64", "restartPending", "update-install-7"],
    [
      "windows-x86_64",
      "installerHandoff",
      "update-install-10000000-0000-4000-8000-000000000001"
    ]
  ] as const)("event-binds and seals the raw %s handoff journal", async (
    platform,
    phase,
    attemptId
  ) => {
    const fixture = await createFixture();
    const source = journalSource({ attemptId, phase });
    const onWatchStarted = vi.fn();
    const events = async function* () {
      await writeFile(fixture.journalPath, source, { flag: "wx" });
      yield { eventType: "rename", filename: "app-update-install-journal.json" };
    };

    const capture = await observeElectronProductionUpdaterSourceJournal({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform,
      signal: new AbortController().signal,
      targetVersion: "8.6.0",
      visibleInstallInvokedAt: "2026-09-02T00:00:00Z"
    }, { onWatchStarted, watchDirectory: events });

    expect(capture).toMatchObject({
      phase,
      platform,
      sourceInstallAttemptId: attemptId,
      journal: {
        bytes: source.length,
        sha256: sha256(source)
      }
    });
    expect(await readFile(fixture.outputPath)).toEqual(source);
    expect(onWatchStarted).toHaveBeenCalledOnce();
  });

  it("ignores non-terminal phases but never converts cancellation into success", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const events = async function* () {
      await writeFile(fixture.journalPath, journalSource({
        attemptId: "update-install-2",
        phase: "installing"
      }), { flag: "wx" });
      yield { filename: "app-update-install-journal.json" };
      controller.abort(new Error("external acknowledgement deadline"));
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    };

    await expect(observeElectronProductionUpdaterSourceJournal({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: controller.signal,
      targetVersion: "8.6.0",
      visibleInstallInvokedAt: "2026-09-02T00:00:00Z"
    }, { watchDirectory: events })).rejects.toThrow(
      "cancelled before authoritative handoff"
    );
  });

  it("rejects a stale prior-attempt journal and leaves the output absent", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.journalPath, journalSource({
      attemptId: "update-install-1",
      phase: "restartPending",
      startedAt: "2026-09-01T23:59:59Z"
    }));

    await expect(observeElectronProductionUpdaterSourceJournal({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: new AbortController().signal,
      targetVersion: "8.6.0",
      visibleInstallInvokedAt: "2026-09-02T00:00:00Z"
    })).rejects.toThrow("predates the visible install action");
    await expect(readFile(fixture.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "rion-source-journal-observer-"));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, "source-user-data");
  const sealedRoot = join(root, "sealed-parent-output");
  await Promise.all([mkdir(sourceRoot), mkdir(sealedRoot)]);
  return {
    journalPath: join(sourceRoot, "app-update-install-journal.json"),
    outputPath: join(sealedRoot, "source-install-journal.json")
  };
}

function journalSource(input: {
  attemptId: string;
  phase: string;
  startedAt?: string;
}) {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    attempt: {
      attemptId: input.attemptId,
      targetVersion: "8.6.0",
      phase: input.phase,
      startedAt: input.startedAt ?? "2026-09-02T00:00:01Z",
      updatedAt: "2026-09-02T00:00:02Z"
    }
  }));
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
