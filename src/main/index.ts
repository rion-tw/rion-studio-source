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
  screen,
  session as electronSession,
  shell,
  WebContentsView
} from "electron";

import { ExternalChromeManager } from "./browser/ExternalChromeManager";
import { createExternalChromeWindowBoundsAdapter } from "./browser/WindowsExternalChromeWindowBoundsAdapter";
import { AuthManager } from "./auth/AuthManager";
import {
  BrowserManager,
  createRoleSessionPartition,
  GAME_DIVIDER_POINTER_CHANNEL
} from "./browser/BrowserManager";
import { MacDockRoleMenu } from "./dock/MacDockRoleMenu";
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
import { broadcastWorkspaceDisplaysChanged, registerIpcHandlers } from "./ipc/registerHandlers";
import { LegalAcceptanceStore } from "./legal/LegalAcceptanceStore";
import { MacroManager } from "./macros/MacroManager";
import { MacroOverlayInjector } from "./macros/MacroOverlayInjector";
import { MacroStore } from "./macros/MacroStore";
import { PortableDataManager } from "./portable/PortableDataManager";
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
import { createWorkspaceDisplayInfos } from "./workspaces/workspaceDisplays";
import { IPC_CHANNELS } from "../shared/ipc";
import { normalizeGameBrowserSettings } from "../shared/browserFonts";
import type { MacroEditorRequest } from "../shared/types";

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
let dockRoleMenu: MacDockRoleMenu | null = null;
let pendingMacroEditorRequest: MacroEditorRequest | null = null;
let appInitialized = false;
let initializationFailed = false;
let mainWindowReady = false;
let startupPromise: Promise<void> | null = null;
const rendererReadyGate = new RendererReadyGate();
const RENDERER_READY_TIMEOUT_MS = 15_000;

function getAppIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }

  return join(__dirname, "../../build/icon.png");
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

function requestMacroEditorFromOverlay(request: MacroEditorRequest): void {
  pendingMacroEditorRequest = request;
  showMainWindow();

  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowReady) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.macrosEditorRequested, request);
}

function consumePendingMacroEditorRequest(): MacroEditorRequest | null {
  const request = pendingMacroEditorRequest;
  pendingMacroEditorRequest = null;
  return request;
}

async function initializeApplication(): Promise<void> {
  const userDataDir = app.getPath("userData");
  const roleStore = new RoleStore(userDataDir);
  const gameStore = new GameStore(userDataDir, roleStore);
  await gameStore.initialize();
  const workspaceStore = new LaunchWorkspaceStore(userDataDir);
  const macroStore = new MacroStore(userDataDir);
  const legalAcceptanceStore = new LegalAcceptanceStore(userDataDir);
  const gameBrowserSettingsStore = new GameBrowserSettingsStore(userDataDir);
  const browserFontApplier = new BrowserFontApplier({
    appUserDataDir: userDataDir,
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const browserProxyApplier = new BrowserProxyApplier({
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const cdnCompatibilityManager = new CdnCompatibilityManager({
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const systemFontService = new SystemFontService();
  const gameCompatibilityStore = new GameCompatibilityStore(userDataDir);
  const portableDataManager = new PortableDataManager({
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
    workspaceStore
  });
  const updateManager = new AppUpdateManager({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    manualUpdateRepository:
      process.env.RION_STUDIO_RELEASE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? DEFAULT_UPDATE_REPOSITORY,
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
  const externalChromeManager = new ExternalChromeManager(roleStore, {
    applyBrowserFonts: async (_role, browserUserDataDir) => {
      await browserFontApplier.applyToChromeUserDataDir(browserUserDataDir);
    },
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
  browserManager = new BrowserManager(roleStore, {
    applyBrowserFonts: async (role, partition) => {
      const browserUserDataDir = await roleStore.ensureBrowserUserDataDir(role.id);
      await browserFontApplier.applyToRoleLaunch(browserUserDataDir, partition);
    },
    applyBrowserProxy: (_role, _partition, session) => browserProxyApplier.applyToSession(session),
    applyCdnCompatibility: async (_role, _partition, session) => {
      await cdnCompatibilityManager.applyToSession(session);
    },
    createHostWindow: (options) => new BaseWindow(options),
    createView: (options) => new WebContentsView(options),
    dividerPreloadPath: join(__dirname, "../preload/divider.cjs"),
    embeddedPreloadPath: join(__dirname, "../preload/embedded.cjs"),
    externalChromeManager,
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
    getWorkspaceAppearanceSettings: async () =>
      (await gameBrowserSettingsStore.getSettings()).workspace,
    prefersReducedTransparency: () => nativeTheme.prefersReducedTransparency
  });
  ipcMain.on(GAME_DIVIDER_POINTER_CHANNEL, (event, payload) => {
    browserManager?.handleDividerPointer(event.sender.id, payload);
  });
  const macroManager = new MacroManager(browserManager, macroStore);
  browserManager.setBeforeRolesStop(async (roleIds) => {
    await Promise.all(roleIds.map((roleId) => macroManager.stopRole(roleId)));
  });
  const macroOverlayInjector = new MacroOverlayInjector(macroStore, macroManager, requestMacroEditorFromOverlay);
  browserManager.setMacroOverlayInstaller((role, page) => macroOverlayInjector.install(role, page));
  browserManager.setExternalMacroOverlayInstaller((role, target) => macroOverlayInjector.installExternal(role, target));
  macroManager.on("change", () => {
    macroOverlayInjector.refreshInstalledOverlays();
  });
  const authManager = new AuthManager(roleStore, browserManager);
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

  registerIpcHandlers(roleStore, workspaceStore, browserManager, authManager, {
    consumePendingMacroEditorRequest,
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
    onMacrosChanged: () => {
      macroOverlayInjector.refreshInstalledOverlays();
    },
    onLegalAccepted: () => {
      startUpdateCheck();
      dockRoleMenu?.scheduleRefresh();
    },
    onMacroOverlayRequest: async (webContentsId, request) => {
      const roleId = browserManager?.getRoleIdForWebContents(webContentsId);
      if (!roleId) {
        throw new Error("Embedded game view is not associated with a role.");
      }

      return macroOverlayInjector.handleRequest(roleId, request);
    },
    onOverlayLanguageChanged: (language) => {
      macroOverlayInjector.setLanguage(language);
    },
    onRendererReady: (senderId, state) => {
      rendererReadyGate.notify(senderId, state);
    },
    onRolesChanged: () => {
      dockRoleMenu?.scheduleRefresh();
    },
    quitApplication: () => app.quit(),
    restartApplication: () => {
      app.relaunch();
      app.exit(0);
    }
  });
  const notifyWorkspaceDisplaysChanged = (): void => {
    broadcastWorkspaceDisplaysChanged(getWorkspaceDisplayInfos());
  };
  screen.on("display-added", notifyWorkspaceDisplaysChanged);
  screen.on("display-removed", notifyWorkspaceDisplaysChanged);
  screen.on("display-metrics-changed", notifyWorkspaceDisplaysChanged);

  const appIcon = loadAppIcon();
  if (process.platform === "darwin" && app.dock) {
    if (appIcon) {
      app.dock.setIcon(appIcon);
    }

    dockRoleMenu = new MacDockRoleMenu({
      roleStore,
      browserManager,
      authManager,
      canUseApp: () => legalAcceptanceStore.isAccepted(),
      dock: app.dock,
      openApp: showMainWindow
    });
    browserManager.on("change", () => {
      dockRoleMenu?.scheduleRefresh();
    });
    authManager.on("change", () => {
      dockRoleMenu?.scheduleRefresh();
    });
    dockRoleMenu.scheduleRefresh();
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
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
  }

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

app.on("before-quit", async (event) => {
  if (!browserManager) {
    return;
  }

  event.preventDefault();
  const manager = browserManager;
  browserManager = null;
  await manager.stopAll();
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
