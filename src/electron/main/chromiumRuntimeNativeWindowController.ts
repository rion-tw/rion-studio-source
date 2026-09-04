import { randomUUID } from "node:crypto";

import type {
  AppKitRuntimeHostIdentityRecord,
  RuntimeTabMoveResultRecord,
  RuntimeWindowPreferencesRecord,
  RuntimeWindowZoomReceiptRecord,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type {
  AnyAuthenticatedChromiumRuntimeAction,
  ChromiumRuntimeActionBackend
} from "./chromiumRuntimeActionController";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";

function controlError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export type ChromiumRuntimeNativeTabAction =
  | Readonly<{ type: "activateTab" }>
  | Readonly<{ type: "closeTab" }>
  | Readonly<{ type: "hideTab" }>
  | Readonly<{ muted: boolean; type: "setTabMuted" }>
  | Readonly<{ type: "moveTabToNewWindow" }>
  | Readonly<{ targetWindowId: string; type: "moveTab" }>
  | Readonly<{ beforeTabId?: string; type: "reorderTab" }>;

export interface ChromiumRuntimeWindowActionTarget {
  readonly activeTabId: string;
  readonly appKitIdentity?: AppKitRuntimeHostIdentityRecord;
  readonly parentNativeHostId: number;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

export type ChromiumRuntimeFullscreenFocusAdmission =
  "windows-native-foreground";

/** Routes native menu/toolbar actions back through the same Core-owned lanes. */
export class ChromiumRuntimeNativeWindowController {
  readonly #core: ElectronCoreCommandPort;
  readonly #backend: ChromiumRuntimeActionBackend;
  readonly #readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly #platform: "darwin" | "win32";
  readonly #presentationLanes = new Map<string, Promise<void>>();
  readonly #zoomLanes = new Map<string, Promise<void>>();
  #adapterSequence = 0;

  constructor(input: Readonly<{
    backend: ChromiumRuntimeActionBackend;
    core: ElectronCoreCommandPort;
    platform: "darwin" | "win32";
    readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  }>) {
    this.#backend = input.backend;
    this.#core = input.core;
    this.#platform = input.platform;
    this.#readNativeSnapshot = input.readNativeSnapshot;
  }

  async toggleFullscreenForTab(
    tabId: string,
    focusAdmission?: ChromiumRuntimeFullscreenFocusAdmission
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    if (focusAdmission && this.#platform !== "win32") {
      throw controlError(
        "ELECTRON_RUNTIME_FULLSCREEN_ADMISSION_INVALID",
        "Only the exact Win32 shortcut owner may admit a blurred fullscreen target."
      );
    }
    const native = this.#readNativeSnapshot().tabs.find((tab) => tab.tabId === tabId);
    if (!native) {
      throw controlError(
        "ELECTRON_RUNTIME_FULLSCREEN_TAB_STALE",
        "The managed Role tab no longer owns a native runtime window."
      );
    }
    const window = this.#readNativeSnapshot().windows.find(
      (candidate) => candidate.windowId === native.windowId
    );
    if (!window?.parentNativeHostId) {
      throw controlError(
        "ELECTRON_RUNTIME_FULLSCREEN_WINDOW_STALE",
        "The managed Role tab lost its exact native host identity."
      );
    }
    const target = Object.freeze({
      activeTabId: window.activeTabId,
      ...(window.appKitIdentity
        ? { appKitIdentity: Object.freeze({ ...window.appKitIdentity }) }
        : {}),
      parentNativeHostId: window.parentNativeHostId,
      topologyRevision: window.topologyRevision,
      windowGeneration: window.windowGeneration,
      windowId: window.windowId
    });
    return this.#setPresentation(
      target.windowId,
      window.presentation === "fullscreen" ? "normal" : "fullscreen",
      target,
      focusAdmission
    );
  }

  toggleFullscreenForTarget(
    target: ChromiumRuntimeWindowActionTarget
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const window = this.#requireExplicitWindowTarget(target);
    return this.#setPresentation(
      target.windowId,
      window.presentation === "fullscreen" ? "normal" : "fullscreen",
      target
    );
  }

  zoomRuntimeWindow(
    target: ChromiumRuntimeWindowActionTarget,
    action: "in" | "out" | "reset"
  ): Promise<RuntimeWindowZoomReceiptRecord> {
    const prior = this.#zoomLanes.get(target.windowId) ?? Promise.resolve();
    const operation = prior.then(() => this.#zoomRuntimeWindowNow(target, action));
    const tail = operation.then(() => undefined, () => undefined);
    this.#zoomLanes.set(target.windowId, tail);
    return operation.finally(() => {
      if (this.#zoomLanes.get(target.windowId) === tail) {
        this.#zoomLanes.delete(target.windowId);
      }
    });
  }

  async requestWindowControl(
    windowId: string,
    action: "closeWindow" | "toggleMaximizeWindow"
  ): Promise<void> {
    if (action === "closeWindow") {
      const receipt = await this.#executeNativeAction({
        type: "stopGameWindow",
        windowId
      });
      const summary = receipt.value as SystemRuntimeOperationSummaryRecord;
      if (receipt.status !== "applied" || summary.status !== "applied") {
        throw controlError(
          "ELECTRON_RUNTIME_WINDOW_CLOSE_NOT_APPLIED",
          "Core did not terminalize the exact native close as applied."
        );
      }
      return;
    }
    const native = this.#readNativeSnapshot().windows.find(
      (candidate) => candidate.windowId === windowId
    );
    await this.#setPresentation(
      windowId,
      native?.presentation === "normal" ? "maximized" : "normal"
    );
  }

  async requestTabControl(
    tabId: string,
    action: ChromiumRuntimeNativeTabAction
  ): Promise<void> {
    const nativeAction: AnyAuthenticatedChromiumRuntimeAction["action"] =
      action.type === "activateTab"
        ? { type: "showGameWindowTab", tabId }
        : action.type === "closeTab"
          ? { type: "stopGameWindowTab", tabId }
          : action.type === "hideTab"
            ? { type: "setGameWindowTabHidden", tabId, hidden: true }
            : action.type === "setTabMuted"
              ? { type: "setGameWindowTabMuted", tabId, muted: action.muted }
            : action.type === "moveTabToNewWindow"
              ? { type: "moveGameWindowTabToNewWindow", tabId }
              : action.type === "moveTab"
                ? {
                    type: "moveGameWindowTab",
                    tabId,
                    windowId: action.targetWindowId
                  }
                : {
                    type: "reorderGameWindowTab",
                    tabId,
                    ...(action.beforeTabId === undefined
                      ? {}
                      : { beforeTabId: action.beforeTabId })
                  };
    const receipt = await this.#executeNativeAction(nativeAction);
    const summary = action.type === "moveTabToNewWindow"
      ? (receipt.value as RuntimeTabMoveResultRecord).receipt
      : receipt.value as SystemRuntimeOperationSummaryRecord;
    if (receipt.status !== "applied" || summary.status !== "applied") {
      throw controlError(
        "ELECTRON_RUNTIME_TAB_CONTROL_NOT_APPLIED",
        "Core did not terminalize the exact native tab control as applied."
      );
    }
  }

  async setAlwaysShowToolbarInFullScreen(
    alwaysShowToolbarInFullScreen: boolean
  ): Promise<RuntimeWindowPreferencesRecord> {
    const preferences = await this.#core.invoke({
      type: "runtimeWindowPreferencesGet"
    });
    const receipt = await this.#executeNativeAction({
      type: "updateRuntimeWindowPreferences",
      preferences: {
        ...preferences,
        alwaysShowToolbarInFullScreen
      }
    });
    if (receipt.status !== "applied") {
      throw controlError(
        "ELECTRON_RUNTIME_WINDOW_PREFERENCES_NOT_APPLIED",
        "Core did not apply the native runtime-window preference."
      );
    }
    return receipt.value as RuntimeWindowPreferencesRecord;
  }

  async #setPresentation(
    windowId: string,
    presentation: "fullscreen" | "maximized" | "normal",
    target?: ChromiumRuntimeWindowActionTarget,
    focusAdmission?: ChromiumRuntimeFullscreenFocusAdmission
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const prior = this.#presentationLanes.get(windowId);
    // The first event-bound presentation ingress is already serialized by the
    // absence of a lane. Start it in the current native callback turn so a
    // Win32 TSFN delivery cannot lose its exact HWND/revision fence behind an
    // otherwise unnecessary Promise microtask. Contended requests still chain.
    const begin = () => this.#setPresentationNow(
      windowId,
      presentation,
      target,
      focusAdmission
    );
    const operation = prior ? prior.then(begin) : begin();
    const tail = operation.then(() => undefined, () => undefined);
    this.#presentationLanes.set(windowId, tail);
    return operation.finally(() => {
      if (this.#presentationLanes.get(windowId) === tail) {
        this.#presentationLanes.delete(windowId);
      }
    });
  }

  async #setPresentationNow(
    windowId: string,
    presentation: "fullscreen" | "maximized" | "normal",
    target?: ChromiumRuntimeWindowActionTarget,
    focusAdmission?: ChromiumRuntimeFullscreenFocusAdmission
  ): Promise<SystemRuntimeOperationSummaryRecord> {
    const requireFocused = focusAdmission === undefined;
    if (focusAdmission && this.#platform !== "win32") {
      throw controlError(
        "ELECTRON_RUNTIME_FULLSCREEN_ADMISSION_INVALID",
        "The native fullscreen focus admission is not valid on this platform."
      );
    }
    if (target) {
      this.#requireExplicitWindowTarget(
        target,
        target.topologyRevision,
        requireFocused
      );
    }
    const core = await this.#core.invoke({ type: "appSnapshot" });
    const logical = core.logicalWindows.find((window) => window.windowId === windowId);
    const native = this.#readNativeSnapshot().windows.find(
      (window) => window.windowId === windowId
    );
    if (
      !logical || !native ||
      logical.windowGeneration !== native.windowGeneration ||
      logical.revision !== native.topologyRevision ||
      logical.presentation !== native.presentation ||
      logical.tabs.length !== native.tabIds.length ||
      logical.tabs.some((tab, index) => tab.id !== native.tabIds[index])
    ) {
      throw controlError(
        "ELECTRON_RUNTIME_WINDOW_PRESENTATION_FENCE_STALE",
        "The native window control lost its exact Core topology fence."
      );
    }
    const summary = await this.#core.invoke({
      type: "embeddedWindowPresentation",
      operationId: randomUUID(),
      windowId,
      windowGeneration: logical.windowGeneration,
      topologyRevision: logical.revision,
      presentation
    });
    if (summary.status !== "applied") {
      throw controlError(
        "ELECTRON_RUNTIME_WINDOW_PRESENTATION_NOT_APPLIED",
        "Core did not terminalize the exact native presentation as applied."
      );
    }
    if (target) {
      if (!Number.isSafeInteger(summary.topologyRevision)) {
        throw controlError(
          "ELECTRON_RUNTIME_WINDOW_PRESENTATION_RECEIPT_INVALID",
          "Core omitted the exact runtime-window presentation revision."
        );
      }
      this.#requireExplicitWindowTarget(
        target,
        summary.topologyRevision!,
        requireFocused
      );
    }
    return summary;
  }

  async #zoomRuntimeWindowNow(
    target: ChromiumRuntimeWindowActionTarget,
    action: "in" | "out" | "reset"
  ): Promise<RuntimeWindowZoomReceiptRecord> {
    const admitted = this.#requireExplicitWindowTarget(target);
    const admittedZoomFactor = admitted.windowZoomFactor ?? 1;
    const operationId = randomUUID();
    const receipt = await this.#core.invoke({
      type: "browserRuntimeWindowZoom",
      operationId,
      windowId: target.windowId,
      windowGeneration: target.windowGeneration,
      topologyRevision: target.topologyRevision,
      action
    });
    if (
      receipt.operationId !== operationId || receipt.windowId !== target.windowId ||
      receipt.windowGeneration !== target.windowGeneration ||
      receipt.sourceTopologyRevision !== target.topologyRevision ||
      receipt.action !== action || receipt.status !== "applied" ||
      receipt.failureCode !== undefined ||
      !Number.isSafeInteger(receipt.topologyRevision) ||
      receipt.topologyRevision < target.topologyRevision ||
      receipt.previousZoomFactor !== admittedZoomFactor ||
      !Number.isFinite(receipt.nextZoomFactor) ||
      receipt.nextZoomFactor < 0.25 || receipt.nextZoomFactor > 5
    ) {
      throw controlError(
        "ELECTRON_RUNTIME_WINDOW_ZOOM_NOT_APPLIED",
        "Core did not terminalize the exact runtime-window zoom as applied."
      );
    }
    const current = this.#requireExplicitWindowTarget(target, receipt.topologyRevision);
    if (current.windowZoomFactor !== receipt.nextZoomFactor) {
      throw controlError(
        "ELECTRON_RUNTIME_WINDOW_ZOOM_READBACK_STALE",
        "The native runtime window did not retain Core's exact zoom revision."
      );
    }
    return Object.freeze({ ...receipt });
  }

  #requireExplicitWindowTarget(
    target: ChromiumRuntimeWindowActionTarget,
    topologyRevision: number = target.topologyRevision,
    requireFocused = true
  ): ChromiumRuntimeExecutorSnapshot["windows"][number] {
    const native = this.#readNativeSnapshot().windows.find((candidate) =>
      candidate.windowId === target.windowId);
    const appKitMatches = this.#platform === "darwin"
      ? target.appKitIdentity !== undefined && native?.appKitIdentity !== undefined &&
        target.appKitIdentity.logicalWindowId === native.appKitIdentity.logicalWindowId &&
        target.appKitIdentity.launchGeneration === native.appKitIdentity.launchGeneration &&
        target.appKitIdentity.nativeGeneration === native.appKitIdentity.nativeGeneration
      : target.appKitIdentity === undefined && native?.appKitIdentity === undefined;
    if (
      !native || native.activeTabId !== target.activeTabId ||
      !native.visible || (requireFocused && !native.focused) ||
      target.activeTabId.length === 0 ||
      !native.tabIds.includes(target.activeTabId) ||
      !Number.isSafeInteger(target.parentNativeHostId) ||
      target.parentNativeHostId < 1 ||
      !Number.isSafeInteger(target.windowGeneration) ||
      target.windowGeneration < 1 ||
      !Number.isSafeInteger(target.topologyRevision) ||
      target.topologyRevision < 1 ||
      !Number.isSafeInteger(native.parentNativeHostId) ||
      (native.parentNativeHostId ?? 0) < 1 ||
      !Number.isSafeInteger(native.windowGeneration) ||
      native.windowGeneration < 1 ||
      !Number.isSafeInteger(native.topologyRevision) ||
      native.topologyRevision < 1 ||
      native.parentNativeHostId !== target.parentNativeHostId ||
      native.windowGeneration !== target.windowGeneration ||
      native.topologyRevision !== topologyRevision || !appKitMatches
    ) {
      throw controlError(
        "ELECTRON_RUNTIME_WINDOW_ACTION_FENCE_STALE",
        "The explicit native runtime-window target no longer matches its exact host fence."
      );
    }
    return native;
  }

  async #executeNativeAction(
    action: AnyAuthenticatedChromiumRuntimeAction["action"]
  ) {
    this.#adapterSequence += 1;
    if (!Number.isSafeInteger(this.#adapterSequence)) {
      throw controlError(
        "ELECTRON_RUNTIME_NATIVE_ACTION_SEQUENCE_EXHAUSTED",
        "The native runtime action sequence is exhausted."
      );
    }
    return this.#backend.execute({
      action,
      adapterSequence: this.#adapterSequence,
      intentId: randomUUID(),
      rendererGeneration: 1,
      rendererInstanceId: "native-runtime-chrome"
    } as AnyAuthenticatedChromiumRuntimeAction);
  }
}
