import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  app,
  BaseWindow,
  BrowserWindow,
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

import { ExternalChromeManager } from "./browser/ExternalChromeManager";
import { ChromeZoomPreferenceApplier } from "./browser/ChromeZoomPreferenceApplier";
import { SystemPressureMonitor } from "./browser/SystemPressureMonitor";
import { createExternalChromeWindowBoundsAdapter } from "./browser/WindowsExternalChromeWindowBoundsAdapter";
import { createRuntimeTabsPageUrl } from "./browser/runtimeTabsPage";
import { AuthManager } from "./auth/AuthManager";
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
import {
  broadcastMacrosChanged,
  broadcastWorkspaceDisplaysChanged,
  registerIpcHandlers
} from "./ipc/registerHandlers";
import { LegalAcceptanceStore } from "./legal/LegalAcceptanceStore";
import { MacroManager } from "./macros/MacroManager";
import { MacroOverlayInjector } from "./macros/MacroOverlayInjector";
import { MacroStore } from "./macros/MacroStore";
import {
  PortableDataManager,
  recoverPortableImportTransaction
} from "./portable/PortableDataManager";
import { SerialTaskQueue } from "./persistence/SerialTaskQueue";
import { runBackgroundActivityMigration } from "./persistence/BackgroundActivityMigration";
import { RoleStore } from "./roles/RoleStore";
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
import { RuntimeWindowPreferencesStore } from "./window/RuntimeWindowPreferencesStore";
import { IPC_CHANNELS } from "../shared/ipc";
import { normalizeGameBrowserSettings } from "../shared/browserFonts";
import {
  RUNTIME_TABS_ACTION_CHANNEL,
  isRuntimeTabAction
} from "../shared/runtimeTabs";
import type { MacroPageRequest, PendingWorkspaceLaunchRequest } from "../shared/types";

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
let appQuickMenu: AppQuickMenu | null = null;
let applicationMenu: ApplicationMenuController | null = null;
let windowsTray: Tray | null = null;
let pendingMacroPageRequest: MacroPageRequest | null = null;
let pendingWorkspaceLaunchRequest: PendingWorkspaceLaunchRequest | null = null;
let appInitialized = false;
let initializationFailed = false;
let mainWindowReady = false;
let startupPromise: Promise<void> | null = null;
let isApplicationQuitting = false;
let quitCleanupPromise: Promise<void> | null = null;
const rendererReadyGate = new RendererReadyGate();
const RENDERER_READY_TIMEOUT_MS = 15_000;

function getAppIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }

  return join(__dirname, "../../build/icon.png");
}

function getWindowsTrayIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.ico");
  }

  return join(__dirname, "../../build/icon.ico");
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

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Failed to load preload script: ${preloadPath}`, error);
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
  const transactionalRoleAuthStore: Pick<RoleStore, "updateAuthState"> = {
    updateAuthState: (id, authState, messageTimestamp) =>
      withDataMutation(() => roleStore.updateAuthState(id, authState, messageTimestamp))
  };
  const gameStore = new GameStore(userDataDir, roleStore);
  await gameStore.initialize();
  await runBackgroundActivityMigration(userDataDir, { gameStore, roleStore });
  const workspaceStore = new LaunchWorkspaceStore(userDataDir);
  const macroStore = new MacroStore(userDataDir);
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
    ...(externalChromeWindowBoundsAdapter
      ? { windowBoundsAdapter: externalChromeWindowBoundsAdapter }
      : {})
  });
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
    getLaunchWorkArea: () => getMainWindowDisplayWorkArea(),
    getCursorScreenPoint: () => screen.getCursorScreenPoint(),
    getDefaultLaunchTarget: () => {
      const display = getMainWindowDisplay();
      return { displayId: display.id, workArea: display.workArea };
    },
    getWorkspaceDisplays: () => getWorkspaceDisplayInfos(),
    getWorkspaceAppearanceSettings: async () =>
      (await gameBrowserSettingsStore.getSettings()).workspace,
    prefersReducedTransparency: () => nativeTheme.prefersReducedTransparency
  });
  browserManager.setAlwaysShowToolbarInFullScreen(
    runtimeWindowPreferences.alwaysShowToolbarInFullScreen
  );
  ipcMain.on(GAME_DIVIDER_POINTER_CHANNEL, (event, payload) => {
    browserManager?.handleDividerPointer(event.sender.id, payload);
  });
  const macroManager = new MacroManager(browserManager, macroStore);
  const portableDataManager = new PortableDataManager({
    gameBrowserSettingsStore,
    gameStore,
    getAppVersion: () => app.getVersion(),
    macroStore,
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
  const macroOverlayInjector = new MacroOverlayInjector(
    macroStore,
    macroManager,
    requestMacroPageFromOverlay,
    (roleId) => browserManager?.listStatuses().find((status) => status.roleId === roleId)
  );
  browserManager.setMacroOverlayInstaller((role, page) => macroOverlayInjector.install(role, page));
  browserManager.setExternalMacroOverlayInstaller((role, target) => macroOverlayInjector.installExternal(role, target));
  macroManager.on("change", () => {
    macroOverlayInjector.refreshInstalledOverlays();
  });
  browserManager.on("change", () => {
    macroOverlayInjector.refreshInstalledOverlays();
  });
  const authManager = new AuthManager(transactionalRoleAuthStore, browserManager);
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

  const runtimeTabMenu = new RuntimeTabMenuController({
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
    }
  });
  applicationMenu.install();

  ipcMain.on(RUNTIME_TABS_ACTION_CHANNEL, (event, action: unknown) => {
    if (!browserManager || !isRuntimeTabAction(action)) return;
    const displayId = browserManager.getRuntimeDisplayIdForWebContents(event.sender.id);
    if (displayId === undefined) return;
    const runtimeWindow = BrowserWindow.fromWebContents(event.sender);
    if (!runtimeWindow || runtimeWindow.isDestroyed()) return;
    if ("tabId" in action) {
      const actionTab = browserManager.listEmbeddedRuntimeState().tabs.find(
        (tab) => tab.id === action.tabId
      );
      if (!actionTab) return;
      const isAuthorizedMove = action.type === "move" &&
        (actionTab.displayId === displayId || action.displayId === displayId);
      if (actionTab.displayId !== displayId && !isAuthorizedMove) return;
    }

    switch (action.type) {
      case "activate":
        void browserManager.showRuntimeTab(action.tabId).catch((error) => {
          console.error("Failed to activate runtime tab.", error);
        });
        break;
      case "hide":
        void browserManager.hideRuntimeTab(action.tabId).catch((error) => {
          console.error("Failed to hide runtime tab.", error);
        });
        break;
      case "stop":
        void browserManager.stopRuntimeTab(action.tabId).catch((error) => {
          console.error("Failed to stop runtime tab.", error);
        });
        break;
      case "move":
        void browserManager.moveRuntimeTab(action.tabId, action.displayId).catch((error) => {
          console.error("Failed to move runtime tab.", error);
        });
        break;
      case "reorder":
        browserManager.reorderRuntimeTab(action.tabId, action.beforeTabId);
        break;
      case "openLauncher":
        void runtimeTabMenu.openLauncher(runtimeWindow, displayId).catch((error) => {
          console.error("Failed to open the runtime launcher menu.", error);
        });
        break;
      case "openTabMenu":
        runtimeTabMenu.openTabMenu(runtimeWindow, displayId, action.tabId);
        break;
      case "fullscreenToolbarEnter":
        browserManager.handleRuntimeToolbarPointer(displayId, true);
        break;
      case "fullscreenToolbarLeave":
        browserManager.handleRuntimeToolbarPointer(displayId, false);
        break;
      case "reportNativeTitlebarHeight":
        browserManager.reportRuntimeNativeTitlebarHeight(displayId, action.height);
        break;
    }
  });

  registerIpcHandlers(roleStore, workspaceStore, browserManager, authManager, {
    consumePendingMacroPageRequest,
    consumePendingWorkspaceLaunchRequest,
    gameCompatibilityManager,
    gameStore,
    gameBrowserSettingsStore,
    legalAcceptanceStore,
    getDefaultWorkspaceDisplayId: () => getMainWindowDisplay().id,
    getWorkspaceDisplays: () => getWorkspaceDisplayInfos(),
    getGraphicsDiagnostics: (sender) => graphicsDiagnosticsService.collect(sender),
    macroManager,
    macroStore,
    portableDataManager,
    systemFontService,
    updateManager,
    withDataMutation,
    onMacrosChanged: () => {
      macroOverlayInjector.refreshInstalledOverlays();
      void macroStore.listMacros().then(broadcastMacrosChanged);
    },
    onLegalAccepted: () => {
      startUpdateCheck();
      appQuickMenu?.scheduleRefresh();
    },
    onMacroOverlayRequest: async (webContents, request) => {
      const activeRoleId = browserManager?.getRoleIdForWebContents(webContents.id);
      return macroOverlayInjector.handleEmbeddedRequest(webContents, activeRoleId, request);
    },
    onOverlayLanguageChanged: (language) => {
      macroOverlayInjector.setLanguage(language);
      browserManager?.setRuntimeTabsLanguage(language);
      runtimeTabMenu.setLanguage(language);
      applicationMenu?.setLanguage(language);
    },
    onRendererReady: (senderId, state) => {
      rendererReadyGate.notify(senderId, state);
    },
    onRolesChanged: () => {
      appQuickMenu?.scheduleRefresh();
    },
    onWorkspacesChanged: () => {
      appQuickMenu?.scheduleRefresh();
    },
    quitApplication: () => app.quit(),
    restartApplication: () => {
      app.relaunch();
      app.exit(0);
    },
    workspaceLauncher
  });
  const notifyWorkspaceDisplaysChanged = (): void => {
    broadcastWorkspaceDisplaysChanged(getWorkspaceDisplayInfos());
    appQuickMenu?.scheduleRefresh();
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
    console.error("Rion Studio startup failed.", error);

    if (!loadingWindow.isDestroyed()) {
      await showStartupFailure(loadingWindow).catch((failureError) => {
        console.error("Failed to show the startup failure page.", failureError);
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

app.whenReady().then(() => {
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
      console.error("Failed to stop all browser sessions while quitting.", error);
    } finally {
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
