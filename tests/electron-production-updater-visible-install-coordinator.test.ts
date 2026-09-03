import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  coordinateElectronProductionUpdaterVisibleInstall
} from "../scripts/electronProductionUpdaterVisibleInstallCoordinator.mjs";
import {
  runElectronProductionUpdaterVisibleInstallCoordinatorCli
} from "../scripts/electronProductionUpdaterVisibleInstallCoordinatorCli.mjs";
import type {
  ElectronProductionUpdaterJournalTrace
} from "../scripts/electronProductionUpdaterJournalTraceObserver.mjs";

const roots: string[] = [];
const TARGET_VERSION = "23.2.0";
const INVOKED_AT = "2026-09-02T00:00:00.000Z";
const COMPLETED_AT = "2026-09-02T00:00:01.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true
  })));
});

describe("Electron production updater visible-install coordinator", () => {
  it.each([
    [
      "darwin-aarch64",
      "darwin",
      "tauri-v22-to-electron-v23",
      "restartPending",
      "update-install-42"
    ],
    [
      "windows-x86_64",
      "win32",
      "electron-v23-to-electron-v23",
      "installerHandoff",
      "update-install-20000000-0000-4000-8000-000000000004"
    ]
  ] as const)(
    "admits both %s journal observers before pressing the visible install control",
    async (platform, uiPlatform, transitionKind, handoffPhase, attemptId) => {
      const fixture = await makeFixture();
      const events: string[] = [];
      const installed = deferred();
      const times = [new Date(INVOKED_AT), new Date(COMPLETED_AT)];
      const source = serializeCanonicalJson({
        schemaVersion: 1,
        attempt: {
          attemptId,
          phase: handoffPhase,
          startedAt: INVOKED_AT,
          targetVersion: TARGET_VERSION,
          updatedAt: COMPLETED_AT
        }
      });
      const sourceIdentity = identity(source, "source-install-journal.json");
      const trace = traceDocument({
        attemptId,
        handoffPhase,
        platform,
        sourceIdentity,
        transitionKind
      });
      const traceSource = serializeCanonicalJson(trace);
      const traceIdentity = identity(traceSource, "source-journal-trace.json");

      const result = await coordinateElectronProductionUpdaterVisibleInstall({
        installActionOutputPath: fixture.installActionPath,
        journalPath: fixture.journalPath,
        journalTraceOutputPath: fixture.tracePath,
        platform,
        processId: 4242,
        signal: new AbortController().signal,
        sourceJournalOutputPath: fixture.sourceJournalPath,
        targetVersion: TARGET_VERSION,
        transitionKind
      }, {
        now: () => times.shift()!,
        observeJournalTrace: async (input, dependencies) => {
          events.push("trace-started");
          dependencies?.onWatchStarted?.();
          events.push("trace-admitted");
          await installed.promise;
          await writeFile(input.outputPath, traceSource, { flag: "wx" });
          return { trace, traceIdentity, tracePath: input.outputPath };
        },
        observeSourceJournal: async (input, dependencies) => {
          events.push("source-started");
          dependencies?.onWatchStarted?.();
          events.push("source-admitted");
          await installed.promise;
          await writeFile(input.outputPath, source, { flag: "wx" });
          return {
            schemaVersion: 1 as const,
            kind: "rion-production-updater-source-journal-capture" as const,
            platform,
            sourceInstallAttemptId: attemptId,
            phase: handoffPhase,
            startedAt: INVOKED_AT,
            updatedAt: COMPLETED_AT,
            journal: sourceIdentity
          };
        },
        pressInstall: async (input, dependencies) => {
          events.push("install-pressed");
          expect(events).toEqual([
            "trace-started",
            "trace-admitted",
            "source-started",
            "source-admitted",
            "install-pressed"
          ]);
          expect(input).toEqual({ platform: uiPlatform, processId: 4242 });
          const invokedAt = dependencies?.now?.().toISOString();
          installed.resolve();
          const completedAt = dependencies?.now?.().toISOString();
          return {
            schemaVersion: 1,
            kind: "rion-production-updater-visible-ui-action",
            action: "install",
            controlName: "Restart and update",
            interaction: "visible-os-accessibility-press",
            invokedAt: invokedAt!,
            completedAt: completedAt!,
            platform: uiPlatform,
            processId: 4242,
            remoteDebugging: false
          };
        }
      });

      expect(result).toMatchObject({
        kind: "rion-production-updater-visible-install-observation",
        platform,
        transitionKind,
        sourceInstallAttemptId: attemptId,
        artifacts: {
          installAction: { fileName: "install-action.json" },
          journalTrace: traceIdentity,
          sourceJournal: sourceIdentity
        }
      });
      expect(JSON.parse(await readFile(fixture.installActionPath, "utf8")))
        .toMatchObject({ action: "install", invokedAt: INVOKED_AT });
      expect(await readFile(fixture.tracePath)).toEqual(traceSource);
      expect(await readFile(fixture.sourceJournalPath)).toEqual(source);
    }
  );

  it("fails before pressing when an observer completes without watcher admission", async () => {
    const fixture = await makeFixture();
    const pressInstall = vi.fn();
    const completedObserver = async () => ({}) as never;

    await expect(coordinateElectronProductionUpdaterVisibleInstall({
      installActionOutputPath: fixture.installActionPath,
      journalPath: fixture.journalPath,
      journalTraceOutputPath: fixture.tracePath,
      platform: "darwin-aarch64",
      processId: 4242,
      signal: new AbortController().signal,
      sourceJournalOutputPath: fixture.sourceJournalPath,
      targetVersion: TARGET_VERSION,
      transitionKind: "tauri-v22-to-electron-v23"
    }, {
      now: () => new Date(INVOKED_AT),
      observeJournalTrace: completedObserver,
      observeSourceJournal: completedObserver,
      pressInstall
    })).rejects.toThrow("completed before visible install admission");
    expect(pressInstall).not.toHaveBeenCalled();
  });

  it("exposes only the closed observe CLI and forwards caller cancellation", async () => {
    const fixture = await makeFixture();
    const signal = new AbortController().signal;
    const expected = Object.freeze({
      schemaVersion: 1 as const,
      kind: "rion-production-updater-visible-install-observation" as const,
      platform: "darwin-aarch64" as const,
      transitionKind: "tauri-v22-to-electron-v23" as const,
      sourceInstallAttemptId: "update-install-42",
      artifacts: Object.freeze({
        installAction: identity(Buffer.from("a"), "install-action.json"),
        journalTrace: identity(Buffer.from("b"), "source-journal-trace.json"),
        sourceJournal: identity(Buffer.from("c"), "source-install-journal.json")
      })
    });
    const coordinate = vi.fn(async (_input: unknown) => expected);
    let stdout = Buffer.alloc(0);

    const result = await runElectronProductionUpdaterVisibleInstallCoordinatorCli([
      "observe",
      "--install-action-output", fixture.installActionPath,
      "--journal", fixture.journalPath,
      "--journal-trace-output", fixture.tracePath,
      "--platform", "darwin-aarch64",
      "--process-id", "4242",
      "--source-journal-output", fixture.sourceJournalPath,
      "--target-version", TARGET_VERSION,
      "--transition-kind", "tauri-v22-to-electron-v23"
    ], {
      coordinate,
      signal,
      writeStdout: (source) => { stdout = Buffer.from(source); }
    });

    expect(result).toEqual(expected);
    expect(JSON.parse(stdout.toString("utf8"))).toEqual(expected);
    expect(coordinate.mock.calls[0]?.[0]).toMatchObject({
      processId: 4242,
      signal
    });
    await expect(runElectronProductionUpdaterVisibleInstallCoordinatorCli([
      "observe",
      "--install-action-output", fixture.installActionPath,
      "--journal", fixture.journalPath,
      "--journal-trace-output", fixture.tracePath,
      "--platform", "darwin-aarch64",
      "--process-id", "4242",
      "--source-journal-output", fixture.sourceJournalPath,
      "--target-version", TARGET_VERSION,
      "--transition-kind", "tauri-v22-to-electron-v23",
      "--fallback", "debug"
    ], { coordinate, signal })).rejects.toThrow("Unknown visible-install option --fallback");
  });
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "rion-visible-install-coordinator-"));
  roots.push(root);
  const userData = join(root, "user-data");
  const output = join(root, "output");
  await Promise.all([mkdir(userData), mkdir(output)]);
  return {
    installActionPath: join(output, "install-action.json"),
    journalPath: join(userData, "app-update-install-journal.json"),
    sourceJournalPath: join(output, "source-install-journal.json"),
    tracePath: join(output, "source-journal-trace.json")
  };
}

function traceDocument(input: {
  attemptId: string;
  handoffPhase: "restartPending" | "installerHandoff";
  platform: "darwin-aarch64" | "windows-x86_64";
  sourceIdentity: ReturnType<typeof identity>;
  transitionKind:
    | "tauri-v22-to-electron-v23"
    | "electron-v23-to-electron-v23";
}): ElectronProductionUpdaterJournalTrace {
  const phases: ElectronProductionUpdaterJournalTrace["observations"][number]["phase"][] = [
    "accepted",
    "preparing",
    "installing",
    "draining",
    input.handoffPhase
  ];
  return {
    schemaVersion: 1 as const,
    kind: "rion-production-updater-source-journal-trace" as const,
    platform: input.platform,
    transitionKind: input.transitionKind,
    targetVersion: TARGET_VERSION,
    visibleInstallInvokedAt: INVOKED_AT,
    sourceInstallAttemptId: input.attemptId,
    observations: phases.map((phase, index) => ({
      sequence: index + 1,
      phase,
      observedAt: COMPLETED_AT,
      sourceInstallAttemptId: input.attemptId,
      startedAt: INVOKED_AT,
      updatedAt: index === 0 ? INVOKED_AT : COMPLETED_AT,
      journal: {
        bytes: index === 4 ? input.sourceIdentity.bytes : index + 1,
        sha256: index === 4
          ? input.sourceIdentity.sha256
          : String(index + 1).repeat(64)
      }
    }))
  };
}

function identity<const FileName extends string>(source: Buffer, fileName: FileName) {
  return Object.freeze({
    bytes: source.length,
    fileName,
    sha256: createHash("sha256").update(source).digest("hex")
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
