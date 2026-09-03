import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import {
  assertElectronUpdaterDarwinProcessTreeGone,
  completeElectronUpdaterDarwinProcessIsolationEvidence,
  createElectronUpdaterDarwinProcessSupervisor,
  requireElectronUpdaterDarwinProcessIsolationEvidence,
  terminateElectronUpdaterDarwinProcessSupervisor,
  waitForElectronUpdaterDarwinProcessSupervisorAdmission
} from "../scripts/electronUpdaterDarwinProcessSupervisor.mjs";
import type {
  DarwinPackagedProcessOperations,
  DarwinProcessInventoryRecord
} from "../scripts/packagedElectronDarwinProcessOwnership.mjs";

const LAUNCHED_AFTER_MILLISECONDS = 1_800_000_000_000;
const CURRENT_USER_ID = process.getuid?.() ?? 501;

describe.skipIf(process.platform === "win32")(
  "Electron updater Darwin process supervisor",
  () => {
  it("admits the exact helper and reaches audit-token active-zero for its descendants", async () => {
    const fixture = await createSupervisorFixture();
    const helper = processRecord({
      auditByte: "11",
      executablePath: fixture.mainExecutablePath,
      parentProcessUniqueId: "1",
      processId: 81_001,
      processUniqueId: "101"
    });
    const active = new Map([[helper.processUniqueId, helper]]);
    const { operations, signals } = fakeOperations(active, new Set(["33".repeat(32)]));
    try {
      const supervisor = await createElectronUpdaterDarwinProcessSupervisor({
        applicationPath: fixture.applicationPath,
        helperProcessId: helper.processId,
        inventoryExecutablePath: fixture.inventoryExecutablePath,
        launchedAfterMilliseconds: LAUNCHED_AFTER_MILLISECONDS,
        platform: "darwin",
        runtimeRoot: fixture.runtimeRoot
      }, operations);
      expect(() => completeElectronUpdaterDarwinProcessIsolationEvidence(
        supervisor
      )).toThrow("requires exact admission and termination");

      await expect(
        waitForElectronUpdaterDarwinProcessSupervisorAdmission(supervisor)
      ).resolves.toEqual(helper);
      expect(Object.isFrozen(supervisor)).toBe(true);

      active.delete(helper.processUniqueId);
      const relaunchedApplication = processRecord({
        auditByte: "22",
        executablePath: fixture.mainExecutablePath,
        parentProcessUniqueId: helper.processUniqueId,
        processId: 81_002,
        processUniqueId: "102"
      });
      const escapedDescendant = processRecord({
        auditByte: "33",
        executablePath: "/usr/bin/true",
        parentProcessUniqueId: relaunchedApplication.processUniqueId,
        processId: 81_003,
        processUniqueId: "103"
      });
      const unrelated = processRecord({
        auditByte: "44",
        executablePath: "/usr/bin/false",
        parentProcessUniqueId: "1",
        processId: 81_004,
        processUniqueId: "104"
      });
      for (const entry of [relaunchedApplication, escapedDescendant, unrelated]) {
        active.set(entry.processUniqueId, entry);
      }

      await terminateElectronUpdaterDarwinProcessSupervisor(supervisor);
      await expect(assertElectronUpdaterDarwinProcessTreeGone(supervisor))
        .resolves.toBeUndefined();
      const evidence = await completeElectronUpdaterDarwinProcessIsolationEvidence(
        supervisor
      );
      expect(requireElectronUpdaterDarwinProcessIsolationEvidence(evidence))
        .toBe(evidence);
      expect(evidence).toMatchObject({
        admittedIdentity: helper,
        applicationPath: fixture.applicationPath,
        helperProcessId: helper.processId,
        kind: "rion-electron-updater-darwin-supervisor-isolation",
        outcome: "active-zero"
      });
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(() => requireElectronUpdaterDarwinProcessIsolationEvidence({
        ...evidence
      })).toThrow("supervisor-issued capability");

      expect(signals).toContainEqual({
        auditToken: relaunchedApplication.auditToken,
        signal: "SIGTERM"
      });
      expect(signals).toContainEqual({
        auditToken: escapedDescendant.auditToken,
        signal: "SIGTERM"
      });
      expect(signals).toContainEqual({
        auditToken: escapedDescendant.auditToken,
        signal: "SIGKILL"
      });
      expect(signals).not.toContainEqual(expect.objectContaining({
        auditToken: unrelated.auditToken
      }));
      expect(active.has(unrelated.processUniqueId)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not admit another process running the same bundle executable", async () => {
    const fixture = await createSupervisorFixture();
    const impostor = processRecord({
      auditByte: "55",
      executablePath: fixture.mainExecutablePath,
      parentProcessUniqueId: "1",
      processId: 82_002,
      processUniqueId: "202"
    });
    const active = new Map([[impostor.processUniqueId, impostor]]);
    const { clock, operations } = fakeOperations(active);
    try {
      const supervisor = await createElectronUpdaterDarwinProcessSupervisor({
        applicationPath: fixture.applicationPath,
        helperProcessId: 82_001,
        inventoryExecutablePath: fixture.inventoryExecutablePath,
        launchedAfterMilliseconds: LAUNCHED_AFTER_MILLISECONDS,
        platform: "darwin",
        runtimeRoot: fixture.runtimeRoot
      }, operations);

      await expect(waitForElectronUpdaterDarwinProcessSupervisorAdmission(
        supervisor,
        clock.now + 50
      )).rejects.toThrow("was not observable after launch");
    } finally {
      await fixture.cleanup();
    }
  });

  it("fails closed when an exact descendant survives audit-token SIGKILL", async () => {
    const fixture = await createSupervisorFixture();
    const helper = processRecord({
      auditByte: "66",
      executablePath: fixture.mainExecutablePath,
      parentProcessUniqueId: "1",
      processId: 83_001,
      processUniqueId: "301"
    });
    const active = new Map([[helper.processUniqueId, helper]]);
    const { operations } = fakeOperations(
      active,
      new Set([helper.auditToken]),
      new Set([helper.auditToken])
    );
    try {
      const supervisor = await createElectronUpdaterDarwinProcessSupervisor({
        applicationPath: fixture.applicationPath,
        helperProcessId: helper.processId,
        inventoryExecutablePath: fixture.inventoryExecutablePath,
        launchedAfterMilliseconds: LAUNCHED_AFTER_MILLISECONDS,
        platform: "darwin",
        runtimeRoot: fixture.runtimeRoot
      }, operations);
      await waitForElectronUpdaterDarwinProcessSupervisorAdmission(supervisor);

      await expect(
        terminateElectronUpdaterDarwinProcessSupervisor(supervisor)
      ).rejects.toBeInstanceOf(AggregateError);
      expect(active.has(helper.processUniqueId)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects non-exclusive paths and detects executable identity mutation", async () => {
    const fixture = await createSupervisorFixture();
    const helper = processRecord({
      auditByte: "77",
      executablePath: fixture.mainExecutablePath,
      parentProcessUniqueId: "1",
      processId: 84_001,
      processUniqueId: "401"
    });
    const active = new Map([[helper.processUniqueId, helper]]);
    const { operations } = fakeOperations(active);
    try {
      await expect(createElectronUpdaterDarwinProcessSupervisor({
        applicationPath: fixture.applicationPath,
        helperProcessId: helper.processId,
        inventoryExecutablePath: fixture.inventoryExecutablePath,
        launchedAfterMilliseconds: LAUNCHED_AFTER_MILLISECONDS,
        platform: "darwin",
        runtimeRoot: join(fixture.root, "outside")
      }, operations)).rejects.toThrow("fixed app inside its runtime root");

      const supervisor = await createElectronUpdaterDarwinProcessSupervisor({
        applicationPath: fixture.applicationPath,
        helperProcessId: helper.processId,
        inventoryExecutablePath: fixture.inventoryExecutablePath,
        launchedAfterMilliseconds: LAUNCHED_AFTER_MILLISECONDS,
        platform: "darwin",
        runtimeRoot: fixture.runtimeRoot
      }, operations);
      await waitForElectronUpdaterDarwinProcessSupervisorAdmission(supervisor);
      active.clear();
      await chmod(fixture.mainExecutablePath, 0o755);

      await expect(assertElectronUpdaterDarwinProcessTreeGone(supervisor))
        .rejects.toThrow("identity changed during supervision");
      await expect(assertElectronUpdaterDarwinProcessTreeGone({} as never))
        .rejects.toThrow("was not factory-issued");
    } finally {
      await fixture.cleanup();
    }
  });

  it("contains no path-regex process termination fallback", async () => {
    const source = await readFile(resolve(
      import.meta.dirname,
      "../scripts/electronUpdaterDarwinProcessSupervisor.mjs"
    ), "utf8");

    expect(source).not.toMatch(/\b(?:pkill|pgrep)\b/u);
    expect(source).not.toContain("-f");
  });
  }
);

async function createSupervisorFixture() {
  const temporaryLink = await mkdtemp(join(tmpdir(), "rion-updater-supervisor-"));
  const root = await realpath(temporaryLink);
  const runtimeRoot = join(root, "runtime");
  const applicationPath = join(
    runtimeRoot,
    "installed",
    "Rion Studio.app"
  );
  const mainExecutablePath = join(
    applicationPath,
    "Contents",
    "MacOS",
    "Rion Studio"
  );
  const inventoryExecutablePath = join(root, "native", "process-inventory");
  await Promise.all([
    mkdir(join(applicationPath, "Contents", "MacOS"), { recursive: true }),
    mkdir(join(root, "native"), { recursive: true }),
    mkdir(join(root, "outside"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(mainExecutablePath, "packaged executable\n", { mode: 0o700 }),
    writeFile(inventoryExecutablePath, "inventory executable\n", { mode: 0o700 })
  ]);
  return {
    applicationPath,
    cleanup: () => rm(root, { force: true, recursive: true }),
    inventoryExecutablePath,
    mainExecutablePath,
    root,
    runtimeRoot
  };
}

function processRecord(input: {
  auditByte: string;
  executablePath: string;
  parentProcessUniqueId: string;
  processId: number;
  processUniqueId: string;
}): DarwinProcessInventoryRecord {
  const startSeconds = Math.floor(LAUNCHED_AFTER_MILLISECONDS / 1_000);
  return Object.freeze({
    auditToken: input.auditByte.repeat(32),
    executablePath: input.executablePath,
    parentProcessId: 1,
    parentProcessUniqueId: input.parentProcessUniqueId,
    processGroupId: input.processId,
    processId: input.processId,
    processUniqueId: input.processUniqueId,
    startMicroseconds:
      (LAUNCHED_AFTER_MILLISECONDS - startSeconds * 1_000) * 1_000,
    startSeconds,
    userId: CURRENT_USER_ID
  });
}

function fakeOperations(
  active: Map<string, DarwinProcessInventoryRecord>,
  survivesTerm = new Set<string>(),
  survivesKill = new Set<string>()
) {
  const clock = { now: 100 };
  const signals: Array<{
    auditToken: string;
    signal: "SIGTERM" | "SIGKILL";
  }> = [];
  const operations: DarwinPackagedProcessOperations = {
    epochMilliseconds: () => LAUNCHED_AFTER_MILLISECONDS + 10_000,
    now: () => clock.now,
    readInventory: vi.fn(async () => [...active.values()]),
    signalAuditToken: vi.fn(async (
      _executablePath,
      auditToken,
      signal
    ) => {
      signals.push({ auditToken, signal });
      const survivors = signal === "SIGTERM" ? survivesTerm : survivesKill;
      if (survivors.has(auditToken)) return;
      const identity = [...active.values()].find(
        (entry) => entry.auditToken === auditToken
      );
      if (identity) active.delete(identity.processUniqueId);
    }),
    sleep: vi.fn(async (milliseconds) => {
      clock.now += milliseconds;
    })
  };
  return { clock, operations, signals };
}
