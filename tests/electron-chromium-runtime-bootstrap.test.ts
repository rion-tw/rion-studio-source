import { posix } from "node:path";

import type {
  CoreCommand,
  CoreCommandResult,
  CoreEffectRequest,
  CoreEffectResult,
  CoreEvent,
  EmbeddedTabEffectRecord,
  EngineCapabilitySnapshotRecord,
  RolePathsRecord,
  RoleSessionMigrationRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import { CHROMIUM_ROLE_FONTS_CHANNEL } from
  "../src/electron/ipc/chromiumRoleFontsProtocol";
import {
  CoreAddonClient,
  type CoreEventStreamFailure,
  type RawNodeApiCoreBinding
} from "../src/electron/core/coreAddonClient";
import { CHROMIUM_ROLE_OVERLAY_CHANNEL } from
  "../src/electron/ipc/chromiumRoleOverlayProtocol";
import { RionBridgeError } from "../src/electron/ipc/errors";
import type { ChromiumRoleSessionPort } from
  "../src/electron/main/chromiumRoleSessionRegistry";
import { CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES } from
  "../src/electron/main/chromiumRoleBrowserDataClearCoordinator";
import {
  chromiumRoleBrowserDataClearFreshHelperResponseMetadata,
  parseChromiumRoleBrowserDataClearFreshHelperRequest
} from
  "../src/electron/main/chromiumRoleBrowserDataClearFreshHelperContract";
import type {
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort
} from "../src/electron/main/chromiumRoleSurfacePorts";
import {
  buildChromiumRuntimeRegistration,
  ChromiumRuntimeBootstrap,
  ELECTRON_CHROMIUM_RUNTIME_CONTRACT_VERSION,
  MACOS_APPKIT_CHROMIUM_CAPABILITIES,
  UNAVAILABLE_CHROMIUM_CAPABILITIES,
  WINDOWS_CHROMIUM_BOOTSTRAP_CAPABILITIES,
  withElectronChromiumRuntimeContract,
  type ChromiumRuntimeCorePort,
  type MacosAppKitRuntimeBootstrapAdapter
} from "../src/electron/main/chromiumRuntimeBootstrap";
import type { ChromiumRuntimeHostPort } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";
import type { CoreEffectEventStreamFailureTerminal } from
  "../src/electron/main/coreEffectCoordinator";

type Listener = (...arguments_: unknown[]) => unknown;

function rolePaths(roleId: string): RolePathsRecord {
  const browser = posix.join("/RionData/roles", roleId, "browser");
  return {
    browserUserDataDir: browser,
    systemBrowserDataDir: posix.join(browser, "system-webview"),
    webview2UserDataDir: posix.join(browser, "system-webview", "webview2"),
    chromiumUserDataDir: posix.join(browser, "chromium"),
    webkitDataStoreKey: `role:${roleId}:wkwebview`,
    webkitDataStoreIdentifier: roleId
  };
}

function exportedMigrationJournal(): RoleSessionMigrationRecord {
  return {
    roleId: "11111111-1111-4111-8111-111111111111",
    transferId: "22222222-2222-4222-8222-222222222222",
    phase: "exported",
    journalRevision: 3,
    platform: "macos",
    sourceEngine: "wkwebview",
    targetEngine: "chromium",
    sourceRevision: 12,
    envelopeSha256: "a".repeat(64),
    inventorySha256: "b".repeat(64),
    cookieCount: 1,
    localStorageOriginCount: 0,
    localStorageEntryCount: 0,
    startedAt: "2026-08-30T00:00:00.000Z",
    phaseChangedAt: "2026-08-30T00:00:01.000Z",
    updatedAt: "2026-08-30T00:00:01.000Z"
  };
}

class FakeCore implements ChromiumRuntimeCorePort {
  readonly commands: CoreCommand[] = [];
  readonly dispatches: CoreEffectResult[][] = [];
  readonly order: string[];
  readonly migrationJournals: readonly RoleSessionMigrationRecord[];
  readonly beginMigrationError?: Error;
  listener: ((event: CoreEvent) => void) | null = null;
  failureListener: ((failure: CoreEventStreamFailure) => void) | null = null;
  readonly unsubscribe = vi.fn(() => {
    this.order.push("unsubscribe-local");
    this.listener = null;
  });
  readonly unsubscribeFailure = vi.fn(() => {
    this.order.push("unsubscribe-stream-failure");
    this.failureListener = null;
  });

  constructor(
    order: string[] = [],
    migration: Readonly<{
      journals?: readonly RoleSessionMigrationRecord[];
      beginError?: Error;
    }> = {}
  ) {
    this.order = order;
    this.migrationJournals = migration.journals ?? [];
    this.beginMigrationError = migration.beginError;
  }

  async invoke<Command extends CoreCommand>(
    command: Command
  ): Promise<CoreCommandResult<Command>> {
    this.commands.push(command);
    if (command.type === "roleSessionMigrationsList") {
      this.order.push("resume-migrations");
      return [...this.migrationJournals] as unknown as CoreCommandResult<Command>;
    }
    if (command.type === "browserRuntimeRegister") {
      this.order.push("register");
      return command.registration as CoreCommandResult<Command>;
    }
    if (command.type === "rolePathsResolve") {
      this.order.push("resolve-role-paths");
      return rolePaths(command.id) as CoreCommandResult<Command>;
    }
    if (command.type === "runtimeWindowPreferencesGet") {
      this.order.push("runtime-window-preferences");
      return {
        alwaysHideTabCloseButton: false,
        alwaysShowToolbarInFullScreen: false,
        restoreGameWindowsOnStartup: true
      } as CoreCommandResult<Command>;
    }
    if (command.type === "layoutCreateDividers") {
      this.order.push("resolve-dividers");
      return [] as unknown as CoreCommandResult<Command>;
    }
    if (command.type === "layoutResolve") {
      this.order.push("resolve-layout");
      return {
        visible: true,
        roles: command.input.roles.map((role) => ({
          roleId: role.roleId,
          bounds: { ...command.input.contentBounds }
        })),
        dividers: []
      } as unknown as CoreCommandResult<Command>;
    }
    throw new Error(`Unexpected Core command ${command.type}.`);
  }

  async readRoleSessionTransferVaultInternal(): Promise<Buffer> {
    throw new Error("No resumable session migration was expected.");
  }

  async beginRoleSessionMigrationImportInternal(): Promise<never> {
    throw this.beginMigrationError ??
      new Error("No exported session migration was expected.");
  }

  async transitionRoleSessionMigrationTargetInternal(): Promise<never> {
    throw new Error("No resumable session migration was expected.");
  }

  async acquireChromeProfileImportTransactionInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async refreshChromeProfileImportTransactionInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async readChromeProfileImportPayloadInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async writeChromeProfileImportBackupInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async readChromeProfileImportBackupInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async prepareChromeProfileImportFreshVerificationInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async completeChromeProfileImportFreshVerificationInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async commitChromeProfileImportInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async verifyChromeProfileImportCommitMarkerInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async releaseChromeProfileImportTransactionInternal(): Promise<never> {
    throw new Error("No Chrome profile import was expected.");
  }

  async recoverPendingChromeProfileImportsInternal() {
    this.order.push("recover-chrome-profile-imports");
    return { recovered: 0, pending: 0 };
  }

  async launchChromeProfileImportHelperInternal(
    metadataBytes: Buffer,
    secretBytes: Buffer
  ) {
    const request = parseChromiumRoleBrowserDataClearFreshHelperRequest(
      metadataBytes
    );
    if (secretBytes.byteLength !== 0) {
      throw new Error("The role clear helper received unexpected secret bytes.");
    }
    this.order.push("fresh-role-clear-helper");
    return {
      outcome: "applied" as const,
      metadataBytes: chromiumRoleBrowserDataClearFreshHelperResponseMetadata(
        request,
        {
          cookieReadbackCount: 0,
          storageClearAcknowledgement:
            "electron-clear-storage-data-promise",
          processInstanceId: "22222222-2222-4222-8222-222222222222",
          sessionDrainEvidenceSha256: "a".repeat(64)
        }
      ),
      secretBytes: Buffer.alloc(0),
      exitEvidenceSha256: "b".repeat(64)
    };
  }

  subscribeCoreEvents(listener: (event: CoreEvent) => void): () => void {
    this.order.push("subscribe-local");
    this.listener = listener;
    return this.unsubscribe;
  }

  subscribeCoreEventStreamFailures(
    listener: (failure: CoreEventStreamFailure) => void
  ): () => void {
    this.failureListener = listener;
    return this.unsubscribeFailure;
  }

  startCoreEventBridge(): void {
    this.order.push("subscribe-raw");
  }

  async dispatchCoreEffectResults(results: CoreEffectResult[]) {
    this.dispatches.push(results);
    this.order.push(`ack:${results[0]?.effectId}`);
    return {
      accepted: results.map((result) => result.effectId),
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    };
  }

  async shutdown(): Promise<void> {
    this.order.push("core-shutdown");
  }

  emit(event: CoreEvent): void {
    this.listener?.(event);
  }

  failEventStream(): void {
    this.failureListener?.({
      type: "eventStreamFailure",
      drained: Promise.resolve(),
      error: {
        code: "CORE_EVENT_STREAM_CLOSED",
        message: "The authoritative Core event stream closed unexpectedly."
      }
    });
  }
}

function tab(): EmbeddedTabEffectRecord {
  const role = {
    id: "role-1",
    gameId: "game-1",
    name: "Role 1",
    launchUrl: "https://game.test/play",
    notes: "",
    createdAt: "2026-08-30T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z"
  };
  return {
    tabId: "tab-1",
    audioMuted: false,
    attemptGeneration: "attempt-1",
    sourceId: role.id,
    name: role.name,
    workspaceAppearance: { background: "black", gap: 4 },
    target: {
      windowId: "window-1",
      displayId: 1,
      scaleFactor: 2,
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
      bounds: { x: 100, y: 80, width: 800, height: 600 },
      presentation: "normal"
    },
    slots: [{
      slotId: "slot-1",
      role,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      zoomFactor: 1,
      zoomMode: "fixed",
      state: "launching",
      owner: { tabId: "tab-1", slotId: "slot-1", generation: 1 }
    }],
    roles: [{
      role,
      resolvedEngine: "chromium",
      rect: { x: 0, y: 0, width: 1, height: 1 },
      zoomFactor: 1,
      zoomMode: "fixed"
    }]
  };
}

function effect(
  effectId: string,
  action: CoreEffectRequest["action"],
  handleId = "tab-1"
): CoreEffectRequest {
  return {
    effectId,
    operationId: `operation-${effectId}`,
    target: { kind: "app", handleId },
    completionPolicy: "deadlineBound",
    deadlineMs: 60_000,
    action
  };
}

function fullCapabilities(): EngineCapabilitySnapshotRecord {
  return Object.fromEntries(
    Object.keys(UNAVAILABLE_CHROMIUM_CAPABILITIES).map((key) => [key, "supported"])
  ) as EngineCapabilitySnapshotRecord;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function emptyNativePorts() {
  return {
    ipcMain: emptyIpcMain(),
    sessions: {
      fromPath: vi.fn(() => {
        throw new Error("No role session was expected.");
      })
    },
    views: {
      create: vi.fn(() => {
        throw new Error("No role surface was expected.");
      })
    }
  };
}

function emptyIpcMain() {
  return {
    handle: vi.fn(),
    removeHandler: vi.fn()
  };
}

describe("Electron Chromium runtime bootstrap", () => {
  it("rejects a startup quit fence before Core recovery or native construction", async () => {
    const core = new FakeCore();
    const native = emptyNativePorts();
    const startupAbort = new AbortController();
    startupAbort.abort("application-before-quit");

    await expect(ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      startupSignal: startupAbort.signal,
      ...native,
      onError: vi.fn()
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_BOOTSTRAP_CANCELLED"
    });
    expect(core.commands).toHaveLength(0);
    expect(core.order).toHaveLength(0);
    expect(native.sessions.fromPath).not.toHaveBeenCalled();
    expect(native.views.create).not.toHaveBeenCalled();
  });

  it("awaits Chrome-profile recovery after registration and raw effect intake", async () => {
    const order: string[] = [];
    const core = new FakeCore(order);
    vi.spyOn(core, "recoverPendingChromeProfileImportsInternal")
      .mockImplementation(async () => {
        order.push("recover-chrome-profile-imports");
        return { recovered: 1, pending: 2 };
      });
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    });

    expect(runtime.chromeProfileImportRecovery).toEqual({ recovered: 1, pending: 2 });
    expect(order.indexOf("resume-migrations"))
      .toBeLessThan(order.indexOf("register"));
    expect(order.indexOf("register"))
      .toBeLessThan(order.indexOf("subscribe-raw"));
    expect(order.indexOf("subscribe-raw"))
      .toBeLessThan(order.indexOf("recover-chrome-profile-imports"));
    await runtime.shutdown();

    const failedCore = new FakeCore();
    vi.spyOn(failedCore, "recoverPendingChromeProfileImportsInternal")
      .mockRejectedValue(new RionBridgeError({
        code: "CHROME_PROFILE_IMPORT_RECOVERY_FAILED",
        message: "Recovery evidence was not exact."
      }));
    await expect(ChromiumRuntimeBootstrap.start({
      core: failedCore,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    })).rejects.toMatchObject({ code: "CHROME_PROFILE_IMPORT_RECOVERY_FAILED" });
  });

  it("rejects startup after the event stream fails and its coordinator drain completes", async () => {
    const order: string[] = [];
    const core = new FakeCore(order);
    const recovery = deferred();
    vi.spyOn(core, "recoverPendingChromeProfileImportsInternal")
      .mockImplementation(async () => {
        order.push("recover-chrome-profile-imports");
        await recovery.promise;
        return { recovered: 0, pending: 0 };
      });
    const onFatalEventStreamFailure = vi.fn();
    const onError = vi.fn(() => {
      throw new Error("observational reporter failed");
    });
    const start = ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onFatalEventStreamFailure,
      onError
    });
    await vi.waitFor(() => expect(order).toContain("recover-chrome-profile-imports"));

    core.failEventStream();
    await expect(start).rejects.toMatchObject({
      code: "CORE_EVENT_STREAM_CLOSED"
    });
    expect(onFatalEventStreamFailure).not.toHaveBeenCalled();
    expect(core.unsubscribe).toHaveBeenCalledOnce();
    expect(core.unsubscribeFailure).toHaveBeenCalledOnce();
    expect(order).not.toContain("core-shutdown");
    expect(onError).toHaveBeenCalled();
  });

  it("hands a post-start failure to one ordered fatal runtime drain", async () => {
    const order: string[] = [];
    const core = new FakeCore(order);
    let fatalDrain: Promise<void> | undefined;
    const onFatalEventStreamFailure = vi.fn((
      terminal: CoreEffectEventStreamFailureTerminal
    ) => {
      fatalDrain = terminal.drained.then(() => runtime.shutdown());
    });
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onFatalEventStreamFailure,
      onError: vi.fn()
    });

    core.failEventStream();
    core.failEventStream();
    expect(() => runtime.snapshot()).toThrow(
      "cannot project native state while it is draining"
    );
    await vi.waitFor(() => expect(onFatalEventStreamFailure).toHaveBeenCalledOnce());
    await fatalDrain;
    expect(core.unsubscribe).toHaveBeenCalledOnce();
    expect(core.unsubscribeFailure).toHaveBeenCalledOnce();
    expect(order.indexOf("unsubscribe-stream-failure"))
      .toBeLessThan(order.indexOf("core-shutdown"));
    expect(order.filter((entry) => entry === "core-shutdown")).toHaveLength(1);
  });

  it("does not enter fatal topology for an ordinary runtime shutdown", async () => {
    const core = new FakeCore();
    const onFatalEventStreamFailure = vi.fn();
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onFatalEventStreamFailure,
      onError: vi.fn()
    });

    await runtime.shutdown();
    expect(onFatalEventStreamFailure).not.toHaveBeenCalled();
    expect(core.order.filter((entry) => entry === "core-shutdown")).toHaveLength(1);
  });

  it("closes frozen native state before admitting a clean recovery journal", async () => {
    const order: string[] = [];
    const core = new FakeCore(order);
    const persist = vi.fn(async (snapshot) => {
      order.push("persist-clean");
      expect(snapshot).toEqual({
        windows: [], tabs: [], roles: [], webSurfaces: []
      });
    });
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    });

    runtime.beginCleanExit();
    expect(() => runtime.snapshot()).toThrow(
      "cannot project native state while it is draining"
    );
    const clean = runtime.prepareCleanExit(persist);
    expect(runtime.prepareCleanExit(persist)).toBe(clean);
    await clean;

    expect(core.unsubscribe).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(order).toContain("persist-clean");
    expect(order).not.toContain("core-shutdown");
    await runtime.shutdown();
    expect(order.indexOf("persist-clean"))
      .toBeLessThan(order.indexOf("core-shutdown"));
  });

  it("invalidates a pending clean-exit commit when fatal stream loss wins", async () => {
    const core = new FakeCore();
    const platformDrain = deferred();
    const drainEvents = vi.fn(() => platformDrain.promise);
    const persist = vi.fn(async () => undefined);
    const onFatalEventStreamFailure = vi.fn();
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      appKit: {
        adapterVersion: "test-appkit-unavailable",
        capabilities: UNAVAILABLE_CHROMIUM_CAPABILITIES,
        hostFactory: {} as MacosAppKitRuntimeBootstrapAdapter["hostFactory"],
        drainEvents
      },
      onFatalEventStreamFailure,
      onError: vi.fn()
    });

    const clean = runtime.prepareCleanExit(persist);
    await vi.waitFor(() => expect(drainEvents).toHaveBeenCalledOnce());
    core.failEventStream();
    expect(() => runtime.snapshot()).toThrow(
      "cannot project native state while it is draining"
    );
    expect(onFatalEventStreamFailure).toHaveBeenCalledOnce();

    platformDrain.resolve();
    await expect(clean).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_CLEAN_EXIT_INVALIDATED"
    });
    expect(persist).not.toHaveBeenCalled();
    await runtime.shutdown();
  });

  it("rejects a clean commit when fatal stream loss arrives during persistence", async () => {
    const core = new FakeCore();
    const persistence = deferred();
    const persist = vi.fn(() => persistence.promise);
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onFatalEventStreamFailure: vi.fn(),
      onError: vi.fn()
    });

    const clean = runtime.prepareCleanExit(persist);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    core.failEventStream();
    persistence.resolve();

    await expect(clean).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_CLEAN_EXIT_INVALIDATED"
    });
    await runtime.shutdown();
  });

  it("owns and drains the fixed overlay and browser-font preload handlers", async () => {
    const core = new FakeCore();
    const native = emptyNativePorts();
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...native,
      onError: vi.fn()
    });

    expect(native.ipcMain.handle.mock.calls.map(([channel]) => channel).sort())
      .toEqual([
        CHROMIUM_ROLE_FONTS_CHANNEL,
        CHROMIUM_ROLE_OVERLAY_CHANNEL
      ].sort());
    await runtime.shutdown();
    expect(native.ipcMain.removeHandler.mock.calls.map(([channel]) => channel).sort())
      .toEqual([
        CHROMIUM_ROLE_FONTS_CHANNEL,
        CHROMIUM_ROLE_OVERLAY_CHANNEL
      ].sort());
  });

  it("acknowledges role-data clear only after the exact v23 session receipt", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const paths = rolePaths(roleId);
    const order: string[] = [];
    const core = new FakeCore(order);
    const clearStorageData = vi.fn(async () => { order.push("clear"); });
    const flushStore = vi.fn(async () => { order.push("cookie-flush"); });
    const get = vi.fn(async () => {
      order.push("cookie-readback");
      return [];
    });
    const flushStorageData = vi.fn(() => { order.push("storage-flush"); });
    const session = {
      on: vi.fn(),
      clearStorageData,
      cookies: { flushStore, get },
      flushStorageData,
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setBluetoothPairingHandler: vi.fn()
    } as unknown as ChromiumRoleSessionPort;
    const fromPath = vi.fn((path: string) => {
      Object.defineProperty(session, "storagePath", { value: path });
      return session;
    });
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ipcMain: emptyIpcMain(),
      sessions: { fromPath },
      views: {
        create: vi.fn(() => { throw new Error("No role surface was expected."); })
      },
      onError: vi.fn()
    });

    core.emit({
      type: "coreEffects",
      effects: [effect("clear-role-data", {
        type: "roleBrowserDataClearSession",
        roleId,
        webview2UserDataDir: paths.webview2UserDataDir,
        webkitDataStoreIdentifier: paths.webkitDataStoreIdentifier
      }, roleId)]
    });

    await vi.waitFor(() => expect(core.dispatches).toHaveLength(1));
    const receipt = core.dispatches[0]?.[0];
    expect(receipt).toMatchObject({
      effectId: "clear-role-data",
      operationId: "operation-clear-role-data",
      ok: true,
      error: null
    });
    expect(JSON.parse(receipt?.valueJson ?? "null")).toEqual({
      roleId,
      operationId: "operation-clear-role-data",
      clearedStorages: CHROMIUM_ROLE_BROWSER_DATA_STORAGE_TYPES,
      cookieReadbackCount: 0,
      evidence: "electron-clear-storage-data-promise-and-cookie-readback"
    });
    expect(fromPath).not.toHaveBeenCalled();
    expect(clearStorageData).not.toHaveBeenCalled();
    expect(flushStore).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(order).toEqual(expect.arrayContaining([
      "fresh-role-clear-helper",
      "ack:clear-role-data"
    ]));
    expect(order.indexOf("fresh-role-clear-helper"))
      .toBeLessThan(order.indexOf("ack:clear-role-data"));
    await runtime.shutdown();
  });

  it("registers the exact conservative v23 capability fixtures", () => {
    const versions = { electronVersion: "43.4.1", chromiumVersion: "150.0.7871.224" };
    expect(ELECTRON_CHROMIUM_RUNTIME_CONTRACT_VERSION).toBe(23);
    expect(buildChromiumRuntimeRegistration({
      platform: "win32",
      ...versions
    })).toEqual({
      contractVersion: 23,
      platform: "windows",
      engine: "chromium",
      adapterVersion: "electron-43.4.1+chromium-150.0.7871.224",
      available: true,
      capabilities: WINDOWS_CHROMIUM_BOOTSTRAP_CAPABILITIES
    });
    expect(WINDOWS_CHROMIUM_BOOTSTRAP_CAPABILITIES).toEqual({
      navigation: "supported",
      persistentSession: "supported",
      trustedInput: "supported",
      backgroundInput: "supported",
      frameEvaluation: "degraded",
      popup: "supported",
      audioMute: "supported",
      customFonts: "supported",
      downloads: "disabled",
      fileUpload: "supported",
      permissions: "degraded",
      dialogs: "supported",
      certificateHandling: "supported"
    });
    expect(MACOS_APPKIT_CHROMIUM_CAPABILITIES.fileUpload).toBe("supported");
    expect(MACOS_APPKIT_CHROMIUM_CAPABILITIES.popup).toBe("supported");
    expect(buildChromiumRuntimeRegistration({
      platform: "darwin",
      ...versions
    })).toEqual({
      contractVersion: 23,
      platform: "macos",
      engine: "chromium",
      adapterVersion: "electron-43.4.1+chromium-150.0.7871.224",
      available: false,
      capabilities: UNAVAILABLE_CHROMIUM_CAPABILITIES,
      failureReason: "runtime-creation-failed"
    });

    const macCapabilities = {
      ...fullCapabilities(),
      audioMute: "disabled" as const
    };
    expect(buildChromiumRuntimeRegistration({
      platform: "darwin",
      ...versions,
      appKit: {
        adapterVersion: "appkit-complete-platform-evidence",
        capabilities: macCapabilities,
        hostFactory: {
          nativeHostKind: "rust-napi-appkit",
          applyWindowName: vi.fn(),
          applyWindowPreferences: vi.fn(),
          captureHostObservations: vi.fn(() => []),
          create: vi.fn(),
          createEmpty: vi.fn(),
          createPopup: vi.fn(),
          quarantineHost: vi.fn()
        }
      }
    })).toMatchObject({
      platform: "macos",
      available: false,
      capabilities: macCapabilities,
      failureReason: "runtime-creation-failed"
    });
  });

  it("pins every Electron AppCore creation to runtime contract v23", () => {
    const options = withElectronChromiumRuntimeContract({
      userDataDir: "/RionData",
      runtimeContractVersion: 22
    });
    expect(options).toEqual({
      userDataDir: "/RionData",
      runtimeContractVersion: 23
    });
    expect(Object.isFrozen(options)).toBe(true);
  });

  it("resumes and registers before attaching local and raw effect intake", async () => {
    const core = new FakeCore();
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    });

    expect(core.order.slice(0, 4)).toEqual([
      "resume-migrations",
      "register",
      "subscribe-local",
      "subscribe-raw"
    ]);
    expect(runtime.sessionMigrationResume).toEqual({
      eligibleRoleCount: 0,
      results: []
    });
    core.emit({
      type: "coreEffects",
      effects: [effect("create", { type: "embeddedCreateTab", tab: tab() })]
    });
    await vi.waitFor(() => expect(core.dispatches).toHaveLength(1));
    expect(core.dispatches[0]).toEqual([expect.objectContaining({
      effectId: "create",
      ok: false,
      error: expect.objectContaining({ code: "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE" })
    })]);

    await runtime.shutdown();
    expect(core.unsubscribe).toHaveBeenCalledOnce();
    expect(core.unsubscribeFailure).toHaveBeenCalledOnce();
    expect(core.order.indexOf("core-shutdown"))
      .toBeLessThan(core.order.indexOf("unsubscribe-stream-failure"));
  });

  it("fails closed before registration and event bridges on structured migration rejection", async () => {
    const failure = new RionBridgeError({
      code: "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
      message: "The durable migration belongs to the opposite host platform."
    });
    const core = new FakeCore([], {
      journals: [exportedMigrationJournal()],
      beginError: failure
    });

    await expect(ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    })).rejects.toBe(failure);

    expect(core.order).toEqual(["resume-migrations"]);
    expect(core.listener).toBeNull();
  });

  it("continues bootstrap only when the import admission acknowledgement is unknown", async () => {
    const core = new FakeCore([], {
      journals: [exportedMigrationJournal()],
      beginError: new Error("native acknowledgement channel closed")
    });

    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    });

    expect(runtime.sessionMigrationResume).toMatchObject({
      results: [{
        status: "pending",
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_IMPORT_BEGIN_INDETERMINATE"
      }]
    });
    expect(core.order.slice(0, 4)).toEqual([
      "resume-migrations",
      "register",
      "subscribe-local",
      "subscribe-raw"
    ]);
    await runtime.shutdown();
  });

  it("keeps the real raw addon stream dormant until bootstrap has a local effect consumer", async () => {
    const order: string[] = [];
    const dispatch = vi.fn(async (resultsJson: string) => {
      order.push("ack");
      const results = JSON.parse(resultsJson) as CoreEffectResult[];
      return JSON.stringify({
        accepted: results.map((result) => result.effectId),
        duplicate: [],
        late: [],
        unknown: [],
        operationMismatch: []
      });
    });
    const subscribe = vi.fn((listener: (eventsJson: string) => void) => {
      order.push("subscribe-raw");
      listener(JSON.stringify([{
        type: "coreEffects",
        effects: [effect("raw-stream-probe", { type: "embeddedCreateTab", tab: tab() })]
      }]));
    });
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected private Core binding call.");
    };
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async (commandJson: string) => {
        const command = JSON.parse(commandJson) as CoreCommand;
        if (command.type === "roleSessionMigrationsList") {
          order.push("resume-migrations");
          return "[]";
        }
        if (command.type === "browserRuntimeRegister") {
          order.push("register");
          return JSON.stringify(command.registration);
        }
        throw new Error(`Unexpected Core command ${command.type}.`);
      }),
      subscribeCoreEvents: subscribe,
      dispatchCoreEffectResults: dispatch,
      beginRoleSessionMigrationImportInternal: vi.fn(unexpected),
      transitionRoleSessionMigrationTargetInternal: vi.fn(unexpected),
      readRoleSessionTransferVaultInternal: vi.fn(unexpected),
      acquireChromeProfileImportTransactionInternal: vi.fn(unexpected),
      refreshChromeProfileImportTransactionInternal: vi.fn(unexpected),
      readChromeProfileImportPayloadInternal: vi.fn(unexpected),
      writeChromeProfileImportBackupInternal: vi.fn(unexpected),
      readChromeProfileImportBackupInternal: vi.fn(unexpected),
      prepareChromeProfileImportFreshVerificationInternal: vi.fn(unexpected),
      completeChromeProfileImportFreshVerificationInternal: vi.fn(unexpected),
      commitChromeProfileImportInternal: vi.fn(unexpected),
      verifyChromeProfileImportCommitMarkerInternal: vi.fn(unexpected),
      releaseChromeProfileImportTransactionInternal: vi.fn(unexpected),
      recoverPendingChromeProfileImportsInternal: vi.fn(async () => {
        order.push("recover-chrome-profile-imports");
        return JSON.stringify({ recovered: 0, pending: 0 });
      }),
      launchChromeProfileImportHelperInternal: vi.fn(unexpected),
      beginRoleBrowserDataClearCommandDrain: vi.fn(),
      waitForRoleBrowserDataClearCommandDrain: vi.fn(async () => true),
      invalidateRuntimeRestoreSessionCleanExitInternal: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => { order.push("core-shutdown"); })
    };
    const core = await CoreAddonClient.create({ createAppCore: () => binding }, {});
    expect(subscribe).not.toHaveBeenCalled();

    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    });

    expect(order.slice(0, 4)).toEqual([
      "resume-migrations",
      "register",
      "subscribe-raw",
      "recover-chrome-profile-imports"
    ]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(JSON.parse(dispatch.mock.calls[0]![0])).toEqual([
      expect.objectContaining({ effectId: "raw-stream-probe", ok: false })
    ]);
    await runtime.shutdown();
    expect(order.at(-1)).toBe("core-shutdown");
  });

  it("does not expose an AppKit host factory from an unavailable capability snapshot", async () => {
    const core = new FakeCore();
    const create = vi.fn();
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      appKit: {
        adapterVersion: "appkit-attach-layout-only",
        capabilities: UNAVAILABLE_CHROMIUM_CAPABILITIES,
        hostFactory: {
          nativeHostKind: "rust-napi-appkit",
          applyWindowName: vi.fn(),
          applyWindowPreferences: vi.fn(),
          captureHostObservations: vi.fn(() => []),
          create,
          createEmpty: vi.fn(),
          createPopup: vi.fn(),
          quarantineHost: vi.fn()
        }
      },
      ...emptyNativePorts(),
      onError: vi.fn()
    });

    core.emit({
      type: "coreEffects",
      effects: [effect("create", { type: "embeddedCreateTab", tab: tab() })]
    });

    await vi.waitFor(() => expect(core.dispatches).toHaveLength(1));
    expect(create).not.toHaveBeenCalled();
    expect(core.dispatches[0]).toEqual([expect.objectContaining({
      effectId: "create",
      ok: false,
      error: expect.objectContaining({ code: "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE" })
    })]);
    await runtime.shutdown();
  });

  it("rejects incomplete AppKit ABI evidence before durable migration resume", async () => {
    const missingAttachmentsCore = new FakeCore();
    const baseAdapter = {
      adapterVersion: "appkit-incomplete-abi",
      capabilities: fullCapabilities(),
      hostFactory: {
        nativeHostKind: "rust-napi-appkit" as const,
        applyWindowName: vi.fn(),
        applyWindowPreferences: vi.fn(),
        captureHostObservations: vi.fn(() => []),
        create: vi.fn(),
        createEmpty: vi.fn(),
        createPopup: vi.fn(),
        quarantineHost: vi.fn()
      }
    };
    await expect(ChromiumRuntimeBootstrap.start({
      core: missingAttachmentsCore,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      appKit: {
        ...baseAdapter,
        createTrustedInput: vi.fn()
      },
      ...emptyNativePorts(),
      onError: vi.fn()
    })).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_NATIVE_ATTACHMENTS_MISSING"
    });
    expect(missingAttachmentsCore.commands).toHaveLength(0);

    const missingTrustedCore = new FakeCore();
    await expect(ChromiumRuntimeBootstrap.start({
      core: missingTrustedCore,
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      appKit: {
        ...baseAdapter,
        nativeAttachments: {
          attach: vi.fn(), reparent: vi.fn(), retire: vi.fn(),
          attachNonInputSurface: vi.fn(), detachNonInputSurface: vi.fn()
        }
      },
      ...emptyNativePorts(),
      onError: vi.fn()
    })).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_TRUSTED_INPUT_MISSING"
    });
    expect(missingTrustedCore.commands).toHaveLength(0);
  });

  it("wires AppKit host, Rust layout and paths, role session, surface, and ordered drain", async () => {
    const order: string[] = [];
    const core = new FakeCore(order);
    let webContents: ChromiumRoleSurfaceWebContentsPort | null = null;
    const cookieFlush = deferred();
    const session = {
      on: vi.fn(),
      cookies: {
        flushStore: vi.fn(() => {
          order.push("cookie-flush");
          return cookieFlush.promise;
        })
      },
      flushStorageData: vi.fn(() => order.push("storage-flush")),
      webRequest: { onErrorOccurred: vi.fn() },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setBluetoothPairingHandler: vi.fn()
    } as unknown as ChromiumRoleSessionPort;
    const fromPath = vi.fn((path: string) => {
      Object.defineProperty(session, "storagePath", { value: path });
      return session;
    });
    const listeners = new Map<keyof ChromiumRoleSurfaceEventMap, Set<Listener>>();
    let failHostClose = true;
    const contentView = {
      addChildView: vi.fn(() => order.push("surface-attached")),
      removeChildView: vi.fn(() => order.push("surface-detached"))
    };
    const host: ChromiumRuntimeHostPort = {
      id: 41,
      logicalWindowId: "window-1",
      contentView,
      close: vi.fn(async () => {
        order.push("host-close");
        if (failHostClose) {
          failHostClose = false;
          throw new Error("host close failed");
        }
      }),
      focus: vi.fn(),
      hide: vi.fn(),
      getContentBounds: () => ({ x: 0, y: 40, width: 800, height: 560 }),
      readProjection: () => ({
        displayId: 7,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        focused: false,
        presentation: "normal"
      }),
      isDestroyed: () => false,
      isVisible: () => true,
      show: vi.fn()
    };
    const adapter: MacosAppKitRuntimeBootstrapAdapter = {
      adapterVersion: "appkit-chromium-v23-test",
      capabilities: fullCapabilities(),
      drainEvents: async () => { order.push("appkit-events-drained"); },
      nativeAttachments: {
        attach: async (input) => { input.attach(); },
        reparent: async (input) => {
          input.detachSource();
          input.attachTarget();
        },
        retire: async () => undefined,
        attachNonInputSurface: async (input) => { input.attach(); },
        detachNonInputSurface: async () => undefined
      },
      createTrustedInput: () => ({
        execute: vi.fn(async () => { throw new Error("not used"); }),
        retireSurface: vi.fn(async () => false),
        retireSurfaceForDestruction: vi.fn(async () => true),
        resumeAfterDocumentReplacement: vi.fn(async () => false),
        prepareControlledDocumentReplacement: vi.fn(async () => undefined),
        confirmControlledDocumentReplacementNeutral: vi.fn(async () => true),
        resumeControlledDocumentReplacement: vi.fn(async () => true),
        supersedeControlledDocumentReplacement: vi.fn(() => true),
        dispose: vi.fn(async () => undefined)
      }),
      hostFactory: {
        nativeHostKind: "rust-napi-appkit",
        applyWindowName: vi.fn(),
        applyWindowPreferences: vi.fn(),
        captureHostObservations: vi.fn(() => []),
        create: vi.fn(async () => host),
        createEmpty: vi.fn(async () => host),
        createPopup: vi.fn(),
        quarantineHost: vi.fn()
      }
    };
    const runtime = await ChromiumRuntimeBootstrap.start({
      core,
      ipcMain: emptyIpcMain(),
      platform: "darwin",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "/Rion/out/preload/role.cjs",
      appKit: adapter,
      sessions: { fromPath },
      views: {
        create: (options) => {
          let destroyed = false;
          let bounds = { x: 0, y: 0, width: 0, height: 0 };
          let visible = false;
          let zoomFactor = 1;
          const contents = {
            mainFrame: Object.freeze({ frameToken: "frame-token-1" }),
            session: options.webPreferences.session,
            close: vi.fn(() => order.push("surface-close")),
            getURL: () => "https://game.test/play",
            getZoomFactor: () => zoomFactor,
            isDestroyed: () => destroyed,
            loadURL: vi.fn(async () => undefined),
            on: (event: keyof ChromiumRoleSurfaceEventMap, listener: Listener) => {
              const eventListeners = listeners.get(event) ?? new Set<Listener>();
              eventListeners.add(listener);
              listeners.set(event, eventListeners);
            },
            removeListener: (event: keyof ChromiumRoleSurfaceEventMap, listener: Listener) => {
              listeners.get(event)?.delete(listener);
            },
            setWindowOpenHandler: vi.fn(),
            setAudioMuted: vi.fn(),
            isAudioMuted: vi.fn(() => false),
            setZoomFactor: vi.fn((value: number) => { zoomFactor = value; }),
            destroy: () => {
              destroyed = true;
              for (const listener of listeners.get("destroyed") ?? []) listener();
            }
          } as unknown as ChromiumRoleSurfaceWebContentsPort & { destroy: () => void };
          webContents = contents;
          return {
            webContents: contents,
            getBounds: () => ({ ...bounds }),
            getVisible: () => visible,
            setBounds: vi.fn((value: typeof bounds) => { bounds = { ...value }; }),
            setVisible: vi.fn((value: boolean) => { visible = value; })
          } as ChromiumRoleWebContentsViewPort;
        }
      },
      onError: vi.fn()
    });

    expect(runtime.registration).toMatchObject({
      platform: "macos",
      available: true,
      capabilities: { trustedInput: "supported", audioMute: "supported" }
    });
    expect(adapter.hostFactory.applyWindowPreferences).toHaveBeenCalledWith({
      alwaysHideTabCloseButton: false,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    });
    expect(order.indexOf("runtime-window-preferences"))
      .toBeLessThan(order.indexOf("resume-migrations"));
    core.emit({
      type: "coreEffects",
      effects: [effect("create", { type: "embeddedCreateTab", tab: tab() })]
    });
    await vi.waitFor(() => expect(core.dispatches).toHaveLength(1));
    expect(core.dispatches[0]?.[0]?.ok).toBe(true);

    core.emit({
      type: "coreEffects",
      effects: [effect("load", {
        type: "embeddedLoadRoles",
        roles: [{
          roleId: "role-1",
          resolvedEngine: "chromium",
          url: "https://game.test/play",
          zoomFactor: 1
        }]
      })]
    });
    await vi.waitFor(() => expect(webContents?.loadURL).toHaveBeenCalledWith(
      "https://game.test/play"
    ));
    for (const listener of listeners.get("did-finish-load") ?? []) listener();
    await vi.waitFor(() => expect(core.dispatches).toHaveLength(2));
    expect(fromPath).toHaveBeenCalledWith(
      "/RionData/roles/role-1/browser/chromium",
      { cache: true }
    );
    expect(order).toEqual(expect.arrayContaining([
      "resolve-dividers",
      "resolve-layout",
      "resolve-role-paths",
      "surface-attached",
      "ack:load"
    ]));

    const shutdown = runtime.shutdown();
    await vi.waitFor(() => expect(order).toContain("appkit-events-drained"));
    await vi.waitFor(() => expect(order).toContain("surface-close"));
    expect(order).not.toContain("core-shutdown");
    (webContents as unknown as { destroy: () => void }).destroy();
    await vi.waitFor(() => expect(order).toContain("cookie-flush"));
    expect(order).not.toContain("host-close");
    cookieFlush.resolve();
    await expect(shutdown).rejects.toThrow("host close failed");
    expect(order).not.toContain("core-shutdown");
    await runtime.shutdown();
    expect(order.indexOf("surface-detached")).toBeLessThan(order.indexOf("surface-close"));
    expect(order.indexOf("appkit-events-drained"))
      .toBeLessThan(order.indexOf("surface-close"));
    expect(order.indexOf("storage-flush")).toBeLessThan(order.indexOf("host-close"));
    expect(order.indexOf("cookie-flush")).toBeLessThan(order.indexOf("host-close"));
    expect(order.indexOf("host-close")).toBeLessThan(order.indexOf("core-shutdown"));
  });

  it("requires a native Windows host before registering with Core", async () => {
    const core = new FakeCore();
    await expect(ChromiumRuntimeBootstrap.start({
      core,
      platform: "win32",
      electronVersion: "43.4.1",
      chromiumVersion: "150.0.7871.224",
      rolePreloadPath: "C:\\Rion\\out\\preload\\role.cjs",
      ...emptyNativePorts(),
      onError: vi.fn()
    })).rejects.toMatchObject({ code: "ELECTRON_WINDOWS_RUNTIME_HOST_MISSING" });
    expect(core.commands).toHaveLength(0);
  });
});
