import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

import { runElectronUpdaterDarwinHelperProbe } from
  "../scripts/electronUpdaterDarwinHelperProbe.mjs";
import type {
  ElectronUpdaterDarwinCargoOwner,
  ElectronUpdaterDarwinHelperProbeOperations
} from "../scripts/electronUpdaterDarwinHelperProbe.mjs";

const ATTEMPT_ID = "update-install-12345678-1234-4123-8123-123456789abc";

describe.skipIf(process.platform === "win32")("Electron updater Darwin helper probe", () => {
  it("admits the exact helper before ACK and closes both ownership fences", async () => {
    const fixture = await createHelperFixture();
    const events: string[] = [];
    const group = { alive: true };
    let closeCargo!: (value: unknown) => void;
    const cargoClose = new Promise((resolvePromise) => {
      closeCargo = resolvePromise;
    });
    const supervisor = Object.freeze({ kind: "supervisor" });
    const operations = fakeOperations({
      cargoClose,
      events,
      fixture,
      group,
      onAcknowledgement: async (path, source) => {
        events.push("ack");
        await writeFile(path, source, { flag: "wx", mode: 0o600 });
        await unlink(fixture.journal);
        closeCargo({ code: 0, signal: null });
      },
      result: fixture.result,
      supervisor
    });
    try {
      const result = await runElectronUpdaterDarwinHelperProbe({
        environment: { PATH: "/usr/bin:/bin" },
        fixtureRoot: fixture.fixtureRoot,
        platform: "darwin",
        workingDirectory: fixture.workingDirectory
      }, operations);

      expect(result).toMatchObject({
        ...fixture.result,
        cargoProcessGroupId: 91_001,
        cargoProcessGroupOutcome: "active-zero",
        childSandbox: "seatbelt-v1",
        isolationEvidence: { kind: "test-isolation-evidence" }
      });
      expect(events).toEqual([
        "spawn",
        "create-supervisor",
        "admit-supervisor",
        "ack",
        "group-SIGTERM",
        "terminate-supervisor",
        "assert-supervisor-gone",
        "complete-isolation"
      ]);
      const spawnInput = vi.mocked(operations.spawnCargoProbe).mock.calls[0][0];
      expect(spawnInput.testName).toBe(
        "platform_install::macos::tests::packaged_macos_helper_handoff_probe"
      );
      expect(spawnInput.environment).toMatchObject({
        RION_UPDATER_PROBE_ADMISSION_ACK: join(
          fixture.fixtureRoot,
          "probe-control",
          "macos-helper-admission.ack"
        ),
        RION_UPDATER_PROBE_CHILD_SANDBOX: "seatbelt-v1",
        RION_UPDATER_PROBE_INVENTORY_ROOT: join(
          fixture.fixtureRoot,
          "native-tools",
          "process-supervisor"
        ),
        RION_UPDATER_PROBE_RESULT: join(
          fixture.fixtureRoot,
          "probe-control",
          "macos-helper-handoff.json"
        )
      });
      expect(await readFile(
        join(
          fixture.fixtureRoot,
          "probe-control",
          "macos-helper-admission.ack"
        ),
        "utf8"
      )).toBe(`${ATTEMPT_ID}\n`);
      expect(operations.createSupervisor).toHaveBeenCalledWith({
        applicationPath: fixture.currentApp,
        helperProcessId: fixture.result.helperProcessId,
        inventoryExecutablePath: fixture.inventoryExecutablePath,
        launchedAfterMilliseconds: 1_900_000_000_000,
        platform: "darwin",
        runtimeRoot: fixture.fixtureRoot
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses only the exact detached process group when result admission fails", async () => {
    const fixture = await createHelperFixture();
    const events: string[] = [];
    const group = { alive: true };
    let closeCargo!: (value: unknown) => void;
    const cargoClose = new Promise((resolvePromise) => {
      closeCargo = resolvePromise;
    });
    const operations = fakeOperations({
      cargoClose,
      events,
      fixture,
      group,
      onAcknowledgement: async () => {
        throw new Error("ACK must not be written for malformed evidence");
      },
      result: {},
      supervisor: Object.freeze({ kind: "unused" })
    });
    vi.mocked(operations.signalProcessGroup).mockImplementation((id, signal) => {
      events.push(`group-${signal}`);
      expect(id).toBe(91_001);
      group.alive = false;
      closeCargo({ code: null, signal });
    });
    try {
      await expect(runElectronUpdaterDarwinHelperProbe({
        environment: {},
        fixtureRoot: fixture.fixtureRoot,
        platform: "darwin",
        workingDirectory: fixture.workingDirectory
      }, operations)).rejects.toThrow(
        "macOS updater helper probe or its exact cleanup failed"
      );

      expect(events).toEqual(["spawn", "group-SIGTERM"]);
      expect(operations.createSupervisor).not.toHaveBeenCalled();
      expect(operations.writeAdmissionAcknowledgement).not.toHaveBeenCalled();
      expect(operations.signalProcessGroup).toHaveBeenCalledWith(
        91_001,
        "SIGTERM"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires a create-new private control directory before spawning Cargo", async () => {
    const fixture = await createHelperFixture();
    const operations = fakeOperations({
      cargoClose: Promise.resolve({ code: 0, signal: null }),
      events: [],
      fixture,
      group: { alive: false },
      onAcknowledgement: async () => undefined,
      result: fixture.result,
      supervisor: Object.freeze({ kind: "unused" })
    });
    await mkdir(join(fixture.fixtureRoot, "probe-control"), { mode: 0o700 });
    try {
      await expect(runElectronUpdaterDarwinHelperProbe({
        environment: {},
        fixtureRoot: fixture.fixtureRoot,
        platform: "darwin",
        workingDirectory: fixture.workingDirectory
      }, operations)).rejects.toMatchObject({ code: "EEXIST" });
      expect(operations.spawnCargoProbe).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("runner source has no path-regex macOS process fallback", async () => {
    const [runner, helper] = await Promise.all([
      readFile("scripts/runElectronUpdaterTransactionProbe.mjs", "utf8"),
      readFile("scripts/electronUpdaterDarwinHelperProbe.mjs", "utf8")
    ]);

    expect(runner).toContain("runElectronUpdaterDarwinHelperProbe({");
    expect(runner).not.toContain("terminateMacosInstalledApplication");
    expect(`${runner}\n${helper}`).not.toMatch(/\b(?:pkill|pgrep)\b/u);
    expect(helper).toContain("detached: true");
    expect(helper).toContain("process.kill(-processGroupId, signal)");
    expect(helper).toContain("await handle.sync()");
    expect(helper).toContain("await directory.sync()");
  });
});

async function createHelperFixture() {
  const temporaryLink = await mkdtemp(join(tmpdir(), "rion-helper-runner-"));
  const fixtureRoot = await realpath(temporaryLink);
  const workingDirectory = join(fixtureRoot, "workspace");
  const transactionRoot = join(
    fixtureRoot,
    "rion-packaged-updater-handoff-ABC123"
  );
  const currentApp = join(
    transactionRoot,
    "installed",
    "Rion Studio.app"
  );
  const userData = join(transactionRoot, "user-data");
  const journal = join(userData, "app-update-install-journal.json");
  const marker = join(userData, "preserved-user-data-marker");
  const inventoryExecutablePath = join(
    fixtureRoot,
    "native-tools",
    "process-supervisor",
    "inventory"
  );
  await Promise.all([
    mkdir(join(currentApp, "Contents", "Resources"), { recursive: true }),
    mkdir(userData, { recursive: true }),
    mkdir(workingDirectory)
  ]);
  await Promise.all([
    writeFile(join(currentApp, "Contents", "Resources", "app.asar"), "asar"),
    writeFile(journal, "journal", { mode: 0o600 }),
    writeFile(marker, "marker")
  ]);
  const result = Object.freeze({
    attemptId: ATTEMPT_ID,
    currentApp,
    helperProcessId: 92_001,
    journal,
    marker,
    sourceRuntime: "tauri-v22",
    sourceVersion: "22.9.0",
    targetVersion: "23.4.0",
    userData
  });
  return {
    cleanup: () => rm(fixtureRoot, { force: true, recursive: true }),
    currentApp,
    fixtureRoot,
    inventoryExecutablePath,
    journal,
    result,
    workingDirectory
  };
}

function fakeOperations(input: {
  cargoClose: Promise<unknown>;
  events: string[];
  fixture: Awaited<ReturnType<typeof createHelperFixture>>;
  group: { alive: boolean };
  onAcknowledgement(path: string, source: string): Promise<void>;
  result: object;
  supervisor: object;
}): Partial<ElectronUpdaterDarwinHelperProbeOperations> &
  Pick<ElectronUpdaterDarwinHelperProbeOperations,
    "createSupervisor" | "signalProcessGroup" |
    "spawnCargoProbe" | "writeAdmissionAcknowledgement"> {
  let now = 100;
  const cargoOwner: ElectronUpdaterDarwinCargoOwner = {
    close: input.cargoClose,
    completion: input.cargoClose,
    processGroupId: 91_001,
    release: vi.fn()
  };
  return {
    assertSupervisorGone: vi.fn(async () => {
      input.events.push("assert-supervisor-gone");
    }),
    buildProcessInventory: vi.fn(async () => {
      await mkdir(join(
        input.fixture.fixtureRoot,
        "native-tools",
        "process-supervisor"
      ), { recursive: true });
      await writeFile(input.fixture.inventoryExecutablePath, "inventory");
      await chmod(input.fixture.inventoryExecutablePath, 0o700);
      return input.fixture.inventoryExecutablePath;
    }),
    createSupervisor: vi.fn(async () => {
      input.events.push("create-supervisor");
      return input.supervisor as never;
    }),
    completeSupervisorIsolationEvidence: vi.fn(async () => {
      input.events.push("complete-isolation");
      return Object.freeze({ kind: "test-isolation-evidence" }) as never;
    }),
    epochMilliseconds: () => 1_900_000_000_000,
    isProcessGroupAlive: vi.fn(() => input.group.alive),
    now: () => now,
    releaseCargoOwner: vi.fn(),
    signalProcessGroup: vi.fn((_id, signal) => {
      input.events.push(`group-${signal}`);
      input.group.alive = false;
    }),
    sleep: vi.fn(async (milliseconds) => {
      now += milliseconds;
    }),
    spawnCargoProbe: vi.fn(async (spawnInput) => {
      input.events.push("spawn");
      await writeFile(
        spawnInput.environment.RION_UPDATER_PROBE_RESULT!,
        JSON.stringify(input.result),
        { flag: "wx", mode: 0o600 }
      );
      return cargoOwner;
    }),
    terminateSupervisor: vi.fn(async () => {
      input.events.push("terminate-supervisor");
    }),
    waitForCargoClose: vi.fn(async () => {
      await input.cargoClose;
    }),
    waitForSupervisorAdmission: vi.fn(async () => {
      input.events.push("admit-supervisor");
    }),
    writeAdmissionAcknowledgement: vi.fn(input.onAcknowledgement)
  };
}
