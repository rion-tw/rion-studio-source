import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { cpus, freemem, totalmem } from "node:os";

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
  WebContentsView,
  type Session
} from "electron";

import { ExternalChromeManager } from "./browser/ExternalChromeManager";
import {
  ChromeProfileImportManager,
  readChromeLoginDataWithCdp,
  recoverChromeProfileImport
} from "./browser/ChromeProfileImportManager";
import { EmbeddedRuntimeDiagnostics } from "./browser/EmbeddedRuntimeDiagnostics";
import { RoleBrowserDataManager } from "./browser/RoleBrowserDataManager";
import { ChromeZoomPreferenceApplier } from "./browser/ChromeZoomPreferenceApplier";
import { SystemPressureMonitor } from "./browser/SystemPressureMonitor";
import { createExternalChromeWindowBoundsAdapter } from "./browser/WindowsExternalChromeWindowBoundsAdapter";
import { loadMacRuntimeTabsControllerFactory } from "./browser/MacRuntimeTabsController";
import { createRuntimeTabsPageUrl } from "./browser/runtimeTabsPage";
import { AuthManager } from "./auth/AuthManager";
import { createLoginStorageSnapshot, LOGIN_STORAGE_EXPRESSION } from "./auth/loginEvidence";
import { waitForSettledAuthSession } from "./auth/settledAuthSession";
import {
  BrowserManager,
  createRoleSessionPartition,
  GAME_DIVIDER_POINTER_CHANNEL
} from "./browser/BrowserManager";
import { AppQuickMenu } from "./menu/AppQuickMenu";
import { ApplicationMenuController } from "./menu/ApplicationMenu";
import { RuntimeTabMenuController } from "./menu/RuntimeTabMenu";
import { buildWindowsTrayMenuTemplate } from "./tray/WindowsTrayMenu";
import { BrowserFontApplier } from "./game-browser/BrowserFontApplier";
import { BrowserProxyApplier } from "./game-browser/BrowserProxyApplier";
import { CdnCompatibilityManager } from "./game-browser/CdnCompatibilityManager";
import { GameBrowserSettingsStore } from "./game-browser/GameBrowserSettingsStore";
import { GraphicsDiagnosticsService } from "./game-browser/GraphicsDiagnosticsService";
import {
  configureChromiumCommandLine,
  readAppliedBrowserGraphicsMode
} from "./game-browser/BrowserLaunchConfiguration";
import { SystemFontService } from "./game-browser/SystemFontService";
import { GameCompatibilityManager } from "./games/GameCompatibilityManager";
import { GameCompatibilityStore } from "./games/GameCompatibilityStore";
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
import { writeZip } from "./logging/zipWriter";
import { MacroManager } from "./macros/MacroManager";
import { MacroOverlayInjector } from "./macros/MacroOverlayInjector";
import { MacroStore } from "./macros/MacroStore";
import { MacroSettingsStore } from "./macros/MacroSettingsStore";
import {
  PortableDataManager,
  recoverPortableImportTransaction
} from "./portable/PortableDataManager";
import { SerialTaskQueue } from "./persistence/SerialTaskQueue";
import { runBackgroundActivityMigration } from "./persistence/BackgroundActivityMigration";
import { RoleStore } from "./roles/RoleStore";
import { requestGracefulChromeQuit } from "./system-browser/SystemChromeCloser";
import { findSystemChromeExecutable } from "./system-browser/SystemChromeLauncher";
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
import { IPC_CHANNELS } from "../shared/ipc";
import { EMBEDDED_RUNTIME_DIAGNOSTICS_CHANNEL } from "../shared/embeddedRuntimeDiagnostics";
import { normalizeGameBrowserSettings } from "../shared/browserFonts";
import { formatMacroCoordinateClipboard } from "../shared/macroCoordinates";
import {
  RUNTIME_TABS_ACTION_CHANNEL,
  isRuntimeTabAction,
  type RuntimeTabAction
} from "../shared/runtimeTabs";
import type {
  ChromeProfileImportRuntimeVerification,
  MacroPageRequest,
  PendingWorkspaceLaunchRequest
} from "../shared/types";

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "false";

const appliedBrowserGraphicsMode = readAppliedBrowserGraphicsMode(app.getPath("userData"));
configureChromiumCommandLine(app.commandLine, appliedBrowserGraphicsMode);
let gpuInfoReady = false;
app.on("gpu-info-update", () => {
  gpuInfoReady = true;
});

let mainWindow: BrowserWindow | null = null;
let startupWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let embeddedRuntimeDiagnostics: EmbeddedRuntimeDiagnostics | null = null;
let appQuickMenu: AppQuickMenu | null = null;
let applicationMenu: ApplicationMenuController | null = null;
let runtimeTabMenu: RuntimeTabMenuController | null = null;
let windowsTray: Tray | null = null;
let pendingMacroPageRequest: MacroPageRequest | null = null;
let pendingWorkspaceLaunchRequest: PendingWorkspaceLaunchRequest | null = null;
let appInitialized = false;
let initializationFailed = false;
let mainWindowReady = false;
let startupPromise: Promise<void> | null = null;
let isApplicationQuitting = false;
let quitCleanupPromise: Promise<void> | null = null;
let getDiagnosticDataCounts = async () => ({ games: 0, roles: 0, workspaces: 0, macros: 0 });
const rendererReadyGate = new RendererReadyGate();
const RENDERER_READY_TIMEOUT_MS = 15_000;
const logService = new LogService({
  appVersion: app.getVersion(),
  platform: process.platform,
  userDataPath: app.getPath("userData")
});

ipcMain.on(EMBEDDED_RUNTIME_DIAGNOSTICS_CHANNEL, (event, payload: unknown) => {
  embeddedRuntimeDiagnostics?.handlePageEvent(event.sender, payload);
});
const loggingReady = logService.initialize();
logService.on("entry", (entry) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.logsEntryAdded, entry);
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
  const result = await shell.openPath(logService.directory);
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
  const temporaryPath = `${filePath}.tmp`;
  const logFiles = await logService.getFiles();
  const logStatus = await logService.getStatus();
  const cpu = cpus()[0];
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    application: { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged },
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    system: {
      platform: process.platform,
      release: process.getSystemVersion(),
      arch: process.arch,
      locale: app.getLocale(),
      cpu: cpu ? { model: cpu.model, cores: cpus().length } : undefined,
      memory: { totalBytes: totalmem(), freeBytes: freemem() },
      displayCount: screen.getAllDisplays().length,
      gpuFeatureStatus: app.getGPUFeatureStatus()
    },
    dataCounts: await getDiagnosticDataCounts(),
    logging: { ...logStatus, directory: "<USER_DATA>/logs" }
  };
  try {
    await writeZip(temporaryPath, [
      { name: "diagnostics.json", data: Buffer.from(JSON.stringify(diagnostics, null, 2)) },
      ...logFiles.map((file) => ({ name: `logs/${file.name}`, data: file.data }))
    ]);
    await unlink(filePath).catch(() => undefined);
    await rename(temporaryPath, filePath);
    logService.info("main", "diagnostics_exported", "A diagnostic bundle was exported.", { logFileCount: logFiles.length });
    return { filePath, logFileCount: logFiles.length };
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    logService.error("main", "diagnostics_export_failed", "Failed to export diagnostic bundle.", error);
    throw error;
  }
}

function loadAppIcon() {
  const iconPath = getAppIconPath();

  if (!existsSync(iconPath)) {
    return undefined;
  }

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
  if (!existsSync(iconPath)) {
    console.error(`Windows tray icon was not found: ${iconPath}`);
    return;
  }

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

function getStartupPageOptions(state: StartupPageState = "loading") {
  const appIcon = loadAppIcon();

  return {
    iconDataUrl: appIcon?.resize({ height: 128, quality: "best", width: 128 }).toDataURL(),
    state,
    theme: nativeTheme.shouldUseDarkColors ? ("dark" as const) : ("light" as const)
  };
}

async function showStartupFailure(window: BrowserWindow): Promise<void> {
  const loadFailurePage = () => window.loadURL(createStartupPageUrl(getStartupPageOptions("failed")));

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
  await recoverPortableImportTransaction(userDataDir);
  const dataMutationQueue = new SerialTaskQueue();
  const withDataMutation = <T>(operation: () => Promise<T>): Promise<T> =>
    dataMutationQueue.run(operation);
  const roleStore = new RoleStore(userDataDir);
  await recoverChromeProfileImport(userDataDir, roleStore);
  const transactionalRoleAuthStore: Pick<RoleStore, "updateAuthState"> & Pick<RoleStore, "updateRole"> = {
    updateAuthState: (id, authState, messageTimestamp) =>
      withDataMutation(() => roleStore.updateAuthState(id, authState, messageTimestamp)),
    updateRole: (id, input) => withDataMutation(() => roleStore.updateRole(id, input))
  };
  const gameStore = new GameStore(userDataDir, roleStore);
  await gameStore.initialize();
  await runBackgroundActivityMigration(userDataDir, { gameStore, roleStore });
  const workspaceStore = new LaunchWorkspaceStore(userDataDir);
  await workspaceStore.reconcileTargetDisplays(getWorkspaceDisplayInfos());
  const notifyWorkspacesChanged = async (): Promise<void> => {
    appQuickMenu?.scheduleRefresh();
    broadcastWorkspacesChanged(await workspaceStore.listWorkspaces());
  };
  const macroStore = new MacroStore(userDataDir);
  getDiagnosticDataCounts = async () => {
    const [games, roles, workspaces, macros] = await Promise.all([
      gameStore.listGames(), roleStore.listRoles(), workspaceStore.listWorkspaces(), macroStore.listMacros()
    ]);
    return { games: games.length, roles: roles.length, workspaces: workspaces.length, macros: macros.length };
  };
  const macroSettingsStore = new MacroSettingsStore(userDataDir);
  const legalAcceptanceStore = new LegalAcceptanceStore(userDataDir);
  const gameBrowserSettingsStore = new GameBrowserSettingsStore(userDataDir);
  const runtimeWindowPreferencesStore = new RuntimeWindowPreferencesStore(userDataDir);
  const runtimeWindowPreferences = await runtimeWindowPreferencesStore.getPreferences();
  const browserFontApplier = new BrowserFontApplier({
    appUserDataDir: userDataDir,
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const chromeZoomPreferenceApplier = new ChromeZoomPreferenceApplier();
  const browserProxyApplier = new BrowserProxyApplier({
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const cdnCompatibilityManager = new CdnCompatibilityManager({
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const systemFontService = new SystemFontService();
  const gameCompatibilityStore = new GameCompatibilityStore(userDataDir);
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
  const externalChromeWindowBoundsAdapter = createExternalChromeWindowBoundsAdapter();
  const resourcePressureMonitor = new SystemPressureMonitor();
  powerMonitor.on("speed-limit-change", ({ limit }) => resourcePressureMonitor.setSpeedLimit(limit));
  if (process.platform === "darwin") {
    powerMonitor.on("thermal-state-change", ({ state }) => resourcePressureMonitor.setThermalState(state));
  }
  resourcePressureMonitor.start();
  const externalChromeManager = new ExternalChromeManager(roleStore, {
    applyBrowserFonts: async (_role, browserUserDataDir) => {
      await browserFontApplier.applyToChromeUserDataDir(browserUserDataDir);
    },
    applyBrowserZoom: (browserUserDataDir, zoomFactor) =>
      chromeZoomPreferenceApplier.applyToChromeUserDataDir(browserUserDataDir, zoomFactor),
    prepareCdnCompatibility: async (role, _browserUserDataDir) => {
      const settings = normalizeGameBrowserSettings(await gameBrowserSettingsStore.getSettings());
      const browserSession = electronSession.fromPartition(createRoleSessionPartition(role.id));
      await browserProxyApplier.applyToSession(browserSession);
      return {
        enabled: await cdnCompatibilityManager.resolveForSession(browserSession),
        ...(settings.network.proxy.mode === "custom"
          ? { proxyServer: settings.network.proxy.server }
          : {})
      };
    },
    getLaunchWorkArea: () => getMainWindowDisplayWorkArea(),
    graphicsMode: appliedBrowserGraphicsMode,
    onDiagnostic: ({ details, roleId, type }) => {
      const context = { roleId, ...details };
      if (type === "cdp_evaluate_failed" || type === "disconnect") {
        logService.warn("browser", `external_chrome_${type}`, "External Chrome automation diagnostic.", context);
      } else {
        logService.info("browser", `external_chrome_${type}`, "External Chrome automation diagnostic.", context);
      }
    },
    ...(externalChromeWindowBoundsAdapter
      ? { windowBoundsAdapter: externalChromeWindowBoundsAdapter }
      : {})
  });
  const macRuntimeTabsControllerFactory = process.platform === "darwin"
    ? loadMacRuntimeTabsControllerFactory(getMacRuntimeTabsAddonPath())
    : undefined;
  embeddedRuntimeDiagnostics?.stop();
  embeddedRuntimeDiagnostics = new EmbeddedRuntimeDiagnostics(logService);
  powerMonitor.on("suspend", () => embeddedRuntimeDiagnostics?.handleSuspend());
  powerMonitor.on("resume", () => embeddedRuntimeDiagnostics?.handleResume());
  browserManager = new BrowserManager(transactionalRoleAuthStore, {
    applyBrowserFonts: async (role, partition) => {
      const browserUserDataDir = await roleStore.ensureBrowserUserDataDir(role.id);
      await browserFontApplier.applyToRoleLaunch(browserUserDataDir, partition);
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
    embeddedPreloadPath: join(__dirname, "../preload/embedded.cjs"),
    runtimeTabsPageUrl: createRuntimeTabsPageUrl(),
    runtimeTabsPreloadPath: join(__dirname, "../preload/runtime-tabs.cjs"),
    externalChromeManager,
    resourcePressureMonitor,
    getBrowserLaunchMode: async (role) => {
      const globalMode = (await gameBrowserSettingsStore.getSettings()).launchMode;
      if (!role) {
        return globalMode;
      }
      const game = await gameStore.getGame(role.gameId);
      return game.browserLaunchMode === "inherit" ? globalMode : game.browserLaunchMode;
    },
    getLoginUrl: async (role) => (await gameStore.getGame(role.gameId)).loginUrl ?? role.launchUrl,
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
      const updated = await withDataMutation(() =>
        workspaceStore.updateRoleBrowserZoom(workspaceId, roleId, browserZoomPercent)
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
  browserManager.setAlwaysShowToolbarInFullScreen(
    runtimeWindowPreferences.alwaysShowToolbarInFullScreen
  );
  ipcMain.on(GAME_DIVIDER_POINTER_CHANNEL, (event, payload) => {
    browserManager?.handleDividerPointer(event.sender.id, payload);
  });
  const macroManager = new MacroManager(browserManager, macroStore, macroSettingsStore);
  const portableDataManager = new PortableDataManager({
    gameBrowserSettingsStore,
    gameStore,
    getAppVersion: () => app.getVersion(),
    macroStore,
    macroSettingsStore,
    roleStore,
    showOpenDialog: (options) =>
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showOpenDialog(mainWindow, options)
        : dialog.showOpenDialog(options),
    showSaveDialog: (options) =>
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showSaveDialog(mainWindow, options)
        : dialog.showSaveDialog(options),
    userDataDir,
    withDataMutation,
    withStoppedMacros: (macroIds, operation) => macroManager.runStoppedMutations(macroIds, operation),
    workspaceStore
  });
  browserManager.setBeforeRolesStop(async (roleIds) => {
    await Promise.all(roleIds.map((roleId) => macroManager.stopRole(roleId)));
  });
  const roleBrowserDataManager = new RoleBrowserDataManager({
    browserManager,
    getSession: (partition) => electronSession.fromPartition(partition),
    roleStore
  });
  const chromeProfileImportManager = new ChromeProfileImportManager({
    closeChrome: () => requestGracefulChromeQuit({ platform: process.platform }),
    gameStore,
    getSession: (partition) => electronSession.fromPartition(partition),
    injectEmbeddedStorage: async (partition, url, values) => {
      const probe = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          sandbox: true
        }
      });
      try {
        await probe.loadURL(url);
        await probe.webContents.executeJavaScript(
          `Object.entries(${JSON.stringify(values)}).forEach(([key, value]) => localStorage.setItem(key, value));`,
          true
        );
      } finally {
        if (!probe.isDestroyed()) probe.destroy();
      }
    },
    verifyEmbeddedSession: async (partition, role): Promise<ChromeProfileImportRuntimeVerification> => {
      const probe = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          sandbox: true
        }
      });
      try {
        await browserProxyApplier.applyToSession(probe.webContents.session);
        await cdnCompatibilityManager.applyToSession(probe.webContents.session);
        await probe.loadURL(role.launchUrl);
        const verification = await waitForSettledAuthSession(async () => {
          const [cookies, runtimeValue] = await Promise.all([
            probe.webContents.session.cookies.get({ url: role.launchUrl }),
            probe.webContents.executeJavaScript(LOGIN_STORAGE_EXPRESSION)
          ]);
          return {
            finalUrl: probe.webContents.getURL(),
            snapshot: createLoginStorageSnapshot(cookies, runtimeValue)
          };
        });
        return {
          durationMs: verification.durationMs,
          message: verification.message,
          mode: "embedded",
          state: verification.authState
        };
      } catch (error) {
        return {
          message: error instanceof Error ? error.message : "Unable to verify the embedded login session.",
          mode: "embedded",
          state: "auth_failed"
        };
      } finally {
        if (!probe.isDestroyed()) probe.destroy();
      }
    },
    onLoginDataTransfer: (summary) => {
      logService.info("browser", "chrome_profile_import_data_transfer", "Chrome profile login data transfer completed.", {
        failedItemCount: summary.failedItemCount,
        failedStorageOriginCount: summary.failedStorageOriginCount,
        flushFailed: summary.flushFailed,
        readbackFailed: summary.readbackFailed,
        readFailed: summary.readFailed,
        resetFailed: summary.resetFailed,
        sourceItemCount: summary.sourceItemCount,
        sourceStorageKeyCount: summary.sourceStorageKeyCount,
        sourceStorageOriginCount: summary.sourceStorageOriginCount,
        visibleItemCount: summary.visibleItemCount,
        writtenItemCount: summary.writtenItemCount,
        writtenStorageKeyCount: summary.writtenStorageKeyCount,
        writtenStorageOriginCount: summary.writtenStorageOriginCount,
        roleId: summary.roleId
      });
    },
    resetEmbeddedSession: async (partition) => {
      const session = electronSession.fromPartition(partition);
      await session.closeAllConnections();
      await session.clearData({
        dataTypes: [
          "cache",
          "cookies",
          "fileSystems",
          "indexedDB",
          "localStorage",
          "serviceWorkers",
          "webSQL"
        ] as NonNullable<Parameters<Session["clearData"]>[0]>["dataTypes"]
      });
      await session.clearStorageData({ storages: ["cachestorage"] });
    },
    readChromeLoginData: readChromeLoginDataWithCdp,
    roleStore,
    showOpenDialog: (options) =>
      mainWindow && !mainWindow.isDestroyed()
        ? dialog.showOpenDialog(mainWindow, options)
        : dialog.showOpenDialog(options),
    userDataDir
  });
  const macroOverlayInjector = new MacroOverlayInjector(
    macroStore,
    macroManager,
    requestMacroPageFromOverlay,
    (roleId) => browserManager?.listStatuses().find((status) => status.roleId === roleId),
    (details) => {
      logService.info(
        "browser",
        "external_overlay_refresh_requested",
        "External Chrome overlay refresh requested.",
        details
      );
    },
    (details) => {
      logService.info(
        "browser",
        "embedded_overlay_refresh_requested",
        "Embedded game overlay refresh requested.",
        details
      );
    },
    async () => (await gameBrowserSettingsStore.getSettings()).macroBadgePosition,
    (coordinate) => clipboard.writeText(formatMacroCoordinateClipboard(coordinate))
  );
  browserManager.setMacroOverlayInstaller((role, page) => macroOverlayInjector.install(role, page));
  browserManager.setExternalMacroOverlayInstaller((role, target) => macroOverlayInjector.installExternal(role, target));
  macroManager.on("change", (statuses) => {
    macroOverlayInjector.refreshChangedMacroStatuses(statuses);
    logService.info("macro", "macro_status_changed", "Macro runtime status changed.", {
      statuses: statuses.map((status) => ({ macroId: status.macroId, state: status.state }))
    });
  });
  browserManager.on("change", (statuses) => {
    macroOverlayInjector.refreshChangedRoleStatuses(statuses);
    logService.info("browser", "role_status_changed", "Browser role status changed.", {
      statuses: statuses.map((status) => ({ roleId: status.roleId, state: status.state, runtimeMode: status.runtimeMode }))
    });
  });
  const authManager = new AuthManager(transactionalRoleAuthStore, browserManager);
  authManager.on("change", (statuses) => {
    logService.info("auth", "auth_status_changed", "Authentication status changed.", {
      statuses: statuses.map((status) => ({ roleId: status.roleId, state: status.state }))
    });
  });
  const gameCompatibilityManager = new GameCompatibilityManager({
    applyCdnCompatibility: async (session) => {
      await cdnCompatibilityManager.applyToSession(session);
    },
    applyProxy: (session) => browserProxyApplier.applyToSession(session),
    compatibilityStore: gameCompatibilityStore,
    createWindow: (options) => new BrowserWindow(options),
    gameBrowserSettingsStore,
    gameStore,
    getLaunchWorkArea: () => getMainWindowDisplayWorkArea(),
    isSystemChromeAvailable: () => {
      try {
        findSystemChromeExecutable();
        return true;
      } catch {
        return false;
      }
    }
  });
  authManager.on("result", (role, authState) => {
    void gameCompatibilityManager.recordObservation(role.gameId, authState === "authenticated"
      ? { lastAuthSuccessAt: new Date().toISOString() }
      : { lastAuthFailureAt: new Date().toISOString() });
  });
  const graphicsDiagnosticsService = new GraphicsDiagnosticsService({
    app,
    appliedMode: appliedBrowserGraphicsMode,
    browserManager,
    gameBrowserSettingsStore,
    isGpuInfoReady: () => gpuInfoReady
  });
  const workspaceLauncher = new WorkspaceLaunchCoordinator({
    browserManager,
    gameBrowserSettingsStore,
    gameCompatibilityManager,
    getDefaultWorkspaceDisplayId: () => getMainWindowDisplay().id,
    getWorkspaceDisplays: () => getWorkspaceDisplayInfos(),
    roleStore,
    workspaceStore
  });

  runtimeTabMenu = new RuntimeTabMenuController({
    authManager,
    browserManager,
    getWorkspaceDisplays: getWorkspaceDisplayInfos,
    onWorkspaceDisplaySelectionRequired: requestWorkspaceDisplaySelection,
    roleStore,
    workspaceLauncher,
    workspaceStore
  });
  applicationMenu = new ApplicationMenuController({
    alwaysShowToolbarInFullScreen: runtimeWindowPreferences.alwaysShowToolbarInFullScreen,
    applyAlwaysShowToolbarInFullScreen: (value) => {
      browserManager?.setAlwaysShowToolbarInFullScreen(value);
    },
    saveAlwaysShowToolbarInFullScreen: async (value) => {
      await runtimeWindowPreferencesStore.updatePreferences({
        alwaysShowToolbarInFullScreen: value
      });
    },
    toggleFullScreen: () => {
      const focusedWindow = BaseWindow.getFocusedWindow();
      if (!focusedWindow || focusedWindow.isDestroyed()) return;
      if (browserManager?.toggleRuntimeWindowFullscreenForWindow(focusedWindow.id)) return;
      focusedWindow.setFullScreen(!focusedWindow.isFullScreen());
    }
  });
  applicationMenu.install();

  ipcMain.on(RUNTIME_TABS_ACTION_CHANNEL, (event, action: unknown) => {
    if (!browserManager || !isRuntimeTabAction(action)) return;
    const displayId = browserManager.getRuntimeDisplayIdForWebContents(event.sender.id);
    if (displayId === undefined) return;
    const runtimeWindow = browserManager.getRuntimeWindowForWebContents(event.sender.id);
    if (!runtimeWindow || runtimeWindow.isDestroyed()) return;
    dispatchRuntimeTabAction(runtimeWindow, displayId, action);
  });

  registerIpcHandlers(roleStore, workspaceStore, browserManager, authManager, {
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
    roleBrowserDataManager,
    systemFontService,
    updateManager,
    withDataMutation,
    onGameBrowserSettingsChanged: () => {
      macroOverlayInjector.refreshInstalledOverlays(undefined, "game_browser_settings");
    },
    onMacrosChanged: () => {
      macroOverlayInjector.refreshInstalledOverlays(undefined, "macro_definition");
      void macroStore.listMacros().then(broadcastMacrosChanged);
    },
    onLegalAccepted: () => {
      startUpdateCheck();
      appQuickMenu?.scheduleRefresh();
    },
    onMacroOverlayRequest: async (webContents, request) => {
      const activeRoleId = browserManager?.getRoleIdForWebContents(webContents.id);
      if (request.type === "game-input-context") {
        browserManager?.setGameInputContext(webContents.id, request.active);
      }
      return macroOverlayInjector.handleEmbeddedRequest(webContents, activeRoleId, request);
    },
    onOverlayLanguageChanged: (language) => {
      macroOverlayInjector.setLanguage(language);
      browserManager?.setRuntimeTabsLanguage(language);
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
    workspaceLauncher
  });
  const notifyWorkspaceDisplaysChanged = (): void => {
    const displays = getWorkspaceDisplayInfos();
    broadcastWorkspaceDisplaysChanged(displays);
    appQuickMenu?.scheduleRefresh();
    void withDataMutation(() => workspaceStore.reconcileTargetDisplays(displays))
      .then(() => appQuickMenu?.scheduleRefresh())
      .catch((error) => console.error("Failed to reconcile workspace target displays.", error));
  };
  screen.on("display-added", notifyWorkspaceDisplaysChanged);
  screen.on("display-removed", (_event, removedDisplay) => {
    const studioDisplay = getMainWindowDisplay();
    const fallbackDisplay = studioDisplay.id === removedDisplay.id
      ? screen.getPrimaryDisplay()
      : studioDisplay;
    browserManager?.handleDisplayRemoved(removedDisplay.id, fallbackDisplay.id);
    notifyWorkspaceDisplaysChanged();
  });
  screen.on("display-metrics-changed", (_event, display) => {
    browserManager?.handleDisplayMetricsChanged(display.id, display.workArea);
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
      browserManager,
      authManager,
      canUseApp: () => legalAcceptanceStore.isAccepted(),
      includeQuit: process.platform === "win32",
      onWorkspaceDisplaySelectionRequired: requestWorkspaceDisplaySelection,
      openApp: showMainWindow,
      ...(process.platform === "win32" ? { quitApp: () => app.quit() } : {}),
      setMenu: setQuickMenu
    });
    browserManager.on("change", () => {
      appQuickMenu?.scheduleRefresh();
    });
    browserManager.on("runtimeChange", () => {
      appQuickMenu?.scheduleRefresh();
    });
    authManager.on("change", () => {
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
  await loggingReady;
  const loadingWindow = createStartupWindow();

  try {
    const startupShown = await showStartupWindow(loadingWindow, getStartupPageOptions());
    if (!startupShown || loadingWindow.isDestroyed()) {
      return;
    }

    if (initializationFailed) {
      await showStartupFailure(loadingWindow);
      return;
    }

    if (!appInitialized) {
      try {
        await initializeApplication();
        appInitialized = true;
      } catch (error) {
        initializationFailed = true;
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
      await showStartupFailure(loadingWindow).catch((failureError) => {
        logService.error("main", "startup_failure_page_failed", "Failed to show the startup failure page.", failureError);
      });
    }
  }
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

  quitCleanupPromise = (async () => {
    const manager = browserManager;

    try {
      await manager?.stopAll();
    } catch (error) {
      logService.error("browser", "quit_stop_sessions_failed", "Failed to stop all browser sessions while quitting.", error);
    } finally {
      embeddedRuntimeDiagnostics?.stop();
      embeddedRuntimeDiagnostics = null;
      logService.info("main", "app_quitting", "Application is quitting.");
      await Promise.race([logService.flush(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      isApplicationQuitting = true;
      app.quit();
      isApplicationQuitting = false;
      quitCleanupPromise = null;
    }
  })();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
