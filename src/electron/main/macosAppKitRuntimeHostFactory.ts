import type {
  AppKitRuntimeHostIdentityRecord,
  AppKitRuntimeHostObservationRecord,
  AppKitRuntimeTabProjectionRecord,
  AppKitRuntimeWindowProjectionRecord,
  ChromiumPopupAdmissionRecord,
  EmbeddedLaunchTargetRecord,
  EmbeddedRuntimeWindowProjectionRecord,
  EmbeddedTabEffectRecord,
  RuntimeWindowPreferencesRecord
} from "../../shared/generated";
import { normalizeRionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds, ChromiumRoleSurfaceParentPort } from
  "./chromiumRoleSurfacePorts";
import type {
  ChromiumRuntimeEmptyHostIdentity,
  ChromiumRuntimeHostPort
} from "./chromiumRuntimeEffectExecutor";
import type { ChromiumRuntimeWindowStateObserver } from
  "./chromiumRuntimeHostPorts";
import type { ChromiumRuntimeAppKitProjectionTransaction } from
  "./chromiumRuntimeProjectionTransaction";
import { readMacosAppKitFullscreenToolbar } from
  "./macosAppKitFullscreenToolbarObservation";
import type { ChromiumRuntimeWindowPresentationRequest } from
  "./chromiumRuntimeFullscreenToolbar";
import { buildMacosAppKitRuntimeWindowOptions } from
  "./macosAppKitRuntimeWindowOptions";
export { buildMacosAppKitRuntimeWindowOptions } from
  "./macosAppKitRuntimeWindowOptions";
import type {
  ChromiumRuntimePopupHostHandle,
  MacosAppKitRuntimeHostFactoryPort
} from "./chromiumRuntimeHostFactory";
import type { ChromiumPopupHostLifecycleObserver } from "./chromiumPopupPorts";
import type { MacosAppKitInputHostBinding } from
  "./macosAppKitInputSurfaceAttachmentCoordinator";
import {
  matchesMacosAppKitHostIdentity,
  requireMacosAppKitBounds,
  requireMacosAppKitContentLayout,
  requireMacosAppKitIdentifier,
  validateMacosAppKitEmptyHostRequest,
  validateMacosAppKitRuntimeHostRequest
} from "./macosAppKitRuntimeHostValidation";
import {
  bindPopupObserver,
  classifyMacosPopupAction,
  createMacosAppKitPopupHost,
  popupTabProjection
} from "./macosAppKitPopupHost";
import {
  discardMacosAppKitSurfaceAttachment,
  MacosAppKitRuntimeHostPresentationGate,
  releaseMacosAppKitSurfaceAttachment
} from "./macosAppKitRuntimeHostPresentationGate";
import { MacosAppKitRuntimePresentationController } from
  "./macosAppKitRuntimePresentationController";
import {
  deferred,
  fail,
  hostError,
  isRecord,
  sameAppKitTabProjection,
  type MacosAppKitRuntimeHostFactoryInput,
  supportsNativeInputSurface,
  supportsWorkspaceDividerProjection,
  tabProjection
} from "./macosAppKitRuntimeHostSupport";
export type { MacosAppKitRuntimeHostFactoryInput } from
  "./macosAppKitRuntimeHostSupport";
import {
  createMacosAppKitWorkspaceDividerProjectionState,
  prepareMacosAppKitWorkspaceDividerProjection,
} from "./macosAppKitWorkspaceDividerProjection";
import { applyMacosAppKitRuntimeWindowPreferences } from
  "./macosAppKitRuntimeWindowPreferences";
import {
  bindMacosAppKitRuntimeWindowState,
  installMacosAppKitRuntimeWindowListeners,
  publishMacosAppKitRuntimeWindowFocus,
  publishMacosAppKitRuntimeWindowState,
  readMacosAppKitRuntimeWindowState,
  removeMacosAppKitRuntimeWindowListeners,
  snapshotMacosAppKitRuntimeHostObservation,
  type MacosAppKitCapturedWindowState
} from "./macosAppKitRuntimeWindowState";
import type {
  AppKitRuntimeHostIdentity,
  ElectronBaseWindowConstructor,
  MacosAppKitBaseWindowPort,
  MacosAppKitPreventableWindowEvent,
  RawAppKitRuntimeAddon,
  RawNativeAppKitRuntimeHost
} from "./macosAppKitRuntimePorts";
import type {
  MacosAppKitRuntimeHostRecord as HostRecord,
  MacosAppKitRuntimeHostState as HostState
} from "./macosAppKitRuntimeHostRecord";
export type {
  AppKitRuntimeActionEvent,
  AppKitRuntimeHostIdentity,
  AppKitRuntimeLayoutEvent,
  MacosAppKitBaseWindowFactoryPort,
  MacosAppKitBaseWindowPort,
  MacosAppKitDisplayPort,
  MacosAppKitDisplayResolverPort,
  RawAppKitRuntimeAddon,
  RawNativeAppKitRuntimeHost
} from "./macosAppKitRuntimePorts";

export const RION_APPKIT_RUNTIME_ABI_VERSION = 6;
const MAX_NATIVE_EVENT_BYTES = 96 * 1024;
function requireNativeController(
  record: HostRecord,
  purpose: string
): RawNativeAppKitRuntimeHost {
  if (!record.controller) fail(
    "ELECTRON_MACOS_APPKIT_CONTROLLER_MISSING",
    `The AppKit controller is unavailable for ${purpose}.`
  );
  return record.controller;
}

function requireCapturedWindowFocusState(
  action: Readonly<Record<string, unknown>>
): MacosAppKitCapturedWindowState {
  if (
    typeof action.focused !== "boolean" ||
    typeof action.minimized !== "boolean" ||
    typeof action.visible !== "boolean"
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_WINDOW_FOCUS_STATE_INVALID",
      "The AppKit focus event omitted its exact synchronous window state."
    );
  }
  return Object.freeze({
    focused: action.focused,
    minimized: action.minimized,
    visible: action.visible
  });
}

/**
 * Electron BaseWindow carries Chromium child views while the linked Rust/AppKit
 * controller remains the sole owner of macOS runtime chrome and geometry.
 */
export class MacosAppKitChromiumRuntimeHostFactory implements
  MacosAppKitRuntimeHostFactoryPort {
  readonly nativeHostKind = "rust-napi-appkit" as const;
  readonly #input: MacosAppKitRuntimeHostFactoryInput;
  readonly #activeByLogicalWindow = new Map<string, HostRecord>();
  readonly #ownerByNativeId = new Map<number, HostRecord>();
  readonly #ownerByNativeWindow = new WeakMap<object, HostRecord>();
  readonly #lastNativeGeneration = new Map<string, number>();
  #windowPreferences: RuntimeWindowPreferencesRecord = Object.freeze({
    alwaysHideTabCloseButton: false,
    alwaysShowToolbarInFullScreen: false,
    restoreGameWindowsOnStartup: true
  });

  constructor(input: MacosAppKitRuntimeHostFactoryInput) {
    this.#input = input;
    if (input.addon.appKitRuntimeAbiVersion() !== RION_APPKIT_RUNTIME_ABI_VERSION) {
      fail(
        "ELECTRON_MACOS_APPKIT_ABI_MISMATCH",
        "The Electron addon does not contain the required AppKit runtime ABI."
      );
    }
  }
  static fromElectronBaseWindow(
    addon: RawAppKitRuntimeAddon,
    BaseWindowConstructor: ElectronBaseWindowConstructor,
    observers: Omit<MacosAppKitRuntimeHostFactoryInput, "addon" | "windows">
  ): MacosAppKitChromiumRuntimeHostFactory {
    return new MacosAppKitChromiumRuntimeHostFactory({
      ...observers,
      addon,
      windows: {
        create: (options) => new BaseWindowConstructor(options) as unknown as
          MacosAppKitBaseWindowPort
      }
    });
  }
  applyWindowPreferences(preferences: RuntimeWindowPreferencesRecord): void {
    const hosts = [...this.#activeByLogicalWindow.values()]
      .filter((record) => record.state === "active" && !!record.controller &&
        this.#isExactOwner(record))
      .map((record) => {
        const windowGeneration = record.windowGeneration;
        const topologyRevision = record.topologyRevision;
        return {
          applyFullscreenPolicy: (value: boolean) =>
            record.controller?.setFullscreenPolicy(record.identity, value),
          applyTabClosePolicy: (value: boolean) =>
            record.controller?.setTabCloseButtonsHidden(record.identity, value),
          fenceMatches: () => record.state === "active" && !!record.controller &&
            this.#isExactOwner(record) &&
            record.windowGeneration === windowGeneration &&
            record.topologyRevision === topologyRevision,
          poison: (error: unknown) => this.#poison(record, error),
          quarantine: (error: unknown) =>
            this.#markProjectionPoisoned(record, error)
        };
      });
    this.#windowPreferences = applyMacosAppKitRuntimeWindowPreferences({
      hosts,
      preferences,
      previous: this.#windowPreferences
    });
  }
  applyWindowName(
    expected: AppKitRuntimeHostIdentityRecord,
    name: string
  ): Readonly<{ identity: AppKitRuntimeHostIdentityRecord; name: string }> {
    const record = this.#requireExactActiveHost(expected);
    if (
      typeof name !== "string" || name.length === 0 || name.length > 512 ||
      name.trim() !== name || [...name].some((character) => {
        const code = character.codePointAt(0)!;
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_WINDOW_NAME_INVALID",
        "Core supplied an invalid AppKit runtime-window name."
      );
    }
    const previous = record.windowName;
    if (name !== previous) {
      try {
        record.controller!.setWindowName(record.identity, name);
      } catch (error) {
        try {
          record.controller!.setWindowName(record.identity, previous);
        } catch (rollbackError) {
          this.#markProjectionPoisoned(record, rollbackError);
          throw hostError(
            "ELECTRON_MACOS_APPKIT_WINDOW_NAME_ROLLBACK_FAILED",
            "The AppKit runtime-window name could not be compensated exactly."
          );
        }
        throw error;
      }
      record.windowName = name;
    }
    return Object.freeze({
      identity: Object.freeze({ ...record.identity }),
      name: record.windowName
    });
  }

  quarantineHost(
    expected: AppKitRuntimeHostIdentityRecord,
    error: unknown
  ): void {
    this.#markProjectionPoisoned(this.#requireExactActiveHost(expected), error);
  }

  resolveInputHost(
    parent: ChromiumRoleSurfaceParentPort
  ): MacosAppKitInputHostBinding | null {
    if (!Number.isSafeInteger(parent.id) || parent.id < 1 || parent.isDestroyed()) {
      return null;
    }
    const record = this.#ownerByNativeId.get(parent.id);
    if (
      !record || record.host !== parent || record.state !== "active" ||
      !this.#isExactOwner(record) || !record.inputBinding
    ) {
      return null;
    }
    return record.inputBinding;
  }

  captureHostObservations(
    windowIds: readonly string[]
  ): readonly AppKitRuntimeHostObservationRecord[] {
    if (!Array.isArray(windowIds) || windowIds.length > 128) {
      fail(
        "ELECTRON_MACOS_APPKIT_OBSERVATION_SET_INVALID",
        "The authenticated AppKit observation request is not bounded."
      );
    }
    const seen = new Set<string>();
    const observations = windowIds.map((windowId) => {
      const validatedWindowId = requireMacosAppKitIdentifier(
        windowId,
        "logical window"
      );
      if (seen.has(validatedWindowId)) {
        fail(
          "ELECTRON_MACOS_APPKIT_OBSERVATION_SET_INVALID",
          "The authenticated AppKit observation request contains a duplicate window."
        );
      }
      seen.add(validatedWindowId);
      const record = this.#activeByLogicalWindow.get(validatedWindowId);
      if (!record || record.state !== "active" || !this.#isExactOwner(record)) {
        fail(
          "ELECTRON_MACOS_APPKIT_OBSERVATION_STALE",
          "The authenticated AppKit observation request references a stale window."
        );
      }
      return this.#snapshotObservation(record);
    });
    return Object.freeze(observations);
  }

  async create(
    target: EmbeddedLaunchTargetRecord,
    initialTab: EmbeddedTabEffectRecord
  ): Promise<ChromiumRuntimeHostPort> {
    const fences = validateMacosAppKitRuntimeHostRequest(target, initialTab);
    return this.#createHost(target, fences, initialTab);
  }

  async createEmpty(
    target: EmbeddedLaunchTargetRecord,
    identity: ChromiumRuntimeEmptyHostIdentity
  ): Promise<ChromiumRuntimeHostPort> {
    const fences = validateMacosAppKitEmptyHostRequest(target, identity);
    return this.#createHost(target, fences);
  }

  async createPopup(
    admission: ChromiumPopupAdmissionRecord
  ): Promise<ChromiumRuntimePopupHostHandle> {
    return createMacosAppKitPopupHost(
      admission,
      (target, launchGeneration, popup) => this.#createHost(target, {
        launchGeneration,
        windowGeneration: 1,
        topologyRevision: 1
      }, undefined, popup)
    );
  }

  async #createHost(
    target: EmbeddedLaunchTargetRecord,
    fences: Readonly<{
      launchGeneration: string;
      windowGeneration: number;
      topologyRevision: number;
    }>,
    initialTab?: EmbeddedTabEffectRecord,
    popupAdmission?: ChromiumPopupAdmissionRecord
  ): Promise<ChromiumRuntimeHostPort> {
    const {
      launchGeneration,
      windowGeneration,
      topologyRevision
    } = fences;
    if (this.#activeByLogicalWindow.has(target.windowId)) {
      fail(
        "ELECTRON_MACOS_APPKIT_OWNERSHIP_CONFLICT",
        "The logical runtime window already owns an AppKit host."
      );
    }
    const nativeGeneration = this.#nextNativeGeneration(target.windowId);
    const identity = Object.freeze({
      logicalWindowId: target.windowId,
      launchGeneration,
      nativeGeneration
    });
    const native = this.#input.windows.create(
      buildMacosAppKitRuntimeWindowOptions(target)
    );
    const nativeId = native.id;
    if (
      !Number.isSafeInteger(nativeId) ||
      nativeId < 1 ||
      native.isDestroyed() ||
      this.#ownerByNativeId.has(nativeId) ||
      this.#ownerByNativeWindow.has(native)
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_NATIVE_HOST_INVALID",
        "Electron returned an invalid or aliased AppKit BaseWindow."
      );
    }
    const record = this.#buildRecord(
      identity,
      target,
      native,
      nativeId,
      windowGeneration,
      topologyRevision,
      popupAdmission?.popupId ?? null
    );
    if (initialTab) record.presentationGate.begin(initialTab.tabId);
    this.#activeByLogicalWindow.set(target.windowId, record);
    this.#ownerByNativeId.set(nativeId, record);
    this.#ownerByNativeWindow.set(native, record);
    installMacosAppKitRuntimeWindowListeners(record.native, record.listeners);
    try {
      const handle = native.getNativeWindowHandle();
      if (!Buffer.isBuffer(handle)) {
        fail(
          "ELECTRON_MACOS_APPKIT_NATIVE_HANDLE_INVALID",
          "Electron did not return a native NSView handle Buffer."
        );
      }
      record.controller = this.#input.addon.attachAppKitRuntimeHost(
        handle,
        identity,
        (eventJson) => this.#receiveNativeEvent(record, eventJson)
      );
      this.#validateControllerIdentity(record);
      record.controllerIdentityValidated = true;
      record.controller.setWindowName(
        record.identity,
        target.persistedName ?? "Rion Studio"
      );
      record.controller.setFullscreenPolicy(
        record.identity,
        this.#windowPreferences.alwaysShowToolbarInFullScreen
      );
      record.controller.setTabCloseButtonsHidden(
        record.identity,
        this.#windowPreferences.alwaysHideTabCloseButton
      );
      if (!supportsNativeInputSurface(record.controller)) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_SURFACE_ABI_MISSING",
          `The AppKit ABI v${RION_APPKIT_RUNTIME_ABI_VERSION} controller lacks required Chromium input-surface lifecycle methods.`
        );
      }
      if (!supportsWorkspaceDividerProjection(record.controller)) {
        fail(
          "ELECTRON_MACOS_APPKIT_WORKSPACE_DIVIDER_ABI_MISSING",
          `The AppKit ABI v${RION_APPKIT_RUNTIME_ABI_VERSION} controller lacks its retained workspace-divider projection methods.`
        );
      }
      record.inputBinding = Object.freeze({
        identity: record.identity,
        native: record.controller
      });
      if (popupAdmission) {
        record.projectedTabs.set(
          popupAdmission.popupId,
          popupTabProjection(popupAdmission)
        );
        record.projectedActiveTabId = popupAdmission.popupId;
        this.#commitNativeProjection(record);
      } else if (initialTab) {
        this.#initializeTab(record, initialTab);
      } else {
        // Establish an exact zero-tab native projection before exposing the
        // provisional host. A controller that cannot represent an empty host
        // fails closed here; callers must never seed a duplicate tab owner.
        this.#commitNativeProjection(record);
      }
      this.#refreshLayout(record);
      this.#submitPresentation(record);
      await record.presentationReady.promise;
      if (record.state !== "opening") {
        fail(
          "ELECTRON_MACOS_APPKIT_CREATION_INTERRUPTED",
          "The AppKit host did not remain current through native attachment."
        );
      }
      record.state = "active";
      if (!initialTab && native.isVisible()) {
        fail(
          "ELECTRON_MACOS_APPKIT_EMPTY_HOST_VISIBLE",
          "The provisional AppKit runtime host became visible before Core moved a tab."
        );
      }
      return record.host;
    } catch (error) {
      await this.#cleanupFailedCreation(record, error);
      throw error;
    }
  }

  #buildRecord(
    identity: AppKitRuntimeHostIdentity,
    target: EmbeddedLaunchTargetRecord,
    native: MacosAppKitBaseWindowPort,
    nativeId: number,
    windowGeneration: number,
    topologyRevision: number,
    popupId: string | null
  ): HostRecord {
    const record = {
      identity,
      target,
      native,
      nativeId,
      closed: deferred<void>(),
      presentationReady: deferred<void>(),
      controller: null,
      inputBinding: null,
      layout: null,
      state: "opening" as HostState,
      closePromise: null,
      controllerDetached: false,
      controllerIdentityValidated: false,
      nativeProjectionRevision: 0,
      windowGeneration,
      topologyRevision,
      normalBounds: Object.freeze({ ...target.bounds }),
      readLifecycleEpoch: this.#input.lifecycleEpoch ?? (() => 1),
      windowStateObservers: new Set(),
      windowStateSequence: 0,
      windowStateTerminal: false,
      projectedTabs: new Map<string, AppKitRuntimeTabProjectionRecord>(),
      workspaceDividerProjection:
        createMacosAppKitWorkspaceDividerProjectionState(),
      presentationGate: new MacosAppKitRuntimeHostPresentationGate(),
      presentation: undefined as unknown as
        MacosAppKitRuntimePresentationController,
      projectedActiveTabId: undefined,
      lastAdapterSequence: 0,
      windowName: target.persistedName ?? "Rion Studio",
      popupId,
      popupObserver: null as ChromiumPopupHostLifecycleObserver | null,
      host: undefined as unknown as ChromiumRuntimeHostPort,
      listeners: undefined as unknown as HostRecord["listeners"]
    } satisfies Omit<HostRecord, "host" | "listeners" | "presentation"> &
      Partial<Pick<HostRecord, "host" | "listeners" | "presentation">>;
    // Keep an authoritative rejection observable without allowing an external
    // native close to become an unhandled JavaScript rejection.
    void record.closed.promise.catch(() => undefined);
    const readProjection = () => this.#withCurrent(record as HostRecord, () => {
      const observation = this.#snapshotObservation(record as HostRecord);
      return Object.freeze({
        displayId: observation.targetDisplay.id,
        bounds: Object.freeze({ ...observation.normalBounds }),
        visible: observation.visible,
        focused: observation.focused,
        presentation: observation.presentation
      });
    });
    record.presentation = new MacosAppKitRuntimePresentationController({
      native,
      prepareFullscreen: (fullscreen) => {
        const current = record as HostRecord;
        requireNativeController(current, "fullscreen preparation")
          .prepareFullscreen(current.identity, fullscreen);
      },
      readFence: () => ({
        current: record.state === "active" &&
          this.#isExactOwner(record as HostRecord),
        topologyRevision: record.topologyRevision,
        windowGeneration: record.windowGeneration,
        windowId: record.identity.logicalWindowId
      }),
      readProjection
    });
    record.host = Object.freeze({
      id: nativeId,
      logicalWindowId: identity.logicalWindowId,
      appKitIdentity: identity,
      contentView: native.contentView,
      close: () => this.#close(record as HostRecord),
      focus: () => this.#withCurrent(record as HostRecord, () => {
        const current = record as HostRecord;
        requireNativeController(current, "native window focus")
          .focusWindow(current.identity);
      }),
      hide: () => this.#withCurrent(record as HostRecord, () => native.hide()),
      getContentBounds: () => this.#contentBounds(record as HostRecord),
      readProjection,
      bindRuntimeWindowState: (observer: ChromiumRuntimeWindowStateObserver) =>
        this.#withCurrent(
          record as HostRecord,
          () => bindMacosAppKitRuntimeWindowState(record as HostRecord, observer)
        ),
      readRuntimeWindowState: () => this.#withCurrent(
        record as HostRecord,
        () => readMacosAppKitRuntimeWindowState(record as HostRecord)
      ),
      isDestroyed: () =>
        record.state === "closed" || native.isDestroyed() ||
        this.#activeByLogicalWindow.get(identity.logicalWindowId) !== record,
      isVisible: () => this.#withCurrent(
        record as HostRecord,
        () => native.isVisible()
      ),
      initializeAppKitTab: (tab: EmbeddedTabEffectRecord) => this.#withCurrent(
        record as HostRecord,
        () => this.#initializeTab(record as HostRecord, tab)
      ),
      releaseAppKitSurfaceAttachment: (tabId: string) => this.#withCurrent(
        record as HostRecord,
        () => {
          const current = record as HostRecord;
          const exactTabId = requireMacosAppKitIdentifier(tabId, "tab");
          releaseMacosAppKitSurfaceAttachment({
            gate: current.presentationGate,
            ownsTab: current.projectedTabs.has(exactTabId),
            publishLayout: () => this.#publishLayout(current),
            publishWindowState: (action) => this.#input.onAction({
              identity: current.identity,
              action,
              hosts: this.#observationsForAction(current, action)
            }),
            tabId: exactTabId
          });
        }
      ),
      discardAppKitSurfaceAttachment: (tabId: string) => this.#withCurrent(
        record as HostRecord,
        () => {
          const current = record as HostRecord;
          const exactTabId = requireMacosAppKitIdentifier(tabId, "tab");
          discardMacosAppKitSurfaceAttachment({
            gate: current.presentationGate,
            ownsTab: current.projectedTabs.has(exactTabId),
            tabId: exactTabId
          });
        }
      ),
      prepareAppKitProjection: (projection: AppKitRuntimeWindowProjectionRecord) =>
        this.#withCurrent(
          record as HostRecord,
          () => this.#prepareProjection(record as HostRecord, projection)
        ),
      applyAppKitPhaseProjection: (
        projection: EmbeddedRuntimeWindowProjectionRecord
      ) => this.#withCurrent(
        record as HostRecord,
        () => this.#applyPhaseProjection(record as HostRecord, projection)
      ),
      prepareWorkspaceDividerProjection: (
        projection: AppKitRuntimeWindowProjectionRecord
      ) => this.#withCurrent(
        record as HostRecord,
        () => this.#prepareWorkspaceDividerProjection(
          record as HostRecord,
          projection
        )
      ),
      readFullscreenToolbar: () => this.#withCurrent(
        record as HostRecord,
        () => {
          const current = record as HostRecord;
          const controller = current.controller;
          return readMacosAppKitFullscreenToolbar({
            identity: current.identity,
            nativeFullscreen: readProjection().presentation === "fullscreen",
            nativeProjectionRevision: current.nativeProjectionRevision,
            ...(controller?.desktopE2eFullscreenToolbarState
              ? {
                  read: (expected) =>
                    controller.desktopE2eFullscreenToolbarState!(expected)
                }
              : {}),
            ...(controller?.desktopE2eTitlebarGeometry
              ? {
                  readTitlebarGeometry: (expected) =>
                    controller.desktopE2eTitlebarGeometry!(expected)
                }
              : {}),
            ...(controller?.desktopE2eTabAnchor
              ? {
                  readTabAnchor: (expected, tabId) =>
                    controller.desktopE2eTabAnchor!(expected, tabId, 1, 0.5),
                  tabIds: [...current.projectedTabs.keys()]
                }
              : {}),
            topologyRevision: current.topologyRevision,
            windowGeneration: current.windowGeneration
          });
        }
      ),
      setRuntimeWindowPresentation: (request: ChromiumRuntimeWindowPresentationRequest) =>
        this.#withCurrent(record as HostRecord,
          () => record.presentation.setPresentation(request)),
      desktopE2eShowAppKitTabMenu: (tabId: string) => this.#withCurrent(
        record as HostRecord, () => requireNativeController(
          record as HostRecord, "desktop E2E tab menu"
        ).desktopE2eAccessibilityShowMenu?.(record.identity, tabId) ?? false),
      desktopE2eStatusPresentation: () => this.#withCurrent(record as HostRecord,
        () => requireNativeController(record as HostRecord, "desktop E2E status presentation")
          .desktopE2eStatusPresentation?.(record.identity) ?? 0),
      show: () => this.#withCurrent(record as HostRecord, () => native.show()),
      showInactive: () => this.#withCurrent(record as HostRecord, () => native.showInactive()),
      ...(popupId
        ? {
            bindPopupLifecycle: (observer: ChromiumPopupHostLifecycleObserver) =>
              this.#withCurrent(record as HostRecord, () => {
                record.popupObserver = bindPopupObserver(
                  record.popupObserver,
                  observer
                );
              })
          }
        : {})
    });
    record.listeners = Object.freeze({
      close: (event: unknown) => this.#onNativeCloseRequested(
        record as HostRecord,
        event
      ),
      closed: () => this.#onClosed(record as HostRecord),
      enteredFullScreen: () => {
        if (
          target.presentation === "fullscreen" &&
          record.state === "opening" &&
          this.#isExactOwner(record as HostRecord)
        ) {
          record.presentationReady.resolve();
        }
      },
      hidden: () => this.#publishRuntimeWindowState(record as HostRecord, "hide"),
      leftFullScreen: () => {
        const current = record as HostRecord;
        if (
          current.controller && current.state !== "closed" &&
          current.state !== "closing" && this.#isExactOwner(current)
        ) {
          try {
            current.controller.prepareFullscreen(current.identity, false);
            this.#refreshLayout(current);
          } catch (error) {
            this.#poison(current, error);
          }
        }
      },
      maximized: () => {
        if (
          target.presentation === "maximized" &&
          record.state === "opening" &&
          this.#isExactOwner(record as HostRecord)
        ) {
          record.presentationReady.resolve();
        }
      },
      minimized: () => this.#publishRuntimeWindowState(
        record as HostRecord,
        "minimize"
      ),
      moved: () => undefined,
      resized: () => this.#refreshLayout(record as HostRecord),
      restored: () => {
        this.#refreshLayout(record as HostRecord);
        this.#publishRuntimeWindowState(record as HostRecord, "restore");
      },
      shown: () => this.#publishRuntimeWindowState(record as HostRecord, "show")
    });
    return record as HostRecord;
  }

  #submitPresentation(record: HostRecord): void {
    switch (record.target.presentation) {
      case "fullscreen":
        record.controller?.prepareFullscreen(record.identity, true);
        record.native.setFullScreen(true);
        break;
      case "maximized":
        record.native.maximize();
        break;
      case "normal":
        record.presentationReady.resolve();
        break;
    }
  }

  #initializeTab(record: HostRecord, tab: EmbeddedTabEffectRecord): void {
    const tabId = requireMacosAppKitIdentifier(tab.tabId, "tab");
    record.presentationGate.begin(tabId);
    if (tab.target.windowId !== record.identity.logicalWindowId) {
      fail(
        "ELECTRON_MACOS_APPKIT_TAB_WINDOW_MISMATCH",
        "The AppKit tab initialization target does not match its native host."
      );
    }
    const windowGeneration = tab.appkitWindowGeneration;
    const topologyRevision = tab.appkitTopologyRevision;
    if (
      windowGeneration !== record.windowGeneration ||
      !Number.isSafeInteger(topologyRevision) ||
      (topologyRevision ?? 0) < record.topologyRevision ||
      (record.projectedTabs.has(tabId) && topologyRevision !== record.topologyRevision)
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_TAB_FENCE_STALE",
        "The AppKit tab initialization lost its Rust-owned window or topology fence."
      );
    }
    const projection = tabProjection(tab);
    const previous = record.projectedTabs.get(tabId);
    const previousActive = record.projectedActiveTabId;
    record.projectedTabs.set(tabId, projection);
    record.projectedActiveTabId = tabId;
    try {
      this.#commitNativeProjection(record);
      record.topologyRevision = topologyRevision!;
    } catch (error) {
      if (previous) record.projectedTabs.set(tabId, previous);
      else record.projectedTabs.delete(tabId);
      record.projectedActiveTabId = previousActive;
      if (record.state === "active") this.#poison(record, error);
      throw error;
    }
  }

  #prepareProjection(
    record: HostRecord,
    projection: AppKitRuntimeWindowProjectionRecord
  ): ChromiumRuntimeAppKitProjectionTransaction {
    if (!matchesMacosAppKitHostIdentity(projection.identity, record.identity)) {
      fail(
        "ELECTRON_MACOS_APPKIT_PROJECTION_IDENTITY_STALE",
        "Core projected tabs to a stale AppKit host identity."
      );
    }
    if (
      projection.windowGeneration !== record.windowGeneration ||
      !Number.isSafeInteger(projection.topologyRevision) ||
      projection.topologyRevision < record.topologyRevision ||
      !Number.isSafeInteger(projection.adapterSequence) ||
      projection.adapterSequence <= record.lastAdapterSequence
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_PROJECTION_FENCE_STALE",
        "Core projected a stale AppKit window, topology, or adapter sequence."
      );
    }
    const tabs = new Map<string, AppKitRuntimeTabProjectionRecord>();
    for (const tab of projection.tabs) {
      const tabId = requireMacosAppKitIdentifier(tab.tabId, "tab");
      if (tabs.has(tabId)) {
        fail(
          "ELECTRON_MACOS_APPKIT_PROJECTION_DUPLICATE_TAB",
          "Core projected a duplicate AppKit tab identity."
        );
      }
      tabs.set(tabId, Object.freeze({ ...tab }));
    }
    if (
      (projection.activeTabId !== undefined && !tabs.has(projection.activeTabId)) ||
      (projection.activeTabId === undefined && tabs.size > 0)
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_PROJECTION_ACTIVE_INVALID",
        "Core projected an active AppKit tab outside the exact tab order."
      );
    }
    const previousTabs = new Map(record.projectedTabs);
    const previousActive = record.projectedActiveTabId;
    const previousTopologyRevision = record.topologyRevision;
    const previousAdapterSequence = record.lastAdapterSequence;
    const previousNativeProjectionRevision = record.nativeProjectionRevision;
    const nativeTabProjectionChanged =
      previousActive !== projection.activeTabId ||
      !sameAppKitTabProjection(previousTabs, tabs);
    let state: "prepared" | "committed" | "rolled-back" | "failed" = "prepared";
    let committedNativeProjectionRevision = 0;
    let quarantineRequired = false;

    const restorePreviousJavaScriptProjection = (): void => {
      record.projectedTabs.clear();
      for (const [tabId, tab] of previousTabs) {
        record.projectedTabs.set(tabId, tab);
      }
      record.projectedActiveTabId = previousActive;
      record.topologyRevision = previousTopologyRevision;
      record.lastAdapterSequence = previousAdapterSequence;
    };
    const previousProjectionStillCurrent = (): boolean =>
      record.nativeProjectionRevision === previousNativeProjectionRevision &&
      record.topologyRevision === previousTopologyRevision &&
      record.lastAdapterSequence === previousAdapterSequence &&
      record.projectedActiveTabId === previousActive &&
      record.projectedTabs.size === previousTabs.size &&
      [...previousTabs].every(
        ([tabId, tab]) => record.projectedTabs.get(tabId) === tab
      );

    return Object.freeze({
      commit: () => this.#withCurrent(record, () => {
        if (state !== "prepared" || !previousProjectionStillCurrent()) {
          state = "failed";
          fail(
            "ELECTRON_MACOS_APPKIT_PROJECTION_PREPARE_STALE",
            "The prepared AppKit projection lost its exact prior native state."
          );
        }
        record.projectedTabs.clear();
        for (const [tabId, tab] of tabs) record.projectedTabs.set(tabId, tab);
        record.projectedActiveTabId = projection.activeTabId;
        try {
          if (nativeTabProjectionChanged) this.#commitNativeProjection(record);
          committedNativeProjectionRevision = record.nativeProjectionRevision;
          record.topologyRevision = projection.topologyRevision;
          record.lastAdapterSequence = projection.adapterSequence;
          state = "committed";
        } catch (error) {
          restorePreviousJavaScriptProjection();
          state = "failed";
          const restored = (() => {
            try {
              const receipt = record.controller?.restoreLastVerifiedTabProjection?.(
                record.identity
              );
              return receipt?.projectionRevision ===
                  String(previousNativeProjectionRevision) &&
                receipt.tabCount === previousTabs.size &&
                receipt.activeTabId === previousActive;
            } catch {
              return false;
            }
          })();
          if (restored) {
            record.nativeProjectionRevision = previousNativeProjectionRevision;
          } else {
            quarantineRequired = true;
            this.#markProjectionPoisoned(record, error);
          }
          throw error;
        }
      }),
      finalize: () => record.presentation.coreProjectionApplied({
        topologyRevision: projection.topologyRevision,
        windowGeneration: projection.windowGeneration,
        windowId: projection.identity.logicalWindowId
      }),
      requiresQuarantine: () => quarantineRequired,
      rollback: () => {
        if (state === "rolled-back") return;
        if (state !== "committed") {
          fail(
            "ELECTRON_MACOS_APPKIT_PROJECTION_ROLLBACK_INVALID",
            "Only an exactly committed AppKit projection can be rolled back."
          );
        }
        this.#withCurrent(record, () => {
          if (
            record.nativeProjectionRevision !== committedNativeProjectionRevision ||
            record.topologyRevision !== projection.topologyRevision ||
            record.lastAdapterSequence !== projection.adapterSequence
          ) {
            state = "failed";
            fail(
              "ELECTRON_MACOS_APPKIT_PROJECTION_ROLLBACK_STALE",
              "The AppKit projection changed before its transaction could roll back."
            );
          }
          restorePreviousJavaScriptProjection();
          try {
            if (nativeTabProjectionChanged) this.#commitNativeProjection(record);
            state = "rolled-back";
          } catch (error) {
            state = "failed";
            quarantineRequired = true;
            this.#markProjectionPoisoned(record, error);
            throw error;
          }
        });
      }
    });
  }

  #prepareWorkspaceDividerProjection(
    record: HostRecord,
    projection: AppKitRuntimeWindowProjectionRecord
  ): ChromiumRuntimeAppKitProjectionTransaction {
    const controller = requireNativeController(
      record,
      "a native workspace-divider projection"
    );
    return prepareMacosAppKitWorkspaceDividerProjection({
      identity: record.identity,
      projection,
      state: record.workspaceDividerProjection,
      contentBounds: () => this.#projectContentBounds(record),
      currentFenceMatches: () => this.#isExactOwner(record) &&
        record.windowGeneration === projection.windowGeneration &&
        record.topologyRevision === projection.topologyRevision &&
        record.lastAdapterSequence === projection.adapterSequence,
      apply: (revision, contentBounds, dividers) =>
        controller.applyWorkspaceDividerProjection(
          record.identity,
          revision,
          contentBounds,
          dividers
        )
    });
  }

  #applyPhaseProjection(
    record: HostRecord,
    projection: EmbeddedRuntimeWindowProjectionRecord
  ): void {
    const visibleTabIds = projection.tabIds.filter(
      (tabId) => !projection.hiddenTabIds.includes(tabId)
    );
    const projectedTabIds = [...record.projectedTabs.keys()];
    const phaseByTab = new Map(projection.tabPhases.map((tab) => [
      tab.tabId,
      tab.phase
    ]));
    if (
      projection.windowId !== record.identity.logicalWindowId ||
      projection.windowGeneration !== record.windowGeneration ||
      projection.topologyRevision < record.topologyRevision ||
      JSON.stringify(visibleTabIds) !== JSON.stringify(projectedTabIds) ||
      projection.activeTabId !== record.projectedActiveTabId ||
      phaseByTab.size !== projection.tabIds.length ||
      projection.tabIds.some((tabId) => !phaseByTab.has(tabId))
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_STALE",
        "Core supplied a stale AppKit phase-only projection."
      );
    }
    const previous = new Map(record.projectedTabs);
    const previousActive = record.projectedActiveTabId;
    const previousNativeProjectionRevision = record.nativeProjectionRevision;
    for (const tabId of visibleTabIds) {
      const current = record.projectedTabs.get(tabId)!;
      record.projectedTabs.set(tabId, Object.freeze({
        ...current,
        phase: phaseByTab.get(tabId)!
      }));
    }
    try {
      this.#commitNativeProjection(record);
      record.topologyRevision = projection.topologyRevision;
    } catch (error) {
      record.projectedTabs.clear();
      for (const [tabId, tab] of previous) record.projectedTabs.set(tabId, tab);
      record.projectedActiveTabId = previousActive;
      const restored = (() => {
        try {
          const receipt = record.controller?.restoreLastVerifiedTabProjection?.(
            record.identity
          );
          return receipt?.projectionRevision ===
              String(previousNativeProjectionRevision) &&
            receipt.tabCount === previous.size &&
            receipt.activeTabId === previousActive;
        } catch {
          return false;
        }
      })();
      if (restored) {
        record.nativeProjectionRevision = previousNativeProjectionRevision;
      } else {
        this.#markProjectionPoisoned(record, error);
      }
      throw error;
    }
  }

  #commitNativeProjection(record: HostRecord): void {
    const controller = requireNativeController(record, "a native tab projection");
    const revision = record.nativeProjectionRevision + 1;
    if (!Number.isSafeInteger(revision)) {
      fail(
        "ELECTRON_MACOS_APPKIT_PROJECTION_REVISION_EXHAUSTED",
        "The native AppKit projection revision is exhausted."
      );
    }
    record.nativeProjectionRevision = revision;
    const tabs = [...record.projectedTabs.values()].map((tab) => ({
      tabId: tab.tabId,
      name: tab.name,
      phase: tab.phase,
      tabType: tab.tabType,
      ...(tab.workspaceTemplate === undefined
        ? {}
        : { workspaceTemplate: tab.workspaceTemplate })
    }));
    const receipt = controller.applyTabProjection(
      record.identity,
      String(revision),
      tabs,
      record.projectedActiveTabId
    );
    if (
      receipt.projectionRevision !== String(revision) ||
      receipt.tabCount !== tabs.length ||
      receipt.activeTabId !== record.projectedActiveTabId
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_PROJECTION_RECEIPT_INVALID",
        "The native AppKit controller returned a mismatched projection receipt."
      );
    }
  }

  #receiveNativeEvent(record: HostRecord, eventJson: string): void {
    // Thread-safe native calls already queued before destroy may reach JS after
    // the controller fence. They carry valid historical identity, but are no
    // longer authoritative for a closing/replaced host and must be discarded.
    if (
      (record.state !== "opening" && record.state !== "active") ||
      record.native.isDestroyed() ||
      !this.#isExactOwner(record)
    ) {
      return;
    }
    try {
      if (
        typeof eventJson !== "string" ||
        Buffer.byteLength(eventJson, "utf8") > MAX_NATIVE_EVENT_BYTES
      ) {
        fail(
          "ELECTRON_MACOS_APPKIT_EVENT_INVALID",
          "The AppKit adapter emitted an oversized or malformed native event."
        );
      }
      const event = JSON.parse(eventJson) as unknown;
      if (
        !isRecord(event) ||
        !matchesMacosAppKitHostIdentity(event.identity, record.identity)
      ) {
        fail(
          "ELECTRON_MACOS_APPKIT_EVENT_STALE",
          "The AppKit adapter emitted stale native identity evidence."
        );
      }
      if (event.type === "layout") {
        record.layout = requireMacosAppKitContentLayout(event.layout);
        this.#publishLayout(record);
        return;
      }
      if (event.type === "action" && isRecord(event.action)) {
        const action = event.action;
        if (action.type === "windowFocusChanged") {
          if (action.sourceWindowId !== record.identity.logicalWindowId) {
            fail(
              "ELECTRON_MACOS_APPKIT_WINDOW_FOCUS_SOURCE_STALE",
              "The AppKit focus event lost its exact native window identity."
            );
          }
          publishMacosAppKitRuntimeWindowFocus(
            record,
            requireCapturedWindowFocusState(action)
          );
        }
        if (record.popupId) {
          switch (classifyMacosPopupAction(record.popupId, action)) {
            case "focus": record.native.focus(); break;
            case "close": record.popupObserver?.closeRequested(); break;
            case "layout": this.#refreshLayout(record); break;
            case "ignore": break;
            case "reject": {
              const error = hostError(
                "ELECTRON_MACOS_APPKIT_POPUP_ACTION_REJECTED",
                "The retained AppKit popup emitted an unsupported tab/window action."
              );
              this.#input.onError(normalizeRionBridgeError(error));
              record.popupObserver?.closeRequested();
            }
          }
          return;
        }
        if (
          action.type === "windowPlacementChanged" &&
          record.presentation.observeWindowPlacement()
        ) {
          return;
        }
        if (
          action.type === "windowFocusChanged" &&
          record.presentation.suppressWindowStateEvent()
        ) {
          return;
        }
        if (
          (action.type === "windowFocusChanged" ||
            action.type === "windowPlacementChanged") &&
          record.presentationGate.deferWindowState(action)
        ) {
          return;
        }
        this.#input.onAction({
          identity: record.identity,
          action: Object.freeze({ ...action }),
          hosts: this.#observationsForAction(record, action)
        });
        return;
      }
      fail(
        "ELECTRON_MACOS_APPKIT_EVENT_INVALID",
        "The AppKit adapter emitted an unknown native event."
      );
    } catch (error) {
      this.#poison(record, error);
    }
  }

  #refreshLayout(record: HostRecord): void {
    if (!record.controller || record.state === "closed" || record.state === "closing") {
      return;
    }
    try {
      record.layout = requireMacosAppKitContentLayout(
        record.controller.snapshotContentLayout(record.identity)
      );
      this.#publishLayout(record);
    } catch (error) {
      this.#poison(record, error);
      throw error;
    }
  }

  #publishRuntimeWindowState(record: HostRecord,
    source: "hide" | "minimize" | "restore" | "show"): void {
    if (record.state !== "active" || !this.#isExactOwner(record)) return;
    try {
      publishMacosAppKitRuntimeWindowState(record, source);
    } catch (error) {
      this.#poison(record, error);
    }
  }

  #publishLayout(record: HostRecord): void {
    if (!record.layout) return;
    if (record.popupId) {
      record.popupObserver?.layoutChanged(this.#projectContentBounds(record));
      return;
    }
    if (!this.#input.onLayout) return;
    if (record.presentationGate.deferLayout()) return;
    this.#input.onLayout({
      identity: record.identity,
      hosts: Object.freeze([this.#snapshotObservation(record)])
    });
  }

  #observationsForAction(
    record: HostRecord,
    action: Readonly<Record<string, unknown>>
  ): readonly AppKitRuntimeHostObservationRecord[] {
    const sourceWindowId = action.sourceWindowId;
    if (
      typeof sourceWindowId !== "string" ||
      sourceWindowId.length === 0
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_ACTION_SOURCE_MISSING",
        "The native AppKit action omitted its exact source window identity."
      );
    }
    const targetWindowId = action.targetWindowId ?? action.windowId;
    if (
      targetWindowId !== undefined &&
      (typeof targetWindowId !== "string" || targetWindowId.length === 0)
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_ACTION_TARGET_INVALID",
        "The native AppKit action carried an invalid target window identity."
      );
    }
    const primaryWindowId = typeof targetWindowId === "string"
      ? targetWindowId
      : sourceWindowId;
    if (primaryWindowId !== record.identity.logicalWindowId) {
      fail(
        "ELECTRON_MACOS_APPKIT_ACTION_HOST_MISMATCH",
        "The native AppKit action was emitted by a different target host."
      );
    }
    const primary = this.#activeByLogicalWindow.get(primaryWindowId);
    const source = this.#activeByLogicalWindow.get(sourceWindowId);
    if (!primary || !source || !this.#isExactOwner(primary) || !this.#isExactOwner(source)) {
      fail(
        "ELECTRON_MACOS_APPKIT_ACTION_HOST_STALE",
        "The native AppKit action references a stale source or target host."
      );
    }
    if (action.type === "windowPlacementChanged") {
      this.#refreshNormalBounds(primary);
      if (source !== primary) this.#refreshNormalBounds(source);
    }
    const captured = action.type === "windowFocusChanged"
      ? requireCapturedWindowFocusState(action)
      : undefined;
    const observations = [this.#snapshotObservation(primary, captured)];
    if (source !== primary) observations.push(this.#snapshotObservation(source));
    return Object.freeze(observations);
  }

  #refreshNormalBounds(record: HostRecord): void {
    if (
      record.native.isFullScreen() || record.native.isMaximized() ||
      record.native.isMinimized()
    ) {
      return;
    }
    const controller = requireNativeController(record, "a placement observation");
    record.layout = requireMacosAppKitContentLayout(
      controller.snapshotContentLayout(record.identity)
    );
    const frameBounds = record.native.getNormalBounds();
    requireMacosAppKitBounds(frameBounds, "normal window frame");
    // Match v22's durable geometry: outer window position plus AppKit's
    // unobscured content size. The native toolbar may expand Electron's raw
    // content view, but that is chrome rather than a user resize.
    const contentBounds = this.#projectContentBounds(record);
    record.normalBounds = Object.freeze({
      x: frameBounds.x,
      y: frameBounds.y,
      width: contentBounds.width,
      height: contentBounds.height
    });
  }

  #snapshotObservation(
    record: HostRecord,
    captured?: MacosAppKitCapturedWindowState
  ): AppKitRuntimeHostObservationRecord {
    return snapshotMacosAppKitRuntimeHostObservation({
      ...(captured ? { captured } : {}),
      contentBounds: this.#projectContentBounds(record),
      current: this.#isExactOwner(record),
      displays: this.#input.displays,
      record
    });
  }

  #contentBounds(record: HostRecord): ChromiumRoleSurfaceBounds {
    return this.#withCurrent(record, () => {
      this.#refreshLayout(record);
      return this.#projectContentBounds(record);
    });
  }

  #projectContentBounds(record: HostRecord): ChromiumRoleSurfaceBounds {
    const layout = record.layout;
    if (!layout) {
      fail(
        "ELECTRON_MACOS_APPKIT_LAYOUT_MISSING",
        "The AppKit content-layout projection is unavailable."
      );
    }
    const nativeBounds = record.native.getContentBounds();
    requireMacosAppKitBounds(nativeBounds, "native content");
    const y = Math.round(layout.yOffset);
    const heightInset = Math.round(layout.heightInset);
    const bounds = {
      x: 0,
      y,
      width: nativeBounds.width,
      height: nativeBounds.height - heightInset
    };
    requireMacosAppKitBounds(bounds, "Chromium content");
    return Object.freeze(bounds);
  }

  #onNativeCloseRequested(record: HostRecord, event: unknown): void {
    if (record.state === "closing") return;
    if (!isRecord(event) || typeof event.preventDefault !== "function") {
      this.#poison(record, hostError(
        "ELECTRON_MACOS_APPKIT_CLOSE_EVENT_INVALID",
        "Electron emitted an invalid AppKit close event."
      ));
      return;
    }
    (event as unknown as MacosAppKitPreventableWindowEvent).preventDefault();
    if (record.state === "active") {
      if (record.popupId) {
        record.popupObserver?.closeRequested();
        return;
      }
      this.#input.onCloseRequested(
        record.identity,
        Object.freeze([this.#snapshotObservation(record)])
      );
    }
  }

  #close(record: HostRecord): Promise<void> {
    if (record.closePromise) return record.closePromise;
    if (record.state === "closed") return record.closed.promise;
    record.presentation.close();
    record.state = "closing";
    const close = (async () => {
      if (record.inputBinding && this.#input.onHostClosing) {
        await this.#input.onHostClosing(record.inputBinding);
      }
      if (!record.controllerDetached) {
        const destroyed = requireNativeController(record, "exact native teardown")
          .destroy(record.identity);
        if (!destroyed) {
          fail(
            "ELECTRON_MACOS_APPKIT_CONTROLLER_STALE",
            "The exact AppKit controller was already detached before teardown."
          );
        }
        record.controllerDetached = true;
        record.controller = null;
        record.inputBinding = null;
      }
      record.native.destroy();
      await record.closed.promise;
    })();
    record.closePromise = close.catch((error: unknown) => {
      if (record.state !== "closed") {
        const normalized = normalizeRionBridgeError(
          error,
          "ELECTRON_MACOS_APPKIT_CLOSE_FAILED"
        );
        publishMacosAppKitRuntimeWindowState(record, "failed", normalized.code);
        record.state = "poisoned";
        record.closePromise = null;
      }
      throw error;
    });
    return record.closePromise;
  }

  #onClosed(record: HostRecord): void {
    if (record.state === "closed") return;
    record.presentation.close();
    let nativeDestroyed: boolean;
    try {
      nativeDestroyed = record.native.isDestroyed();
    } catch {
      nativeDestroyed = false;
    }
    const exactTeardown = record.state === "closing" && (
      record.controllerDetached || !record.controllerIdentityValidated
    ) && nativeDestroyed;
    const error = exactTeardown
      ? null
      : nativeDestroyed
        ? hostError(
            "ELECTRON_MACOS_APPKIT_NATIVE_CLOSE_UNFENCED",
            "The AppKit BaseWindow closed without an exact controller-detach fence."
          )
        : hostError(
            "ELECTRON_MACOS_APPKIT_NATIVE_DESTROY_READBACK_FAILED",
            "The AppKit BaseWindow emitted closed without an exact destroyed readback."
          );
    record.state = "closed";
    publishMacosAppKitRuntimeWindowState(
      record,
      error ? "failed" : "closed",
      error?.code
    );
    removeMacosAppKitRuntimeWindowListeners(record.native, record.listeners);
    if (this.#activeByLogicalWindow.get(record.identity.logicalWindowId) === record) {
      this.#activeByLogicalWindow.delete(record.identity.logicalWindowId);
    }
    if (this.#ownerByNativeId.get(record.nativeId) === record) {
      this.#ownerByNativeId.delete(record.nativeId);
    }
    this.#ownerByNativeWindow.delete(record.native);
    record.popupObserver?.closed();
    if (!error) {
      record.closed.resolve();
    } else {
      record.closed.reject(error);
      record.presentationReady.reject(error);
      if (record.controller) {
        try {
          record.controllerDetached = record.controller.destroy(record.identity);
        } catch {
          record.controllerDetached = false;
        }
        record.controller = null;
        record.inputBinding = null;
      }
      this.#input.onError(normalizeRionBridgeError(error));
    }
  }

  async #cleanupFailedCreation(record: HostRecord, cause: unknown): Promise<void> {
    if (record.state === "closed") return;
    const failure = normalizeRionBridgeError(
      cause,
      "ELECTRON_MACOS_APPKIT_CREATE_FAILED"
    );
    publishMacosAppKitRuntimeWindowState(record, "failed", failure.code);
    if (record.controller) {
      try {
        record.controllerDetached = record.controller.destroy(record.identity);
      } catch {
        record.controllerDetached = false;
      }
      record.controller = null;
      record.inputBinding = null;
    } else {
      record.controllerDetached = true;
    }
    if (!record.controllerDetached && record.controllerIdentityValidated) {
      record.state = "poisoned";
      this.#input.onError({
        code: "ELECTRON_MACOS_APPKIT_COMPENSATION_FAILED",
        message: "The failed AppKit host could not detach its exact native controller."
      });
      return;
    }
    record.state = "closing";
    if (!record.native.isDestroyed()) {
      record.native.destroy();
      try {
        await record.closed.promise;
      } catch {
        // The original creation failure remains the authoritative rejection.
      }
    } else {
      this.#onClosed(record);
    }
    this.#input.onError(failure);
  }

  #validateControllerIdentity(record: HostRecord): void {
    const controller = record.controller;
    if (
      !controller ||
      controller.logicalWindowId !== record.identity.logicalWindowId ||
      controller.launchGeneration !== record.identity.launchGeneration ||
      controller.nativeGeneration !== record.identity.nativeGeneration
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_CONTROLLER_IDENTITY_MISMATCH",
        "The Node adapter returned a stale AppKit controller identity."
      );
    }
  }

  #poison(record: HostRecord, error: unknown): void {
    if (record.state === "closed" || record.state === "closing") return;
    const wasOpening = record.state === "opening";
    const failure = normalizeRionBridgeError(
      error,
      "ELECTRON_MACOS_APPKIT_EVENT_INVALID"
    );
    record.presentation.close(error);
    publishMacosAppKitRuntimeWindowState(record, "failed", failure.code);
    record.state = "poisoned";
    this.#input.onError(failure);
    if (wasOpening) return;
    void this.#close(record).catch((closeError: unknown) => {
      this.#input.onError(normalizeRionBridgeError(
        closeError,
        "ELECTRON_MACOS_APPKIT_POISON_CLOSE_FAILED"
      ));
    });
  }

  #markProjectionPoisoned(record: HostRecord, error: unknown): void {
    if (record.state === "closed" || record.state === "closing") return;
    const failure = normalizeRionBridgeError(
      error,
      "ELECTRON_MACOS_APPKIT_PROJECTION_MUTATION_UNVERIFIED"
    );
    record.presentation.close(error);
    publishMacosAppKitRuntimeWindowState(record, "failed", failure.code);
    record.state = "poisoned";
    this.#input.onError(failure);
  }

  #requireExactActiveHost(
    expected: AppKitRuntimeHostIdentityRecord
  ): HostRecord {
    if (
      !expected || !Number.isSafeInteger(expected.nativeGeneration) ||
      expected.nativeGeneration < 1 || expected.nativeGeneration > 0xffff_ffff
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_IDENTITY_INVALID",
        "Core supplied an invalid AppKit runtime-host identity."
      );
    }
    const logicalWindowId = requireMacosAppKitIdentifier(
      expected.logicalWindowId,
      "logical window"
    );
    requireMacosAppKitIdentifier(expected.launchGeneration, "launch generation");
    const record = this.#activeByLogicalWindow.get(logicalWindowId);
    if (
      !record || record.state !== "active" || !record.controller ||
      !matchesMacosAppKitHostIdentity(expected, record.identity) ||
      !this.#isExactOwner(record)
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_STALE_GENERATION",
        "The AppKit runtime-host generation is no longer current."
      );
    }
    return record;
  }

  #withCurrent<Value>(record: HostRecord, operation: () => Value): Value {
    if (
      record.state !== "active" ||
      record.native.isDestroyed() ||
      !this.#isExactOwner(record)
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_STALE_GENERATION",
        "The AppKit runtime-host generation is no longer current."
      );
    }
    return operation();
  }
  #isExactOwner(record: HostRecord): boolean {
    return this.#activeByLogicalWindow.get(record.identity.logicalWindowId) === record &&
      this.#ownerByNativeId.get(record.nativeId) === record &&
      this.#ownerByNativeWindow.get(record.native) === record;
  }

  #nextNativeGeneration(logicalWindowId: string): number {
    const next = (this.#lastNativeGeneration.get(logicalWindowId) ?? 0) + 1;
    if (!Number.isSafeInteger(next) || next > 0xffff_ffff) {
      fail(
        "ELECTRON_MACOS_APPKIT_GENERATION_EXHAUSTED",
        "The AppKit native-window generation is exhausted."
      );
    }
    this.#lastNativeGeneration.set(logicalWindowId, next);
    return next;
  }
}
