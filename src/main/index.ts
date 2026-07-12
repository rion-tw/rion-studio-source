import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, nativeImage, nativeTheme, screen, shell } from "electron";

import { AuthManager } from "./auth/AuthManager";
import { AuthSessionChecker } from "./auth/AuthSessionChecker";
import { MacHiddenBrowserHost } from "./browser/MacHiddenBrowserHost";
import { BrowserManager } from "./browser/BrowserManager";
import { BrowserUserDataLockWatcher } from "./browser/BrowserUserDataLockWatcher";
import { MacDockRoleMenu } from "./dock/MacDockRoleMenu";
import { registerIpcHandlers } from "./ipc/registerHandlers";
import { MacroManager } from "./macros/MacroManager";
import { MacroOverlayInjector } from "./macros/MacroOverlayInjector";
import { MacroStore } from "./macros/MacroStore";
import { RoleStore } from "./roles/RoleStore";
import { SystemChromeLauncher } from "./system-browser/SystemChromeLauncher";
import { AppUpdateManager } from "./updates/AppUpdateManager";
import { LaunchWorkspaceStore } from "./workspaces/LaunchWorkspaceStore";
import { IPC_CHANNELS } from "../shared/ipc";
import type { MacroEditorRequest } from "../shared/types";

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "false";

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let dockRoleMenu: MacDockRoleMenu | null = null;
let pendingMacroEditorRequest: MacroEditorRequest | null = null;

function getAppIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.png");
  }

  return join(__dirname, "../../build/icon.png");
}

function getAppIcnsPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "icon.icns");
  }

  return join(__dirname, "../../build/icon.icns");
}

function loadAppIcon() {
  const iconPath = getAppIconPath();

  if (!existsSync(iconPath)) {
    return undefined;
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

function createWindow(): void {
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

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "Rion Studio",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111111" : "#f7f7f7",
    ...(appIcon ? { icon: appIcon } : {}),
    ...macWindowOptions,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Failed to load preload script: ${preloadPath}`, error);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }

  if (!mainWindow) {
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

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.macrosEditorRequested, request);
}

function consumePendingMacroEditorRequest(): MacroEditorRequest | null {
  const request = pendingMacroEditorRequest;
  pendingMacroEditorRequest = null;
  return request;
}

app.whenReady().then(() => {
  const userDataDir = app.getPath("userData");
  const roleStore = new RoleStore(userDataDir);
  const workspaceStore = new LaunchWorkspaceStore(userDataDir);
  const macroStore = new MacroStore(userDataDir);
  const updateManager = new AppUpdateManager({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    manualUpdateRepository:
      process.env.RION_STUDIO_RELEASE_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? "rion-studio/rion-studio",
    openExternal: (url) => shell.openExternal(url)
  });
  const hiddenBrowserHost = new MacHiddenBrowserHost(userDataDir, {
    appIconPath: getAppIcnsPath()
  });
  browserManager = new BrowserManager(roleStore, {
    executablePathResolver: () => hiddenBrowserHost.resolveExecutablePath(),
    allowVisibleFallback: process.platform !== "darwin"
  });
  const macroManager = new MacroManager(browserManager, macroStore);
  const macroOverlayInjector = new MacroOverlayInjector(macroStore, macroManager, requestMacroEditorFromOverlay);
  browserManager.setMacroOverlayInstaller((role, page) => macroOverlayInjector.install(role, page));
  macroManager.on("change", () => {
    macroOverlayInjector.refreshInstalledOverlays();
  });
  const authManager = new AuthManager(
    roleStore,
    browserManager,
    new SystemChromeLauncher(roleStore),
    new AuthSessionChecker(roleStore),
    new BrowserUserDataLockWatcher()
  );

  registerIpcHandlers(roleStore, workspaceStore, browserManager, authManager, {
    getLaunchWorkArea: () => getMainWindowDisplayWorkArea(),
    consumePendingMacroEditorRequest,
    macroManager,
    macroStore,
    updateManager,
    onMacrosChanged: () => {
      macroOverlayInjector.refreshInstalledOverlays();
    },
    onOverlayLanguageChanged: (language) => {
      macroOverlayInjector.setLanguage(language);
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

  createWindow();
  void updateManager.checkForUpdates();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
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
