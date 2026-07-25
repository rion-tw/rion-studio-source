import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  Menu,
  nativeTheme,
  screen,
  session as electronSession,
  WebContentsView
} from "electron";

import type {
  CoreCommand,
  CoreCommandResult,
  CoreEffectRequest,
  CoreEvent,
  SystemWebViewRuntimeRegistrationRecord
} from "../../shared/generated";
import {
  RUNTIME_HELPER_MAX_MESSAGE_BYTES,
  RUNTIME_HELPER_PROTOCOL_VERSION,
  type RuntimeHelperChildMessage,
  type RuntimeHelperHostMessage
} from "../../shared/runtimeHelperProtocol";
import type {
  PendingWorkspaceLaunchRequest,
  Role,
  WorkspaceBrowserZoomPercent,
  WorkspaceDisplayInfo,
  WorkspaceLaunchResult
} from "../../shared/types";
import {
  ElectronBrowserRuntime,
  type ElectronBrowserRuntimeOptions,
  createRoleSessionPartition
} from "../browser/ElectronBrowserRuntime";
import { resolveExternalPhysicalBounds } from "../browser/externalPhysicalBounds";
import { createNativeBrowserFontDocumentStartScript } from "../browser/NativeBrowserDocumentStart";
import {
  getMacSystemWebViewSessionStore,
  loadMacSystemWebViewSurfaceFactory
} from "../browser/MacSystemWebViewSurface";
import { createRuntimeTabsPageUrl } from "../browser/runtimeTabsPage";
import { SystemWebViewRuntimePool } from "../browser/SystemWebViewRuntimePool";
import { WebView2AutomationTarget } from "../browser/WebView2AutomationTarget";
import {
  getWindowsWebView2SessionStore,
  loadWindowsWebView2SurfaceFactory,
  type WindowsWebView2SurfacePort
} from "../browser/WindowsWebView2Surface";
import type { WebSurfacePort } from "../browser/ports/WebSurfacePort";
import { ElectronBrowserActionAdapter } from "../core/ElectronBrowserActionAdapter";
import {
  ElectronEffectExecutor,
  ElectronHandleRegistry
} from "../core/ElectronEffectExecutor";
import type { EmbeddedKeyRuntimeClient } from "../core/nativeCore";
import { BrowserProxyApplier } from "../game-browser/BrowserProxyApplier";
import { CdnCompatibilityManager } from "../game-browser/CdnCompatibilityManager";
import { GameCompatibilityManager } from "../games/GameCompatibilityManager";
import { MACRO_OVERLAY_SCRIPT, MacroOverlayInjector } from "../macros/MacroOverlayInjector";
import { RuntimeTabMenuController } from "../menu/RuntimeTabMenu";
import { ElectronProfileEffectAdapter } from "../browser/ElectronProfileEffectAdapter";
import { formatMacroCoordinateClipboard } from "../../shared/macroCoordinates";
import type { RuntimeTabAction } from "../../shared/runtimeTabs";

const configuredToken = process.env.RION_RUNTIME_HELPER_TOKEN;
const configuredUserDataDir = process.env.RION_RUNTIME_HELPER_USER_DATA_DIR;
if (!configuredToken || configuredToken.length < 32 || !configuredUserDataDir) {
  process.stderr.write("Rion runtime helper authentication is missing.\n");
  app.exit(78);
  throw new Error("Rion runtime helper authentication is missing.");
}
const token: string = configuredToken;
const userDataDir: string = configuredUserDataDir;

// stdout is reserved for the authenticated JSON-lines protocol.
console.log = (...values: unknown[]) => console.error(...values);

class RemoteCoreClient implements EmbeddedKeyRuntimeClient {
  private readonly eventListeners = new Set<(events: CoreEvent[]) => void>();
  private readonly pending = new Map<string, {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
  }>();

  invoke<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>> {
    const requestId = randomUUID();
    return new Promise<CoreCommandResult<C>>((resolve, reject) => {
      this.pending.set(requestId, {
        reject,
        resolve: (value) => resolve(value as CoreCommandResult<C>)
      });
      send({ type: "coreInvoke", requestId, command });
    });
  }

  subscribe(listener: (events: CoreEvent[]) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  receive(message: RuntimeHelperHostMessage): void {
    if (message.type === "coreEvents") {
      this.eventListeners.forEach((listener) => listener(message.events));
      return;
    }
    if (message.type !== "coreInvokeResult") return;
    const operation = this.pending.get(message.requestId);
    if (!operation) return;
    this.pending.delete(message.requestId);
    if (message.ok) {
      operation.resolve(message.value);
      return;
    }
    operation.reject(Object.assign(new Error(message.error.message), {
      code: message.error.code
    }));
  }

  close(): void {
    const error = new Error("The Tauri host disconnected.");
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }
}

const core = new RemoteCoreClient();
let executor: ElectronEffectExecutor | undefined;
let runtime: ElectronBrowserRuntime | undefined;
let overlay: MacroOverlayInjector | undefined;
let runtimeMenu: RuntimeTabMenuController | undefined;
const macSessionSurfaces = new Map<string, { surface: WebSurfacePort; window: BaseWindow }>();
const windowsSessionSurfaces = new Map<
  string,
  { surface: WindowsWebView2SurfacePort; window: BaseWindow }
>();

type ChildMessageBody = RuntimeHelperChildMessage extends infer Message
  ? Message extends RuntimeHelperChildMessage
    ? Omit<Message, "protocol" | "token">
    : never
  : never;

function send(message: ChildMessageBody): void {
  const encoded = JSON.stringify({
    ...message,
    protocol: RUNTIME_HELPER_PROTOCOL_VERSION,
    token
  } satisfies RuntimeHelperChildMessage);
  if (Buffer.byteLength(encoded) > RUNTIME_HELPER_MAX_MESSAGE_BYTES) {
    throw new Error("Runtime helper message exceeds the protocol limit.");
  }
  process.stdout.write(`${encoded}\n`);
}

function nativeAddonPath(name: "rion-runtime-tabs.node" | "rion-webview2.node"): string {
  if (app.isPackaged) return join(process.resourcesPath, "native", name);
  const directory = name === "rion-runtime-tabs.node"
    ? `darwin-${process.arch}`
    : `win32-${process.arch}`;
  return join(import.meta.dirname, `../../../build/native/${directory}/${name}`);
}

function workspaceDisplays(): WorkspaceDisplayInfo[] {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    label: display.label || `Display ${display.id}`,
    bounds: display.bounds,
    workArea: display.workArea,
    resolution: display.size,
    scaleFactor: display.scaleFactor,
    isPrimary: display.id === primaryId,
    isInternal: display.internal
  }));
}

function capabilityRegistration(
  available: boolean,
  windows: boolean
): SystemWebViewRuntimeRegistrationRecord {
  const enabled = available ? "supported" as const : "disabled" as const;
  return {
    adapterVersion: windows ? "webview2-napi-6" : "wkwebview-napi-10",
    available,
    capabilitySnapshot: {
      navigation: enabled,
      persistentSession: enabled,
      trustedInput: windows && available ? "supported" : "unsupported",
      backgroundInput: windows && available ? "supported" : "unsupported",
      frameEvaluation: windows && available ? "supported" : available ? "degraded" : "disabled",
      cdnRewrite: windows && available ? "supported" : available ? "unsupported" : "disabled",
      proxy: available ? "degraded" : "disabled",
      popup: enabled,
      audioMute: enabled,
      customFonts: available ? "degraded" : "disabled",
      graphicsTuning: available ? "degraded" : "disabled",
      downloads: enabled,
      fileUpload: enabled,
      permissions: available ? "degraded" : "disabled",
      dialogs: enabled,
      certificateHandling: enabled
    },
    engine: windows ? "webview2" : "wkwebview",
    ...(available ? {} : { failureReason: "runtime-creation-failed" as const }),
    platform: windows ? "windows" : "macos"
  };
}

async function initialize(): Promise<SystemWebViewRuntimeRegistrationRecord> {
  await app.whenReady();
  const handles = new ElectronHandleRegistry();
  const proxy = new BrowserProxyApplier({
    getSettings: () => core.invoke({ type: "gameBrowserSettingsGet" })
  });
  const cdn = new CdnCompatibilityManager({ core, handles });
  const macFactory = process.platform === "darwin"
    ? loadMacSystemWebViewSurfaceFactory(nativeAddonPath("rion-runtime-tabs.node"))
    : undefined;
  const windowsFactory = process.platform === "win32"
    ? loadWindowsWebView2SurfaceFactory(nativeAddonPath("rion-webview2.node"))
    : undefined;
  const systemPool = new SystemWebViewRuntimePool({
    ...(macFactory ? { createMacSurface: macFactory } : {}),
    ...(windowsFactory ? {
      createWindowsSurface: windowsFactory,
      createWindowsAutomationTarget: (
        roleId: string,
        surface: WindowsWebView2SurfacePort
      ) => new WebView2AutomationTarget(surface, core, roleId)
    } : {}),
    platform: process.platform
  });
  const nativeCapability = systemPool.capability();
  const isWindows = nativeCapability.engine === "webview2";
  const systemProbeSession = electronSession.fromPartition("rion-helper-system-cdn-probe", {
    cache: false
  });

  const getMacSessionSurface = (roleId: string, identifier: string) => {
    const current = macSessionSurfaces.get(roleId);
    if (current && !current.window.isDestroyed()) return current;
    if (!macFactory) throw effectError(
      "SYSTEM_SESSION_STORE_UNAVAILABLE",
      "The macOS System WebView session adapter is unavailable."
    );
    const window = new BaseWindow({ height: 1, show: false, skipTaskbar: true, width: 1 });
    const entry = { surface: macFactory(window, { dataStoreIdentifier: identifier }), window };
    macSessionSurfaces.set(roleId, entry);
    return entry;
  };
  const getWindowsSessionSurface = (roleId: string, folder: string) => {
    const current = windowsSessionSurfaces.get(roleId);
    if (current && !current.window.isDestroyed()) return current;
    if (!windowsFactory) throw effectError(
      "SYSTEM_SESSION_STORE_UNAVAILABLE",
      "The Windows System WebView session adapter is unavailable."
    );
    const window = new BaseWindow({ height: 1, show: false, skipTaskbar: true, width: 1 });
    const entry = { surface: windowsFactory(window, { userDataFolder: folder }), window };
    windowsSessionSurfaces.set(roleId, entry);
    return entry;
  };

  runtime = new ElectronBrowserRuntime({
    browserRuntimeState: core,
    embeddedKeyRuntime: core,
    applyBrowserFonts: async (role, partition) => {
      const [paths, settings] = await Promise.all([
        core.invoke({ type: "rolePathsResolve", id: role.id }),
        core.invoke({ type: "gameBrowserSettingsGet" })
      ]);
      await core.invoke({
        type: "browserPreferencesApply",
        browserUserDataDir: paths.electronBrowserUserDataDir,
        roleSessionPartition: partition,
        fonts: settings.fonts
      });
    },
    applyBrowserProxy: (_role, _partition, targetSession) =>
      proxy.applyToSession(targetSession),
    applyCdnCompatibility: async (_role, _partition, targetSession) => {
      await cdn.applyToSession(targetSession);
    },
    createHostWindow: (options) => new BaseWindow(options),
    createRuntimeChromeView: (options) => new WebContentsView(options),
    createTabbedHostWindow: (options) => new BrowserWindow(options),
    createView: (options) => new WebContentsView(options),
    dividerPreloadPath: join(import.meta.dirname, "../../preload/divider.cjs"),
    embeddedPreloadPath: join(import.meta.dirname, "../../preload/embedded.cjs"),
    runtimeTabsPageUrl: createRuntimeTabsPageUrl(),
    runtimeTabsPreloadPath: join(import.meta.dirname, "../../preload/runtime-tabs.cjs"),
    adaptiveZoomResolver: (viewportWidth, currentPercent) =>
      core.invoke({
        type: "layoutAdaptiveZoom",
        viewportWidth,
        ...(currentPercent === undefined ? {} : { currentPercent })
      }).then((value) => value as WorkspaceBrowserZoomPercent),
    workspaceDividerResolver: (roles) => core.invoke({ type: "layoutCreateDividers", roles }),
    workspaceDividerResizeResolver: (input) =>
      core.invoke({ type: "layoutResizeDivider", input }),
    workspaceLayoutResolver: (input) => core.invoke({ type: "layoutResolve", input }),
    getRoleSession: async (role) => role.browserSessionSource === "chrome-profile"
      ? electronSession.fromPath(join(
          (await core.invoke({ type: "rolePathsResolve", id: role.id }))
            .electronBrowserUserDataDir,
          "Default"
        ))
      : undefined,
    getRolePaths: (roleId) => core.invoke({ type: "rolePathsResolve", id: roleId }),
    getNativeSessionConfiguration: async () => {
      const settings = await core.invoke({ type: "gameBrowserSettingsGet" });
      const documentStartScript =
        createNativeBrowserFontDocumentStartScript(settings.fonts);
      await proxy.applyToSession(systemProbeSession);
      const cdnPlan = await cdn.resolvePlanForSession(systemProbeSession);
      if (cdnPlan.enabled && process.platform === "darwin") {
        throw effectError(
          "MAC_CDN_REWRITE_UNSUPPORTED",
          "WKWebView cannot apply the complete active CDN compatibility plan."
        );
      }
      return {
        ...(cdnPlan.enabled ? { cdnRewriteRules: cdnPlan.rewriteRules } : {}),
        ...(documentStartScript ? { documentStartScript } : {}),
        ...(settings.network.proxy.mode === "custom"
          ? { proxyServer: settings.network.proxy.server }
          : {})
      };
    },
    getLaunchWorkArea: () => screen.getPrimaryDisplay().workArea,
    getDefaultLaunchTarget: () => {
      const display = screen.getPrimaryDisplay();
      return { displayId: display.id, workArea: display.workArea };
    },
    getWorkspaceDisplays: workspaceDisplays,
    getWorkspaceAppearanceSettings: () =>
      core.invoke({ type: "gameBrowserSettingsGet" }).then((settings) => settings.workspace),
    persistWorkspaceRoleZoom: async (workspaceId, roleId, browserZoomPercent) => {
      await core.invoke({
        type: "workspaceSetRoleBrowserZoom",
        workspaceId,
        roleId,
        browserZoomPercent
      });
    },
    handleRuntimeTabAction: (window, displayId, action) =>
      dispatchRuntimeTabAction(window, displayId, action),
    platform: process.platform,
    prefersReducedTransparency: () => nativeTheme.prefersReducedTransparency,
    systemRuntimePool: systemPool
  } satisfies ElectronBrowserRuntimeOptions);
  runtime.on("runtimeChange", (state) => {
    send({ type: "shellEvent", event: "runtimeState", payload: state });
  });

  overlay = new MacroOverlayInjector(core);
  runtime.setMacroOverlayInstaller((role, contents) => overlay!.install(role, contents));
  const browserActions = new ElectronBrowserActionAdapter({
    getTarget: (roleId) => runtime?.getEmbeddedAutomationSession(roleId)?.target
  });
  const profile = new ElectronProfileEffectAdapter({
    getEmbeddedSession: (roleId) =>
      electronSession.fromPartition(createRoleSessionPartition(roleId)),
    getImportedSession: (browserUserDataDir) =>
      electronSession.fromPath(join(browserUserDataDir, "Default")),
    getSystemSessionStore: (roleId, paths) => process.platform === "darwin"
      ? getMacSystemWebViewSessionStore(
          getMacSessionSurface(roleId, paths.webkitDataStoreIdentifier).surface
        )
      : getWindowsWebView2SessionStore(
          getWindowsSessionSurface(roleId, paths.webview2UserDataDir).surface
        ),
    verifyEngineSession: async (roleId, engine, launchUrl, paths) => {
      if (engine === "system") {
        const surface = process.platform === "darwin"
          ? getMacSessionSurface(roleId, paths.webkitDataStoreIdentifier).surface
          : getWindowsSessionSurface(roleId, paths.webview2UserDataDir).surface;
        await surface.loadUrl(launchUrl);
        return surface.evaluate<boolean>(
          "document.readyState === 'interactive' || document.readyState === 'complete'"
        );
      }
      const verifier = new BrowserWindow({
        height: 1,
        show: false,
        skipTaskbar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition: createRoleSessionPartition(roleId),
          sandbox: true
        },
        width: 1
      });
      try {
        await verifier.loadURL(launchUrl);
        return true;
      } finally {
        verifier.destroy();
      }
    }
  });
  const compatibility = new GameCompatibilityManager({
    applyCdnCompatibility: (targetSession) => cdn.applyToSession(targetSession).then(() => undefined),
    applyProxy: (targetSession) => proxy.applyToSession(targetSession),
    core,
    createWindow: (options) => new BrowserWindow(options),
    getLaunchWorkArea: () => screen.getPrimaryDisplay().workArea
  });
  executor = new ElectronEffectExecutor(handles, {
    clearSessionStorage: async (handle, storages) => {
      await electronSession.fromPartition(handle.partition).clearStorageData({
        storages: storages as Electron.ClearStorageDataOptions["storages"]
      });
    },
    createView: (optionsJson) =>
      new WebContentsView(JSON.parse(optionsJson) as Electron.WebContentsViewConstructorOptions),
    createWindow: (optionsJson) =>
      new BaseWindow(
        JSON.parse(optionsJson) as Electron.BaseWindowConstructorOptions
      ) as unknown as import("../core/ElectronEffectExecutor").ElectronWindowEffectHandle,
    dispatchResults: async () => ({
      accepted: [],
      duplicate: [],
      late: [],
      operationMismatch: [],
      unknown: []
    }),
    executeBrowserActionEffect: ({ action }) => browserActions.executeEffect(action),
    executeEmbeddedEffect: ({ action }) => runtime!.executeEmbeddedEffect(action),
    executeExternalEffect: async ({ action }) => {
      if (action.type === "externalPrepareSession") {
        const settings = await core.invoke({ type: "gameBrowserSettingsGet" });
        const targetSession = electronSession.fromPartition(
          createRoleSessionPartition(action.roleId)
        );
        await proxy.applyToSession(targetSession);
        return {
          cdnEnabled: await cdn.resolveForSession(targetSession),
          ...(settings.network.proxy.mode === "custom" &&
          settings.network.proxy.server.trim()
            ? { proxyServer: settings.network.proxy.server }
            : {})
        };
      }
      if (action.type === "externalResolvePhysicalBounds") {
        return resolveExternalPhysicalBounds(
          process.platform,
          action.bounds,
          (_window, bounds) => screen.dipToScreenRect(null, bounds)
        );
      }
      return MACRO_OVERLAY_SCRIPT;
    },
    executeOverlayEffect: async ({ action }) => {
      if (action.type === "overlayOpenMacroPage") {
        send({
          type: "shellEvent",
          event: "macroPageRequest",
          payload: { roleId: action.roleId }
        });
        return undefined;
      }
      clipboard.writeText(formatMacroCoordinateClipboard(action.coordinate));
      return undefined;
    },
    executeProfileEffect: ({ action }) => profile.execute(action),
    executeCdnEffect: (effect) => cdn.executeEffect(effect),
    executeCompatibilityEffect: (effect) => compatibility.executeEffect(effect),
    sendDebuggerCommand: async (contents, method, params) => {
      const target = contents as Electron.WebContents;
      if (!target.debugger.isAttached()) target.debugger.attach("1.3");
      return target.debugger.sendCommand(method, params);
    },
    setCookie: async (handle, cookieJson) => {
      await electronSession
        .fromPartition(handle.partition)
        .cookies.set(JSON.parse(cookieJson) as Electron.CookiesSetDetails);
    }
  });

  runtimeMenu = new RuntimeTabMenuController({
    browserManager: runtime,
    getWorkspaceDisplays: workspaceDisplays,
    onWorkspaceDisplaySelectionRequired: (request) => send({
      type: "shellEvent",
      event: "workspaceLaunchRequest",
      payload: request
    }),
    roleStore: {
      getRole: (id: string) => core.invoke({ type: "roleGet", id }),
      listRoles: () => core.invoke({ type: "rolesList" })
    },
    workspaceStore: {
      getWorkspace: (id: string) => core.invoke({ type: "workspaceGet", id }),
      listWorkspaces: () => core.invoke({ type: "workspacesList" })
    },
    workspaceLauncher: {
      launch: async (workspaceId: string, input?: { displayId?: number }) => {
        const selectedDisplay = workspaceDisplays().find(
          (candidate) => candidate.id === input?.displayId
        );
        const target = selectedDisplay
          ? {
              displayId: selectedDisplay.id,
              workArea: selectedDisplay.workArea
            }
          : {
              displayId: screen.getPrimaryDisplay().id,
              workArea: screen.getPrimaryDisplay().workArea
            };
        const statuses = await core.invoke({
          type: "browserWorkspaceLaunch",
          workspaceId,
          target
        });
        return {
          kind: "launched",
          displayId: target.displayId,
          statuses
        } satisfies WorkspaceLaunchResult;
      }
    }
  });
  return capabilityRegistration(nativeCapability.available, isWindows);
}

function dispatchRuntimeTabAction(
  window: BaseWindow,
  displayId: number,
  action: RuntimeTabAction
): void {
  if (!runtime || window.isDestroyed()) return;
  switch (action.type) {
    case "activate":
      void runtime.showRuntimeTab(action.tabId);
      break;
    case "hide":
      void runtime.hideRuntimeTab(action.tabId);
      break;
    case "stop":
      void runtime.stopRuntimeTab(action.tabId);
      break;
    case "move":
      void runtime.moveRuntimeTab(action.tabId, action.displayId);
      break;
    case "reorder":
      runtime.reorderRuntimeTab(action.tabId, action.beforeTabId);
      break;
    case "openLauncher":
      void runtimeMenu?.openLauncher(window, displayId);
      break;
    case "openTabMenu":
      runtimeMenu?.openTabMenu(window, displayId, action.tabId);
      break;
    case "fullscreenToolbarEnter":
      runtime.handleRuntimeToolbarPointer(displayId, true);
      break;
    case "fullscreenToolbarLeave":
      runtime.handleRuntimeToolbarPointer(displayId, false);
      break;
    case "windowControl":
      runtime.handleRuntimeWindowControl(displayId, action.control);
      break;
  }
}

function receive(line: string): void {
  if (Buffer.byteLength(line) > RUNTIME_HELPER_MAX_MESSAGE_BYTES) {
    throw new Error("Runtime helper host message exceeds the protocol limit.");
  }
  const message = JSON.parse(line) as RuntimeHelperHostMessage;
  if (
    message.protocol !== RUNTIME_HELPER_PROTOCOL_VERSION ||
    message.token !== token
  ) {
    throw new Error("Runtime helper host authentication failed.");
  }
  if (message.type === "shutdown") {
    void shutdown();
    return;
  }
  core.receive(message);
  if (message.type !== "effect") return;
  void executor!.execute(message.effect).then(
    (result) => send({ type: "effectResult", result }),
    (error) => send({
      type: "effectResult",
      result: {
        effectId: message.effect.effectId,
        operationId: message.effect.operationId,
        ok: false,
        valueJson: null,
        error: {
          code: "ELECTRON_HELPER_EFFECT_FAILED",
          message: error instanceof Error ? error.message : String(error)
        }
      }
    })
  );
}

async function shutdown(): Promise<void> {
  core.close();
  await overlay?.dispose();
  await executor?.closeAndDrain();
  await runtime?.stopAll().catch(() => undefined);
  macSessionSurfaces.forEach(({ surface, window }) => {
    void surface.destroy();
    if (!window.isDestroyed()) window.close();
  });
  windowsSessionSurfaces.forEach(({ surface, window }) => {
    void surface.destroy();
    if (!window.isDestroyed()) window.close();
  });
  app.exit(0);
}

function effectError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  try {
    receive(line);
  } catch (error) {
    process.stderr.write(`Runtime helper protocol error: ${String(error)}\n`);
    app.exit(78);
  }
});
process.stdin.on("end", () => void shutdown());

void initialize().then((registration) => {
  send({
    type: "ready",
    registration,
    helperVersion: app.getVersion(),
    versions: {
      chromium: process.versions.chrome ?? "unknown",
      electron: process.versions.electron ?? "unknown",
      node: process.versions.node
    }
  });
}).catch((error) => {
  send({
    type: "log",
    level: "error",
    message: error instanceof Error ? error.message : String(error)
  });
  app.exit(70);
});
