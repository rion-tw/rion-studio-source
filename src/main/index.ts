import { join } from "node:path";

import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  session as electronSession,
  shell,
  Tray,
  WebContentsView
} from "electron";

import { ChromeProfileImportManager } from "./browser/ChromeProfileImportManager";
import { ElectronProfileEffectAdapter } from "./browser/ElectronProfileEffectAdapter";
import { EmbeddedRuntimeDiagnostics } from "./browser/EmbeddedRuntimeDiagnostics";
import { RustSystemPressureMonitor } from "./browser/RustSystemPressureMonitor";
import { AppCoreClient, readBootstrapPlan } from "./core/nativeCore";
import { ElectronBrowserActionAdapter } from "./core/ElectronBrowserActionAdapter";
import {
  ElectronEffectExecutor,
  ElectronHandleRegistry
} from "./core/ElectronEffectExecutor";
import { loadMacRuntimeTabsControllerFactory } from "./browser/MacRuntimeTabsController";
import { createRuntimeTabsPageUrl } from "./browser/runtimeTabsPage";
import {
  ElectronBrowserRuntime,
  type ElectronBrowserRuntimeOptions,
  createRoleSessionPartition,
  GAME_DIVIDER_POINTER_CHANNEL
} from "./browser/ElectronBrowserRuntime";
import { AppQuickMenu } from "./menu/AppQuickMenu";
import { ApplicationMenuController } from "./menu/ApplicationMenu";
import { RuntimeTabMenuController } from "./menu/RuntimeTabMenu";
import { buildWindowsTrayMenuTemplate } from "./tray/WindowsTrayMenu";
import { BrowserProxyApplier } from "./game-browser/BrowserProxyApplier";
import { CdnCompatibilityManager } from "./game-browser/CdnCompatibilityManager";
import { GameBrowserSettingsStore } from "./game-browser/GameBrowserSettingsStore";
import { GraphicsDiagnosticsService } from "./game-browser/GraphicsDiagnosticsService";
import { configureChromiumCommandLine } from "./game-browser/BrowserLaunchConfiguration";
import { RustSystemFontService } from "./game-browser/RustSystemFontService";
import { GameCompatibilityManager } from "./games/GameCompatibilityManager";
import { GameStore } from "./games/GameStore";
import { createRuntimeGameIconDataUrl } from "./games/runtimeGameIcon";
import {
  broadcastMacrosChanged,
  broadcastWorkspacesChanged,
  broadcastWorkspaceDisplaysChanged,
  registerIpcHandlers
} from "./ipc/registerHandlers";
import { LegalAcceptanceStore } from "./legal/LegalAcceptanceStore";
import { LogService } from "./logging/LogService";
import { sendToWindowIfAvailable } from "./window/sendToWindow";
import { RustMacroManager } from "./macros/RustMacroManager";
import {
  MACRO_OVERLAY_SCRIPT,
  MacroOverlayInjector
} from "./macros/MacroOverlayInjector";
import { MacroStore } from "./macros/MacroStore";
import { MacroSettingsStore } from "./macros/MacroSettingsStore";
import { PortableDataManager } from "./portable/PortableDataManager";
import { RoleStore } from "./roles/RoleStore";
import {
  createStartupPageUrl,
  loadRendererPage,
  loadWindowAndReveal,
  RendererReadyGate,
  RendererReadyTimeoutError,
  showStartupWindow,
  type StartupPageState
} from "./startup/startupWindow";
import { AppUpdateManager, DEFAULT_UPDATE_REPOSITORY } from "./updates/AppUpdateManager";
import { LaunchWorkspaceStore } from "./workspaces/LaunchWorkspaceStore";
import { WorkspaceLaunchCoordinator } from "./workspaces/WorkspaceLaunchCoordinator";
import { createWorkspaceDisplayInfos } from "./workspaces/workspaceDisplays";
import { handleMainWindowClose } from "./window/mainWindowLifecycle";
import { bindAppWindowStateBroadcast } from "./window/appWindowState";
import { RuntimeWindowPreferencesStore } from "./window/RuntimeWindowPreferencesStore";
import { configureSingleInstanceLifecycle } from "./window/singleInstanceLifecycle";
import { resolveTestUserDataPath } from "./testing/testUserData";
import { IPC_CHANNELS } from "../shared/ipc";
import { EMBEDDED_RUNTIME_DIAGNOSTICS_CHANNEL } from "../shared/embeddedRuntimeDiagnostics";
import { formatMacroCoordinateClipboard } from "../shared/macroCoordinates";
import {
  RUNTIME_TABS_ACTION_CHANNEL,
  isRuntimeTabAction,
  type RuntimeTabAction
} from "../shared/runtimeTabs";
import type {
  MacroPageRequest,
  PendingWorkspaceLaunchRequest,
  WorkspaceBrowserZoomPercent
} from "../shared/types";

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "false";

const testUserDataPath = resolveTestUserDataPath();
if (testUserDataPath) app.setPath("userData", testUserDataPath);

const bootstrapUserDataDir = app.getPath("userData");
const bootstrapPlan = readBootstrapPlan({
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  platform: process.platform,
  resourcesPath: process.resourcesPath,
  userDataDir: bootstrapUserDataDir
}, app.commandLine.getSwitchValue("enable-features"), app.commandLine.getSwitchValue("disable-features"));
const appliedBrowserGraphicsSettings = bootstrapPlan.appliedGraphicsSettings;
configureChromiumCommandLine(app.commandLine, bootstrapPlan.switches);
let gpuInfoReady = false;
app.on("gpu-info-update", () => {
  gpuInfoReady = true;
});

let mainWindow: BrowserWindow | null = null;
let startupWindow: BrowserWindow | null = null;
let browserManager: ElectronBrowserRuntime | null = null;
let embeddedRuntimeDiagnostics: EmbeddedRuntimeDiagnostics | null = null;
let latestExternalFreezeReportedAt: Date | undefined;
let appQuickMenu: AppQuickMenu | null = null;
let applicationMenu: ApplicationMenuController | null = null;
let runtimeTabMenu: RuntimeTabMenuController | null = null;
let windowsTray: Tray | null = null;
let pendingMacroPageRequest: MacroPageRequest | null = null;
let pendingWorkspaceLaunchRequest: PendingWorkspaceLaunchRequest | null = null;
let appInitialized = false;
let initializationFailed = false;
let startupFailureMessage: string | undefined;
let mainWindowReady = false;
let startupPromise: Promise<void> | null = null;
let isApplicationQuitting = false;
let quitCleanupPromise: Promise<void> | null = null;
let appCoreClient: AppCoreClient | null = null;
let electronBrowserActionAdapter: ElectronBrowserActionAdapter | null = null;
let electronEffectExecutor: ElectronEffectExecutor | null = null;
let electronEffectUnsubscribe: (() => void) | null = null;
const rendererReadyGate = new RendererReadyGate();
const RENDERER_READY_TIMEOUT_MS = 15_000;
const logService = new LogService();

ipcMain.on(EMBEDDED_RUNTIME_DIAGNOSTICS_CHANNEL, (event, payload: unknown) => {
  embeddedRuntimeDiagnostics?.handlePageEvent(event.sender, payload);
});
logService.on("entry", (entry) => {
  sendToWindowIfAvailable(mainWindow, IPC_CHANNELS.logsEntryAdded, entry);
});

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logService.error("main", "uncaught_exception", `Uncaught exception (${origin}).`, error);
});
process.on("unhandledRejection", (reason) => {
  logService.error("main", "unhandled_rejection", "Unhandled promise rejection.", reason);
});
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);
console.warn = (...values: unknown[]) => {
  originalConsoleWarn(...values);
  const error = values.find((value) => value instanceof Error);
  logService.warn("main", "console_warn", typeof values[0] === "string" ? values[0] : "Console warning.", {
    details: values.filter((value) => value !== error).slice(1)
  }, error);
};
console.error = (...values: unknown[]) => {
  originalConsoleError(...values);
  const error = values.find((value) => value instanceof Error);
  logService.error("main", "console_error", typeof values[0] === "string" ? values[0] : "Console error.", error, {
    details: values.filter((value) => value !== error).slice(1)
  });
};

function getAppIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }

  return join(__dirname, "../../build/icon.png");
}

function getMacRuntimeTabsAddonPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "native/rion-runtime-tabs.node")
    : join(
        __dirname,
        `../../build/native/darwin-${process.arch}/rion-runtime-tabs.node`
      );
}

function getWindowsTrayIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.ico");
  }

  return join(__dirname, "../../build/icon.ico");
}

async function revealLogDirectory(): Promise<void> {
  const result = await shell.openPath((await logService.getStatus()).directory);
  if (result) throw new Error(result);
}

async function exportDiagnostics() {
  const date = new Date().toISOString().slice(0, 10);
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, {
        defaultPath: `Rion-Studio-Diagnostics-${date}.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }]
      })
    : await dialog.showSaveDialog({
        defaultPath: `Rion-Studio-Diagnostics-${date}.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }]
  });
  if (result.canceled || !result.filePath) return null;
  const filePath = result.filePath.toLowerCase().endsWith(".zip") ? result.filePath : `${result.filePath}.zip`;
  if (!appCoreClient) throw new Error("Rust diagnostics are not initialized.");
  const displays = screen.getAllDisplays();
  const gpuInfo = gpuInfoReady
    ? await app.getGPUInfo("basic").catch(() => undefined)
    : undefined;
  try {
    const exported = await appCoreClient.invoke({
      type: "diagnosticsExport",
      path: filePath,
      snapshot: {
        applicationName: app.getName(),
        applicationVersion: app.getVersion(),
        packaged: app.isPackaged,
        electronVersion: process.versions.electron,
        chromiumVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        locale: app.getLocale(),
        systemVersion: process.getSystemVersion(),
        displays: displays.map((display) => ({
          bounds: display.bounds,
          resolution: display.size,
          scaleFactor: display.scaleFactor
        })),
        gpuFeatureStatusRawJson: JSON.stringify(app.getGPUFeatureStatus()),
        ...(gpuInfo === undefined ? {} : { gpuInfoRawJson: JSON.stringify(gpuInfo) }),
        ...(latestExternalFreezeReportedAt
          ? { externalFreezeReportedAt: latestExternalFreezeReportedAt.toISOString() }
          : {})
      }
    });
    logService.info("main", "diagnostics_exported", "A diagnostic bundle was exported.", {
      logFileCount: exported.logFileCount
    });
    return exported;
  } catch (error) {
    logService.error("main", "diagnostics_export_failed", "Failed to export diagnostic bundle.", error);
    throw error;
  }
}

function loadAppIcon() {
  const iconPath = getAppIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

function createWindow({
  bounds
}: {
  bounds?: Electron.Rectangle;
}): BrowserWindow {
  const appIcon = loadAppIcon();
  const macWindowOptions =
    process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: {
            x: 18,
            y: 18
          },
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
          transparent: true,
          backgroundColor: "#00000000"
        }
      : {};

  const window = new BrowserWindow({
    ...(bounds ?? { width: 1440, height: 900 }),
    minWidth: 960,
    minHeight: 640,
    title: "Rion Studio",
    show: false,
    autoHideMenuBar: process.platform !== "darwin",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f7f7f7",
    ...(appIcon ? { icon: appIcon } : {}),
    ...macWindowOptions,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  bindAppWindowStateBroadcast(window);

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    logService.error("preload", "preload_error", `Failed to load preload script: ${preloadPath}`, error);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

function createStartupWindow(): BrowserWindow {
  const window = createWindow({});
  const webContentsId = window.webContents.id;
  startupWindow = window;
  mainWindow = window;
  mainWindowReady = false;

  window.on("close", (event) => {
    handleMainWindowClose(event, window, isApplicationQuitting);
  });

  window.on("closed", () => {
    rendererReadyGate.cancel(webContentsId);
    if (startupWindow === window) {
      startupWindow = null;
    }
    if (mainWindow === window) {
      mainWindow = null;
      mainWindowReady = false;
    }
  });

  return window;
}

function createWindowsTray(): void {
  if (process.platform !== "win32" || windowsTray) {
    return;
  }

  const iconPath = getWindowsTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`Windows tray icon could not be loaded: ${iconPath}`);
    return;
  }

  windowsTray = new Tray(icon);
  windowsTray.setToolTip("Rion Studio");
  windowsTray.setContextMenu(
    Menu.buildFromTemplate(
      buildWindowsTrayMenuTemplate({
        openApp: showMainWindow,
        quitApp: () => app.quit()
      })
    )
  );
  windowsTray.on("click", showMainWindow);
}

function loadMainRenderer(window: BrowserWindow): Promise<void> {
  return loadRendererPage(
    window,
    process.env.ELECTRON_RENDERER_URL,
    join(__dirname, "../renderer/index.html")
  );
}

function getStartupPageOptions(state: StartupPageState = "loading", errorDetail?: string) {
  const appIcon = loadAppIcon();

  return {
    ...(errorDetail ? { errorDetail } : {}),
    iconDataUrl: appIcon?.resize({ height: 128, quality: "best", width: 128 }).toDataURL(),
    state,
    theme: nativeTheme.shouldUseDarkColors ? ("dark" as const) : ("light" as const)
  };
}

async function showStartupFailure(window: BrowserWindow, errorDetail = startupFailureMessage): Promise<void> {
  const loadFailurePage = () => window.loadURL(
    createStartupPageUrl(getStartupPageOptions("failed", errorDetail))
  );

  if (window.isVisible()) {
    await loadFailurePage();
    return;
  }

  await loadWindowAndReveal(window, loadFailurePage);
}

function showMainWindow(): void {
  if (startupWindow && !startupWindow.isDestroyed() && !mainWindowReady) {
    if (startupWindow.isMinimized()) {
      startupWindow.restore();
    }

    startupWindow.show();
    startupWindow.focus();
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) {
    ensureApplicationStarted();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function requestMacroPageFromOverlay(request: MacroPageRequest): void {
  pendingMacroPageRequest = request;
  showMainWindow();

  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.macrosPageRequested, request);
}

function consumePendingMacroPageRequest(): MacroPageRequest | null {
  const request = pendingMacroPageRequest;
  pendingMacroPageRequest = null;
  return request;
}

function requestWorkspaceDisplaySelection(request: PendingWorkspaceLaunchRequest): void {
  pendingWorkspaceLaunchRequest = request;
  showMainWindow();

  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.workspacesLaunchRequested, request);
}

function consumePendingWorkspaceLaunchRequest(): PendingWorkspaceLaunchRequest | null {
  const request = pendingWorkspaceLaunchRequest;
  pendingWorkspaceLaunchRequest = null;
  return request;
}

async function initializeApplication(): Promise<void> {
  const userDataDir = app.getPath("userData");
  const coreClient = await AppCoreClient.create({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    performanceTelemetryPath: process.env.RION_PERFORMANCE_TELEMETRY_PATH,
    resourcesPath: process.resourcesPath,
    userDataDir
  });
  appCoreClient = coreClient;
  await logService.initialize(coreClient, {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  });
  coreClient.subscribe((events) => {
    if (events.some((event) => event.type === "ready")) {
      logService.info("main", "rust_core_ready", "Rust application core is ready.", {
        version: coreClient.version
      });
    }
  });
  const roleStore = new RoleStore(userDataDir, coreClient);
  const gameStore = new GameStore(userDataDir, coreClient);
  const workspaceStore = new LaunchWorkspaceStore(userDataDir, coreClient);
  await workspaceStore.reconcileTargetDisplays(getWorkspaceDisplayInfos());
  const notifyWorkspacesChanged = async (): Promise<void> => {
    appQuickMenu?.scheduleRefresh();
    broadcastWorkspacesChanged(await workspaceStore.listWorkspaces());
  };
  const macroStore = new MacroStore(userDataDir, coreClient);
  const macroOverlayRef: { current?: MacroOverlayInjector } = {};
  const macroSettingsStore = new MacroSettingsStore(userDataDir, coreClient);
  const legalAcceptanceStore = new LegalAcceptanceStore(userDataDir, { core: coreClient });
  const gameBrowserSettingsStore = new GameBrowserSettingsStore(userDataDir, coreClient);
  const runtimeWindowPreferencesStore = new RuntimeWindowPreferencesStore(userDataDir, coreClient);
  const runtimeWindowPreferences = await runtimeWindowPreferencesStore.getPreferences();
  const browserProxyApplier = new BrowserProxyApplier({
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const electronEffectHandles = new ElectronHandleRegistry();
  const cdnCompatibilityManager = new CdnCompatibilityManager({
    core: coreClient,
    handles: electronEffectHandles,
    matchCdnUrl: (url: string) => coreClient.matchCdnUrl(url)
  });
  const gameCompatibilityManager = new GameCompatibilityManager({
    applyCdnCompatibility: async (session) => {
      await cdnCompatibilityManager.applyToSession(session);
    },
    applyProxy: (session) => browserProxyApplier.applyToSession(session),
    core: coreClient,
    createWindow: (options) => new BrowserWindow(options),
    getLaunchWorkArea: () => getMainWindowDisplayWorkArea()
  });
  const systemFontService = new RustSystemFontService(coreClient);
  const updateManager = new AppUpdateManager({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    manualUpdateRepository:
      process.env.RION_STUDIO_RELEASE_REPOSITORY ?? DEFAULT_UPDATE_REPOSITORY,
    openExternal: (url) => shell.openExternal(url)
  });
  updateManager.on("change", (status) => {
    logService.info("update", "update_status_changed", "Application update status changed.", {
      state: status.state,
      availableVersion: status.availableVersion,
      installMode: status.installMode
    });
  });
  let updateCheckStarted = false;
  const startUpdateCheck = (): void => {
    if (updateCheckStarted) {
      return;
    }

    updateCheckStarted = true;
    void updateManager.checkForUpdates();
  };
  const resourcePressureMonitor = new RustSystemPressureMonitor(coreClient);
  powerMonitor.on("speed-limit-change", ({ limit }) => resourcePressureMonitor.setSpeedLimit(limit));
  if (process.platform === "darwin") {
    powerMonitor.on("thermal-state-change", ({ state }) => resourcePressureMonitor.setThermalState(state));
  }
  resourcePressureMonitor.start();
  const macRuntimeTabsControllerFactory = process.platform === "darwin"
    ? loadMacRuntimeTabsControllerFactory(getMacRuntimeTabsAddonPath())
    : undefined;
  embeddedRuntimeDiagnostics?.stop();
  embeddedRuntimeDiagnostics = new EmbeddedRuntimeDiagnostics(logService);
  powerMonitor.on("suspend", () => {
    embeddedRuntimeDiagnostics?.handleSuspend();
    void coreClient.invoke({ type: "browserRuntimeSuspend", suspended: true });
  });
  powerMonitor.on("resume", () => {
    embeddedRuntimeDiagnostics?.handleResume();
    void coreClient.invoke({ type: "browserRuntimeSuspend", suspended: false });
  });
  const runtimeManager = new ElectronBrowserRuntime({
    browserRuntimeState: coreClient,
    applyBrowserFonts: async (role, partition) => {
      const browserUserDataDir = await roleStore.ensureBrowserUserDataDir(role.id);
      const settings = await gameBrowserSettingsStore.getSettings();
      await coreClient.invoke({
        type: "browserPreferencesApply",
        browserUserDataDir,
        roleSessionPartition: partition,
        fonts: settings.fonts
      });
    },
    applyBrowserProxy: (_role, _partition, session) => browserProxyApplier.applyToSession(session),
    applyCdnCompatibility: async (_role, _partition, session) => {
      await cdnCompatibilityManager.applyToSession(session);
    },
    createHostWindow: (options) => new BaseWindow(options),
    ...(macRuntimeTabsControllerFactory
      ? { createMacRuntimeTabsController: macRuntimeTabsControllerFactory }
      : {}),
    createRuntimeChromeView: (options) => new WebContentsView(options),
    createTabbedHostWindow: (options) => new BrowserWindow({
      ...options,
      ...(loadAppIcon() ? { icon: loadAppIcon() } : {})
    }),
    createView: (options) => new WebContentsView(options),
    dividerPreloadPath: join(__dirname, "../preload/divider.cjs"),
    embeddedKeyRuntime: coreClient,
    embeddedPreloadPath: join(__dirname, "../preload/embedded.cjs"),
    runtimeTabsPageUrl: createRuntimeTabsPageUrl(),
    runtimeTabsPreloadPath: join(__dirname, "../preload/runtime-tabs.cjs"),
    recordTabActivationLatency: (durationMs) =>
      coreClient.recordTabActivationLatency(durationMs),
    adaptiveZoomResolver: (viewportWidth, currentPercent) =>
      coreClient.invoke({
        type: "layoutAdaptiveZoom",
        viewportWidth,
        ...(currentPercent === undefined ? {} : { currentPercent })
      }).then((value) => value as WorkspaceBrowserZoomPercent),
    workspaceDividerResolver: (roles) =>
      coreClient.invoke({ type: "layoutCreateDividers", roles }),
    workspaceDividerResizeResolver: (input) =>
      coreClient.invoke({ type: "layoutResizeDivider", input }),
    workspaceLayoutResolver: (input: Parameters<NonNullable<ElectronBrowserRuntimeOptions["workspaceLayoutResolver"]>>[0]) =>
      coreClient.invoke({ type: "layoutResolve", input }),
    getRoleSession: async (role) => role.browserSessionSource === "chrome-profile"
      ? electronSession.fromPath(join(
          (await roleStore.getRolePaths(role.id)).browserUserDataDir,
          "Default"
        ))
      : undefined,
    getRuntimeTabGameIcon: async (role) => {
      const game = await gameStore.getGame(role.gameId);
      return createRuntimeGameIconDataUrl(
        game,
        (source) => nativeImage.createFromDataURL(source)
      );
    },
    getLaunchWorkArea: () => getMainWindowDisplayWorkArea(),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    getDefaultLaunchTarget: () => {
      const display = getMainWindowDisplay();
      return { displayId: display.id, workArea: display.workArea };
    },
    getWorkspaceDisplays: () => getWorkspaceDisplayInfos(),
    getWorkspaceAppearanceSettings: async () =>
      (await gameBrowserSettingsStore.getSettings()).workspace,
    onEmbeddedWebContentsCreated: (context, contents) => {
      embeddedRuntimeDiagnostics?.attach(context, contents);
    },
    performNativeZoom: (action, runtimeWindow, targetWebContents, event) =>
      applicationMenu?.performZoom(action, event, runtimeWindow, targetWebContents) ?? false,
    persistWorkspaceRoleZoom: async (workspaceId, roleId, browserZoomPercent) => {
      const updated = await workspaceStore.updateRoleBrowserZoom(
        workspaceId,
        roleId,
        browserZoomPercent
      );
      if (updated) {
        await notifyWorkspacesChanged();
      }
    },
    handleRuntimeTabAction: (runtimeWindow, displayId, action) => {
      dispatchRuntimeTabAction(runtimeWindow, displayId, action);
    },
    prefersReducedTransparency: () => nativeTheme.prefersReducedTransparency
  });
  browserManager = runtimeManager;
  coreClient.subscribe((events) => {
    if (events.some((event) => event.type === "resourceStatuses")) {
      runtimeManager.notifyResourceStatusesChanged();
    }
  });
  const browserActionAdapter = new ElectronBrowserActionAdapter({
    getTarget: (roleId) => runtimeManager.getEmbeddedAutomationSession(roleId)?.target,
    recordMacroScheduleToDispatchLatency: (durationMs) =>
      coreClient.recordMacroScheduleToDispatchLatency(durationMs)
  });
  electronBrowserActionAdapter = browserActionAdapter;
  const electronProfileEffectAdapter = new ElectronProfileEffectAdapter({
    getEmbeddedSession: (roleId) =>
      electronSession.fromPartition(createRoleSessionPartition(roleId)),
    getImportedSession: (browserUserDataDir) =>
      electronSession.fromPath(join(browserUserDataDir, "Default"))
  });
  const effectExecutor = new ElectronEffectExecutor(
    electronEffectHandles,
    {
      clearSessionStorage: async (sessionHandle, storages) => {
        await electronSession.fromPartition(sessionHandle.partition).clearStorageData({
          storages: storages as Electron.ClearStorageDataOptions["storages"]
        });
      },
      createView: (optionsJson) =>
        new WebContentsView(JSON.parse(optionsJson) as Electron.WebContentsViewConstructorOptions),
      createWindow: (optionsJson) =>
        new BaseWindow(
          JSON.parse(optionsJson) as Electron.BaseWindowConstructorOptions
        ) as unknown as import("./core/ElectronEffectExecutor").ElectronWindowEffectHandle,
      dispatchResults: (results) => coreClient.dispatchCoreEffectResults(results),
      executeBrowserActionEffect: ({ action }) =>
        browserActionAdapter.executeEffect(action),
      executeEmbeddedEffect: ({ action }) => runtimeManager.executeEmbeddedEffect(action),
      executeExternalEffect: async ({ action }) => {
        switch (action.type) {
          case "externalPrepareSession": {
            const settings = await gameBrowserSettingsStore.getSettings();
            const browserSession = electronSession.fromPartition(
              createRoleSessionPartition(action.roleId)
            );
            await browserProxyApplier.applyToSession(browserSession);
            return {
              cdnEnabled: await cdnCompatibilityManager.resolveForSession(browserSession),
              ...(settings.network.proxy.mode === "custom" &&
              settings.network.proxy.server.trim()
                ? { proxyServer: settings.network.proxy.server }
                : {})
            };
          }
          case "externalResolvePhysicalBounds":
            return process.platform === "win32"
              ? screen.dipToScreenRect(null, action.bounds)
              : action.bounds;
          case "externalOverlaySource":
            return MACRO_OVERLAY_SCRIPT;
        }
      },
      executeOverlayEffect: async ({ action }) => {
        switch (action.type) {
          case "overlayOpenMacroPage":
            await requestMacroPageFromOverlay({ roleId: action.roleId });
            return undefined;
          case "overlayCopyCoordinate":
            clipboard.writeText(formatMacroCoordinateClipboard(action.coordinate));
            return undefined;
        }
      },
      executeProfileEffect: async ({ action }) => {
        await electronProfileEffectAdapter.execute(action);
        return undefined;
      },
      onResult: (effect, result) => {
        if (result.ok) return;
        logService.error(
          "browser",
          "electron_effect_failed",
          "An Electron effect failed.",
          result.error,
          {
            actionType: effect.action.type,
            effectId: effect.effectId,
            handleId: effect.target.handleId,
            operationId: effect.operationId,
            ...(effect.action.type === "browserAction"
              ? {
                  roleId: effect.action.request.roleId,
                  origin: effect.action.request.origin
                }
              : {})
          }
        );
      },
      executeCdnEffect: (effect) => cdnCompatibilityManager.executeEffect(effect),
      executeCompatibilityEffect: (effect) => gameCompatibilityManager.executeEffect(effect),
      sendDebuggerCommand: async (contents, method, params) => {
        const electronContents = contents as Electron.WebContents;
        if (!electronContents.debugger.isAttached()) electronContents.debugger.attach("1.3");
        return await electronContents.debugger.sendCommand(method, params);
      },
      setCookie: async (sessionHandle, cookieJson) => {
        await electronSession
          .fromPartition(sessionHandle.partition)
          .cookies.set(JSON.parse(cookieJson) as Electron.CookiesSetDetails);
      }
    }
  );
  electronEffectExecutor = effectExecutor;
  electronEffectUnsubscribe = coreClient.subscribe((events) => {
    for (const event of events) {
      if (event.type !== "coreEffects") continue;
      void effectExecutor.executeAndDispatch(event.effects).catch((error) => {
        logService.error(
          "browser",
          "electron_effect_dispatch_failed",
          "Failed to dispatch an Electron effect result to the Rust core.",
          error
        );
      });
    }
  });
  runtimeManager.setAlwaysShowToolbarInFullScreen(
    runtimeWindowPreferences.alwaysShowToolbarInFullScreen
  );
  ipcMain.on(GAME_DIVIDER_POINTER_CHANNEL, (event, payload) => {
    void runtimeManager.handleDividerPointer(event.sender.id, payload);
  });
  const macroManager = new RustMacroManager(coreClient);
  coreClient.subscribe((events) => {
    const changed = new Set(events.flatMap((event) =>
      event.type === "stateChanged" ? event.changedCollections : []
    ));
    if (changed.has("games")) {
      void gameStore.listGames().then((games) => {
        BrowserWindow.getAllWindows().forEach((window) =>
          sendToWindowIfAvailable(window, IPC_CHANNELS.gamesChanged, games));
      });
    }
    if (changed.has("roles")) {
      appQuickMenu?.scheduleRefresh();
    }
    if (changed.has("launchWorkspaces")) {
      void workspaceStore.listWorkspaces().then((workspaces) => {
        appQuickMenu?.scheduleRefresh();
        broadcastWorkspacesChanged(workspaces);
      });
    }
    if (changed.has("macros")) {
      void macroStore.listMacros().then(broadcastMacrosChanged);
    }
    if (changed.has("compatibilityReports")) {
      void gameCompatibilityManager.listReports().then((reports) => {
        const statuses = gameCompatibilityManager.listStatuses();
        BrowserWindow.getAllWindows().forEach((window) =>
          sendToWindowIfAvailable(
            window,
            IPC_CHANNELS.gamesCompatibilityChanged,
            reports,
            statuses
          ));
      });
    }
  });
  coreClient.subscribe((events) => {
    for (const event of events) {
      if (event.type !== "externalHealthChanged") continue;
      const context = { roleId: event.roleId, pageHealth: event.health };
      if (event.health === "unresponsive") {
        latestExternalFreezeReportedAt = new Date();
        logService.warn(
          "browser",
          "external_chrome_page_unresponsive",
          "An external Chrome game page stopped responding.",
          context
        );
      } else {
        logService.info(
          "browser",
          "external_chrome_page_recovered",
          "An external Chrome game page diagnostics heartbeat recovered.",
          context
        );
      }
    }
  });
  const portableDataManager = new PortableDataManager({
    core: coreClient,
    showOpenDialog: (options) =>
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showOpenDialog(mainWindow, options)
        : dialog.showOpenDialog(options),
    showSaveDialog: (options) =>
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showSaveDialog(mainWindow, options)
        : dialog.showSaveDialog(options)
  });
  runtimeManager.setBeforeRolesStop(async (roleIds) => {
    await Promise.all(roleIds.map((roleId) => macroManager.stopRole(roleId)));
  });
  const chromeProfileImportManager = new ChromeProfileImportManager({
    closeChrome: async () => {
      await coreClient.invoke({ type: "systemChromeClose" });
    },
    core: coreClient,
    showOpenDialog: (options) =>
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showOpenDialog(mainWindow, options)
        : dialog.showOpenDialog(options)
  });
  const macroOverlay = new MacroOverlayInjector(coreClient);
  macroOverlayRef.current = macroOverlay;
  runtimeManager.setMacroOverlayInstaller((role, page) => macroOverlay.install(role, page));
  macroManager.on("change", (statuses) => {
    logService.info("macro", "macro_status_changed", "Macro runtime status changed.", {
      statuses: statuses.map((status) => ({
        error: status.error,
        iteration: status.iteration,
        macroId: status.macroId,
        roleId: status.roleId,
        state: status.state
      }))
    });
  });
  runtimeManager.on("change", (statuses) => {
    logService.info("browser", "role_status_changed", "Browser role status changed.", {
      statuses: statuses.map((status) => ({ roleId: status.roleId, state: status.state, runtimeMode: status.runtimeMode }))
    });
  });
  coreClient.subscribe((events) => {
    for (const event of events) {
      if (event.type !== "overlayChanged") continue;
      macroOverlay.refreshInstalledOverlays(
        event.roleIds.length === 0 ? undefined : event.roleIds
      );
    }
  });
  const graphicsDiagnosticsService = new GraphicsDiagnosticsService({
    app,
    appliedSettings: appliedBrowserGraphicsSettings,
    core: coreClient,
    isGpuInfoReady: () => gpuInfoReady
  });
  const workspaceLauncher = new WorkspaceLaunchCoordinator({
    browserManager: runtimeManager,
    gameBrowserSettingsStore,
    gameCompatibilityManager,
    getDefaultWorkspaceDisplayId: () => getMainWindowDisplay().id,
    getWorkspaceDisplays: () => getWorkspaceDisplayInfos(),
    roleStore,
    workspaceStore
  });

  runtimeTabMenu = new RuntimeTabMenuController({
    browserManager: runtimeManager,
    getWorkspaceDisplays: getWorkspaceDisplayInfos,
    onWorkspaceDisplaySelectionRequired: requestWorkspaceDisplaySelection,
    roleStore,
    workspaceLauncher,
    workspaceStore
  });
  applicationMenu = new ApplicationMenuController({
    alwaysShowToolbarInFullScreen: runtimeWindowPreferences.alwaysShowToolbarInFullScreen,
    applyAlwaysShowToolbarInFullScreen: (value) => {
      runtimeManager.setAlwaysShowToolbarInFullScreen(value);
    },
    saveAlwaysShowToolbarInFullScreen: async (value) => {
      await runtimeWindowPreferencesStore.updatePreferences({
        alwaysShowToolbarInFullScreen: value
      });
    },
    toggleFullScreen: () => {
      const focusedWindow = BaseWindow.getFocusedWindow();
      if (!focusedWindow || focusedWindow.isDestroyed()) return;
      if (runtimeManager.toggleRuntimeWindowFullscreenForWindow(focusedWindow.id)) return;
      focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
    }
  });
  applicationMenu.install();

  ipcMain.on(RUNTIME_TABS_ACTION_CHANNEL, (event, action: unknown) => {
    if (!isRuntimeTabAction(action)) return;
    const displayId = runtimeManager.getRuntimeDisplayIdForWebContents(event.sender.id);
    if (displayId === undefined) return;
    const runtimeWindow = runtimeManager.getRuntimeWindowForWebContents(event.sender.id);
    if (!runtimeWindow || runtimeWindow.isDestroyed()) return;
    dispatchRuntimeTabAction(runtimeWindow, displayId, action);
  });

  registerIpcHandlers(roleStore, workspaceStore, runtimeManager, {
    captureExternalRoleDiagnostics: async (roleId) => {
      const capturedAt = new Date();
      latestExternalFreezeReportedAt = capturedAt;
      const [diagnostics, windowsGraphicsEvents] = await Promise.all([
        coreClient.invoke({ type: "externalDiagnosticsCapture", roleId }),
        coreClient.invoke({
          type: "windowsGraphicsEventsCollect",
          since: new Date(capturedAt.getTime() - 30 * 60_000).toISOString()
        })
      ]);
      logService.warn(
        "browser",
        "external_chrome_manual_diagnostics",
        "Captured user-requested diagnostics for an external Chrome game page.",
        { roleId, diagnostics, windowsGraphicsEvents }
      );
    },
    consumePendingMacroPageRequest,
    consumePendingWorkspaceLaunchRequest,
    gameCompatibilityManager,
    gameStore,
    gameBrowserSettingsStore,
    legalAcceptanceStore,
    logService,
    revealLogs: revealLogDirectory,
    exportDiagnostics,
    getDefaultWorkspaceDisplayId: () => getMainWindowDisplay().id,
    getWorkspaceDisplays: () => getWorkspaceDisplayInfos(),
    getGraphicsDiagnostics: (sender) => graphicsDiagnosticsService.collect(sender),
    macroManager,
    macroStore,
    macroSettingsStore,
    portableDataManager,
    chromeProfileImportManager,
    clearRoleBrowserData: (roleId) =>
      coreClient.invoke({ type: "roleBrowserDataClear", roleId }),
    systemFontService,
    updateManager,
    onGameBrowserSettingsChanged: () => undefined,
    onMacrosChanged: () => {
      void macroStore.listMacros().then(broadcastMacrosChanged);
    },
    onLegalAccepted: () => {
      startUpdateCheck();
      appQuickMenu?.scheduleRefresh();
    },
    onMacroOverlayRequest: async (webContents, request) => {
      const activeRoleId = runtimeManager.getRoleIdForWebContents(webContents.id);
      if (isGameInputContextRequest(request)) {
        runtimeManager.setGameInputContext(webContents.id, request.active);
      }
      return macroOverlay.handleEmbeddedRequest(webContents, activeRoleId, request);
    },
    onOverlayLanguageChanged: (language) => {
      void macroOverlay.setLanguage(language);
      runtimeManager.setRuntimeTabsLanguage(language);
      runtimeTabMenu?.setLanguage(language);
      applicationMenu?.setLanguage(language);
    },
    onRendererReady: (senderId, state) => {
      rendererReadyGate.notify(senderId, state);
    },
    onRolesChanged: () => {
      appQuickMenu?.scheduleRefresh();
    },
    onWorkspacesChanged: () => {
      void notifyWorkspacesChanged().catch((error) => {
        console.error("Failed to broadcast launch workspace changes.", error);
      });
    },
    quitApplication: () => app.quit(),
    restartApplication: () => {
      app.relaunch();
      app.exit(0);
    },
    recordIpcCommandLatency: (_channel, durationMs) =>
      coreClient.recordIpcCommandLatency(durationMs),
    workspaceLauncher
  });
  const notifyWorkspaceDisplaysChanged = (): void => {
    const displays = getWorkspaceDisplayInfos();
    broadcastWorkspaceDisplaysChanged(displays);
    appQuickMenu?.scheduleRefresh();
    void workspaceStore.reconcileTargetDisplays(displays)
      .then(() => appQuickMenu?.scheduleRefresh())
      .catch((error) => console.error("Failed to reconcile workspace target displays.", error));
  };
  screen.on("display-added", notifyWorkspaceDisplaysChanged);
  screen.on("display-removed", (_event, removedDisplay) => {
    const studioDisplay = getMainWindowDisplay();
    const fallbackDisplay = studioDisplay.id === removedDisplay.id
      ? screen.getPrimaryDisplay()
      : studioDisplay;
    runtimeManager.handleDisplayRemoved(removedDisplay.id, fallbackDisplay.id);
    notifyWorkspaceDisplaysChanged();
  });
  screen.on("display-metrics-changed", (_event, display) => {
    runtimeManager.handleDisplayMetricsChanged(display.id, display.workArea);
    notifyWorkspaceDisplaysChanged();
  });

  const appIcon = loadAppIcon();
  if (process.platform === "darwin" && app.dock) {
    if (appIcon) {
      app.dock.setIcon(appIcon);
    }
  }

  const setQuickMenu = process.platform === "darwin" && app.dock
    ? (menu: Menu) => app.dock?.setMenu(menu)
    : process.platform === "win32" && windowsTray
      ? (menu: Menu) => windowsTray?.setContextMenu(menu)
      : undefined;

  if (setQuickMenu) {
    appQuickMenu = new AppQuickMenu({
      roleStore,
      workspaceStore,
      workspaceLauncher,
      browserManager: runtimeManager,
      canUseApp: () => legalAcceptanceStore.isAccepted(),
      includeQuit: process.platform === "win32",
      onWorkspaceDisplaySelectionRequired: requestWorkspaceDisplaySelection,
      openApp: showMainWindow,
      ...(process.platform === "win32" ? { quitApp: () => app.quit() } : {}),
      setMenu: setQuickMenu
    });
    runtimeManager.on("change", () => {
      appQuickMenu?.scheduleRefresh();
    });
    runtimeManager.on("runtimeChange", () => {
      appQuickMenu?.scheduleRefresh();
    });
    appQuickMenu.scheduleRefresh();
  }

  void legalAcceptanceStore.isAccepted().then((isAccepted) => {
    if (isAccepted) {
      startUpdateCheck();
    }
  });
}

async function prepareRendererWindow(loadingWindow: BrowserWindow): Promise<void> {
  const webContentsId = loadingWindow.webContents.id;
  let preparationTimeout: ReturnType<typeof setTimeout> | undefined;
  const preparationTimeoutPromise = new Promise<never>((_resolve, reject) => {
    preparationTimeout = setTimeout(() => {
      reject(new RendererReadyTimeoutError(RENDERER_READY_TIMEOUT_MS));
    }, RENDERER_READY_TIMEOUT_MS);
  });
  let removePreloadErrorListener = (): void => undefined;
  const preloadFailurePromise = new Promise<never>((_resolve, reject) => {
    const onPreloadError = (_event: Electron.Event, preloadPath: string, error: Error): void => {
      reject(new Error(`Failed to load preload script: ${preloadPath}`, { cause: error }));
    };

    removePreloadErrorListener = () => {
      loadingWindow.webContents.removeListener("preload-error", onPreloadError);
    };
    loadingWindow.webContents.once("preload-error", onPreloadError);
  });

  try {
    const rendererState = await Promise.race([
      Promise.all([
        loadMainRenderer(loadingWindow),
        rendererReadyGate.wait(webContentsId, RENDERER_READY_TIMEOUT_MS)
      ]).then(([, state]) => state),
      preloadFailurePromise,
      preparationTimeoutPromise
    ]);

    if (!rendererState || loadingWindow.isDestroyed()) {
      return;
    }

    mainWindowReady = true;
    loadingWindow.webContents.setBackgroundThrottling(true);
    if (startupWindow === loadingWindow) {
      startupWindow = null;
    }
  } catch (error) {
    mainWindowReady = false;
    rendererReadyGate.cancel(webContentsId);
    throw error;
  } finally {
    if (preparationTimeout) {
      clearTimeout(preparationTimeout);
    }
    removePreloadErrorListener();
  }
}

async function startApplication(): Promise<void> {
  const loadingWindow = createStartupWindow();

  try {
    const startupShown = await showStartupWindow(loadingWindow, getStartupPageOptions());
    if (!startupShown || loadingWindow.isDestroyed()) {
      return;
    }

    if (initializationFailed) {
      await showStartupFailure(loadingWindow, startupFailureMessage);
      return;
    }

    if (!appInitialized) {
      try {
        await initializeApplication();
        appInitialized = true;
      } catch (error) {
        initializationFailed = true;
        startupFailureMessage = formatStartupFailure(error);
        throw error;
      }
    }

    if (loadingWindow.isDestroyed()) {
      return;
    }

    await prepareRendererWindow(loadingWindow);
  } catch (error) {
    logService.error("main", "startup_failed", "Rion Studio startup failed.", error);

    if (!loadingWindow.isDestroyed()) {
      await showStartupFailure(loadingWindow, formatStartupFailure(error)).catch((failureError) => {
        logService.error("main", "startup_failure_page_failed", "Failed to show the startup failure page.", failureError);
      });
    }
  }
}

function formatStartupFailure(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The application could not finish starting. Please quit and try again.";
}

function isGameInputContextRequest(
  value: unknown
): value is { active: boolean; type: "game-input-context" } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "game-input-context" &&
    "active" in value &&
    typeof value.active === "boolean"
  );
}

function ensureApplicationStarted(): void {
  if (startupPromise) {
    return;
  }

  startupPromise = startApplication().finally(() => {
    startupPromise = null;
  });
}

const isPrimaryAppInstance = configureSingleInstanceLifecycle({
  onSecondInstance: (listener) => {
    app.on("second-instance", listener);
  },
  quitSecondaryInstance: () => app.quit(),
  requestLock: () => app.requestSingleInstanceLock(),
  showPrimaryInstance: showMainWindow
});

if (isPrimaryAppInstance) {
  app.whenReady().then(() => {
    logService.info("main", "electron_ready", "Electron app is ready.");
    createWindowsTray();

    ensureApplicationStarted();

    app.on("activate", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        showMainWindow();
        return;
      }

      ensureApplicationStarted();
    });
  });
}

app.on("render-process-gone", (_event, webContents, details) => {
  const embeddedContext = embeddedRuntimeDiagnostics?.getRenderProcessGoneContext(webContents);
  logService.error("browser", "render_process_gone", "A renderer process exited unexpectedly.", undefined, {
    webContentsId: webContents.id,
    reason: details.reason,
    exitCode: details.exitCode,
    ...embeddedContext
  });
});

app.on("child-process-gone", (_event, details) => {
  logService.error("main", "child_process_gone", "An Electron child process exited unexpectedly.", undefined, {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName
  });
});

app.on("web-contents-created", (_event, contents) => {
  const details = { type: contents.getType(), webContentsId: contents.id };
  contents.on("did-start-navigation", (_navigationEvent, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) logService.info("browser", "navigation_started", "Main-frame navigation started.", { ...details, url });
  });
  contents.on("did-fail-load", (_loadEvent, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) logService.warn("browser", "navigation_failed", "Main-frame navigation failed.", {
      ...details, errorCode, errorDescription, url: validatedUrl
    });
  });
  contents.once("destroyed", () => logService.info("browser", "web_contents_destroyed", "Web contents was destroyed.", details));
});

function getMainWindowDisplay(): Electron.Display {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return screen.getPrimaryDisplay();
  }

  return screen.getDisplayMatching(mainWindow.getBounds());
}

function getMainWindowDisplayWorkArea(): Electron.Rectangle {
  return getMainWindowDisplay().workArea;
}

function getWorkspaceDisplayInfos() {
  return createWorkspaceDisplayInfos(screen.getAllDisplays(), screen.getPrimaryDisplay().id);
}

function dispatchRuntimeTabAction(
  runtimeWindow: BaseWindow,
  displayId: number,
  action: RuntimeTabAction
): void {
  const manager = browserManager;
  if (!manager || runtimeWindow.isDestroyed()) return;
  if ("tabId" in action) {
    const actionTab = manager.listEmbeddedRuntimeState().tabs.find(
      (tab) => tab.id === action.tabId
    );
    if (!actionTab) return;
    const isAuthorizedMove = action.type === "move" &&
      (actionTab.displayId === displayId || action.displayId === displayId);
    if (actionTab.displayId !== displayId && !isAuthorizedMove) return;
  }

  switch (action.type) {
    case "activate":
      void manager.showRuntimeTab(action.tabId).catch((error) => {
        console.error("Failed to activate runtime tab.", error);
      });
      break;
    case "hide":
      void manager.hideRuntimeTab(action.tabId).catch((error) => {
        console.error("Failed to hide runtime tab.", error);
      });
      break;
    case "stop":
      void manager.stopRuntimeTab(action.tabId).catch((error) => {
        console.error("Failed to stop runtime tab.", error);
      });
      break;
    case "move":
      void manager.moveRuntimeTab(action.tabId, action.displayId).catch((error) => {
        console.error("Failed to move runtime tab.", error);
      });
      break;
    case "reorder":
      manager.reorderRuntimeTab(action.tabId, action.beforeTabId);
      break;
    case "openLauncher":
      if (!runtimeTabMenu) return;
      void runtimeTabMenu.openLauncher(runtimeWindow, displayId).catch((error) => {
        console.error("Failed to open the runtime launcher menu.", error);
      });
      break;
    case "openTabMenu":
      runtimeTabMenu?.openTabMenu(runtimeWindow, displayId, action.tabId);
      break;
    case "fullscreenToolbarEnter":
      manager.handleRuntimeToolbarPointer(displayId, true);
      break;
    case "fullscreenToolbarLeave":
      manager.handleRuntimeToolbarPointer(displayId, false);
      break;
    case "windowControl":
      manager.handleRuntimeWindowControl(displayId, action.control);
      break;
  }
}

app.on("before-quit", (event) => {
  if (isApplicationQuitting) {
    return;
  }

  event.preventDefault();
  if (quitCleanupPromise) {
    return;
  }

  isApplicationQuitting = true;
  quitCleanupPromise = (async () => {
    const manager = browserManager;
    const coreClient = appCoreClient;
    const actionAdapter = electronBrowserActionAdapter;
    const effectExecutor = electronEffectExecutor;
    const unsubscribeEffects = electronEffectUnsubscribe;

    try {
      await manager?.stopAll();
    } catch (error) {
      logService.error("browser", "quit_stop_sessions_failed", "Failed to stop all browser sessions while quitting.", error);
    } finally {
      embeddedRuntimeDiagnostics?.stop();
      embeddedRuntimeDiagnostics = null;
      logService.info("main", "app_quitting", "Application is quitting.");
      try {
        await Promise.race([
          coreClient?.shutdown() ?? Promise.resolve(),
          new Promise((resolve) => setTimeout(resolve, 15_000))
        ]);
      } catch (error) {
        logService.error(
          "main",
          "core_shutdown_failed",
          "The Rust application core failed to shut down cleanly.",
          error
        );
      }
      try {
        await effectExecutor?.closeAndDrain();
      } catch (error) {
        logService.error(
          "browser",
          "electron_effect_drain_failed",
          "Electron effects did not drain cleanly while quitting.",
          error
        );
      }
      unsubscribeEffects?.();
      await actionAdapter?.shutdown().catch((error) => {
        logService.error(
          "macro",
          "browser_action_adapter_shutdown_failed",
          "The browser action adapter failed to shut down cleanly.",
          error
        );
      });
      await logService.shutdown();
      if (electronEffectUnsubscribe === unsubscribeEffects) electronEffectUnsubscribe = null;
      if (electronEffectExecutor === effectExecutor) electronEffectExecutor = null;
      if (electronBrowserActionAdapter === actionAdapter) electronBrowserActionAdapter = null;
      if (appCoreClient === coreClient) appCoreClient = null;
      app.quit();
    }
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
