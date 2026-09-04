import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  powerMonitor,
  screen,
  session,
  shell,
  WebContentsView
} from "electron";

import type { CoreAppSnapshotRecord } from "../../shared/generated";
import type { RendererLogEvent } from "../../shared/types";
import { CoreAddonClient, type RawNodeApiCoreFactory } from
  "../core/coreAddonClient";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import { createElectronBaselineDispatcher } from "./baselineDispatcher";
import { enforceChromiumCommandLinePolicy } from "./chromiumCommandLinePolicy";
import { ElectronBrowserPerformanceDiagnosticsController } from "./electronBrowserPerformanceDiagnosticsController";
import {
  ElectronApplicationShortcutController,
  type ElectronShortcutMainWindowPort
} from "./electronApplicationShortcutController";
import { ElectronFocusedApplicationShortcutController } from "./electronFocusedApplicationShortcutController";
import { createElectronDiagnosticsComposition } from "./electronDiagnosticsComposition";
import { resolveElectronNewGameWindowTarget } from "./electronNewGameWindowTarget";
import { projectCoreAppSnapshot } from "./appSnapshotProjection";
import { ElectronApplicationLifecycleController } from "./applicationLifecycleController";
import { ChromiumRuntimeLaunchCoordinator } from "./chromiumRuntimeLaunchCoordinator";
import { ChromiumRuntimeLaunchCompletionCoordinator } from "./chromiumRuntimeLaunchCompletionCoordinator";
import { ChromiumRuntimeRestoreSessionCoordinator } from "./chromiumRuntimeRestoreSessionCoordinator";
import { WORKSPACE_WEB_CHROME_SHELL_SESSION } from "../../shared/workspaceWebChrome";
import { RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION } from
  "../../shared/runtimeRolePlaceholder";
import {
  ChromiumRuntimeBootstrap,
  MACOS_APPKIT_CHROMIUM_CAPABILITIES,
  type MacosAppKitRuntimeBootstrapAdapter,
  withElectronChromiumRuntimeContract
} from "./chromiumRuntimeBootstrap";
import { createCoreOwnedChromiumRuntimeActions } from
  "./chromiumRuntimeActionsFactory";
import type {
  ChromiumRuntimeFullscreenFocusAdmission,
  ChromiumRuntimeNativeTabAction
} from "./chromiumRuntimeNativeWindowController";
import {
  installMacosRuntimeWindowPreferencesMenu,
  type MacosRuntimeWindowPreferencesMenuHandle
} from "./macosRuntimeWindowPreferencesMenu";
import type {
  ChromiumRoleWebContentsViewPort
} from "./chromiumRoleSurfacePorts";
import type {
  WindowsRuntimeForegroundProbePort,
  WindowsRuntimeHostWindowPort,
  WindowsRuntimeShortcutOwnerDiagnostic,
  WindowsRuntimeShortcutOwnerDiagnosticPort,
  WindowsRuntimeShortcutOwnerPort
} from "./chromiumRuntimeHostFactory";
import type {
  RawWindowsChromiumTrustedInputAddon,
  WindowsChromiumInputBaseWindowPort
} from "./windowsChromiumInputSurfaceAttachmentCoordinator";
import { MacosAppKitChromiumRuntimeHostFactory,
  RION_APPKIT_RUNTIME_ABI_VERSION, type RawAppKitRuntimeAddon } from
  "./macosAppKitRuntimeHostFactory";
import { MacosAppKitRuntimeEventBridge } from "./macosAppKitRuntimeEventBridge";
import { executeControlledRuntimeTabReload } from
  "./controlledRuntimeTabReload";
import {
  MacosAppKitRuntimeTabMenuController,
  type MacosAppKitRuntimeTabMenuOpenRequest
} from "./macosAppKitRuntimeTabMenu";
import {
  macosRuntimeTabMenuLanguage,
  macosRuntimeTabMenuTemplate
} from "./macosRuntimeTabMenuTemplate";
import { MacosAppKitInputSurfaceAttachmentCoordinator } from
  "./macosAppKitInputSurfaceAttachmentCoordinator";
import {
  isRawNativeAppKitTrustedInputHost,
  MacosAppKitTrustedInputAdapter
} from "./macosAppKitTrustedInputAdapter";
import { ChromiumTrustedInputCoordinator } from
  "./chromiumTrustedInputCoordinator";
import { CoreRendererEventBridge } from "./coreRendererEventBridge";
import { createElectronCoreApiDispatcher } from "./coreApiDispatcher";
import { createChromiumRoleFontApiDispatcher } from
  "./chromiumRoleFontApiDispatcher";
import { ElectronDisplayTopologyController } from
  "./electronDisplayTopologyController";
import { preserveWebDriverUserDataDirectory } from "./electronUserDataPolicy";
import { ElectronMainLifecycle, type ElectronAppLifecyclePort } from "./lifecycle";
import { prepareElectronCleanExit, terminateAfterCleanExitFailure } from "./cleanExitCoordinator";
import {
  registerRionIpcBridge,
  type RionIpcBridgeRegistration
} from "./registerIpcBridge";
import {
  RendererIdentityRegistry,
  type RendererIdentity
} from "./rendererIdentity";
import { ElectronMainRendererQuitHandshake } from
  "./mainRendererQuitHandshake";
import {
  handoffElectronStartupQuitFence,
  installElectronStartupQuitFence,
  type ElectronStartupQuitFence
} from "./electronStartupQuitFence";
import { applyElectronMainWindowClosePolicy } from
  "./mainWindowClosePolicy";
import { ElectronWindowsSessionEndCoordinator } from
  "./windowsSessionEndCoordinator";
import { installWindowsApplicationMenu } from "./windowsApplicationMenu";
import { installMacosApplicationMenu } from "./macosApplicationMenu";
import {
  buildMainRendererWebPreferences,
  installMainRendererContentSecurityPolicy
} from "./security";
import { ElectronWindowStateController } from "./windowStateController";
import { buildMainWindowOptions } from "./windowOptions";
import { ElectronFatalEventStreamRouter, ElectronFatalTerminationCoordinator } from
  "./fatalStartupShutdown";
import { ElectronOverlayShellEffects } from "./electronOverlayShellEffects";
import { ElectronNativeShellActions } from "./electronNativeShellActions";
import {
  ElectronChromiumUpdater,
  MACOS_UPDATE_RECOVERY_SWITCH,
  MACOS_UPDATE_RELAUNCH_HELPER_SWITCH,
  parseMacosUpdaterRecoveryArguments,
  parseMacosUpdaterRelaunchArguments,
  runMacosUpdaterRelaunchHelper,
  verifyMacosUpdaterRecoveryLocator,
  type RawChromiumUpdaterFactory
} from "./electronChromiumUpdater";
import { createElectronUpdaterDispatcher } from "./electronUpdaterDispatcher";
import {
  installChromiumCertificatePolicy,
  installChromiumSessionSecurityPolicy
} from "./chromiumSecurityPolicy";
import {
  runChromeProfileImportHelperProcess,
  type ChromeProfileImportHelperProcessPort
} from "./chromeProfileImportHelperProcess";
import { isChromeProfileImportHelperInvocation } from
  "./chromeProfileImportHelperMode";
import { runElectronReadyPhase } from "./electronReadyGate";

interface NativeAppCoreOptions {
  userDataDir: string;
  platform: "darwin" | "win32";
  appVersion: string;
  buildCommit?: string;
  packaged?: boolean;
  runtimeContractVersion?: number;
  performanceTelemetryPath?: string;
  startupBackupLabel?: string;
}

interface LoadedRionNodeAddon
  extends RawNodeApiCoreFactory<NativeAppCoreOptions>, RawAppKitRuntimeAddon,
    RawChromiumUpdaterFactory, RawWindowsChromiumTrustedInputAddon,
    WindowsRuntimeForegroundProbePort, WindowsRuntimeShortcutOwnerPort,
    WindowsRuntimeShortcutOwnerDiagnosticPort {}

const APP_NAME = "Rion Studio";
const requireNativeModule = createRequire(import.meta.url);
let core: CoreAddonClient | null = null;
let lifecycle: ElectronMainLifecycle | null = null;
let mainWindow: BrowserWindow | null = null;
let mainIdentity: RendererIdentity | null = null;
let ipcBridge: RionIpcBridgeRegistration | null = null;
let coreRendererEvents: CoreRendererEventBridge | null = null;
let rendererGeneration = 0;
let displayTopology: ElectronDisplayTopologyController | null = null;
let unsubscribeDisplayTopology: (() => void) | null = null;
let mainWindowState: ElectronWindowStateController | null = null;
let applicationLifecycle: ElectronApplicationLifecycleController | null = null;
let chromiumRuntime: ChromiumRuntimeBootstrap | null = null;
let appKitRuntimeEvents: MacosAppKitRuntimeEventBridge | null = null;
let chromiumLaunchCompletions: ChromiumRuntimeLaunchCompletionCoordinator | null = null;
let runtimeRestoreSession: ChromiumRuntimeRestoreSessionCoordinator | null = null;
let nativeAddon: LoadedRionNodeAddon | null = null;
let overlayShellEffects: ElectronOverlayShellEffects | null = null;
let chromiumUpdater: ElectronChromiumUpdater | null = null;
let fatalTermination: ElectronFatalTerminationCoordinator | null = null;
let fatalEventStreamDetected = false;
const identities = new RendererIdentityRegistry((contents) =>
  BrowserWindow.fromWebContents(contents as Electron.WebContents)
);
const mainRendererQuitHandshake = new ElectronMainRendererQuitHandshake({
  publishQuitRequested: (identity) =>
    ipcBridge?.publish(identity, "onApplicationQuitRequested") ?? false
});
function platform(): "darwin" | "win32" {
  if (process.platform === "darwin" || process.platform === "win32") return process.platform;
  throw new RionBridgeError({
    code: "ELECTRON_PLATFORM_UNSUPPORTED",
    message: "Rion Studio supports only macOS and Windows."
  });
}

function sharedUserDataDirectory(): string {
  const override = process.env.RION_STUDIO_USER_DATA_DIR;
  if (override) {
    if (app.isPackaged) {
      throw new RionBridgeError({
        code: "ELECTRON_USER_DATA_OVERRIDE_FORBIDDEN",
        message: "The user-data override is restricted to development builds."
      });
    }
    if (!isAbsolute(override)) {
      throw new RionBridgeError({
        code: "ELECTRON_USER_DATA_PATH_INVALID",
        message: "RION_STUDIO_USER_DATA_DIR must be an absolute path."
      });
    }
    return override;
  }
  return join(app.getPath("appData"), APP_NAME);
}

function nativeAddonPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "native/rion-core.node");
  return join(
    import.meta.dirname,
    `../../build/native/${process.platform}-${process.arch}/rion-core.node`
  );
}

async function createCore(userDataDir: string): Promise<CoreAddonClient> {
  const addon = loadNativeAddon();
  nativeAddon = addon;
  return CoreAddonClient.create(addon, withElectronChromiumRuntimeContract({
    userDataDir,
    platform: platform(),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    startupBackupLabel: "electron-chromium-foundation"
  }), {
    onEventBridgeError: revealShellError
  });
}

function loadNativeAddon(): LoadedRionNodeAddon {
  return requireNativeModule(nativeAddonPath()) as LoadedRionNodeAddon;
}

function createMacosAppKitAdapter(
  addon: LoadedRionNodeAddon,
  coreClient: CoreAddonClient,
  onOpenTabMenu: (
    request: MacosAppKitRuntimeTabMenuOpenRequest
  ) => Promise<void>
): MacosAppKitRuntimeBootstrapAdapter {
  try {
    const eventBridge = new MacosAppKitRuntimeEventBridge({
      core: coreClient,
      beforeLayoutDispatch: async () => {
        await chromiumRuntime?.settleCurrentApplicationEffects();
      },
      onOpenTabMenu,
      onError: revealShellError
    });
    let attachments: MacosAppKitInputSurfaceAttachmentCoordinator | null = null;
    const hostFactory = MacosAppKitChromiumRuntimeHostFactory.fromElectronBaseWindow(
      addon,
      BaseWindow,
      {
        displays: {
          displayMatching: (bounds) => {
            const display = screen.getDisplayMatching(bounds);
            return { id: display.id, workArea: display.workArea };
          }
        },
        onAction: (event) => eventBridge.receiveAction(event),
        onCloseRequested: (identity, hosts) =>
          eventBridge.receiveCloseRequested(identity, hosts),
        onHostClosing: (binding) => {
          if (!attachments) {
            return Promise.reject(new RionBridgeError({
              code: "ELECTRON_MACOS_APPKIT_INPUT_HOST_UNAVAILABLE",
              message: "The AppKit input attachment coordinator is unavailable."
            }));
          }
          return attachments.closeHost(binding);
        },
        onLayout: (event) => eventBridge.receiveLayout(event),
        onError: revealShellError,
        lifecycleEpoch: () => applicationLifecycle?.lifecycleEpoch ?? 1
      }
    );
    attachments = new MacosAppKitInputSurfaceAttachmentCoordinator({
      resolve: (parent) => hostFactory.resolveInputHost(parent)
    });
    appKitRuntimeEvents = eventBridge;
    return {
      hostFactory,
      lifecycleEpoch: () => applicationLifecycle?.lifecycleEpoch ?? 1,
      rendererActions: eventBridge,
      nativeAttachments: attachments,
      createTrustedInput: (
        surfaces,
        preflightAutomaticInputContext,
        onRecoveryProof
      ) => {
        const native = new MacosAppKitTrustedInputAdapter({
          hosts: {
            resolve: (roleId, generation) => {
              const binding = attachments!.resolveOwnedInputHost(roleId, generation);
              if (!binding || !isRawNativeAppKitTrustedInputHost(binding.native)) {
                return null;
              }
              return Object.freeze({
                identity: binding.identity,
                native: binding.native
              });
            }
          },
          surfaces,
          clicks: {
            resolve: (request, frame) =>
              surfaces.resolveTrustedInputClick(request, frame)
          },
          nowMs: Date.now
        });
        try {
          native.register(ipcMain);
        } catch (error) {
          native.dispose();
          throw error;
        }
        const coordinator = new ChromiumTrustedInputCoordinator({
          native,
          surfaces,
          nowMs: Date.now,
          preflightAutomaticInputContext,
          onRecoveryProof
        });
        return {
          execute: (request) => coordinator.execute(request),
          retireSurface: (roleId, generation) =>
            coordinator.retireSurface(roleId, generation),
          retireSurfaceForDestruction: (roleId, generation) =>
            coordinator.retireSurfaceForDestruction(roleId, generation),
          resumeAfterDocumentReplacement: (roleId, generation) =>
            coordinator.resumeAfterDocumentReplacement(roleId, generation),
          prepareControlledDocumentReplacement: (lease) =>
            coordinator.prepareControlledDocumentReplacement(lease),
          confirmControlledDocumentReplacementNeutral: (lease) =>
            coordinator.confirmControlledDocumentReplacementNeutral(lease),
          resumeControlledDocumentReplacement: (lease, nextDocumentInstanceId) =>
            coordinator.resumeControlledDocumentReplacement(
              lease,
              nextDocumentInstanceId
            ),
          supersedeControlledDocumentReplacement: (lease, submitted) =>
            coordinator.supersedeControlledDocumentReplacement(lease, submitted),
          dispose: async () => {
            try {
              await coordinator.dispose();
            } finally {
              native.dispose();
            }
          }
        };
      },
      drainEvents: async () => {
        try {
          await eventBridge.dispose();
        } finally {
          if (appKitRuntimeEvents === eventBridge) appKitRuntimeEvents = null;
        }
      },
      adapterVersion:
        `appkit-${RION_APPKIT_RUNTIME_ABI_VERSION}+electron-${process.versions.electron}+chromium-${process.versions.chrome}`,
      capabilities: MACOS_APPKIT_CHROMIUM_CAPABILITIES
    };
  } catch (error) {
    const normalized = normalizeRionBridgeError(
      error,
      "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE"
    );
    revealShellError(normalized);
    throw new RionBridgeError(normalized);
  }
}

function currentWindow(identity: RendererIdentity): BrowserWindow {
  const window = activeMainWindow();
  if (
    mainIdentity !== identity ||
    identities.contentsFor(identity) !== window.webContents
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_WINDOW_NOT_FOUND",
      message: "The active Rion Studio window is no longer available."
    });
  }
  return window;
}

function activeMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed() || !mainIdentity) {
    throw new RionBridgeError({
      code: "ELECTRON_WINDOW_NOT_FOUND",
      message: "The active Rion Studio window is no longer available."
    });
  }
  return mainWindow;
}

function activeCore(): CoreAddonClient {
  if (core) return core;
  throw new RionBridgeError({
    code: "ELECTRON_CORE_UNAVAILABLE",
    message: "The Rion Studio core is not available."
  });
}

function activeLifecycle(): ElectronMainLifecycle {
  if (lifecycle) return lifecycle;
  throw new RionBridgeError({
    code: "ELECTRON_LIFECYCLE_UNAVAILABLE",
    message: "The Electron application lifecycle is not available."
  });
}

export function prepareElectronMainQuit(): Promise<void> {
  return activeLifecycle().prepareCleanQuit();
}

export function focusElectronMainWindow(): void {
  const window = activeMainWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

export function readWindowsRuntimeShortcutOwnerDiagnostic(
  parentNativeHostId: number
): WindowsRuntimeShortcutOwnerDiagnostic | null {
  if (process.platform !== "win32") return null;
  if (!Number.isSafeInteger(parentNativeHostId) || parentNativeHostId < 1) {
    throw new RionBridgeError({
      code: "ELECTRON_RUNTIME_SHORTCUT_DIAGNOSTIC_HOST_INVALID",
      message: "The Windows shortcut diagnostic requires one exact native host."
    });
  }
  const addon = nativeAddon;
  const owner = BrowserWindow.fromId(parentNativeHostId);
  if (!addon || !owner || owner.isDestroyed()) {
    throw new RionBridgeError({
      code: "ELECTRON_RUNTIME_SHORTCUT_DIAGNOSTIC_OWNER_MISSING",
      message: "The Windows shortcut diagnostic owner is no longer active."
    });
  }
  return addon.readWindowsRuntimeShortcutOwner(owner.getNativeWindowHandle());
}

function activeRuntimeRestoreSession(): ChromiumRuntimeRestoreSessionCoordinator {
  if (runtimeRestoreSession) return runtimeRestoreSession;
  throw new RionBridgeError({
    code: "ELECTRON_RUNTIME_RESTORE_SESSION_UNAVAILABLE",
    message: "The Chromium runtime recovery journal is unavailable."
  });
}

function activeDisplayTopology(): ElectronDisplayTopologyController {
  if (displayTopology) return displayTopology;
  throw new RionBridgeError({
    code: "ELECTRON_DISPLAY_TOPOLOGY_UNAVAILABLE",
    message: "The Electron display-topology projection is unavailable."
  });
}

function activeOverlayShellEffects(): ElectronOverlayShellEffects {
  if (overlayShellEffects) return overlayShellEffects;
  throw new RionBridgeError({
    code: "ELECTRON_OVERLAY_SHELL_EFFECTS_UNAVAILABLE",
    message: "The Electron overlay shell-effects adapter is unavailable."
  });
}

function rendererLogCommand(event: RendererLogEvent) {
  return {
    type: "logsCapture" as const,
    entries: [{
      level: "error" as const,
      source: "renderer" as const,
      event: event.event,
      message: event.message,
      ...(event.stack
        ? {
            error: {
              message: event.message,
              name: event.event,
              stack: event.stack
            }
          }
        : {})
    }]
  };
}

function revealShellError(error: ReturnType<typeof normalizeRionBridgeError>): void {
  console.error(`[${error.code}] ${error.message}`);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  if (mainIdentity) ipcBridge?.publish(mainIdentity, "onShellError", error);
}
async function disposeShellAfterFatalTermination(): Promise<void> {
  chromiumUpdater?.dispose();
  unsubscribeDisplayTopology?.(); unsubscribeDisplayTopology = null;
  displayTopology?.dispose(); displayTopology = null;
  await applicationLifecycle?.dispose();
  coreRendererEvents?.dispose();
  chromiumLaunchCompletions?.dispose(); chromiumLaunchCompletions = null;
  ipcBridge?.dispose(); ipcBridge = null;
}
function fatalTerminationCoordinator(): ElectronFatalTerminationCoordinator {
  return fatalTermination ??= new ElectronFatalTerminationCoordinator({
    lifecycle: () => lifecycle, runtime: () => chromiumRuntime, core: () => core,
    disposeShell: disposeShellAfterFatalTermination,
    quit: () => app.quit(), forceExit: (code) => app.exit(code),
    onError: (error) => console.error(`[${error.code}] ${error.message}`)
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  if (!applicationLifecycle) {
    applicationLifecycle = new ElectronApplicationLifecycleController({
      powerMonitor: {
        on: (event, listener) => powerMonitor.on(event as "suspend", listener),
        removeListener: (event, listener) =>
          powerMonitor.removeListener(event as "suspend", listener)
      },
      platform: platform(),
      applyRuntimeSuspended: (suspended) =>
        activeCore().invoke({ type: "browserRuntimeSuspend", suspended }),
      publish: (status) => {
        chromiumRuntime?.advanceLifecycle(status.lifecycleEpoch);
        if (mainIdentity) {
          ipcBridge?.publish(mainIdentity, "onApplicationLifecycleChanged", status);
        }
      },
      onError: revealShellError
    });
    applicationLifecycle.start();
  }
  const window = new BrowserWindow(buildMainWindowOptions(
    platform(),
    buildMainRendererWebPreferences({
      preloadPath: join(import.meta.dirname, "../preload/index.cjs"),
      devTools: !app.isPackaged
    })
  ));
  mainWindow = window;
  const identity = identities.registerMainWindow(window, ++rendererGeneration);
  mainIdentity = identity;
  mainRendererQuitHandshake.bind(identity, window);
  const windowStateController = new ElectronWindowStateController({
    window: {
      isFocused: () => window.isFocused(),
      isFullScreen: () => window.isFullScreen(),
      isMaximized: () => window.isMaximized(),
      isMinimized: () => window.isMinimized(),
      isVisible: () => window.isVisible(),
      on: (event, listener) => window.on(event as "blur", listener),
      removeListener: (event, listener) => window.removeListener(event as "blur", listener)
    },
    windowGeneration: identity.generation,
    lifecycleEpoch: () => applicationLifecycle?.lifecycleEpoch ?? 1,
    publish: (state) => {
      if (mainIdentity === identity) {
        if (state.focused) {
          chromiumRuntime?.observeExternalForeground(state.lifecycleEpoch);
        }
        ipcBridge?.publish(identity, "onCurrentWindowStateChanged", state);
      }
    }
  });
  mainWindowState = windowStateController;
  windowStateController.start();
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  installMainRendererContentSecurityPolicy(window.webContents.session, developmentUrl);
  installChromiumSessionSecurityPolicy(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) {
        mainRendererQuitHandshake.markUnavailable(identity);
      }
    }
  );
  window.webContents.on("render-process-gone", () => {
    mainRendererQuitHandshake.markUnavailable(identity);
  });
  const windowsSessionEnd = platform() === "win32"
    ? new ElectronWindowsSessionEndCoordinator({
        platform: "win32",
        window,
        confirmQuit: () => activeLifecycle().confirmQuit(),
        onError: revealShellError
      })
    : null;
  windowsSessionEnd?.start();
  window.on("close", (event) => {
    applyElectronMainWindowClosePolicy({
      hide: () => window.hide(),
      isFinalCloseAdmitted: () => lifecycle?.isQuitCommitted() ?? false
    }, event);
  });
  window.on("closed", () => {
    windowsSessionEnd?.dispose();
    windowStateController.dispose();
    if (mainWindowState === windowStateController) mainWindowState = null;
    mainRendererQuitHandshake.release(identity);
    identities.release(identity);
    if (mainIdentity === identity) {
      mainIdentity = null;
    }
    if (mainWindow === window) mainWindow = null;
  });

  if (developmentUrl) {
    await window.loadURL(developmentUrl);
  } else {
    await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return window;
}

function readChromiumRuntimeSnapshot() {
  if (!chromiumRuntime) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
      message: "The Chromium runtime is unavailable for app snapshot projection."
    });
  }
  return chromiumRuntime.snapshot();
}

async function readAppSnapshot() {
  let projectionSequence = await settleRuntimeProjection();
  while (true) {
    const snapshot = await activeCore().invoke({ type: "appSnapshot" });
    try {
      return projectAppSnapshot(snapshot);
    } catch (error) {
      if (
        error instanceof RionBridgeError &&
        error.code === "ELECTRON_RUNTIME_PROJECTION_NOT_READY"
      ) {
        projectionSequence = await waitForRuntimeProjection(projectionSequence);
        continue;
      }
      throw error;
    }
  }
}

async function settleRuntimeProjection(): Promise<number> {
  return chromiumRuntime?.settleCurrentProjection() ?? 0;
}

async function waitForRuntimeProjection(afterSequence: number): Promise<number> {
  const runtime = chromiumRuntime;
  if (!runtime) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
      message: "The Chromium runtime cannot await its next native projection."
    });
  }
  await runtime.waitForProjectionAfter(afterSequence);
  return settleRuntimeProjection();
}

function projectAppSnapshot(snapshot: CoreAppSnapshotRecord) {
  const capturedAt = new Date().toISOString();
  const currentDisplayTopology = activeDisplayTopology().snapshot();
  return projectCoreAppSnapshot(
    snapshot,
    readChromiumRuntimeSnapshot(),
    currentDisplayTopology,
    capturedAt
  );
}

async function bootstrap(
  updaterRecovery: { attemptId: string; userDataDir: string } | null = null
): Promise<void> {
  app.setName(APP_NAME);
  if (updaterRecovery) {
    if (process.platform !== "darwin" || !app.isPackaged) {
      throw new RionBridgeError({
        code: "ELECTRON_UPDATE_RECOVERY_FORBIDDEN",
        message: "The updater recovery locator is available only in packaged macOS builds."
      });
    }
    const addon = loadNativeAddon();
    verifyMacosUpdaterRecoveryLocator(addon, {
      userDataDir: updaterRecovery.userDataDir,
      attemptId: updaterRecovery.attemptId,
      currentVersion: app.getVersion()
    });
    nativeAddon = addon;
  }
  const userDataDirectory = updaterRecovery?.userDataDir ?? sharedUserDataDirectory();
  const preserveDriverUserData = preserveWebDriverUserDataDirectory({
    driverUserDataSwitchPresent: app.commandLine.hasSwitch("user-data-dir"),
    packaged: app.isPackaged,
    runtimeTarget: process.env.RION_STUDIO_E2E_RUNTIME_TARGET
  });
  if (!preserveDriverUserData && app.getPath("userData") !== userDataDirectory) {
    app.setPath("userData", userDataDirectory);
  }
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  const startupQuitFence = installElectronStartupQuitFence(app);
  try {
    await runElectronReadyPhase(
      { whenReady: () => app.whenReady() },
      () => bootstrapReadyPhase(
        userDataDirectory,
        startupQuitFence
      )
    );
  } finally {
    startupQuitFence.release();
  }
}

async function bootstrapReadyPhase(
  userDataDirectory: string,
  startupQuitFence: ElectronStartupQuitFence
): Promise<void> {
  installChromiumCertificatePolicy(app);
  displayTopology = new ElectronDisplayTopologyController({
    capture: () => ({
      displays: screen.getAllDisplays(),
      primaryDisplayId: screen.getPrimaryDisplay().id
    }),
    onListenerError: (error) => revealShellError(normalizeRionBridgeError(
      error,
      "ELECTRON_DISPLAY_TOPOLOGY_LISTENER_FAILED"
    ))
  });
  displayTopology.refresh("electron-initial");
  const refreshDisplayTopology = (cause: string): void => {
    try {
      activeDisplayTopology().refresh(cause);
    } catch (error) {
      revealShellError(normalizeRionBridgeError(
        error,
        "ELECTRON_DISPLAY_TOPOLOGY_REFRESH_FAILED"
      ));
    }
  };
  screen.on("display-added", () => refreshDisplayTopology("screen-display-added"));
  screen.on("display-removed", () => refreshDisplayTopology("screen-display-removed"));
  screen.on("display-metrics-changed", () => {
    refreshDisplayTopology("screen-display-metrics-changed");
  });
  core = await createCore(userDataDirectory);
  runtimeRestoreSession = new ChromiumRuntimeRestoreSessionCoordinator({ core });
  overlayShellEffects = new ElectronOverlayShellEffects({
    clipboard,
    mainWindow: () => mainWindow,
    publishMacroPageRequested: (request) => mainIdentity
      ? ipcBridge?.publish(mainIdentity, "onMacroPageRequested", request) ?? false
      : false
  });
  const runtimePlatform = platform();
  if (!nativeAddon) {
    throw new RionBridgeError({
      code: "ELECTRON_NATIVE_RUNTIME_UNAVAILABLE",
      message: "The Rust-owned Chromium runtime addon is unavailable."
    });
  }
  let openMacosRuntimeTabMenu: ((
    request: MacosAppKitRuntimeTabMenuOpenRequest
  ) => Promise<void>) | null = null;
  const appKit = runtimePlatform === "darwin" && nativeAddon
    ? createMacosAppKitAdapter(nativeAddon, core, async (request) => {
        const open = openMacosRuntimeTabMenu;
        if (!open) {
          throw new RionBridgeError({
            code: "ELECTRON_MACOS_APPKIT_TAB_MENU_NOT_READY",
            message: "The retained AppKit tab menu action lane is not ready."
          });
        }
        await open(request);
      })
    : undefined;
  if (runtimePlatform === "darwin" && !appKit) {
    throw new RionBridgeError({
      code: "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE",
      message: "The retained AppKit Chromium runtime host is unavailable."
    });
  }
  const webChromeShellSession = session.fromPartition(
    "rion-web-chrome-shell",
    { cache: false }
  );
  installChromiumSessionSecurityPolicy(webChromeShellSession);
  let beginRuntimeTabQuickAccess: ((tabId: string) => void) | null = null;
  let beginRuntimeTabFullscreen: ((
    tabId: string,
    focusAdmission?: ChromiumRuntimeFullscreenFocusAdmission
  ) => void) | null = null;
  let requestRuntimeWindowControl: ((
    windowId: string,
    action: "closeWindow" | "toggleMaximizeWindow"
  ) => Promise<void>) | null = null;
  let requestRuntimeTabControl: ((
    tabId: string,
    action: ChromiumRuntimeNativeTabAction
  ) => Promise<void>) | null = null;
  const fatalEventStream = new ElectronFatalEventStreamRouter({
    onFatalDetected: () => {
      fatalEventStreamDetected = true;
      chromiumRuntime?.beginFatalEventStreamFailure();
      lifecycle?.beginFatalQuit();
      const bridge = ipcBridge;
      ipcBridge = null;
      return bridge?.closeAndDrain() ?? Promise.resolve();
    },
    terminate: () => fatalTerminationCoordinator().forceTerminate(),
    onError: revealShellError
  });
  chromiumRuntime = await ChromiumRuntimeBootstrap.start({
    core,
    ipcMain,
    platform: runtimePlatform,
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    rolePreloadPath: join(import.meta.dirname, "../preload/role.cjs"),
    startupSignal: startupQuitFence.signal,
    onNativeProjectionChanged: () => {
      coreRendererEvents?.observeNativeProjectionChanged();
    },
    webChromeShell: {
      documentPath: join(
        import.meta.dirname,
        "../renderer/runtime-web-chrome-electron.html"
      ),
      ipcMain,
      preloadPath: join(
        import.meta.dirname,
        "../preload/workspaceWebChrome.cjs"
      ),
      session: webChromeShellSession,
      sessionIdentity: WORKSPACE_WEB_CHROME_SHELL_SESSION
    },
    rolePlaceholderShell: {
      documentPath: join(
        import.meta.dirname,
        "../renderer/runtime-role-placeholder-electron.html"
      ),
      ipcMain,
      preloadPath: join(
        import.meta.dirname,
        "../preload/workspaceWebChrome.cjs"
      ),
      session: webChromeShellSession,
      sessionIdentity: RUNTIME_ROLE_PLACEHOLDER_SHELL_SESSION
    },
    onRuntimeTabQuickAccess: (tabId) => {
      const begin = beginRuntimeTabQuickAccess;
      if (!begin) {
        throw new RionBridgeError({
          code: "ELECTRON_CHROMIUM_QUICK_ACCESS_NOT_READY",
          message: "The managed Chromium Quick Access lane is not ready."
        });
      }
      begin(tabId);
    },
    onRuntimeTabFullscreen: (tabId, focusAdmission) => {
      const begin = beginRuntimeTabFullscreen;
      if (!begin) {
        throw new RionBridgeError({
          code: "ELECTRON_CHROMIUM_FULLSCREEN_NOT_READY",
          message: "The managed Chromium fullscreen lane is not ready."
        });
      }
      begin(tabId, focusAdmission);
    },
    shellEffects: overlayShellEffects,
    sessions: {
      fromPath: (path, options) => {
        const chromiumSession = session.fromPath(path, options);
        installChromiumSessionSecurityPolicy(chromiumSession);
        return chromiumSession;
      }
    },
    views: {
      create: (options) => {
        const focusLease = runtimePlatform === "darwin"
          ? appKit!.hostFactory.captureChromiumSurfaceFocusLease()
          : null;
        let view: WebContentsView;
        try {
          view = new WebContentsView(
            options as Electron.WebContentsViewConstructorOptions
          );
        } catch (error) {
          focusLease?.restore();
          throw error;
        }
        try {
          focusLease?.restore();
        } catch (error) {
          view.webContents.close({ waitForBeforeUnload: false });
          throw error;
        }
        return view as unknown as ChromiumRoleWebContentsViewPort;
      }
    },
    ...(runtimePlatform === "win32"
      ? {
          windows: {
            browserWindows: {
              create: (options: Electron.BrowserWindowConstructorOptions) =>
                new BrowserWindow(options) as unknown as WindowsRuntimeHostWindowPort
            },
            displays: {
              displayMatching: (bounds) => {
                const display = screen.getDisplayMatching(bounds);
                return { id: display.id, workArea: display.workArea };
              }
            },
            displayTopology: () => activeDisplayTopology().snapshot(),
            lifecycleEpoch: () => applicationLifecycle?.lifecycleEpoch ?? 1,
            runtimeForegroundProbe: nativeAddon,
            runtimeShortcutOwner: nativeAddon,
            runtimeDocumentPath: join(
              import.meta.dirname,
              "../renderer/runtime-windows-host.html"
            ),
            runtimeHostPreloadPath: join(
              import.meta.dirname,
              "../preload/runtimeWindowsHost.cjs"
            ),
            onWindowControl: (windowId, action) => {
              const request = requestRuntimeWindowControl;
              if (!request) {
                throw new RionBridgeError({
                  code: "ELECTRON_CHROMIUM_WINDOW_CONTROL_NOT_READY",
                  message: "The Core-owned Windows control lane is not ready."
                });
              }
              return request(windowId, action);
            },
            onTabControl: (tabId, action) => {
              const request = requestRuntimeTabControl;
              if (!request) {
                throw new RionBridgeError({
                  code: "ELECTRON_CHROMIUM_TAB_CONTROL_NOT_READY",
                  message: "The Core-owned Windows tab control lane is not ready."
                });
              }
              return request(tabId, action);
            },
            trustedInput: {
              addon: nativeAddon,
              baseWindows: {
                create: (options) => new BaseWindow(
                  options as unknown as Electron.BaseWindowConstructorOptions
                ) as unknown as WindowsChromiumInputBaseWindowPort
              },
              deadlines: {
                // event-topology-exception: windows-chromium-trusted-input-deadline
                schedule: (callback, delayMs) => setTimeout(callback, delayMs),
                cancel: (handle) => clearTimeout(handle as NodeJS.Timeout)
              },
              ipcMain
            }
          }
        }
      : { appKit: appKit! }),
    onFatalEventStreamFailure: (terminal) => fatalEventStream.route(terminal),
    onError: revealShellError
  });
  const singleDialogPath = (
    canceled: boolean,
    paths: readonly string[],
    operation: string
  ): string | null => {
    if (canceled) return null;
    if (paths.length !== 1 || !paths[0]) {
      throw new RionBridgeError({
        code: "ELECTRON_DIALOG_RESULT_INVALID",
        message: `The ${operation} dialog returned an invalid selection.`
      });
    }
    return paths[0];
  };
  const nativeShellActions = new ElectronNativeShellActions({
    core: activeCore(),
    chooseDirectory: async ({ title, defaultPath }) => {
      const result = await dialog.showOpenDialog(activeMainWindow(), {
        title,
        ...(defaultPath === undefined ? {} : { defaultPath }),
        properties: ["openDirectory", "createDirectory"]
      });
      return singleDialogPath(result.canceled, result.filePaths, "directory picker");
    },
    chooseFile: async ({ title, extension }) => {
      const result = await dialog.showOpenDialog(activeMainWindow(), {
        title,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        properties: ["openFile"]
      });
      return singleDialogPath(result.canceled, result.filePaths, "file picker");
    },
    saveFile: async ({ title, defaultName, extension }) => {
      const result = await dialog.showSaveDialog(activeMainWindow(), {
        title,
        defaultPath: defaultName,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
      });
      if (result.canceled) return null;
      if (!result.filePath) {
        throw new RionBridgeError({
          code: "ELECTRON_DIALOG_RESULT_INVALID",
          message: "The save dialog returned an invalid selection."
        });
      }
      return result.filePath;
    },
    openPath: (path) => shell.openPath(path),
    openExternal: (url) => shell.openExternal(url, { activate: true })
  });
  if (!nativeAddon) {
    throw new RionBridgeError({
      code: "ELECTRON_NATIVE_UPDATER_UNAVAILABLE",
      message: "The Rust-owned Chromium updater is unavailable."
    });
  }
  chromiumUpdater = await fatalEventStream.waitForStartup(
    ElectronChromiumUpdater.create(nativeAddon, {
      userDataDir: userDataDirectory,
      platform: platform(),
      currentVersion: app.getVersion(),
      packaged: app.isPackaged
    }, {
      drainShellAndCore: () => activeLifecycle().prepareCleanQuit(),
      exitAfterHandoff: () => app.exit(0),
      restartAfterFailedDrain: async (failure) => {
        app.relaunch();
        // Clean-drain rejection is already classified by lifecycle; only a
        // post-clean updater handoff failure needs to claim fatal ownership here.
        if (failure === "handoff") await fatalTerminationCoordinator().forceTerminate();
      },
      publishStatus: (status) => {
        if (mainIdentity) {
          ipcBridge?.publish(mainIdentity, "onUpdateStatusChanged", status);
        }
      },
      onFatalEventStreamFailure: (terminal) => fatalEventStream.route(terminal),
      onError: revealShellError,
      processId: process.pid
    })
  );
  const browserPerformanceDiagnostics =
    new ElectronBrowserPerformanceDiagnosticsController({
      publish: (operation) => {
        if (mainIdentity) {
          ipcBridge?.publish(
            mainIdentity,
            "onBrowserPerformanceDiagnosticsChanged",
            operation
          );
        }
      }
    });
  type ElectronShortcutWindow = BrowserWindow & ElectronShortcutMainWindowPort;
  const shortcutWindow = (identity: RendererIdentity): ElectronShortcutWindow =>
    currentWindow(identity) as ElectronShortcutWindow;
  const applicationShortcuts =
    new ElectronApplicationShortcutController<ElectronShortcutWindow>({
    resolveMainWindow: shortcutWindow,
    createNewGameWindow: async (identity, exactWindow) => {
      const gameWindows = await activeCore().invoke({ type: "gameWindowsList" });
      if (shortcutWindow(identity) !== exactWindow) {
        throw new RionBridgeError({
          code: "ELECTRON_IPC_UNAUTHORIZED_SENDER",
          message: "The New Game Window shortcut lost its exact main-window owner."
        });
      }
      const nativeDisplay = screen.getDisplayMatching(exactWindow.getBounds());
      const target = resolveElectronNewGameWindowTarget({
        gameWindows,
        nativeDisplay: {
          id: nativeDisplay.id,
          scaleFactor: nativeDisplay.scaleFactor,
          workArea: { ...nativeDisplay.workArea }
        },
        topology: activeDisplayTopology().snapshot()
      });
      await launchCoordinator.openEmptyTransientGameWindow(target);
    },
    requestApplicationQuit: async (identity, exactWindow) => {
      if (shortcutWindow(identity) !== exactWindow) {
        throw new RionBridgeError({
          code: "ELECTRON_IPC_UNAUTHORIZED_SENDER",
          message: "The quit shortcut lost its exact main-window owner."
        });
      }
      await activeLifecycle().requestQuit();
    }
  });
  const diagnosticsExport = createElectronDiagnosticsComposition({
    applicationName: APP_NAME,
    applicationLifecycle: () => {
      if (applicationLifecycle) return applicationLifecycle.snapshot();
      throw new RionBridgeError({
        code: "ELECTRON_APPLICATION_LIFECYCLE_UNAVAILABLE",
        message: "The Electron application lifecycle projection is unavailable."
      });
    },
    captureDisplayTopology: () => activeDisplayTopology().snapshot(),
    core: activeCore(),
    projectCoherentSnapshot: (coreSnapshot, nativeSnapshot, capturedAt) =>
      projectCoreAppSnapshot(
        coreSnapshot,
        nativeSnapshot,
        activeDisplayTopology().snapshot(),
        capturedAt
      ),
    readCoreSnapshot: () => activeCore().invoke({ type: "appSnapshot" }),
    readNativeSnapshot: readChromiumRuntimeSnapshot,
    registration: () => {
      if (chromiumRuntime) return chromiumRuntime.registration;
      throw new RionBridgeError({
        code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
        message: "The Chromium runtime registration is unavailable."
      });
    },
    resolveMainWindow: currentWindow
  });
  const baselineDispatcher = createElectronBaselineDispatcher({
    beginBrowserPerformanceDiagnostics: () =>
      browserPerformanceDiagnostics.begin(),
    cancelBrowserPerformanceDiagnostics: (operationId) =>
      browserPerformanceDiagnostics.cancel(operationId),
    getAppSnapshot: readAppSnapshot,
    getAppVersion: () => app.getVersion(),
    getApplicationLifecycleStatus: () => {
      if (applicationLifecycle) return applicationLifecycle.snapshot();
      throw new RionBridgeError({
        code: "ELECTRON_APPLICATION_LIFECYCLE_UNAVAILABLE",
        message: "The Electron application lifecycle projection is unavailable."
      });
    },
    getDisplayTopology: () => activeDisplayTopology().snapshot(),
    getEmbeddedRuntimeState: async () => (await readAppSnapshot()).embeddedRuntimeState,
    consumePendingMacroPageRequest: (identity) => {
      currentWindow(identity);
      return activeOverlayShellEffects().consumePendingMacroPageRequest();
    },
    executeApplicationShortcut: (identity, command) =>
      applicationShortcuts.execute(identity, command),
    exportDiagnostics: (identity) => diagnosticsExport.export(identity),
    exportPortableData: (input) => nativeShellActions.exportPortableData(input),
    getCurrentWindowState: (identity) => {
      currentWindow(identity);
      if (mainWindowState) return mainWindowState.snapshot();
      throw new RionBridgeError({
        code: "ELECTRON_WINDOW_STATE_UNAVAILABLE",
        message: "The main window state projection is unavailable."
      });
    },
    minimizeCurrentWindow: (identity) => currentWindow(identity).minimize(),
    notifyRendererReady: (identity) => {
      currentWindow(identity).show();
      mainRendererQuitHandshake.markReady(identity);
    },
    openUpdateDownload: () => nativeShellActions.openUpdateDownload(),
    previewChromeProfileImport: () =>
      nativeShellActions.previewChromeProfileImport(),
    previewPortableImport: () => nativeShellActions.previewPortableImport(),
    revealLogs: () => nativeShellActions.revealLogs(),
    requestApplicationQuit: async (identity) => {
      currentWindow(identity);
      await activeLifecycle().requestQuit();
    },
    confirmApplicationQuit: async (identity) => {
      currentWindow(identity);
      await activeLifecycle().confirmQuit();
    },
    requestCurrentWindowClose: (identity) => {
      currentWindow(identity).hide();
    },
    startCurrentWindowDrag: (identity) =>
      applicationShortcuts.startCurrentWindowDrag(identity),
    toggleCurrentWindowMaximize: (identity) => {
      const window = currentWindow(identity);
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    },
    reportRendererLog: async (event) => {
      await activeCore().invoke(rendererLogCommand(event));
    }
  });
  chromiumLaunchCompletions = new ChromiumRuntimeLaunchCompletionCoordinator({
    core: activeCore(),
    onError: revealShellError
  });
  chromiumLaunchCompletions.start();
  const restoredTabAppKit = runtimePlatform === "darwin" && appKit?.rendererActions
    ? { factory: appKit.hostFactory, events: appKit.rendererActions }
    : undefined;
  const launchCoordinator = new ChromiumRuntimeLaunchCoordinator({
    core: activeCore(),
    launchCompletions: chromiumLaunchCompletions,
    settleRuntimeProjection,
    waitForRuntimeProjection,
    activateExistingTab: async (fence) => {
      if (restoredTabAppKit) {
        const hosts = restoredTabAppKit.factory.captureHostObservations([
          fence.windowId
        ]);
        const receipt = fence.hidden
          ? await restoredTabAppKit.events.setTabHidden(
              hosts,
              fence.tabId,
              false
            )
          : await restoredTabAppKit.events.activateTab(hosts, fence.tabId);
        if (
          !receipt.topologyCommitted || !receipt.nativeApplied ||
          receipt.windowGeneration !== fence.windowGeneration ||
          receipt.topologyRevision <= fence.topologyRevision
        ) {
          throw new RionBridgeError({
            code: "ELECTRON_MACOS_APPKIT_EXISTING_TAB_ACTIVATION_STALE",
            message: "The existing launch source did not commit its exact AppKit projection."
          });
        }
        return;
      }
      const operationId = randomUUID();
      const summary = fence.hidden
        ? await activeCore().invoke({
            type: "embeddedTabHide",
            operationId,
            tabId: fence.tabId,
            windowId: fence.windowId,
            windowGeneration: fence.windowGeneration,
            topologyRevision: fence.topologyRevision,
            hidden: false
          })
        : await activeCore().invoke({
            type: "embeddedTabActivate",
            operationId,
            tabId: fence.tabId,
            windowId: fence.windowId,
            windowGeneration: fence.windowGeneration,
            topologyRevision: fence.topologyRevision
          });
      if (
        summary.status !== "applied" ||
        summary.windowId !== fence.windowId ||
        summary.tabId !== fence.tabId ||
        summary.windowGeneration !== fence.windowGeneration ||
        summary.topologyRevision === undefined ||
        summary.topologyRevision <= fence.topologyRevision
      ) {
        throw new RionBridgeError({
          code: "ELECTRON_WINDOWS_EXISTING_TAB_ACTIVATION_STALE",
          message: "The existing launch source did not commit its exact Windows projection."
        });
      }
    },
    ...(restoredTabAppKit
      ? {
          activateRestoredTab: async (windowId: string, tabId: string) => {
            const hosts = restoredTabAppKit.factory.captureHostObservations([windowId]);
            const receipt = await restoredTabAppKit.events.activateTab(hosts, tabId);
            if (!receipt.nativeApplied) {
              throw new RionBridgeError({
                code: "ELECTRON_MACOS_APPKIT_RESTORE_PROJECTION_STALE",
                message: "The restored Game Window did not commit its exact AppKit projection."
              });
            }
          }
        }
      : {}),
    projectAppSnapshot: (snapshot, native, displayTopology) =>
      projectCoreAppSnapshot(
        snapshot,
        native,
        displayTopology,
        new Date().toISOString()
      ),
    readDisplayTopology: () => activeDisplayTopology().snapshot(),
    readNativeSnapshot: readChromiumRuntimeSnapshot
  });
  let macosWindowPreferencesMenu: MacosRuntimeWindowPreferencesMenuHandle | null = null;
  const runtimeActionServices = createCoreOwnedChromiumRuntimeActions({
    core: activeCore(),
    platform: runtimePlatform,
    readDisplayTopology: () => activeDisplayTopology().snapshot(),
    readNativeSnapshot: readChromiumRuntimeSnapshot,
    windowPreferences: {
      applyWindowPreferences: (preferences) => {
        if (!chromiumRuntime) {
          return Promise.reject(new RionBridgeError({
            code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
            message: "The native runtime-window preference projection is unavailable."
          }));
        }
        return chromiumRuntime.applyWindowPreferences(preferences).then(() => {
          macosWindowPreferencesMenu?.setAlwaysShowToolbarInFullScreen(
            preferences.alwaysShowToolbarInFullScreen
          );
        });
      }
    },
    openEmptySavedGameWindow: (window) =>
      launchCoordinator.openEmptySavedGameWindow(window),
    restoreSavedGameWindow: (window) =>
      launchCoordinator.restoreSavedGameWindow(window),
    restoreSession: activeRuntimeRestoreSession(),
    publishQuickAccessRequest: (request) => {
      if (mainIdentity) {
        ipcBridge?.publish(mainIdentity, "onQuickAccessRequested", request);
      }
    },
    presentMainWindow: async () => {
      const window = activeMainWindow();
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
    ...(runtimePlatform === "darwin" &&
      appKit?.rendererActions !== undefined
      ? {
          appKit: {
            factory: appKit.hostFactory,
            events: appKit.rendererActions
          }
        }
      : {})
  });
  if (!runtimeActionServices) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_RUNTIME_ACTIONS_UNAVAILABLE",
      message: "The Core-owned Chromium runtime action lane is unavailable."
    });
  }
  const focusedApplicationShortcuts =
    new ElectronFocusedApplicationShortcutController({
      platform: runtimePlatform,
      executeMainWindowShortcut: (command) => {
        const identity = mainIdentity;
        if (!identity) {
          throw new RionBridgeError({
            code: "ELECTRON_APPLICATION_SHORTCUT_UNAVAILABLE",
            message: "The application shortcut has no active main window."
          });
        }
        return applicationShortcuts.execute(identity, command);
      },
      readMainWindow: activeMainWindow,
      readRuntimeSnapshot: readChromiumRuntimeSnapshot,
      requestMainWindowQuickAccess: () => {
        runtimeActionServices.beginMainWindowQuickAccess();
      },
      requestRuntimeTabQuickAccess: (tabId) => {
        runtimeActionServices.beginRuntimeTabQuickAccess(tabId);
      },
      toggleRuntimeWindowFullscreen: (target) =>
        runtimeActionServices.toggleRuntimeWindowFullscreen(target),
      zoomRuntimeWindow: (target, action) =>
        runtimeActionServices.zoomRuntimeWindow(target, action)
    });
  const executeNativeApplicationShortcut = (
    command: Parameters<typeof focusedApplicationShortcuts.execute>[0],
    focusedWindow?: BaseWindow
  ): void => {
    void focusedApplicationShortcuts.execute(command, focusedWindow).catch(
      (error: unknown) => revealShellError(normalizeRionBridgeError(
        error,
        "ELECTRON_APPLICATION_SHORTCUT_FAILED"
      ))
    );
  };
  const executeNativeQuickAccessShortcut = (focusedWindow?: BaseWindow): void => {
    try {
      focusedApplicationShortcuts.executeQuickAccess(focusedWindow);
    } catch (error) {
      revealShellError(normalizeRionBridgeError(
        error,
        "ELECTRON_QUICK_ACCESS_SHORTCUT_FAILED"
      ));
    }
  };
  if (runtimePlatform === "win32") {
    installWindowsApplicationMenu(Menu, executeNativeApplicationShortcut);
  } else {
    installMacosApplicationMenu(
      Menu,
      APP_NAME,
      executeNativeApplicationShortcut,
      executeNativeQuickAccessShortcut
    );
  }
  if (runtimePlatform === "darwin") {
    const tabMenu = new MacosAppKitRuntimeTabMenuController({
      actions: {
        execute: async ({ action, source }) => {
          switch (action.type) {
            case "hide":
              await runtimeActionServices.requestRuntimeTabControl(
                action.tabId,
                { type: "hideTab" }
              );
              return;
            case "move":
              await runtimeActionServices.requestRuntimeTabControl(
                action.tabId,
                { type: "moveTab", targetWindowId: action.windowId }
              );
              return;
            case "moveToNewWindow":
              await runtimeActionServices.requestRuntimeTabControl(
                action.tabId,
                { type: "moveTabToNewWindow" }
              );
              return;
            case "reload":
              await executeControlledRuntimeTabReload(activeCore(), {
                lifecycleEpoch: source.lifecycleEpoch,
                tabId: action.tabId,
                topologyRevision: source.topologyRevision,
                windowGeneration: source.windowGeneration,
                windowId: source.windowId
              });
              return;
            case "setMuted":
              await runtimeActionServices.requestRuntimeTabControl(
                action.tabId,
                { muted: action.muted, type: "setTabMuted" }
              );
              return;
            case "stop":
              await runtimeActionServices.requestRuntimeTabControl(
                action.tabId,
                { type: "closeTab" }
              );
          }
        }
      },
      language: () => macosRuntimeTabMenuLanguage(app.getLocale()),
      lifecycleEpoch: () => applicationLifecycle?.lifecycleEpoch ?? 1,
      nativeMenu: {
        popup: ({ items, parentNativeHostId }) => {
          const parent = BaseWindow.fromId(parentNativeHostId);
          if (!parent || parent.isDestroyed()) {
            throw new RionBridgeError({
              code: "ELECTRON_MACOS_APPKIT_TAB_MENU_PARENT_STALE",
              message: "The retained AppKit tab menu lost its exact native parent."
            });
          }
          Menu.buildFromTemplate(macosRuntimeTabMenuTemplate(items)).popup({
            window: parent
          });
        }
      },
      onError: (error) => revealShellError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_APPKIT_TAB_MENU_FAILED"
      )),
      readCoreSnapshot: () => activeCore().invoke({ type: "appSnapshot" }),
      readNativeSnapshot: readChromiumRuntimeSnapshot
    });
    openMacosRuntimeTabMenu = (request) => tabMenu.open(request);
  }
  beginRuntimeTabQuickAccess = runtimeActionServices
    ? (tabId) => { runtimeActionServices.beginRuntimeTabQuickAccess(tabId); }
    : null;
  beginRuntimeTabFullscreen = runtimeActionServices
    ? (tabId, focusAdmission) => {
        void runtimeActionServices.toggleRuntimeTabFullscreen(
          tabId,
          focusAdmission
        ).catch(
          revealShellError
        );
      }
    : null;
  requestRuntimeWindowControl = runtimeActionServices
    ? (windowId, action) =>
        runtimeActionServices.requestRuntimeWindowControl(windowId, action)
    : null;
  requestRuntimeTabControl = runtimeActionServices
    ? (tabId, action) =>
        runtimeActionServices.requestRuntimeTabControl(tabId, action)
    : null;
  if (runtimePlatform === "darwin" && runtimeActionServices) {
    const preferences = await fatalEventStream.waitForStartup(
      activeCore().invoke({ type: "runtimeWindowPreferencesGet" })
    );
    macosWindowPreferencesMenu = installMacosRuntimeWindowPreferencesMenu({
      initialValue: preferences.alwaysShowToolbarInFullScreen,
      menu: Menu,
      menuItem: MenuItem,
      onError: (error) => revealShellError(normalizeRionBridgeError(
        error,
        "ELECTRON_MACOS_WINDOW_PREFERENCES_MENU_FAILED"
      )),
      replace: async (value) => (
        await runtimeActionServices.setAlwaysShowToolbarInFullScreen(value)
      ).alwaysShowToolbarInFullScreen
    });
  }
  await fatalEventStream.waitForStartup(
    runtimeActionServices?.resumeInterruptedSavedWindows() ?? Promise.resolve()
  );
  const coreDispatcher = createElectronCoreApiDispatcher(
    activeCore(),
    baselineDispatcher,
    launchCoordinator,
    runtimeActionServices?.actions
  );
  const fontAwareDispatcher = createChromiumRoleFontApiDispatcher(
    coreDispatcher,
    {
      refreshRoleFonts: (roleIds) => {
        if (!chromiumRuntime) {
          return Promise.reject(new RionBridgeError({
            code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
            message: "The Chromium runtime is unavailable for browser-font refresh."
          }));
        }
        return chromiumRuntime.refreshRoleFonts(roleIds);
      }
    }
  );
  const dispatcher = createElectronUpdaterDispatcher(
    chromiumUpdater,
    fontAwareDispatcher
  );
  ipcBridge = registerRionIpcBridge({
    ipcMain,
    identities,
    dispatcher,
    onNotificationError: revealShellError
  });
  unsubscribeDisplayTopology = activeDisplayTopology().onChanged((topology) => {
    if (mainIdentity) {
      ipcBridge?.publish(mainIdentity, "onDisplayTopologyChanged", topology);
    }
    void readAppSnapshot().then((snapshot) => {
      if (
        snapshot.displayTopology.revision !== topology.revision ||
        activeDisplayTopology().snapshot().revision !== topology.revision
      ) return;
      if (mainIdentity) {
        ipcBridge?.publish(mainIdentity, "onAppSnapshotChanged", snapshot);
      }
    }).catch((error: unknown) => {
      revealShellError(normalizeRionBridgeError(
        error,
        "ELECTRON_APP_SNAPSHOT_DISPLAY_REFRESH_FAILED"
      ));
    });
  });
  coreRendererEvents = new CoreRendererEventBridge({
    core,
    readAppSnapshot,
    publishAppSnapshot: (snapshot) => {
      if (mainIdentity) ipcBridge?.publish(mainIdentity, "onAppSnapshotChanged", snapshot);
    },
    publishLogEntry: (entry) => {
      if (mainIdentity) ipcBridge?.publish(mainIdentity, "onLogEntryAdded", entry);
    },
    publishChromeProfileImportProgress: (progress) => {
      if (mainIdentity) {
        ipcBridge?.publish(mainIdentity, "onChromeProfileImportProgress", progress);
      }
    },
    refreshRoleOverlays: (roleIds) => {
      if (!chromiumRuntime) {
        return Promise.reject(new RionBridgeError({
          code: "ELECTRON_CHROMIUM_RUNTIME_UNAVAILABLE",
          message: "The Chromium runtime is unavailable for overlay refresh."
        }));
      }
      return chromiumRuntime.refreshRoleOverlays(roleIds);
    },
    onError: revealShellError
  });
  coreRendererEvents.start();
  lifecycle = new ElectronMainLifecycle({
    app: app as unknown as ElectronAppLifecyclePort,
    platform: platform(),
    core: {
      shutdown: async () => {
        chromiumUpdater?.dispose();
        unsubscribeDisplayTopology?.();
        unsubscribeDisplayTopology = null;
        await applicationLifecycle?.dispose();
        coreRendererEvents?.dispose();
        chromiumLaunchCompletions?.dispose();
        chromiumLaunchCompletions = null;
        if (chromiumRuntime) await chromiumRuntime.shutdown();
        else await core?.shutdown();
      }
    },
    createMainWindow,
    prepareCleanExit: () => prepareElectronCleanExit({
      core: activeCore(),
      runtime: chromiumRuntime,
      rendererIngress: ipcBridge,
      releaseRendererIngress: () => { ipcBridge = null; },
      persistCleanExit: (snapshot) =>
        activeRuntimeRestoreSession().persistCleanExit(snapshot)
    }),
    onCleanExitFailure: (failure) => terminateAfterCleanExitFailure(
      failure, activeCore(), () => fatalTerminationCoordinator().forceTerminate(),
      revealShellError
    ),
    requestRendererQuitConfirmation: () => mainRendererQuitHandshake.requestConfirmation(),
    onError: revealShellError
  });
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  let lifecycleStart!: Promise<void>;
  handoffElectronStartupQuitFence(startupQuitFence, () => {
    lifecycleStart = lifecycle!.start();
  });
  await fatalEventStream.waitForStartup(lifecycleStart);
  fatalEventStream.completeStartup();
}

async function runInternalChromeProfileImportHelper(): Promise<void> {
  app.setPath(
    "userData",
    mkdtempSync(join(tmpdir(), "rion-chrome-profile-import-helper-"))
  );
  const helperPort: ChromeProfileImportHelperProcessPort = {
    platform: platform(),
    sessions: {
      fromPath: (path, options) => {
        const chromiumSession = session.fromPath(path, options);
        installChromiumSessionSecurityPolicy(chromiumSession);
        return chromiumSession;
      }
    },
    views: {
      create: (options: Electron.WebContentsViewConstructorOptions) =>
        new WebContentsView(options)
    } as unknown as ChromeProfileImportHelperProcessPort["views"],
    readInheritedRequest: () => readFileSync(0),
    ready: () => app.whenReady(),
    writeInheritedResponse: async (bytes) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(1, bytes, offset, bytes.byteLength - offset);
        if (written <= 0) {
          throw new Error("The inherited helper response pipe closed before acknowledgement.");
        }
        offset += written;
      }
    },
    exit: (code) => app.exit(code)
  };
  await runChromeProfileImportHelperProcess(helperPort);
}

async function runInternalMacosUpdateRelaunchHelper(
  helper: { attemptId: string; parentProcessId: number; userDataDir: string }
): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) {
    throw new RionBridgeError({
      code: "ELECTRON_UPDATE_HELPER_FORBIDDEN",
      message: "The updater relaunch helper is available only in packaged macOS builds."
    });
  }
  await runMacosUpdaterRelaunchHelper(loadNativeAddon(), {
    userDataDir: helper.userDataDir,
    attemptId: helper.attemptId,
    currentVersion: app.getVersion(),
    parentProcessId: helper.parentProcessId
  });
  app.exit(0);
}

const internalChromeProfileImportHelper =
  isChromeProfileImportHelperInvocation(process.argv);
const internalMacosUpdateHelperRequested =
  process.argv.includes(MACOS_UPDATE_RELAUNCH_HELPER_SWITCH);
const internalMacosUpdateRecoveryRequested =
  process.argv.includes(MACOS_UPDATE_RECOVERY_SWITCH);
const internalLaunchContractRequested =
  internalChromeProfileImportHelper ||
  internalMacosUpdateHelperRequested ||
  internalMacosUpdateRecoveryRequested;
const startup = Promise.resolve().then(async () => {
  enforceChromiumCommandLinePolicy({
    commandLine: app.commandLine,
    environment: process.env,
    isPackaged: app.isPackaged,
    platform: process.platform
  });
  const macosUpdateHelper = parseMacosUpdaterRelaunchArguments(process.argv);
  const macosUpdateRecovery = parseMacosUpdaterRecoveryArguments(process.argv);
  if (
    internalChromeProfileImportHelper &&
    (macosUpdateHelper || macosUpdateRecovery)
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_INTERNAL_HELPER_CONFLICT",
      message: "Only one internal helper mode may run in a process."
    });
  }
  if (internalChromeProfileImportHelper) {
    await runInternalChromeProfileImportHelper();
    return;
  }
  if (macosUpdateHelper) {
    await runInternalMacosUpdateRelaunchHelper(macosUpdateHelper);
    return;
  }
  await bootstrap(macosUpdateRecovery);
});

void startup.catch(async (error: unknown) => {
  if (internalLaunchContractRequested) {
    app.exit(70);
    return;
  }
  const payload = normalizeRionBridgeError(error, "ELECTRON_STARTUP_FAILED");
  console.error(`[${payload.code}] ${payload.message}`);
  if (!new Set([
    "ELECTRON_CHROMIUM_BOOTSTRAP_CANCELLED",
    "ELECTRON_STARTUP_QUIT_REQUESTED",
    "CHROMIUM_SESSION_MIGRATION_RESUME_CANCELLED",
    "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED"
  ]).has(payload.code)) {
    dialog.showErrorBox(APP_NAME, payload.message);
  }
  await (fatalEventStreamDetected
    ? fatalTerminationCoordinator().forceTerminate()
    : fatalTerminationCoordinator().terminate());
});
