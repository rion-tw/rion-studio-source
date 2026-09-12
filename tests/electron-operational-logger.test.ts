import { describe, expect, it, vi } from "vitest";

import type { CoreEvent, LogCaptureRecord } from "../src/shared/generated";
import {
  ElectronOperationalLogger,
  type ElectronOperationalLogCorePort
} from "../src/electron/main/electronOperationalLogger";
import { logMacosAppKitWindowPlacement } from
  "../src/electron/main/electronRuntimeDiagnosticLogging";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function corePort(invokeImplementation?: (entries: LogCaptureRecord[]) => Promise<unknown>) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const invoke = vi.fn(async (command: { type: string; entries: LogCaptureRecord[] }) => {
    return invokeImplementation?.(command.entries) ?? { inserted: command.entries.length };
  });
  const port = {
    invoke,
    subscribeCoreEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  } as unknown as ElectronOperationalLogCorePort;
  return {
    invoke,
    port,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    }
  };
}

function captured(invoke: ReturnType<typeof vi.fn>): LogCaptureRecord[] {
  return invoke.mock.calls.flatMap(([command]) => command.entries as LogCaptureRecord[]);
}

describe("Electron operational logger", () => {
  it("projects validated AppKit placement provenance into one bounded debug record", () => {
    const nativeWindowPlacement = vi.fn();
    logMacosAppKitWindowPlacement({
      nativeWindowPlacement,
      trustedInputTerminal: vi.fn()
    }, {
      identity: {
        logicalWindowId: "window-1",
        launchGeneration: "launch-1",
        nativeGeneration: 3
      },
      action: {
        type: "windowPlacementChanged",
        sourceWindowId: "window-1",
        placementDiagnostics: {
          zoomed: false,
          fullScreen: false,
          minimized: false,
          frameX: 10,
          frameY: 20,
          frameWidth: 1280,
          frameHeight: 720,
          triggerEventType: 10,
          triggerKeyCode: 65_535,
          triggerModifierFlags: 131_072,
          firstResponderCategory: "roleSurface",
          physicalInputSequence: "4"
        }
      },
      hosts: []
    });

    expect(nativeWindowPlacement).toHaveBeenCalledWith({
      windowId: "window-1",
      nativeGeneration: 3,
      zoomed: false,
      fullScreen: false,
      minimized: false,
      frame: { x: 10, y: 20, width: 1280, height: 720 },
      triggerEventType: 10,
      triggerKeyCode: null,
      triggerModifierFlags: 131_072,
      firstResponderCategory: "roleSurface",
      physicalInputSequence: "4"
    });
  });

  it("emits bounded debug evidence for session, shortcut, input, and placement paths", async () => {
    const core = corePort();
    const logger = new ElectronOperationalLogger();
    logger.bindCore(core.port);
    logger.managedShortcutTransition({ roleId: "role-1", phase: "keyDown" });
    logger.trustedInputTerminal({
      roleId: "role-1",
      applicationPath: "physical-modifier-adoption"
    });
    logger.nativeWindowPlacement({
      windowId: "window-1",
      zoomed: false,
      triggerKeyCode: 16
    });
    await logger.applicationSessionReady();

    expect(captured(core.invoke).map((entry) => [entry.level, entry.event])).toEqual([
      ["debug", "managed_shortcut_transition"],
      ["debug", "trusted_input_terminal"],
      ["debug", "native_window_placement"],
      ["info", "application_session_ready"],
      ["debug", "debug_capture_active"]
    ]);
  });

  it("bounds the pre-Core buffer and flushes it before later observations", async () => {
    const core = corePort();
    const logger = new ElectronOperationalLogger();
    for (let index = 0; index < 258; index += 1) {
      logger.info("main", `event-${index}`, `message-${index}`);
    }

    logger.bindCore(core.port);
    logger.info("main", "after-bind", "after bind");
    await logger.flush();

    expect(core.invoke).toHaveBeenCalledTimes(2);
    expect(core.invoke.mock.calls[0][0].entries).toHaveLength(256);
    expect(captured(core.invoke).map((entry) => entry.event)).toEqual([
      ...Array.from({ length: 256 }, (_, index) => `event-${index + 2}`),
      "after-bind"
    ]);
  });

  it("maps authoritative Core events and deduplicates reduced browser and macro state", async () => {
    const core = corePort();
    const logger = new ElectronOperationalLogger();
    logger.bindCore(core.port);
    const browserEvent: CoreEvent = {
      type: "browserStatuses",
      statuses: [{
        roleId: "role-1",
        state: "running",
        runtimeMode: "embedded",
        automationState: "ready",
        pageHealth: "healthy"
      }]
    };
    const macroEvent: CoreEvent = {
      type: "macroStatuses",
      reliable: true,
      statuses: [{
        roleId: "role-1",
        macroId: "macro-1",
        state: "running",
        iteration: 1,
        lastClick: null,
        startedAt: "2026-09-10T00:00:00Z",
        updatedAt: "2026-09-10T00:00:01Z",
        error: null
      }]
    };

    core.emit(browserEvent);
    core.emit(browserEvent);
    core.emit(macroEvent);
    core.emit({ ...macroEvent, statuses: [{ ...macroEvent.statuses[0], iteration: 2 }] });
    core.emit({ type: "macroStatuses", reliable: true, statuses: [] });
    core.emit({
      type: "stateChanged",
      revision: 8,
      changedCollections: ["roles", "macros"]
    });
    core.emit({
      type: "browserLaunchCompleted",
      operationId: "operation-1",
      sourceId: "role-1",
      sourceType: "role",
      tabId: "tab-1",
      ok: false,
      errorCode: "BROWSER_LAUNCH_FAILED"
    });
    core.emit({
      type: "extensionsChanged",
      snapshot: { revision: 4, installed: [], roles: [] }
    });
    core.emit({
      type: "graphicsSettingsChanged",
      snapshot: { revision: 5, settings: {} }
    } as CoreEvent);
    core.emit({
      type: "roleSessionRecoveryChanged",
      record: {
        roleId: "role-1",
        attemptId: "attempt-1",
        revision: 6,
        journalRevision: 3,
        phase: "ready",
        blockers: [],
        candidates: [],
        sourceIntegrity: "verified",
        targetEquality: "equal",
        persistence: "durable",
        login: "available",
        upgradeResult: null
      }
    });
    core.emit({
      type: "chromeProfileImportProgress",
      progress: {
        importId: "import-1",
        profileId: "profile-1",
        phase: "cookies",
        completed: 2,
        total: 5
      }
    });
    await logger.flush();

    expect(captured(core.invoke).map((entry) => entry.event)).toEqual([
      "browser_status_changed",
      "macro_lifecycle_changed",
      "macro_lifecycle_stopped",
      "core_state_changed",
      "browser_launch_completed",
      "extensions_changed",
      "graphics_settings_changed",
      "session_recovery_changed",
      "chrome_profile_import_progress"
    ]);
    const browserContext = JSON.parse(captured(core.invoke)[0].contextRawJson!);
    expect(browserContext).toEqual({
      count: 1,
      states: [{
        roleId: "role-1",
        state: "running",
        automationState: "ready",
        healthState: "healthy"
      }]
    });
  });

  it("records lifecycle, updater, IPC, and renderer observations without arguments or URLs", async () => {
    const core = corePort();
    const logger = new ElectronOperationalLogger();
    logger.bindCore(core.port);
    logger.observeApplicationLifecycle({
      revision: 2,
      capturedAt: "2026-09-10T00:00:00Z",
      lifecycleEpoch: 2,
      state: "suspended",
      reason: "power-suspended",
      platform: "macos"
    });
    logger.observeUpdateStatus({
      currentVersion: "1.0.0",
      installMode: "manual",
      isPackaged: false,
      autoUpdateEnabled: false,
      state: "error",
      error: "https://private.example/?token=secret",
      errorCode: "UPDATE_CHECK_FAILED"
    });
    logger.observeInvocationFailure("getAppVersion", "ELECTRON_TEST_FAILED");
    logger.rendererError("renderer_crash", "Renderer failed.", "stack");
    await expect(logger.runDiagnosticsExport(async () => ({ logFileCount: 1 })))
      .resolves.toEqual({ logFileCount: 1 });
    await expect(logger.runDiagnosticsExport(async () => {
      throw Object.assign(new Error("export failed"), {
        code: "DIAGNOSTICS_WRITE_FAILED"
      });
    })).rejects.toMatchObject({ code: "DIAGNOSTICS_WRITE_FAILED" });
    await logger.flush();

    const entries = captured(core.invoke);
    expect(entries.map((entry) => entry.event)).toEqual([
      "power_lifecycle_changed",
      "updater_status_changed",
      "ipc_invocation_failed",
      "renderer_crash",
      "diagnostics_export_succeeded",
      "diagnostics_export_failed"
    ]);
    const encoded = JSON.stringify(entries);
    expect(encoded).not.toContain("private.example");
    expect(JSON.parse(entries[2].contextRawJson!)).toEqual({
      method: "getAppVersion",
      errorCode: "ELECTRON_TEST_FAILED"
    });
  });

  it("reports capture failure only to the stderr observer and never recurses", async () => {
    const writeCaptureFailure = vi.fn(() => {
      throw new Error("stderr unavailable");
    });
    const core = corePort(async () => {
      throw Object.assign(new Error("database unavailable"), {
        code: "CORE_LOG_DATABASE_FAILED"
      });
    });
    const logger = new ElectronOperationalLogger({ writeCaptureFailure });
    logger.bindCore(core.port);

    logger.error("main", "shell_error", "Shell failed.", new Error("boom"), "SHELL_FAILED");
    logger.info("main", "after_failure", "The capture lane remains usable.");
    await expect(logger.flush()).resolves.toBeUndefined();

    expect(core.invoke).toHaveBeenCalledOnce();
    expect(writeCaptureFailure).toHaveBeenCalledOnce();
    expect(writeCaptureFailure).toHaveBeenCalledWith("CORE_LOG_DATABASE_FAILED");
  });

  it("batches observations that arrive behind one in-flight capture", async () => {
    const first = deferred<unknown>();
    let calls = 0;
    const core = corePort(async (entries) => {
      calls += 1;
      if (calls === 1) return first.promise;
      return { inserted: entries.length };
    });
    const logger = new ElectronOperationalLogger();
    logger.bindCore(core.port);
    logger.info("main", "first", "first");
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledOnce());

    logger.debug("macro", "second", "second");
    logger.debug("macro", "third", "third");
    first.resolve({ inserted: 1 });
    await logger.flush();

    expect(core.invoke).toHaveBeenCalledTimes(2);
    expect(core.invoke.mock.calls[1][0].entries.map(
      (entry: LogCaptureRecord) => entry.event
    )).toEqual(["second", "third"]);
  });

  it("drains admitted captures on dispose and rejects later observations", async () => {
    const capture = deferred<unknown>();
    const core = corePort(() => capture.promise);
    const logger = new ElectronOperationalLogger();
    logger.bindCore(core.port);
    logger.info("main", "app_quitting", "Application is quitting cleanly.");
    const drain = logger.dispose();
    await vi.waitFor(() => expect(core.invoke).toHaveBeenCalledOnce());
    logger.info("main", "late", "late");

    capture.resolve({ inserted: 1 });
    await drain;
    expect(core.invoke).toHaveBeenCalledOnce();
  });
});
