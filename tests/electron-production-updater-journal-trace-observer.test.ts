import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_KIND,
  observeElectronProductionUpdaterJournalTrace,
  readElectronProductionUpdaterJournalTrace
} from "../scripts/electronProductionUpdaterJournalTraceObserver.mjs";

const roots: string[] = [];
const TARGET_VERSION = "23.2.0";
const TAURI_ATTEMPT = "update-install-42";
const ELECTRON_ATTEMPT =
  "update-install-20000000-0000-4000-8000-000000000004";
const INVOKED_AT = "2026-09-02T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

describe("production updater source journal trace observer", () => {
  it("captures the exact Tauri macOS phase sequence from event-bound journal reads", async () => {
    const fixture = await makeFixture();
    const phases = [
      "accepted",
      "preparing",
      "installing",
      "draining",
      "restartPending"
    ];
    const dependencies = journalDependencies(phases, TAURI_ATTEMPT);
    const onWatchStarted = vi.fn();

    const result = await observeElectronProductionUpdaterJournalTrace({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: new AbortController().signal,
      targetVersion: TARGET_VERSION,
      transitionKind: "tauri-v22-to-electron-v23",
      visibleInstallInvokedAt: INVOKED_AT
    }, { ...dependencies, onWatchStarted });

    expect(result.trace.kind).toBe(ELECTRON_PRODUCTION_UPDATER_JOURNAL_TRACE_KIND);
    expect(result.trace.sourceInstallAttemptId).toBe(TAURI_ATTEMPT);
    expect(result.trace.observations.map((entry) => entry.phase)).toEqual(phases);
    expect(result.trace.observations.map((entry) => entry.sequence)).toEqual([
      1, 2, 3, 4, 5
    ]);
    expect(result.traceIdentity.fileName).toBe("source-journal-trace.json");
    expect(onWatchStarted).toHaveBeenCalledOnce();
    expect(await readFile(result.tracePath)).toEqual(serializeCanonicalJson(result.trace));
    const reread = await readElectronProductionUpdaterJournalTrace({
      expectedSha256: result.traceIdentity.sha256,
      tracePath: result.tracePath
    });
    expect(reread.trace).toEqual(result.trace);
    await expect(readElectronProductionUpdaterJournalTrace({
      expectedSha256: "0".repeat(64),
      tracePath: result.tracePath
    })).rejects.toThrow("source journal trace SHA-256 does not match");
  });

  it("captures an Electron Windows UUID attempt through installer handoff", async () => {
    const fixture = await makeFixture();
    const phases = [
      "accepted",
      "preparing",
      "installing",
      "draining",
      "installerHandoff"
    ];

    const result = await observeElectronProductionUpdaterJournalTrace({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "windows-x86_64",
      signal: new AbortController().signal,
      targetVersion: TARGET_VERSION,
      transitionKind: "electron-v23-to-electron-v23",
      visibleInstallInvokedAt: INVOKED_AT
    }, journalDependencies(phases, ELECTRON_ATTEMPT));

    expect(result.trace.sourceInstallAttemptId).toBe(ELECTRON_ATTEMPT);
    expect(result.trace.observations.at(-1)?.phase).toBe("installerHandoff");
  });

  it("fails closed when filesystem events skip an authoritative phase", async () => {
    const fixture = await makeFixture();

    await expect(observeElectronProductionUpdaterJournalTrace({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: new AbortController().signal,
      targetVersion: TARGET_VERSION,
      transitionKind: "tauri-v22-to-electron-v23",
      visibleInstallInvokedAt: INVOKED_AT
    }, journalDependencies(["accepted", "installing"], TAURI_ATTEMPT)))
      .rejects.toThrow("skipped preparing");
  });

  it("rejects a stale journal instead of adopting an earlier install", async () => {
    const fixture = await makeFixture();
    const source = journalSource(
      "accepted",
      TAURI_ATTEMPT,
      "2026-09-01T23:59:59.000Z",
      "2026-09-01T23:59:59.000Z"
    );

    await expect(observeElectronProductionUpdaterJournalTrace({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: new AbortController().signal,
      targetVersion: TARGET_VERSION,
      transitionKind: "tauri-v22-to-electron-v23",
      visibleInstallInvokedAt: INVOKED_AT
    }, {
      now: () => new Date("2026-09-02T00:00:01.500Z"),
      readFile: async () => identity(source),
      watchDirectory: async function* () {}
    })).rejects.toThrow("predates the visible install action");
  });

  it("rejects cross-runtime attempt identifiers", async () => {
    const fixture = await makeFixture();

    await expect(observeElectronProductionUpdaterJournalTrace({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: new AbortController().signal,
      targetVersion: TARGET_VERSION,
      transitionKind: "tauri-v22-to-electron-v23",
      visibleInstallInvokedAt: INVOKED_AT
    }, journalDependencies(["accepted"], ELECTRON_ATTEMPT)))
      .rejects.toThrow("Tauri source install attempt ID is invalid");
  });

  it("treats caller cancellation as non-success", async () => {
    const fixture = await makeFixture();
    const controller = new AbortController();
    controller.abort(new Error("runner cancelled"));

    await expect(observeElectronProductionUpdaterJournalTrace({
      journalPath: fixture.journalPath,
      outputPath: fixture.outputPath,
      platform: "darwin-aarch64",
      signal: controller.signal,
      targetVersion: TARGET_VERSION,
      transitionKind: "tauri-v22-to-electron-v23",
      visibleInstallInvokedAt: INVOKED_AT
    }, {
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    })).rejects.toThrow("cancelled before authoritative handoff (runner cancelled)");
  });
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-journal-trace-"));
  roots.push(root);
  const userData = join(root, "user-data");
  const output = join(root, "observer-output");
  await mkdir(userData);
  await mkdir(output);
  return {
    journalPath: join(userData, "app-update-install-journal.json"),
    outputPath: join(output, "source-journal-trace.json")
  };
}

function journalDependencies(phases: string[], attemptId: string) {
  let current: Buffer | null = null;
  let observationIndex = 0;
  const startedAt = "2026-09-02T00:00:01.000Z";
  return {
    now: () => new Date(`2026-09-02T00:00:0${observationIndex + 2}.500Z`),
    readFile: async () => {
      if (current === null) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return identity(current);
    },
    watchDirectory: async function* () {
      for (let index = 0; index < phases.length; index += 1) {
        observationIndex = index;
        current = journalSource(
          phases[index],
          attemptId,
          startedAt,
          `2026-09-02T00:00:0${index + 1}.000Z`
        );
        yield { eventType: "rename", filename: "app-update-install-journal.json" };
      }
    }
  };
}

function journalSource(
  phase: string,
  attemptId: string,
  startedAt: string,
  updatedAt: string
) {
  return Buffer.from(JSON.stringify({
    attempt: {
      attemptId,
      phase,
      startedAt,
      targetVersion: TARGET_VERSION,
      updatedAt
    },
    schemaVersion: 1
  }));
}

function identity(source: Buffer) {
  return {
    bytes: source.byteLength,
    sha256: createHash("sha256").update(source).digest("hex"),
    source
  };
}
