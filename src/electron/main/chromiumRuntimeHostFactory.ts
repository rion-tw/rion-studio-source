import { isAbsolute, normalize, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AppKitRuntimeHostIdentityRecord,
  AppKitRuntimeHostObservationRecord,
  BrowserWorkspaceDividerPointerReceiptRecord,
  BrowserWorkspaceDividerPointerRecord,
  ChromiumPopupAdmissionRecord,
  ChromiumPopupNativeHostReceiptRecord,
  EmbeddedLaunchTargetRecord,
  EmbeddedTabEffectRecord,
  RuntimeWindowPreferencesRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { ChromiumRoleSurfaceParentPort } from "./chromiumRoleSurfacePorts";
import type { ChromiumPopupHostLifecycleObserver } from "./chromiumPopupPorts";
import type {
  WindowsChromiumInputBaseWindowPort,
  WindowsChromiumInputRuntimeParentBinding
} from "./windowsChromiumInputSurfaceAttachmentCoordinator";
import type {
  ChromiumRuntimeEmptyHostIdentity,
  ChromiumRuntimeHostFactoryPort,
  ChromiumRuntimeHostPort,
  ChromiumRuntimeHostProjection,
  WindowsRuntimeWindowPlacementObservation
} from "./chromiumRuntimeEffectExecutor";
import type { ChromiumRuntimeWindowStateObserver } from
  "./chromiumRuntimeHostPorts";
import {
  WindowsRuntimeHostChromeController
} from "./windowsRuntimeHostChromeController";
export { WINDOWS_RUNTIME_CHROME_INSET } from
  "./windowsRuntimeHostChromeController";
import type {
  ChromiumRuntimeWindowChromeLayoutProjection,
  ChromiumRuntimeWindowChromeProjection,
  ChromiumRuntimeWindowPresentationRequest
} from "./chromiumRuntimeFullscreenToolbar";
import type { ChromiumRuntimeNativeTabAction } from
  "./chromiumRuntimeNativeWindowController";
import type { ControlledRuntimeTabReloadFence } from
  "./controlledRuntimeTabReload";
import {
  WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL
} from "../../shared/windowsRuntimeHost";
import {
  buildWindowsRuntimeHostWindowOptions,
  canonicalRuntimeHostPreloadPath
} from "./windowsRuntimeHostWindowOptions";
import type {
  ElectronBrowserWindowConstructor,
  RuntimeHostWebContentsEventMap,
  RuntimeHostWindowEventMap,
  WindowsBrowserWindowFactoryPort,
  WindowsRuntimeHostDisplayResolverPort,
  WindowsRuntimeHostWebContentsPort,
  WindowsRuntimeHostWindowPort
} from "./windowsRuntimeHostNativePorts";
import {
  WindowsRuntimeWindowStateStream,
  type WindowsRuntimeForegroundProbePort
} from "./windowsRuntimeWindowState";
import { isChromiumRoleFullscreenShortcut } from
  "./chromiumRoleQuickAccessShortcut";
export {
  buildWindowsRuntimeHostWindowOptions,
  type WindowsRuntimeHostMaterial
} from "./windowsRuntimeHostWindowOptions";
export type {
  WindowsBrowserWindowFactoryPort,
  WindowsRuntimeHostDisplayResolverPort,
  WindowsRuntimeHostWindowPort
} from "./windowsRuntimeHostNativePorts";
export type {
  WindowsRuntimeForegroundProbePort,
  WindowsRuntimeForegroundReadback
} from "./windowsRuntimeWindowState";

type HostState = "opening" | "active" | "closing" | "closed";
type RuntimeHostPlatform = "darwin" | "win32";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Rust/N-API boundary for the retained macOS AppKit runtime host.
 *
 * Implementations must fence logical window ID plus launch/native generation,
 * retain AppKit ownership of tabs, gestures, focus, and input, derive parent-
 * local DIP bounds from NSWindow.contentLayoutRect after subtracting the
 * retained runtime tab chrome/top inset, and resolve close only from the exact
 * matching AppKit window-close event.
 */
export interface MacosAppKitRuntimeHostFactoryPort
  extends ChromiumRuntimeHostFactoryPort {
  readonly nativeHostKind: "rust-napi-appkit";
  applyWindowName: (
    expected: AppKitRuntimeHostIdentityRecord,
    name: string
  ) => Readonly<{
    identity: AppKitRuntimeHostIdentityRecord;
    name: string;
  }>;
  applyWindowPreferences: (
    preferences: RuntimeWindowPreferencesRecord
  ) => void;
  captureHostObservations: (
    windowIds: readonly string[]
  ) => readonly AppKitRuntimeHostObservationRecord[];
  quarantineHost: (
    expected: AppKitRuntimeHostIdentityRecord,
    error: unknown
  ) => void;
  createPopup: (
    admission: ChromiumPopupAdmissionRecord
  ) => Promise<ChromiumRuntimePopupHostHandle>;
}

export interface ChromiumRuntimePopupHostHandle {
  readonly host: ChromiumRuntimeHostPort;
  readonly receipt: ChromiumPopupNativeHostReceiptRecord;
}

export type ChromiumPlatformRuntimeHostFactoryInput =
  | Readonly<{
      platform: "win32";
      browserWindows: WindowsBrowserWindowFactoryPort;
      displays: WindowsRuntimeHostDisplayResolverPort;
      runtimeDocumentPath: string;
      runtimeHostPreloadPath?: string;
      onWindowControl?: (
        windowId: string,
        action: "closeWindow" | "toggleMaximizeWindow"
      ) => Promise<void>;
      onTabControl?: (
        tabId: string,
        action: ChromiumRuntimeNativeTabAction
      ) => Promise<void>;
      lifecycleEpoch?: () => number;
      onTabReload?: (fence: ControlledRuntimeTabReloadFence) => Promise<void>;
      onError?: (error: unknown) => void;
      onWorkspaceDividerPointer?: (
        event: BrowserWorkspaceDividerPointerRecord
      ) => Promise<BrowserWorkspaceDividerPointerReceiptRecord>;
      onRuntimeWindowPlacement?: (host: ChromiumRuntimeHostPort) => Promise<void>;
      onRuntimeTabFullscreen?: (tabId: string) => void;
      runtimeForegroundProbe?: WindowsRuntimeForegroundProbePort;
    }>
  | Readonly<{
      platform: "darwin";
      appKit?: MacosAppKitRuntimeHostFactoryPort;
    }>;

interface WindowsHostListeners {
  readonly beforeInputEvent: RuntimeHostWebContentsEventMap["before-input-event"];
  readonly blurred: () => void;
  readonly close: RuntimeHostWindowEventMap["close"];
  readonly closed: () => void;
  readonly didFailLoad: RuntimeHostWebContentsEventMap["did-fail-load"];
  readonly didFinishLoad: RuntimeHostWebContentsEventMap["did-finish-load"];
  readonly enteredFullScreen: () => void;
  readonly focused: () => void;
  readonly hidden: () => void;
  readonly ipcMessage: RuntimeHostWebContentsEventMap["ipc-message"];
  readonly leftFullScreen: () => void;
  readonly maximized: () => void;
  readonly minimized: () => void;
  readonly moved: () => void;
  readonly readyToShow: () => void;
  readonly resized: () => void;
  readonly restored: () => void;
  readonly renderProcessGone: RuntimeHostWebContentsEventMap["render-process-gone"];
  readonly shown: () => void;
  readonly unresponsive: () => void;
  readonly unmaximized: () => void;
  readonly willAttachWebview: RuntimeHostWebContentsEventMap["will-attach-webview"];
  readonly willNavigate: RuntimeHostWebContentsEventMap["will-navigate"];
  readonly willRedirect: RuntimeHostWebContentsEventMap["will-redirect"];
}

interface WindowsHostRecord {
  readonly logicalWindowId: string;
  readonly launchGeneration: string;
  readonly nativeGeneration: number;
  readonly ownerRevision: string;
  readonly target: EmbeddedLaunchTargetRecord;
  readonly native: WindowsRuntimeHostWindowPort;
  readonly nativeId: number;
  readonly documentUrl: string;
  readonly creation: Deferred<ChromiumRuntimeHostPort>;
  readonly closed: Deferred<void>;
  host: ChromiumRuntimeHostPort;
  listeners: WindowsHostListeners;
  state: HostState;
  documentReady: boolean;
  presentationReady: boolean;
  readyToShow: boolean;
  closePromise: Promise<void> | null;
  creationError: RionBridgeError | null;
  readonly popupId: string | null;
  popupObserver: ChromiumPopupHostLifecycleObserver | null;
  chrome: WindowsRuntimeHostChromeController;
  windowState: WindowsRuntimeWindowStateStream;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function hostError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw hostError(code, message);
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    fail(
      "ELECTRON_RUNTIME_HOST_ID_INVALID",
      `Core supplied an invalid ${field} identity for the runtime host.`
    );
  }
  return value;
}

function requireBounds(
  bounds: ChromiumRoleSurfaceBounds,
  field: string,
  minimumWidth = 1,
  minimumHeight = 1
): void {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.width < minimumWidth ||
    bounds.height < minimumHeight ||
    !Number.isSafeInteger(bounds.x + bounds.width) ||
    !Number.isSafeInteger(bounds.y + bounds.height)
  ) {
    fail(
      "ELECTRON_RUNTIME_HOST_BOUNDS_INVALID",
      `Core supplied invalid ${field} bounds for the runtime host.`
    );
  }
}

function stableTargetEquals(
  left: EmbeddedLaunchTargetRecord,
  right: EmbeddedLaunchTargetRecord
): boolean {
  return left.windowId === right.windowId &&
    left.persistedName === right.persistedName &&
    left.displayId === right.displayId &&
    left.scaleFactor === right.scaleFactor &&
    left.presentation === right.presentation &&
    left.bounds.x === right.bounds.x &&
    left.bounds.y === right.bounds.y &&
    left.bounds.width === right.bounds.width &&
    left.bounds.height === right.bounds.height &&
    left.workArea.x === right.workArea.x &&
    left.workArea.y === right.workArea.y &&
    left.workArea.width === right.workArea.width &&
    left.workArea.height === right.workArea.height;
}

function validateRuntimeHostRequest(
  target: EmbeddedLaunchTargetRecord,
  initialTab: EmbeddedTabEffectRecord
): string {
  requireIdentifier(initialTab.tabId, "tab");
  const launchGeneration = requireIdentifier(
    initialTab.attemptGeneration,
    "launch-generation"
  );
  if (!stableTargetEquals(target, initialTab.target)) {
    fail(
      "ELECTRON_RUNTIME_HOST_TARGET_MISMATCH",
      "The initial tab target does not match the runtime host target."
    );
  }
  validateRuntimeHostTarget(target);
  return launchGeneration;
}

function validateRuntimeHostTarget(target: EmbeddedLaunchTargetRecord): void {
  requireIdentifier(target.windowId, "window");
  if (
    !Number.isSafeInteger(target.displayId) ||
    !Number.isFinite(target.scaleFactor) ||
    target.scaleFactor <= 0 ||
    target.scaleFactor > 8 ||
    !(["normal", "maximized", "fullscreen"] as const).includes(
      target.presentation
    )
  ) {
    fail(
      "ELECTRON_RUNTIME_HOST_DISPLAY_INVALID",
      "Core supplied invalid display metrics for the runtime host."
    );
  }
  requireBounds(target.workArea, "display work-area");
  requireBounds(target.bounds, "window", 640, 480);
  const workAreaRight = target.workArea.x + target.workArea.width;
  const workAreaBottom = target.workArea.y + target.workArea.height;
  if (
    target.bounds.x < target.workArea.x ||
    target.bounds.y < target.workArea.y ||
    target.bounds.x + target.bounds.width > workAreaRight ||
    target.bounds.y + target.bounds.height > workAreaBottom
  ) {
    fail(
      "ELECTRON_RUNTIME_HOST_BOUNDS_INVALID",
      "The runtime host bounds must remain inside the Rust-resolved work area."
    );
  }
  if (
    target.persistedName !== undefined &&
    (
      target.persistedName.length === 0 ||
      target.persistedName !== target.persistedName.trim() ||
      [...target.persistedName].some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || codePoint === 0x7f;
      })
    )
  ) {
    fail(
      "ELECTRON_RUNTIME_HOST_TITLE_INVALID",
      "Core supplied an invalid persisted runtime-window title."
    );
  }
}

function validateEmptyRuntimeHostRequest(
  target: EmbeddedLaunchTargetRecord,
  identity: ChromiumRuntimeEmptyHostIdentity
): string {
  validateRuntimeHostTarget(target);
  const launchGeneration = requireIdentifier(
    identity.attemptGeneration,
    "launch-generation"
  );
  if (
    !Number.isSafeInteger(identity.windowGeneration) ||
    identity.windowGeneration < 1 ||
    !Number.isSafeInteger(identity.topologyRevision) ||
    identity.topologyRevision < 1
  ) {
    fail(
      "ELECTRON_RUNTIME_HOST_CORE_FENCE_MISSING",
      "The empty runtime host is missing its positive Rust-owned generation or revision."
    );
  }
  return launchGeneration;
}

export function validateChromiumPopupHostAdmission(
  admission: ChromiumPopupAdmissionRecord
): void {
  if (
    !admission ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(admission.popupId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(admission.openOperationId) ||
    admission.lifecycleRevision !== 1 ||
    admission.creationUrl !== "about:blank" ||
    admission.openerPolicy !== "isolatedNoopener" ||
    admission.disposition !== "newWindow" ||
    admission.target.windowId !== `popup-${admission.popupId}` ||
    admission.title.length === 0 || admission.title.length > 256
  ) {
    fail(
      "ELECTRON_CHROMIUM_POPUP_ADMISSION_INVALID",
      "An exact Rust-owned popup host admission is required."
    );
  }
  validateRuntimeHostTarget(admission.target);
}

function validatePopupObserver(
  observer: ChromiumPopupHostLifecycleObserver
): void {
  if (
    !observer || typeof observer.closeRequested !== "function" ||
    typeof observer.closed !== "function" ||
    typeof observer.layoutChanged !== "function"
  ) {
    fail(
      "ELECTRON_CHROMIUM_POPUP_OBSERVER_INVALID",
      "The controlled popup requires exact native lifecycle observers."
    );
  }
}

function canonicalRuntimeDocumentPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    parse(value).base !== "runtime-windows-host.html"
  ) {
    fail(
      "ELECTRON_RUNTIME_HOST_DOCUMENT_INVALID",
      "A canonical packaged Windows runtime-host document is required."
    );
  }
  return value;
}

function installDenyByDefaultPolicy(contents: WindowsRuntimeHostWebContentsPort): void {
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  contents.session.setDevicePermissionHandler(() => false);
  contents.session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  contents.session.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: false });
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function windowsInputParent(
  native: WindowsRuntimeHostWindowPort
): WindowsChromiumInputBaseWindowPort | null {
  const candidate = native as unknown as Record<string, unknown>;
  const contentView = candidate.contentView as
    { readonly children?: unknown } | undefined;
  const methods = [
    "destroy", "getBounds", "getContentBounds", "getNativeWindowHandle",
    "hide", "isDestroyed", "isVisible", "on", "removeListener", "setBounds",
    "showInactive"
  ];
  if (!contentView || !Array.isArray(contentView.children) ||
      methods.some((method) => typeof candidate[method] !== "function")) {
    return null;
  }
  return native as unknown as WindowsChromiumInputBaseWindowPort;
}

/**
 * Windows-only native host for the Chromium transition.
 *
 * macOS deliberately does not use this implementation: its runtime window,
 * tabs, gestures, and input remain owned by the Rust/N-API AppKit adapter.
 */
export class WindowsElectronChromiumRuntimeHostFactory
implements ChromiumRuntimeHostFactoryPort {
  readonly #windows: WindowsBrowserWindowFactoryPort;
  readonly #displays: WindowsRuntimeHostDisplayResolverPort;
  readonly #runtimeDocumentPath: string;
  readonly #runtimeDocumentUrl: string;
  readonly #runtimeHostPreloadPath: string;
  readonly #onWindowControl: (
    windowId: string,
    action: "closeWindow" | "toggleMaximizeWindow"
  ) => Promise<void>;
  readonly #onTabControl: (
    tabId: string,
    action: ChromiumRuntimeNativeTabAction
  ) => Promise<void>;
  readonly #lifecycleEpoch: () => number;
  readonly #onTabReload: (fence: ControlledRuntimeTabReloadFence) => Promise<void>;
  readonly #onCommandError: (error: unknown) => void;
  readonly #onWorkspaceDividerPointer: (
    event: BrowserWorkspaceDividerPointerRecord
  ) => Promise<BrowserWorkspaceDividerPointerReceiptRecord>;
  readonly #onRuntimeWindowPlacement: ((
    host: ChromiumRuntimeHostPort
  ) => Promise<void>) | null;
  readonly #onRuntimeTabFullscreen: (tabId: string) => void;
  readonly #runtimeForegroundProbe: WindowsRuntimeForegroundProbePort | null;
  #windowPreferences: RuntimeWindowPreferencesRecord = Object.freeze({
    alwaysHideTabCloseButton: false,
    alwaysShowToolbarInFullScreen: false,
    restoreGameWindowsOnStartup: false
  });
  readonly #activeByLogicalWindow = new Map<string, WindowsHostRecord>();
  readonly #ownerByNativeId = new Map<number, WindowsHostRecord>();
  readonly #ownerByNativeWindow = new WeakMap<object, WindowsHostRecord>();
  readonly #lastNativeGeneration = new Map<string, number>();
  #lastOwnerRevision = 0n;

  constructor(
    windows: WindowsBrowserWindowFactoryPort,
    runtimeDocumentPath: string,
    displays: WindowsRuntimeHostDisplayResolverPort,
    runtimeHostPreloadPath = resolve(
      parse(runtimeDocumentPath).dir,
      "../preload/runtimeWindowsHost.cjs"
    ),
    onWindowControl: (
      windowId: string,
      action: "closeWindow" | "toggleMaximizeWindow"
    ) => Promise<void> = () => Promise.reject(hostError(
      "ELECTRON_RUNTIME_HOST_WINDOW_CONTROL_UNAVAILABLE",
      "The Core-owned Windows control lane is unavailable."
    )),
    onWorkspaceDividerPointer: (
      event: BrowserWorkspaceDividerPointerRecord
    ) => Promise<BrowserWorkspaceDividerPointerReceiptRecord> = () =>
      Promise.reject(hostError(
        "ELECTRON_RUNTIME_HOST_WORKSPACE_DIVIDER_UNAVAILABLE",
        "The Core-owned Windows workspace-divider lane is unavailable."
      )),
    onTabControl: (
      tabId: string,
      action: ChromiumRuntimeNativeTabAction
    ) => Promise<void> = () => Promise.reject(hostError(
      "ELECTRON_RUNTIME_HOST_TAB_CONTROL_UNAVAILABLE",
      "The Core-owned Windows tab control lane is unavailable."
    )),
    onRuntimeWindowPlacement?: (host: ChromiumRuntimeHostPort) => Promise<void>,
    onTabReload?: (fence: ControlledRuntimeTabReloadFence) => Promise<void>,
    lifecycleEpoch?: () => number,
    onCommandError?: (error: unknown) => void,
    runtimeForegroundProbe?: WindowsRuntimeForegroundProbePort,
    onRuntimeTabFullscreen?: (tabId: string) => void
  ) {
    this.#windows = windows;
    this.#displays = displays;
    this.#runtimeDocumentPath = canonicalRuntimeDocumentPath(runtimeDocumentPath);
    this.#runtimeDocumentUrl = pathToFileURL(this.#runtimeDocumentPath).href;
    this.#runtimeHostPreloadPath = canonicalRuntimeHostPreloadPath(
      runtimeHostPreloadPath
    );
    this.#onWindowControl = onWindowControl;
    this.#onWorkspaceDividerPointer = onWorkspaceDividerPointer;
    this.#onTabControl = onTabControl;
    this.#onRuntimeWindowPlacement = onRuntimeWindowPlacement ?? null;
    this.#onTabReload = onTabReload ?? (() => Promise.reject(hostError(
      "ELECTRON_RUNTIME_HOST_TAB_RELOAD_UNAVAILABLE",
      "The controlled Windows Reload lane is unavailable."
    )));
    this.#lifecycleEpoch = lifecycleEpoch ?? (() => 1);
    this.#onCommandError = onCommandError ?? (() => undefined);
    this.#runtimeForegroundProbe = runtimeForegroundProbe ?? null;
    this.#onRuntimeTabFullscreen = onRuntimeTabFullscreen ?? (() => {
      throw hostError(
        "ELECTRON_RUNTIME_HOST_FULLSCREEN_UNAVAILABLE",
        "The Core-owned Windows fullscreen shortcut lane is unavailable."
      );
    });
  }

  static fromElectronBrowserWindow(
    BrowserWindowConstructor: ElectronBrowserWindowConstructor,
    runtimeDocumentPath: string,
    displays: WindowsRuntimeHostDisplayResolverPort,
    runtimeHostPreloadPath: string,
    onWindowControl?: (
      windowId: string,
      action: "closeWindow" | "toggleMaximizeWindow"
    ) => Promise<void>,
    onWorkspaceDividerPointer?: (
      event: BrowserWorkspaceDividerPointerRecord
    ) => Promise<BrowserWorkspaceDividerPointerReceiptRecord>,
    onTabControl?: (
      tabId: string,
      action: ChromiumRuntimeNativeTabAction
    ) => Promise<void>,
    onRuntimeWindowPlacement?: (host: ChromiumRuntimeHostPort) => Promise<void>,
    onTabReload?: (fence: ControlledRuntimeTabReloadFence) => Promise<void>,
    lifecycleEpoch?: () => number,
    onCommandError?: (error: unknown) => void,
    runtimeForegroundProbe?: WindowsRuntimeForegroundProbePort,
    onRuntimeTabFullscreen?: (tabId: string) => void
  ): WindowsElectronChromiumRuntimeHostFactory {
    return new WindowsElectronChromiumRuntimeHostFactory({
      create: (options) => new BrowserWindowConstructor(options) as unknown as
        WindowsRuntimeHostWindowPort
    }, runtimeDocumentPath, displays, runtimeHostPreloadPath, onWindowControl,
    onWorkspaceDividerPointer, onTabControl, onRuntimeWindowPlacement,
    onTabReload, lifecycleEpoch, onCommandError, runtimeForegroundProbe,
    onRuntimeTabFullscreen);
  }

  async applyWindowPreferences(
    preferences: RuntimeWindowPreferencesRecord
  ): Promise<void> {
    if (typeof preferences.alwaysShowToolbarInFullScreen !== "boolean") {
      fail(
        "ELECTRON_RUNTIME_HOST_PREFERENCES_INVALID",
        "Core supplied invalid runtime-window preferences."
      );
    }
    const prior = this.#windowPreferences;
    const applied: WindowsHostRecord[] = [];
    try {
      for (const record of this.#activeByLogicalWindow.values()) {
        if (record.state !== "active") continue;
        await record.chrome.applyPreferences(preferences);
        applied.push(record);
      }
      this.#windowPreferences = Object.freeze({ ...preferences });
    } catch (error) {
      const failures: unknown[] = [];
      for (const record of applied.reverse()) {
        try {
          await record.chrome.applyPreferences(prior);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length > 0) {
        throw hostError(
          "ELECTRON_RUNTIME_HOST_PREFERENCES_COMPENSATION_FAILED",
          "A Windows runtime host could not compensate its toolbar preference."
        );
      }
      throw error;
    }
  }

  create(
    target: EmbeddedLaunchTargetRecord,
    initialTab: EmbeddedTabEffectRecord
  ): Promise<ChromiumRuntimeHostPort> {
    const launchGeneration = validateRuntimeHostRequest(target, initialTab);
    return this.#createHost(target, launchGeneration);
  }

  createEmpty(
    target: EmbeddedLaunchTargetRecord,
    identity: ChromiumRuntimeEmptyHostIdentity
  ): Promise<ChromiumRuntimeHostPort> {
    const launchGeneration = validateEmptyRuntimeHostRequest(target, identity);
    return this.#createHost(target, launchGeneration).then(async (host) => {
      if (host.isVisible()) {
        await host.close();
        throw hostError(
          "ELECTRON_RUNTIME_EMPTY_HOST_VISIBLE",
          "The provisional Windows runtime host became visible before Core moved a tab."
        );
      }
      return host;
    });
  }

  async createPopup(
    admission: ChromiumPopupAdmissionRecord
  ): Promise<ChromiumRuntimePopupHostHandle> {
    validateChromiumPopupHostAdmission(admission);
    const host = await this.#createHost(
      admission.target,
      admission.openOperationId,
      admission.popupId
    );
    if (host.isVisible()) {
      await host.close();
      throw hostError(
        "ELECTRON_CHROMIUM_POPUP_HOST_VISIBLE",
        "The provisional Windows popup host became visible before Core native-ready."
      );
    }
    return Object.freeze({
      host,
      receipt: Object.freeze({
        platform: "windows",
        nativeHostId: host.id,
        logicalWindowId: admission.target.windowId,
        windowGeneration: 1,
        topologyRevision: 1
      })
    });
  }

  resolveInputParent(
    parent: ChromiumRoleSurfaceParentPort
  ): WindowsChromiumInputRuntimeParentBinding | null {
    const record = this.#ownerByNativeId.get(parent.id);
    if (
      !record || record.host !== parent || record.state !== "active" ||
      record.native.isDestroyed() ||
      this.#activeByLogicalWindow.get(record.logicalWindowId) !== record ||
      this.#ownerByNativeWindow.get(record.native) !== record
    ) {
      return null;
    }
    const window = windowsInputParent(record.native);
    if (!window) return null;
    return Object.freeze({
      identity: Object.freeze({
        nativeGeneration: record.nativeGeneration,
        ownerRevision: record.ownerRevision
      }),
      logicalParent: record.host,
      window
    });
  }

  #createHost(
    target: EmbeddedLaunchTargetRecord,
    launchGeneration: string,
    popupId: string | null = null
  ): Promise<ChromiumRuntimeHostPort> {
    if (this.#activeByLogicalWindow.has(target.windowId)) {
      fail(
        "ELECTRON_RUNTIME_HOST_OWNERSHIP_CONFLICT",
        "The logical runtime window already owns a native Windows host."
      );
    }
    const nativeGeneration = this.#nextNativeGeneration(target.windowId);
    let native: WindowsRuntimeHostWindowPort;
    try {
      native = this.#windows.create(buildWindowsRuntimeHostWindowOptions(
        target,
        this.#runtimeHostPreloadPath
      ));
    } catch {
      try {
        native = this.#windows.create(buildWindowsRuntimeHostWindowOptions(
          target,
          this.#runtimeHostPreloadPath,
          "opaque"
        ));
      } catch {
        fail(
          "ELECTRON_RUNTIME_HOST_CREATE_FAILED",
          "Electron could not create the native Windows runtime host."
        );
      }
    }
    const nativeId = native.id;
    if (
      !Number.isSafeInteger(nativeId) ||
      nativeId < 1 ||
      native.isDestroyed()
    ) {
      fail(
        "ELECTRON_RUNTIME_HOST_CREATE_FAILED",
        "Electron returned an invalid native Windows runtime host."
      );
    }

    const record = this.#buildRecord(
      target,
      launchGeneration,
      nativeGeneration,
      this.#nextOwnerRevision(),
      native,
      nativeId,
      popupId
    );
    const nativeOwner = this.#ownerByNativeWindow.get(native);
    const idOwner = this.#ownerByNativeId.get(nativeId);
    if (nativeOwner || idOwner) {
      return this.#rejectNativeAlias(record, nativeOwner ?? idOwner!);
    }
    this.#activeByLogicalWindow.set(target.windowId, record);
    this.#ownerByNativeWindow.set(native, record);
    this.#ownerByNativeId.set(nativeId, record);
    this.#installListeners(record);

    if (native.webContents.session.storagePath !== null) {
      this.#failCreation(
        record,
        "ELECTRON_RUNTIME_HOST_SESSION_PERSISTENT",
        "The Windows runtime shell must use its non-persistent dedicated session."
      );
      return record.creation.promise;
    }
    try {
      installDenyByDefaultPolicy(native.webContents);
      void record.chrome.applyPreferences(this.#windowPreferences).catch((error) => {
        this.#failCreation(
          record,
          "ELECTRON_RUNTIME_HOST_PREFERENCES_APPLY_FAILED",
          error instanceof Error ? error.message : "Windows toolbar preferences failed."
        );
      });
      this.#applyInitialPresentation(record);
      const load = native.loadFile(this.#runtimeDocumentPath);
      // EventBound: exact native events, never the loadFile Promise, settle creation.
      void load.catch(() => undefined);
    } catch {
      this.#failCreation(
        record,
        "ELECTRON_RUNTIME_HOST_SUBMISSION_FAILED",
        "Electron could not submit the secure Windows runtime host creation."
      );
    }
    return record.creation.promise;
  }

  #buildRecord(
    target: EmbeddedLaunchTargetRecord,
    launchGeneration: string,
    nativeGeneration: number,
    ownerRevision: string,
    native: WindowsRuntimeHostWindowPort,
    nativeId: number,
    popupId: string | null
  ): WindowsHostRecord {
    const record: WindowsHostRecord = {
      logicalWindowId: target.windowId,
      launchGeneration,
      nativeGeneration,
      ownerRevision,
      target,
      native,
      nativeId,
      documentUrl: this.#runtimeDocumentUrl,
      creation: deferred<ChromiumRuntimeHostPort>(),
      closed: deferred<void>(),
      host: undefined as unknown as ChromiumRuntimeHostPort,
      listeners: undefined as unknown as WindowsHostListeners,
      state: "opening" as HostState,
      documentReady: false,
      presentationReady: target.presentation === "normal",
      readyToShow: false,
      closePromise: null,
      creationError: null,
      popupId,
      popupObserver: null,
      chrome: undefined as unknown as WindowsRuntimeHostChromeController,
      windowState: undefined as unknown as WindowsRuntimeWindowStateStream
    };
    record.chrome = new WindowsRuntimeHostChromeController({
      documentUrl: record.documentUrl,
      native,
      readProjection: () => this.#readProjection(record),
      requestWindowControl: (action) => this.#onWindowControl(
        record.logicalWindowId,
        action
      ),
      requestTabControl: this.#onTabControl,
      requestTabReload: this.#onTabReload,
      readLifecycleEpoch: this.#lifecycleEpoch,
      requestWorkspaceDividerPointer: this.#onWorkspaceDividerPointer,
      nativeHostId: record.nativeId,
      hostGeneration: record.nativeGeneration,
      send: (channel, projection) => native.webContents.send(channel, projection),
      windowId: record.logicalWindowId
    });
    record.windowState = new WindowsRuntimeWindowStateStream({
      lifecycleEpoch: this.#lifecycleEpoch,
      logicalWindowId: record.logicalWindowId,
      native,
      nativeGeneration: record.nativeGeneration,
      nativeHostId: record.nativeId,
      probe: this.#runtimeForegroundProbe,
      readCoreFence: () => record.chrome.readObservation(),
      isCurrent: () => record.state === "active" &&
        !native.isDestroyed() &&
        this.#activeByLogicalWindow.get(record.logicalWindowId) === record &&
        this.#ownerByNativeId.get(record.nativeId) === record,
      onError: this.#onCommandError
    });
    record.host = Object.freeze({
      id: nativeId,
      logicalWindowId: target.windowId,
      contentView: native.contentView,
      close: () => this.#close(record),
      focus: () => this.#withCurrent(record, () => native.focus()),
      hide: () => this.#withCurrent(record, () => native.hide()),
      getContentBounds: () => this.#contentBounds(record),
      readProjection: () => this.#withCurrent(
        record,
        () => this.#readProjection(record)
      ),
      isDestroyed: () =>
        record.state === "closed" || native.isDestroyed() ||
        this.#activeByLogicalWindow.get(record.logicalWindowId) !== record,
      isVisible: () => this.#withCurrent(record, () => native.isVisible()),
      show: () => this.#withCurrent(record, () => native.show()),
      showInactive: () => this.#withCurrent(record, () => native.showInactive()),
      bindRuntimeWindowState: (observer: ChromiumRuntimeWindowStateObserver) =>
        this.#withCurrent(
          record,
          () => record.windowState.bind(observer)
        ),
      readRuntimeWindowState: () => this.#withCurrent(
        record,
        () => record.windowState.read()
      ),
      applyWindowsChromeProjection: (
        projection: ChromiumRuntimeWindowChromeProjection
      ) => this.#withCurrent(
        record,
        () => record.chrome.applyCoreProjection(projection)
      ),
      applyWindowsChromeLayoutProjection: (
        projection: ChromiumRuntimeWindowChromeLayoutProjection
      ) => this.#withCurrent(
        record,
        () => record.chrome.applyRetainedPhaseLayoutProjection(projection)
      ),
      bindRuntimeWindowLayout: (observer: () => Promise<void>) => this.#withCurrent(
        record,
        () => record.chrome.bindLayout(observer)
      ),
      bindRuntimeWindowPlacement: (observer: () => Promise<void>) =>
        this.#withCurrent(record, () => record.chrome.bindPlacement(observer)),
      readRuntimeWindowPlacement: () => this.#withCurrent(
        record,
        () => this.#readPlacementObservation(record)
      ),
      readFullscreenToolbar: () => this.#withCurrent(
        record,
        () => record.chrome.readObservation()
      ),
      setRuntimeWindowPresentation: (
        request: ChromiumRuntimeWindowPresentationRequest
      ) => this.#withCurrent(
        record,
        () => record.chrome.setPresentation(request)
      ),
      ...(popupId
        ? {
            bindPopupLifecycle: (observer: ChromiumPopupHostLifecycleObserver) =>
              this.#withCurrent(record, () => {
                validatePopupObserver(observer);
                if (record.popupObserver) {
                  fail(
                    "ELECTRON_CHROMIUM_POPUP_OBSERVER_ALREADY_BOUND",
                    "The Windows popup host lifecycle observer is already bound."
                  );
                }
                record.popupObserver = observer;
              })
          }
        : {})
    });
    if (this.#onRuntimeWindowPlacement) {
      record.chrome.bindPlacement(() => this.#onRuntimeWindowPlacement!(record.host));
    }
    record.listeners = {
      beforeInputEvent: (event, input) => {
        if (!isChromiumRoleFullscreenShortcut(input, "win32")) return;
        // Own both halves above Chromium's default F11 BrowserWindow toggle.
        event.preventDefault();
        if (input.type !== "keyDown" || input.isAutoRepeat) return;
        try {
          const tabId = record.chrome.readActiveTabId();
          if (record.state !== "active" || !tabId) {
            throw hostError(
              "ELECTRON_RUNTIME_HOST_FULLSCREEN_TARGET_UNAVAILABLE",
              "The Windows fullscreen shortcut has no exact active runtime tab."
            );
          }
          this.#onRuntimeTabFullscreen(tabId);
        } catch (error) {
          this.#onCommandError(error);
        }
      },
      blurred: () => record.windowState.publish("blur"),
      close: (event) => {
        if (record.state === "closing" || record.state === "closed") return;
        event.preventDefault();
        if (record.popupId && record.state === "active") {
          record.popupObserver?.closeRequested();
        }
      },
      closed: () => this.#onClosed(record),
      didFailLoad: (
        _event,
        _errorCode,
        _errorDescription,
        _validatedUrl,
        isMainFrame
      ) => {
        if (isMainFrame) {
          this.#failCreation(
            record,
            "ELECTRON_RUNTIME_HOST_LOAD_FAILED",
            "The packaged Windows runtime-host document failed to load."
          );
        }
      },
      didFinishLoad: () => this.#onDidFinishLoad(record),
      enteredFullScreen: () => {
        if (record.target.presentation === "fullscreen") {
          record.presentationReady = true;
          this.#completeCreationIfReady(record);
        }
        void record.chrome.nativePresentationChanged().catch((error) =>
          this.#onPresentationFailure(record, error)
        );
      },
      focused: () => record.windowState.publish("focus"),
      hidden: () => record.windowState.publish("hide"),
      leftFullScreen: () => {
        void record.chrome.nativePresentationChanged().catch((error) =>
          this.#onPresentationFailure(record, error)
        );
      },
      maximized: () => {
        if (record.target.presentation === "maximized") {
          record.presentationReady = true;
          this.#completeCreationIfReady(record);
        }
        void record.chrome.nativePresentationChanged().catch((error) =>
          this.#onPresentationFailure(record, error)
        );
      },
      minimized: () => {
        record.chrome.nativeMinimized();
        record.windowState.publish("minimize");
      },
      unmaximized: () => {
        void record.chrome.nativePresentationChanged().catch((error) =>
          this.#onPresentationFailure(record, error)
        );
      },
      ipcMessage: (_event, channel, ...args) => {
        if (channel !== WINDOWS_RUNTIME_HOST_COMMAND_CHANNEL || args.length !== 1) {
          return;
        }
        void record.chrome.handleCommand(
          native.webContents.getURL(),
          args[0]
        ).catch((error) => this.#onCommandError(error));
      },
      moved: () => this.#publishNativeLayout(record),
      readyToShow: () => {
        record.readyToShow = true;
        this.#completeCreationIfReady(record);
      },
      resized: () => this.#publishNativeLayout(record),
      restored: () => record.windowState.publish("restore"),
      renderProcessGone: () => {
        if (record.state === "active") {
          record.windowState.fail("ELECTRON_RUNTIME_HOST_RENDERER_GONE");
        }
        this.#failCreation(
          record,
          "ELECTRON_RUNTIME_HOST_RENDERER_GONE",
          "The Windows runtime-host renderer exited during creation."
        );
      },
      shown: () => record.windowState.publish("show"),
      unresponsive: () => {
        if (record.state === "active") {
          record.windowState.fail("ELECTRON_RUNTIME_HOST_UNRESPONSIVE");
        }
        this.#failCreation(
          record,
          "ELECTRON_RUNTIME_HOST_UNRESPONSIVE",
          "The Windows runtime host became unresponsive during creation."
        );
      },
      willAttachWebview: (event) => event.preventDefault(),
      willNavigate: (event) => event.preventDefault(),
      willRedirect: (event) => event.preventDefault()
    };
    return record;
  }

  #readProjection(record: WindowsHostRecord): ChromiumRuntimeHostProjection {
    const normalBounds = record.native.getNormalBounds();
    requireBounds(normalBounds, "normal window", 640, 480);
    const liveBounds = record.native.getBounds();
    requireBounds(liveBounds, "live window");
    // A maximized/fullscreen BrowserWindow can move to another display while
    // Electron intentionally retains its restore geometry in getNormalBounds().
    // Display ownership therefore comes from the actual live native rectangle;
    // the projection still publishes normalBounds as the durable restore target.
    const display = this.#displays.displayMatching(liveBounds);
    if (!Number.isSafeInteger(display.id)) {
      fail(
        "ELECTRON_RUNTIME_HOST_DISPLAY_INVALID",
        "Electron returned an invalid display for the Windows runtime host."
      );
    }
    requireBounds(display.workArea, "display work-area");
    const presentation = record.native.isFullScreen()
      ? "fullscreen" as const
      : record.native.isMaximized()
        ? "maximized" as const
        : "normal" as const;
    return Object.freeze({
      displayId: display.id,
      bounds: Object.freeze({ ...normalBounds }),
      visible: record.native.isVisible(),
      focused: record.native.isFocused(),
      presentation
    });
  }

  #readPlacementObservation(
    record: WindowsHostRecord
  ): WindowsRuntimeWindowPlacementObservation {
    const normalBounds = record.native.getNormalBounds();
    requireBounds(normalBounds, "normal window", 640, 480);
    const liveBounds = record.native.getBounds();
    requireBounds(liveBounds, "live window");
    const display = this.#displays.displayMatching(liveBounds);
    if (!Number.isSafeInteger(display.id)) {
      fail(
        "ELECTRON_RUNTIME_HOST_DISPLAY_INVALID",
        "Electron returned an invalid display for the Windows runtime host."
      );
    }
    requireBounds(display.workArea, "display work-area");
    const chrome = record.chrome.readObservation();
    return Object.freeze({
      nativeHostId: record.nativeId,
      nativeGeneration: record.nativeGeneration,
      windowId: record.logicalWindowId,
      windowGeneration: chrome.windowGeneration,
      topologyRevision: chrome.topologyRevision,
      displayId: display.id,
      normalBounds: Object.freeze({ ...normalBounds }),
      savedWorkArea: Object.freeze({ ...display.workArea }),
      presentation: record.native.isFullScreen()
        ? "fullscreen" as const
        : record.native.isMaximized() ? "maximized" as const : "normal" as const
    });
  }

  #installListeners(record: WindowsHostRecord): void {
    const { native, listeners } = record;
    native.on("blur", listeners.blurred);
    native.on("close", listeners.close);
    native.on("closed", listeners.closed);
    native.on("enter-full-screen", listeners.enteredFullScreen);
    native.on("focus", listeners.focused);
    native.on("hide", listeners.hidden);
    native.on("leave-full-screen", listeners.leftFullScreen);
    native.on("maximize", listeners.maximized);
    native.on("minimize", listeners.minimized);
    native.on("move", listeners.moved);
    native.on("ready-to-show", listeners.readyToShow);
    native.on("resize", listeners.resized);
    native.on("restore", listeners.restored);
    native.on("show", listeners.shown);
    native.on("unmaximize", listeners.unmaximized);
    native.on("unresponsive", listeners.unresponsive);
    native.webContents.on("before-input-event", listeners.beforeInputEvent);
    native.webContents.on("did-fail-load", listeners.didFailLoad);
    native.webContents.on("did-finish-load", listeners.didFinishLoad);
    native.webContents.on("ipc-message", listeners.ipcMessage);
    native.webContents.on("render-process-gone", listeners.renderProcessGone);
    native.webContents.on("will-attach-webview", listeners.willAttachWebview);
    native.webContents.on("will-navigate", listeners.willNavigate);
    native.webContents.on("will-redirect", listeners.willRedirect);
  }

  #applyInitialPresentation(record: WindowsHostRecord): void {
    switch (record.target.presentation) {
      case "normal":
        return;
      case "maximized":
        record.native.maximize();
        return;
      case "fullscreen":
        record.native.setFullScreen(true);
    }
  }

  #onDidFinishLoad(record: WindowsHostRecord): void {
    if (record.state !== "opening") return;
    if (record.native.webContents.getURL() !== record.documentUrl) {
      this.#failCreation(
        record,
        "ELECTRON_RUNTIME_HOST_DOCUMENT_MISMATCH",
        "Electron finished a document outside the packaged runtime host."
      );
      return;
    }
    try {
      record.chrome.documentLoaded(record.native.webContents.getURL());
    } catch {
      this.#failCreation(
        record,
        "ELECTRON_RUNTIME_HOST_DOCUMENT_MISMATCH",
        "The bundled Windows toolbar rejected its packaged document."
      );
      return;
    }
    record.documentReady = true;
    this.#completeCreationIfReady(record);
  }

  #completeCreationIfReady(record: WindowsHostRecord): void {
    if (
      record.state !== "opening" ||
      !record.documentReady ||
      !record.presentationReady ||
      !record.readyToShow
    ) {
      return;
    }
    record.state = "active";
    this.#removeReadinessListeners(record);
    record.creation.resolve(record.host);
  }

  #failCreation(
    record: WindowsHostRecord,
    code: string,
    message: string
  ): void {
    if (record.state !== "opening") return;
    record.state = "closing";
    record.creationError = hostError(code, message);
    const close = this.#close(record);
    void close.catch(() => {
      record.creation.reject(record.creationError);
    });
  }

  #close(record: WindowsHostRecord): Promise<void> {
    if (record.state === "closed") return record.closed.promise;
    if (record.closePromise) return record.closePromise;
    if (record.state === "active" || record.state === "opening") {
      record.state = "closing";
    }
    const completion = deferred<void>();
    record.closePromise = completion.promise;
    const submitNativeClose = (): void => {
      try {
        record.native.close();
      } catch {
        record.closePromise = null;
        completion.reject(hostError(
          "ELECTRON_RUNTIME_HOST_CLOSE_FAILED",
          "Electron could not submit the exact Windows runtime-host close."
        ));
      }
    };
    if (record.chrome.hasActiveWorkspaceDividerGestures) {
      void record.chrome.drainWorkspaceDividerGestures().then(
        submitNativeClose,
        submitNativeClose
      );
    } else {
      submitNativeClose();
    }
    void record.closed.promise.then(completion.resolve);
    return completion.promise;
  }

  #onClosed(record: WindowsHostRecord): void {
    if (record.state === "closed") return;
    const wasOpening = record.state === "opening";
    record.windowState.close();
    record.state = "closed";
    this.#removeAllListeners(record);
    if (this.#activeByLogicalWindow.get(record.logicalWindowId) === record) {
      this.#activeByLogicalWindow.delete(record.logicalWindowId);
    }
    if (this.#ownerByNativeId.get(record.nativeId) === record) {
      this.#ownerByNativeId.delete(record.nativeId);
    }
    this.#ownerByNativeWindow.delete(record.native);
    record.chrome.close();
    record.closed.resolve();
    record.popupObserver?.closed();
    if (record.creationError) {
      record.creation.reject(record.creationError);
    } else if (wasOpening) {
      record.creation.reject(hostError(
        "ELECTRON_RUNTIME_HOST_CLOSED_DURING_CREATION",
        "The Windows runtime host closed before it became ready."
      ));
    }
  }

  #contentBounds(record: WindowsHostRecord): ChromiumRoleSurfaceBounds {
    return this.#withCurrent(record, () => {
      const bounds = record.native.getContentBounds();
      requireBounds(bounds, "native content");
      const inset = record.chrome.contentInset;
      if (bounds.height <= inset) {
        fail(
          "ELECTRON_RUNTIME_HOST_CONTENT_BOUNDS_INVALID",
          "The Windows runtime host has no content area below its chrome."
        );
      }
      return Object.freeze({
        x: 0,
        y: inset,
        width: bounds.width,
        height: bounds.height - inset
      });
    });
  }

  #publishPopupLayout(record: WindowsHostRecord): void {
    if (record.state !== "active" || !record.popupObserver) return;
    try {
      record.popupObserver.layoutChanged(this.#contentBounds(record));
    } catch {
      // The coordinator owns lifecycle failure classification; native geometry
      // events must never escape Electron's event emitter.
      record.popupObserver.closeRequested();
    }
  }

  #publishNativeLayout(record: WindowsHostRecord): void {
    this.#publishPopupLayout(record);
    void record.chrome.nativeBoundsChanged().catch((error) =>
      this.#onPresentationFailure(record, error)
    );
  }

  #onPresentationFailure(record: WindowsHostRecord, error: unknown): void {
    if (record.state === "opening") {
      this.#failCreation(
        record,
        "ELECTRON_RUNTIME_HOST_PRESENTATION_FAILED",
        error instanceof Error
          ? error.message
          : "The native Windows presentation event failed."
      );
    }
  }

  #withCurrent<Value>(record: WindowsHostRecord, operation: () => Value): Value {
    if (
      record.state !== "active" ||
      record.native.isDestroyed() ||
      this.#activeByLogicalWindow.get(record.logicalWindowId) !== record ||
      this.#ownerByNativeId.get(record.nativeId) !== record
    ) {
      fail(
        "ELECTRON_RUNTIME_HOST_STALE_GENERATION",
        "The Windows runtime-host generation no longer owns this native window."
      );
    }
    return operation();
  }

  #rejectNativeAlias(
    provisional: WindowsHostRecord,
    owner: WindowsHostRecord
  ): Promise<never> {
    if (provisional.native === owner.native) {
      return Promise.reject(hostError(
        "ELECTRON_RUNTIME_HOST_NATIVE_ALIAS",
        "Electron returned one native Windows host for distinct generations."
      ));
    }
    provisional.state = "closing";
    this.#installListeners(provisional);
    const error = hostError(
      "ELECTRON_RUNTIME_HOST_NATIVE_ALIAS",
      "Electron returned one native Windows host ID for distinct generations."
    );
    const close = this.#close(provisional);
    return close.then(
      () => Promise.reject(error),
      () => Promise.reject(error)
    );
  }

  #removeReadinessListeners(record: WindowsHostRecord): void {
    const { native, listeners } = record;
    native.removeListener("ready-to-show", listeners.readyToShow);
    native.webContents.removeListener("did-fail-load", listeners.didFailLoad);
    native.webContents.removeListener("did-finish-load", listeners.didFinishLoad);
  }

  #removeAllListeners(record: WindowsHostRecord): void {
    this.#removeReadinessListeners(record);
    const { native, listeners } = record;
    native.removeListener("blur", listeners.blurred);
    native.removeListener("close", listeners.close);
    native.removeListener("closed", listeners.closed);
    native.removeListener("enter-full-screen", listeners.enteredFullScreen);
    native.removeListener("focus", listeners.focused);
    native.removeListener("hide", listeners.hidden);
    native.removeListener("leave-full-screen", listeners.leftFullScreen);
    native.removeListener("maximize", listeners.maximized);
    native.removeListener("minimize", listeners.minimized);
    native.removeListener("move", listeners.moved);
    native.removeListener("resize", listeners.resized);
    native.removeListener("restore", listeners.restored);
    native.removeListener("show", listeners.shown);
    native.removeListener("unmaximize", listeners.unmaximized);
    native.removeListener("unresponsive", listeners.unresponsive);
    native.webContents.removeListener("before-input-event", listeners.beforeInputEvent);
    native.webContents.removeListener("ipc-message", listeners.ipcMessage);
    native.webContents.removeListener("render-process-gone", listeners.renderProcessGone);
    native.webContents.removeListener("will-attach-webview", listeners.willAttachWebview);
    native.webContents.removeListener("will-navigate", listeners.willNavigate);
    native.webContents.removeListener("will-redirect", listeners.willRedirect);
  }

  #nextNativeGeneration(logicalWindowId: string): number {
    const generation = (this.#lastNativeGeneration.get(logicalWindowId) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      fail(
        "ELECTRON_RUNTIME_HOST_GENERATION_EXHAUSTED",
        "The native Windows runtime-host generation is exhausted."
      );
    }
    this.#lastNativeGeneration.set(logicalWindowId, generation);
    return generation;
  }

  #nextOwnerRevision(): string {
    if (this.#lastOwnerRevision >= 18_446_744_073_709_551_615n) {
      fail(
        "ELECTRON_RUNTIME_HOST_OWNER_REVISION_EXHAUSTED",
        "The native Windows runtime-host owner revision is exhausted."
      );
    }
    this.#lastOwnerRevision += 1n;
    return String(this.#lastOwnerRevision);
  }
}

/**
 * Platform fence for the transition. Windows uses Electron BrowserWindow;
 * macOS remains AppKit-owned and requires a Rust/N-API adapter.
 */
export class ChromiumPlatformRuntimeHostFactory
implements ChromiumRuntimeHostFactoryPort {
  readonly #platform: RuntimeHostPlatform;
  readonly #windows: WindowsElectronChromiumRuntimeHostFactory | null;
  readonly #appKit: MacosAppKitRuntimeHostFactoryPort | null;

  constructor(input: ChromiumPlatformRuntimeHostFactoryInput) {
    this.#platform = input.platform;
    this.#windows = input.platform === "win32"
      ? new WindowsElectronChromiumRuntimeHostFactory(
          input.browserWindows,
          input.runtimeDocumentPath,
          input.displays,
          input.runtimeHostPreloadPath,
          input.onWindowControl,
          input.onWorkspaceDividerPointer,
          input.onTabControl,
          input.onRuntimeWindowPlacement,
          input.onTabReload,
          input.lifecycleEpoch,
          input.onError,
          input.runtimeForegroundProbe,
          input.onRuntimeTabFullscreen
        )
      : null;
    this.#appKit = input.platform === "darwin" ? input.appKit ?? null : null;
  }

  create(
    target: EmbeddedLaunchTargetRecord,
    initialTab: EmbeddedTabEffectRecord
  ): Promise<ChromiumRuntimeHostPort> {
    validateRuntimeHostRequest(target, initialTab);
    if (this.#platform === "win32") return this.#windows!.create(target, initialTab);
    if (!this.#appKit || this.#appKit.nativeHostKind !== "rust-napi-appkit") {
      return Promise.reject(hostError(
        "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE",
        "The Rust/N-API AppKit runtime-host adapter is unavailable."
      ));
    }
    return this.#appKit.create(target, initialTab).then(async (host) => {
      if (
        host.logicalWindowId !== target.windowId ||
        !Number.isSafeInteger(host.id) ||
        host.id < 1 ||
        host.isDestroyed()
      ) {
        if (!host.isDestroyed()) await host.close();
        throw hostError(
          "ELECTRON_MACOS_APPKIT_HOST_INVALID",
          "The AppKit adapter returned a mismatched native runtime host."
        );
      }
      return host;
    });
  }

  createEmpty(
    target: EmbeddedLaunchTargetRecord,
    identity: ChromiumRuntimeEmptyHostIdentity
  ): Promise<ChromiumRuntimeHostPort> {
    validateEmptyRuntimeHostRequest(target, identity);
    if (this.#platform === "win32") {
      return this.#windows!.createEmpty(target, identity);
    }
    if (!this.#appKit || this.#appKit.nativeHostKind !== "rust-napi-appkit") {
      return Promise.reject(hostError(
        "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE",
        "The Rust/N-API AppKit runtime-host adapter is unavailable."
      ));
    }
    return this.#appKit.createEmpty(target, identity).then(async (host) => {
      if (
        host.logicalWindowId !== target.windowId ||
        !Number.isSafeInteger(host.id) ||
        host.id < 1 ||
        host.isDestroyed() ||
        host.isVisible()
      ) {
        if (!host.isDestroyed()) await host.close();
        throw hostError(
          "ELECTRON_MACOS_APPKIT_EMPTY_HOST_INVALID",
          "The AppKit adapter returned a mismatched or visible empty runtime host."
        );
      }
      return host;
    });
  }

  createPopup(
    admission: ChromiumPopupAdmissionRecord
  ): Promise<ChromiumRuntimePopupHostHandle> {
    validateChromiumPopupHostAdmission(admission);
    if (this.#platform === "win32") return this.#windows!.createPopup(admission);
    if (!this.#appKit || this.#appKit.nativeHostKind !== "rust-napi-appkit") {
      return Promise.reject(hostError(
        "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE",
        "The Rust/N-API AppKit popup-host adapter is unavailable."
      ));
    }
    return this.#appKit.createPopup(admission).then(async (created) => {
      const { host, receipt } = created;
      if (
        host.logicalWindowId !== admission.target.windowId ||
        host.id !== receipt.nativeHostId ||
        receipt.platform !== "macos" ||
        receipt.logicalWindowId !== admission.target.windowId ||
        receipt.windowGeneration !== 1 || receipt.topologyRevision !== 1 ||
        !receipt.appkitIdentity || host.appKitIdentity !== receipt.appkitIdentity ||
        host.isDestroyed() || host.isVisible() || !host.bindPopupLifecycle
      ) {
        if (!host.isDestroyed()) await host.close();
        throw hostError(
          "ELECTRON_MACOS_APPKIT_POPUP_HOST_INVALID",
          "The AppKit adapter returned a mismatched popup host receipt."
        );
      }
      return created;
    });
  }

  resolveWindowsInputParent(
    parent: ChromiumRoleSurfaceParentPort
  ): WindowsChromiumInputRuntimeParentBinding | null {
    if (this.#platform !== "win32") return null;
    return this.#windows!.resolveInputParent(parent);
  }

  applyWindowPreferences(
    preferences: RuntimeWindowPreferencesRecord
  ): Promise<void> {
    if (this.#platform === "win32") {
      return this.#windows!.applyWindowPreferences(preferences);
    }
    if (!this.#appKit) {
      return Promise.reject(hostError(
        "ELECTRON_MACOS_APPKIT_HOST_UNAVAILABLE",
        "The retained AppKit host cannot apply runtime-window preferences."
      ));
    }
    try {
      this.#appKit.applyWindowPreferences(preferences);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
