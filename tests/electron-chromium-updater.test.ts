import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type {
  AppUpdateInstallAttemptRecord,
  AppUpdateStatusRecord
} from "../src/shared/generated";
import {
  ElectronChromiumUpdater,
  MACOS_UPDATE_RECOVERY_SWITCH,
  MACOS_UPDATE_RELAUNCH_HELPER_SWITCH,
  parseMacosUpdaterRecoveryArguments,
  parseMacosUpdaterRelaunchArguments,
  runMacosUpdaterRelaunchHelper,
  verifyMacosUpdaterRecoveryLocator,
  type RawChromiumUpdaterBinding,
  type RawChromiumUpdaterFactory
} from "../src/electron/main/electronChromiumUpdater";

const attempt: AppUpdateInstallAttemptRecord = {
  attemptId: "update-install-1",
  targetVersion: "23.0.0",
  phase: "accepted",
  startedAt: "2026-08-30T00:00:00Z",
  updatedAt: "2026-08-30T00:00:00Z"
};

const idleStatus: AppUpdateStatusRecord = {
  currentVersion: "22.0.0",
  installMode: "automatic",
  isPackaged: true,
  autoUpdateEnabled: true,
  state: "idle"
};

const downloadedStatus: AppUpdateStatusRecord = {
  ...idleStatus,
  state: "downloaded",
  availableVersion: "23.0.0",
  downloadProgress: 100
};

describe("Electron Chromium updater", () => {
  it("keeps recovery user data behind the Rust-verified relaunch contract", async () => {
    const [mainSource, updaterSource, macosInstallerSource] = await Promise.all([
      readFile("src/electron/main/index.ts", "utf8"),
      readFile("src/electron/main/electronChromiumUpdater.ts", "utf8"),
      readFile("crates/rion-updater/src/platform_install/macos.rs", "utf8")
    ]);
    const verification = mainSource.indexOf(
      "verifyMacosUpdaterRecoveryLocator(addon"
    );
    const selection = mainSource.indexOf(
      "const userDataDirectory = updaterRecovery?.userDataDir"
    );
    expect(verification).toBeGreaterThan(-1);
    expect(selection).toBeGreaterThan(verification);
    expect(macosInstallerSource).toContain(
      "pub(super) fn verify_relaunch_target("
    );
    expect(macosInstallerSource).toContain("RECOVERY_USER_DATA_DIR_SWITCH");
    expect(mainSource).toContain(
      "onFatalEventStreamFailure: (terminal) => fatalEventStream.route(terminal)"
    );
    expect(`${mainSource}\n${updaterSource}`).not.toContain("autoUpdater");
  });

  it("deduplicates a manual check while Rust owns the authoritative operation", async () => {
    const deferred = deferredPromise<string>();
    const fixture = await updaterFixture({
      checkForUpdatesInternal: vi.fn(() => deferred.promise)
    });

    const first = fixture.updater.checkForUpdates();
    const duplicate = fixture.updater.checkForUpdates();
    expect(duplicate).toBe(first);
    expect(fixture.binding.checkForUpdatesInternal).toHaveBeenCalledOnce();

    deferred.resolve(envelope(4, downloadedStatus));
    await expect(first).resolves.toEqual(downloadedStatus);
    await fixture.updater.checkForUpdates();
    expect(fixture.binding.checkForUpdatesInternal).toHaveBeenCalledTimes(2);
  });

  it("publishes only contiguous forward native revisions and rejects a gap", async () => {
    const fixture = await updaterFixture();
    fixture.emit(envelope(5, idleStatus));
    fixture.emit(envelope(6, { ...idleStatus, state: "checking" }));
    fixture.emit(envelope(6, { ...idleStatus, state: "checking" }));
    fixture.emit(envelope(8, downloadedStatus));

    expect(fixture.publishStatus).toHaveBeenCalledTimes(2);
    expect(fixture.publishStatus).toHaveBeenNthCalledWith(1, idleStatus);
    expect(fixture.publishStatus).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ state: "checking" })
    );
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_UPDATE_EVENT_REVISION_GAP"
    }));
    expect(fixture.onFatalEventStreamFailure).toHaveBeenCalledOnce();
    const [terminal] = fixture.onFatalEventStreamFailure.mock.calls[0]!;
    expect(terminal.error).toEqual(expect.objectContaining({
      code: "ELECTRON_UPDATE_EVENT_REVISION_GAP"
    }));
    await expect(terminal.drained).resolves.toBeUndefined();

    fixture.emit(envelope(9, downloadedStatus));
    fixture.emitFailure(JSON.stringify({
      code: "UPDATE_EVENT_STREAM_CLOSED",
      message: "The authoritative updater event receiver closed unexpectedly."
    }));
    expect(fixture.publishStatus).toHaveBeenCalledTimes(2);
    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(fixture.onFatalEventStreamFailure).toHaveBeenCalledOnce();

    expect(() => fixture.updater.getUpdateStatus()).toThrowError(
      expect.objectContaining({ code: "ELECTRON_UPDATE_EVENT_STREAM_FAILED" })
    );
    await expect(fixture.updater.checkForUpdates()).rejects.toMatchObject({
      code: "ELECTRON_UPDATE_EVENT_STREAM_FAILED"
    });
    await expect(fixture.updater.setAutoUpdateEnabled(false)).rejects.toMatchObject({
      code: "ELECTRON_UPDATE_EVENT_STREAM_FAILED"
    });
    await expect(fixture.updater.installDownloadedUpdate()).rejects.toMatchObject({
      code: "ELECTRON_UPDATE_EVENT_STREAM_FAILED"
    });
    expect(fixture.binding.getUpdateStatusInternal).not.toHaveBeenCalled();
    expect(fixture.binding.checkForUpdatesInternal).not.toHaveBeenCalled();
    expect(fixture.binding.setAutoUpdateEnabledInternal).not.toHaveBeenCalled();
    expect(fixture.binding.acceptUpdateInstallInternal).not.toHaveBeenCalled();
  });

  it("latches one closed-schema native stream failure and ignores later input", async () => {
    const fixture = await updaterFixture();
    fixture.emitFailure(JSON.stringify({
      code: "UPDATE_EVENT_STREAM_CLOSED",
      message: "The authoritative updater event receiver closed unexpectedly."
    }));
    fixture.emitFailure(JSON.stringify({
      code: "UPDATE_EVENT_BRIDGE_FAILED",
      message: "This later failure must not replace the first terminal."
    }));
    fixture.emit(envelope(1, idleStatus));

    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(fixture.onError).toHaveBeenCalledWith({
      code: "UPDATE_EVENT_STREAM_CLOSED",
      message: "The authoritative updater event receiver closed unexpectedly."
    });
    expect(fixture.onFatalEventStreamFailure).toHaveBeenCalledOnce();
    expect(fixture.onFatalEventStreamFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          code: "UPDATE_EVENT_STREAM_CLOSED",
          message: "The authoritative updater event receiver closed unexpectedly."
        }
      })
    );
    expect(fixture.publishStatus).not.toHaveBeenCalled();
  });

  it("latches a fail-closed manager publish error before the receiver-close callback", async () => {
    const fixture = await updaterFixture({
      checkForUpdatesInternal: vi.fn(async () => {
        throw new Error(JSON.stringify({
          code: "UPDATE_EVENT_STREAM_UNAVAILABLE",
          message: "UPDATE_EVENT_STREAM_UNAVAILABLE"
        }));
      })
    });

    await expect(fixture.updater.checkForUpdates()).rejects.toMatchObject({
      code: "UPDATE_EVENT_STREAM_UNAVAILABLE"
    });
    expect(fixture.onFatalEventStreamFailure).toHaveBeenCalledOnce();
    expect(fixture.onFatalEventStreamFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "UPDATE_EVENT_STREAM_UNAVAILABLE"
        })
      })
    );

    fixture.emitFailure(JSON.stringify({
      code: "UPDATE_EVENT_STREAM_CLOSED",
      message: "The authoritative updater event receiver closed unexpectedly."
    }));
    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(fixture.onFatalEventStreamFailure).toHaveBeenCalledOnce();
    await expect(fixture.updater.setAutoUpdateEnabled(false)).rejects.toMatchObject({
      code: "ELECTRON_UPDATE_EVENT_STREAM_FAILED"
    });
    expect(fixture.binding.setAutoUpdateEnabledInternal).not.toHaveBeenCalled();
  });

  it("terminalizes invalid event and failure payloads but treats disposal as nonfatal", async () => {
    const invalidEvent = await updaterFixture();
    invalidEvent.emit("{not-json");
    expect(invalidEvent.onFatalEventStreamFailure).toHaveBeenCalledOnce();
    expect(invalidEvent.onFatalEventStreamFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: "ELECTRON_UPDATE_STATUS_INVALID" })
      })
    );

    const invalidFailure = await updaterFixture();
    invalidFailure.emitFailure(JSON.stringify({
      code: "UPDATE_EVENT_STREAM_CLOSED",
      message: "closed",
      extra: true
    }));
    expect(invalidFailure.onFatalEventStreamFailure).toHaveBeenCalledOnce();
    expect(invalidFailure.onFatalEventStreamFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "ELECTRON_UPDATE_EVENT_STREAM_FAILURE_INVALID"
        })
      })
    );

    const unknownFailure = await updaterFixture();
    unknownFailure.emitFailure(JSON.stringify({
      code: "UPDATE_EVENT_USER_CONTROLLED",
      message: "unknown"
    }));
    expect(unknownFailure.onFatalEventStreamFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "ELECTRON_UPDATE_EVENT_STREAM_FAILURE_INVALID"
        })
      })
    );

    const disposed = await updaterFixture();
    disposed.updater.dispose();
    disposed.emit("{not-json");
    disposed.emitFailure(JSON.stringify({
      code: "UPDATE_EVENT_STREAM_CLOSED",
      message: "The authoritative updater event receiver closed unexpectedly."
    }));
    expect(disposed.onError).not.toHaveBeenCalled();
    expect(disposed.onFatalEventStreamFailure).not.toHaveBeenCalled();
    await expect(disposed.updater.checkForUpdates()).rejects.toMatchObject({
      code: "ELECTRON_UPDATE_STOPPED"
    });
    expect(disposed.binding.checkForUpdatesInternal).not.toHaveBeenCalled();
  });

  it("routes a synchronous native subscription failure exactly once", async () => {
    const onFatalEventStreamFailure = vi.fn();
    const onError = vi.fn();
    await expect(updaterFixture({
      subscribeUpdateStatusInternal: vi.fn(() => {
        throw new Error("native subscription failed");
      })
    }, {
      onFatalEventStreamFailure,
      onError
    })).rejects.toMatchObject({
      code: "ELECTRON_UPDATE_EVENT_STREAM_START_FAILED"
    });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_UPDATE_EVENT_STREAM_START_FAILED"
    }));
    expect(onFatalEventStreamFailure).toHaveBeenCalledOnce();
    expect(onFatalEventStreamFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "ELECTRON_UPDATE_EVENT_STREAM_START_FAILED"
        })
      })
    );
  });

  it("accepts once, drains before the verified native handoff, then exits", async () => {
    const order: string[] = [];
    const fixture = await updaterFixture({
      prepareUpdateInstallInternal: vi.fn(async () => {
        order.push("prepare");
        return JSON.stringify({});
      }),
      beginUpdateInstallDrainInternal: vi.fn(async () => {
        order.push("begin-drain");
        return JSON.stringify({});
      }),
      handoffUpdateInstallAfterDrainInternal: vi.fn(async () => {
        order.push("handoff");
        return JSON.stringify({});
      })
    }, {
      drainShellAndCore: vi.fn(async () => {
        order.push("drain");
      }),
      exitAfterHandoff: vi.fn(() => {
        order.push("exit");
      })
    });

    await expect(fixture.updater.installDownloadedUpdate()).resolves.toEqual(attempt);
    await vi.waitFor(() => expect(order).toEqual([
      "prepare",
      "begin-drain",
      "drain",
      "handoff",
      "exit"
    ]));
    expect(
      fixture.binding.handoffUpdateInstallAfterDrainInternal
    ).toHaveBeenCalledWith(attempt.attemptId, 9001);
    expect(fixture.restartAfterFailedDrain).not.toHaveBeenCalled();
  });

  it("rolls back through Rust and restarts after an observed drain failure", async () => {
    const fixture = await updaterFixture({}, {
      drainShellAndCore: vi.fn(async () => {
        throw new Error("drain failed");
      })
    });

    await fixture.updater.installDownloadedUpdate();
    await vi.waitFor(() => {
      expect(fixture.binding.failUpdateInstallAfterDrainInternal).toHaveBeenCalledWith(
        attempt.attemptId,
        "UPDATE_INSTALL_DRAIN_FAILED"
      );
    });
    expect(fixture.restartAfterFailedDrain).toHaveBeenCalledOnce();
    expect(fixture.restartAfterFailedDrain).toHaveBeenCalledWith("drain");
    expect(fixture.binding.handoffUpdateInstallAfterDrainInternal).not.toHaveBeenCalled();
    expect(fixture.exitAfterHandoff).not.toHaveBeenCalled();
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "UPDATE_INSTALL_DRAIN_FAILED"
    }));
  });

  it("awaits fatal ownership when a verified updater handoff fails", async () => {
    const restart = deferredPromise<void>();
    const restartAfterFailedDrain = vi.fn(() => restart.promise);
    const fixture = await updaterFixture({
      handoffUpdateInstallAfterDrainInternal: vi.fn(async () => {
        throw new Error("handoff failed");
      })
    }, { restartAfterFailedDrain });

    await fixture.updater.installDownloadedUpdate();
    await vi.waitFor(() => {
      expect(restartAfterFailedDrain).toHaveBeenCalledWith("handoff");
    });
    expect(fixture.onError).not.toHaveBeenCalled();

    restart.resolve();
    await vi.waitFor(() => {
      expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
        code: "ELECTRON_NATIVE_UPDATER_FAILED"
      }));
    });
  });

  it("validates the macOS helper fence before crossing the native boundary", async () => {
    const factory = {
      createChromiumUpdater: vi.fn(),
      runMacosUpdateRelaunchHelperInternal: vi.fn(async () => 42),
      verifyMacosUpdateRecoveryLocatorInternal: vi.fn()
    } satisfies RawChromiumUpdaterFactory;
    await expect(runMacosUpdaterRelaunchHelper(factory, {
      userDataDir: "/data",
      attemptId: "attempt-1",
      currentVersion: "23.0.0",
      parentProcessId: 9
    })).resolves.toBe(42);
    await expect(runMacosUpdaterRelaunchHelper(factory, {
      userDataDir: "/data",
      attemptId: "",
      currentVersion: "23.0.0",
      parentProcessId: 9
    })).rejects.toMatchObject({ code: "ELECTRON_UPDATE_HELPER_INPUT_INVALID" });

    expect(parseMacosUpdaterRelaunchArguments([
      MACOS_UPDATE_RELAUNCH_HELPER_SWITCH,
      "--rion-update-parent-pid=99",
      "--rion-update-attempt-id=update-install-11111111-1111-4111-8111-111111111111",
      "--rion-update-user-data-dir=/Users/test/Library/Application Support/Rion Studio",
      "--user-data-dir=/Users/test/Library/Application Support/Rion Studio"
    ])).toEqual({
      attemptId: "update-install-11111111-1111-4111-8111-111111111111",
      parentProcessId: 99,
      userDataDir: "/Users/test/Library/Application Support/Rion Studio"
    });
    expect(parseMacosUpdaterRelaunchArguments([])).toBeNull();
    expect(() => parseMacosUpdaterRelaunchArguments([
      MACOS_UPDATE_RELAUNCH_HELPER_SWITCH,
      "--rion-update-parent-pid=099",
      "--rion-update-attempt-id=attempt-controlled",
      "--rion-update-user-data-dir=relative"
    ])).toThrowError(expect.objectContaining({
      code: "ELECTRON_UPDATE_HELPER_ARGUMENTS_INVALID"
    }));

    expect(parseMacosUpdaterRecoveryArguments([
      MACOS_UPDATE_RECOVERY_SWITCH,
      "--rion-update-recovery-attempt-id=update-install-11111111-1111-4111-8111-111111111111",
      "--rion-update-recovery-user-data-dir=/Users/test/Library/Application Support/Rion Studio",
      "--user-data-dir=/Users/test/Library/Application Support/Rion Studio"
    ])).toEqual({
      attemptId: "update-install-11111111-1111-4111-8111-111111111111",
      userDataDir: "/Users/test/Library/Application Support/Rion Studio"
    });
    expect(parseMacosUpdaterRecoveryArguments([])).toBeNull();
    expect(() => parseMacosUpdaterRecoveryArguments([
      MACOS_UPDATE_RECOVERY_SWITCH,
      "--rion-update-recovery-attempt-id=update-install-11111111-1111-4111-8111-111111111111",
      "--rion-update-recovery-user-data-dir=/Users/test/Rion Studio",
      "--user-data-dir=/Users/other/Rion Studio"
    ])).toThrowError(expect.objectContaining({
      code: "ELECTRON_UPDATE_RECOVERY_ARGUMENTS_INVALID"
    }));
    verifyMacosUpdaterRecoveryLocator(factory, {
      userDataDir: "/Users/test/Library/Application Support/Rion Studio",
      attemptId: "update-install-11111111-1111-4111-8111-111111111111",
      currentVersion: "23.0.0"
    });
    expect(factory.verifyMacosUpdateRecoveryLocatorInternal).toHaveBeenCalledOnce();
  });
});

async function updaterFixture(
  overrides: Partial<RawChromiumUpdaterBinding> = {},
  inputOverrides: Partial<Parameters<typeof ElectronChromiumUpdater.create>[2]> = {}
) {
  let emit = (_event: string): void => undefined;
  let emitFailure = (_failure: string): void => undefined;
  const binding: RawChromiumUpdaterBinding = {
    getUpdateStatusInternal: vi.fn(() => envelope(1, idleStatus)),
    checkForUpdatesInternal: vi.fn(async () => envelope(2, downloadedStatus)),
    setAutoUpdateEnabledInternal: vi.fn(async (enabled) => envelope(2, {
      ...idleStatus,
      autoUpdateEnabled: enabled
    })),
    acceptUpdateInstallInternal: vi.fn(async () => JSON.stringify({
      attempt,
      leader: true
    })),
    prepareUpdateInstallInternal: vi.fn(async () => JSON.stringify({})),
    beginUpdateInstallDrainInternal: vi.fn(async () => JSON.stringify({})),
    failUpdateInstallAfterDrainInternal: vi.fn(async () => JSON.stringify({})),
    handoffUpdateInstallAfterDrainInternal: vi.fn(async () => JSON.stringify({})),
    subscribeUpdateStatusInternal: vi.fn((listener, failureListener) => {
      emit = listener;
      emitFailure = failureListener;
    }),
    ...overrides
  };
  const publishStatus = vi.fn();
  const onFatalEventStreamFailure = vi.fn();
  const onError = vi.fn();
  const exitAfterHandoff = vi.fn();
  const restartAfterFailedDrain = vi.fn();
  const factory = {
    createChromiumUpdater: vi.fn(async () => binding),
    runMacosUpdateRelaunchHelperInternal: vi.fn(async () => 42),
    verifyMacosUpdateRecoveryLocatorInternal: vi.fn()
  } satisfies RawChromiumUpdaterFactory;
  const updater = await ElectronChromiumUpdater.create(factory, {
    userDataDir: "/data",
    platform: "darwin",
    currentVersion: "22.0.0",
    packaged: true
  }, {
    drainShellAndCore: vi.fn(async () => undefined),
    exitAfterHandoff,
    restartAfterFailedDrain,
    publishStatus,
    onFatalEventStreamFailure,
    onError,
    processId: 9001,
    ...inputOverrides
  });
  return {
    updater,
    binding,
    emit,
    emitFailure,
    publishStatus,
    onFatalEventStreamFailure,
    onError,
    exitAfterHandoff,
    restartAfterFailedDrain
  };
}

function envelope(revision: number, status: AppUpdateStatusRecord): string {
  return JSON.stringify({ revision, status });
}

function deferredPromise<Value>() {
  let resolvePromise!: (value: Value) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}
