import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, WebContentsView } from "electron";

import { AuthManager } from "./auth/AuthManager";
import { BrowserManager, GAME_DIVIDER_POINTER_CHANNEL } from "./browser/BrowserManager";
import { MacDockRoleMenu } from "./dock/MacDockRoleMenu";
import { BrowserFontApplier } from "./game-browser/BrowserFontApplier";
import { GameBrowserSettingsStore } from "./game-browser/GameBrowserSettingsStore";
import { SystemFontService } from "./game-browser/SystemFontService";
import { registerIpcHandlers } from "./ipc/registerHandlers";
import { MacroManager } from "./macros/MacroManager";
import { MacroOverlayInjector } from "./macros/MacroOverlayInjector";
import { MacroStore } from "./macros/MacroStore";
import { PortableDataManager } from "./portable/PortableDataManager";
import { RoleStore } from "./roles/RoleStore";
import {
  createStartupPageUrl,
  loadRendererPage,
  loadWindowAndReveal,
  RendererReadyGate,
  RendererReadyTimeoutError,
  showStartupWindow,
  swapPreparedWindows,
  waitForPreparedRenderer,
  type StartupPageState
} from "./startup/startupWindow";
import { AppUpdateManager } from "./updates/AppUpdateManager";
import { LaunchWorkspaceStore } from "./workspaces/LaunchWorkspaceStore";
import { IPC_CHANNELS } from "../shared/ipc";
import type { MacroEditorRequest } from "../shared/types";

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "false";

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
  bounds,
  kind
}: {
  bounds?: Electron.Rectangle;
  kind: "renderer" | "startup";
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
      ...(kind === "renderer" ? { preload: join(__dirname, "../preload/index.cjs") } : {}),
      backgroundThrottling: kind !== "renderer",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  if (kind === "renderer") {
    window.webContents.on("preload-error", (_event, preloadPath, error) => {
      console.error(`Failed to load preload script: ${preloadPath}`, error);
    });
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

function createStartupWindow(): BrowserWindow {
  const window = createWindow({ kind: "startup" });
  startupWindow = window;

  window.on("closed", () => {
    if (startupWindow === window) {
      startupWindow = null;
    }
  });

  return window;
}

function createRendererWindow(bounds: Electron.Rectangle): BrowserWindow {
  const window = createWindow({ bounds, kind: "renderer" });
  const webContentsId = window.webContents.id;
  mainWindow = window;
  mainWindowReady = false;

  window.on("closed", () => {
    rendererReadyGate.cancel(webContentsId);
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

function initializeApplication(): void {
  const userDataDir = app.getPath("userData");
  const roleStore = new RoleStore(userDataDir);
  const workspaceStore = new LaunchWorkspaceStore(userDataDir);
  const macroStore = new MacroStore(userDataDir);
  const gameBrowserSettingsStore = new GameBrowserSettingsStore(userDataDir);
  const browserFontApplier = new BrowserFontApplier({
    appUserDataDir: userDataDir,
    getSettings: () => gameBrowserSettingsStore.getSettings()
  });
  const systemFontService = new SystemFontService();
  const portableDataManager = new PortableDataManager({
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
      process.env.RION_STUDIO_RELEASE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "rion-studio/rion-studio",
    openExternal: (url) => shell.openExternal(url)
  });
  browserManager = new BrowserManager(roleStore, {
    applyBrowserFonts: async (role, partition) => {
      const browserUserDataDir = await roleStore.ensureBrowserUserDataDir(role.id);
      await browserFontApplier.applyToRoleLaunch(browserUserDataDir, partition);
    },
    createHostWindow: (options) => new BrowserWindow(options),
    createView: (options) => new WebContentsView(options),
    dividerPreloadPath: join(__dirname, "../preload/divider.cjs"),
    embeddedPreloadPath: join(__dirname, "../preload/embedded.cjs"),
    getLaunchWorkArea: () => getMainWindowDisplayWorkArea()
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
  macroManager.on("change", () => {
    macroOverlayInjector.refreshInstalledOverlays();
  });
  const authManager = new AuthManager(roleStore, browserManager);

  registerIpcHandlers(roleStore, workspaceStore, browserManager, authManager, {
    consumePendingMacroEditorRequest,
    gameBrowserSettingsStore,
    macroManager,
    macroStore,
    portableDataManager,
    systemFontService,
    updateManager,
    onMacrosChanged: () => {
      macroOverlayInjector.refreshInstalledOverlays();
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
    }
  });

  const appIcon = loadAppIcon();
  if (process.platform === "darwin" && app.dock) {
    if (appIcon) {
      app.dock.setIcon(appIcon);
    }

    dockRoleMenu = new MacDockRoleMenu({
      roleStore,
      browserManager,
      authManager,
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

  void updateManager.checkForUpdates();
}

async function prepareRendererWindow(loadingWindow: BrowserWindow): Promise<void> {
  const rendererWindow = createRendererWindow(loadingWindow.getBounds());
  const webContentsId = rendererWindow.webContents.id;
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
      rendererWindow.webContents.removeListener("preload-error", onPreloadError);
    };
    rendererWindow.webContents.once("preload-error", onPreloadError);
  });
  const cancelForClosedStartup = (): void => {
    if (mainWindowReady) {
      return;
    }

    rendererReadyGate.cancel(webContentsId);
    if (!rendererWindow.isDestroyed()) {
      rendererWindow.destroy();
    }
  };

  loadingWindow.once("closed", cancelForClosedStartup);

  try {
    const rendererState = await Promise.race([
      waitForPreparedRenderer(
        rendererWindow,
        () => loadMainRenderer(rendererWindow),
        rendererReadyGate.wait(webContentsId, RENDERER_READY_TIMEOUT_MS)
      ),
      preloadFailurePromise,
      preparationTimeoutPromise
    ]);

    if (!rendererState || loadingWindow.isDestroyed() || rendererWindow.isDestroyed()) {
      return;
    }

    mainWindowReady = true;
    rendererWindow.webContents.setBackgroundThrottling(true);
    if (!swapPreparedWindows(loadingWindow, rendererWindow)) {
      mainWindowReady = false;
      throw new Error("Prepared renderer window could not replace the startup window.");
    }
  } catch (error) {
    mainWindowReady = false;
    rendererReadyGate.cancel(webContentsId);
    if (!rendererWindow.isDestroyed()) {
      rendererWindow.destroy();
    }
    throw error;
  } finally {
    if (preparationTimeout) {
      clearTimeout(preparationTimeout);
    }
    removePreloadErrorListener();
    loadingWindow.removeListener("closed", cancelForClosedStartup);
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
        initializeApplication();
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

function getMainWindowDisplayWorkArea(): Electron.Rectangle {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return screen.getPrimaryDisplay().workArea;
  }

  return screen.getDisplayMatching(mainWindow.getBounds()).workArea;
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
