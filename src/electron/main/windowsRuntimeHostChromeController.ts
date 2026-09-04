import { randomUUID } from "node:crypto";

import type {
  BrowserWorkspaceDividerPointerReceiptRecord,
  BrowserWorkspaceDividerPointerRecord,
  RuntimeWindowPreferencesRecord
} from "../../shared/generated";
import {
  isWindowsRuntimeHostProjection,
  isWindowsRuntimeHostCommand,
  WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL,
  type WindowsRuntimeHostMoveTargetProjection,
  type WindowsRuntimeHostProjection,
  type WindowsRuntimeHostTabCommand,
  type WindowsRuntimeHostToolbarCommand,
  type WindowsRuntimeWorkspaceDividerPointerCommand,
  type WindowsRuntimeWorkspaceDividerProjection
} from "../../shared/windowsRuntimeHost";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeFullscreenToolbarObservation,
  ChromiumRuntimeWindowChromeLayoutProjection,
  ChromiumRuntimeWindowChromeProjection,
  ChromiumRuntimeWindowPresentationRequest
} from "./chromiumRuntimeFullscreenToolbar";
import type { ChromiumRuntimeHostProjection } from "./chromiumRuntimeHostPorts";
import type { ChromiumRuntimeNativeTabAction } from
  "./chromiumRuntimeNativeWindowController";
import type { ControlledRuntimeTabReloadFence } from
  "./controlledRuntimeTabReload";

export const WINDOWS_RUNTIME_CHROME_INSET = 40;
export const WINDOWS_RUNTIME_REVEAL_EDGE_INSET = 2;

interface WindowsRuntimeHostChromeNativePort {
  isDestroyed: () => boolean;
  isFullScreen: () => boolean;
  isMaximized: () => boolean;
  isMinimized: () => boolean;
  maximize: () => void;
  minimize: () => void;
  setFullScreen: (fullscreen: boolean) => void;
  unmaximize: () => void;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

interface ActiveWorkspaceDividerGesture {
  readonly attemptGeneration: string;
  readonly dividerIndex: number;
  readonly gestureId: string;
  lastPointerSequence: number;
  topologyRevision: number;
  readonly tabId: string;
}

type WindowsNativePresentationEvent =
  | "enteredFullscreen"
  | "leftFullscreen"
  | "maximized"
  | "unmaximized";

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function chromeError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function nativePresentation(
  native: WindowsRuntimeHostChromeNativePort
): ChromiumRuntimeWindowPresentationRequest["presentation"] {
  return native.isFullScreen()
    ? "fullscreen"
    : native.isMaximized() ? "maximized" : "normal";
}

/**
 * Owns the bundled Windows tab row and its event-bound native presentation
 * lane. It never commits Core state; only the requesting Rust effect may do so.
 */
export class WindowsRuntimeHostChromeController {
  readonly #windowId: string;
  readonly #documentUrl: string;
  readonly #native: WindowsRuntimeHostChromeNativePort;
  readonly #readProjection: () => ChromiumRuntimeHostProjection;
  readonly #send: (channel: string, projection: WindowsRuntimeHostProjection) => void;
  readonly #requestWindowControl: (
    action: "closeWindow" | "toggleMaximizeWindow"
  ) => Promise<void>;
  readonly #requestTabControl: (
    tabId: string,
    action: ChromiumRuntimeNativeTabAction
  ) => Promise<void>;
  readonly #requestTabReload: (
    fence: ControlledRuntimeTabReloadFence
  ) => Promise<void>;
  readonly #readLifecycleEpoch: () => number;
  readonly #requestWorkspaceDividerPointer: (
    event: BrowserWorkspaceDividerPointerRecord
  ) => Promise<BrowserWorkspaceDividerPointerReceiptRecord>;
  readonly #nativeHostId: number;
  readonly #hostGeneration: number;
  #alwaysShow = false;
  #revealed = false;
  #documentReady = false;
  #windowGeneration = 0;
  #topologyRevision = 0;
  #projectionRevision = 0;
  #activeTabId: string | null = null;
  #tabs: ChromiumRuntimeWindowChromeProjection["tabs"] = Object.freeze([]);
  #moveTargets: readonly WindowsRuntimeHostMoveTargetProjection[] = Object.freeze([]);
  #contentBounds: ChromiumRuntimeWindowChromeProjection["contentBounds"] | null = null;
  #workspaceDividers: readonly WindowsRuntimeWorkspaceDividerProjection[] =
    Object.freeze([]);
  readonly #dividerGestures = new Map<string, ActiveWorkspaceDividerGesture>();
  #layoutObserver: (() => Promise<void>) | null = null;
  #layoutLane: Promise<void> = Promise.resolve();
  #placementObserver: (() => Promise<void>) | null = null;
  #placementLane: Promise<void> = Promise.resolve();
  #commandLane: Promise<void> = Promise.resolve();
  #pendingMinimize: Deferred<void> | null = null;
  #pending: {
    readonly request: ChromiumRuntimeWindowPresentationRequest;
    readonly completion: Deferred<ChromiumRuntimeHostProjection>;
    expectedEvent: WindowsNativePresentationEvent | null;
  } | null = null;

  constructor(input: Readonly<{
    documentUrl: string;
    native: WindowsRuntimeHostChromeNativePort;
    readProjection: () => ChromiumRuntimeHostProjection;
    requestWindowControl: (
      action: "closeWindow" | "toggleMaximizeWindow"
    ) => Promise<void>;
    requestTabControl?: (
      tabId: string,
      action: ChromiumRuntimeNativeTabAction
    ) => Promise<void>;
    requestTabReload?: (
      fence: ControlledRuntimeTabReloadFence
    ) => Promise<void>;
    readLifecycleEpoch?: () => number;
    requestWorkspaceDividerPointer: (
      event: BrowserWorkspaceDividerPointerRecord
    ) => Promise<BrowserWorkspaceDividerPointerReceiptRecord>;
    nativeHostId: number;
    hostGeneration: number;
    send: (channel: string, projection: WindowsRuntimeHostProjection) => void;
    windowId: string;
  }>) {
    this.#windowId = input.windowId;
    this.#documentUrl = input.documentUrl;
    this.#native = input.native;
    this.#readProjection = input.readProjection;
    this.#requestWindowControl = input.requestWindowControl;
    this.#requestTabControl = input.requestTabControl ?? (() => Promise.reject(chromeError(
      "ELECTRON_WINDOWS_RUNTIME_TAB_CONTROL_UNAVAILABLE",
      "The Core-owned Windows tab control lane is unavailable."
    )));
    this.#requestTabReload = input.requestTabReload ?? (() => Promise.reject(chromeError(
      "ELECTRON_WINDOWS_RUNTIME_TAB_RELOAD_UNAVAILABLE",
      "The controlled Windows Reload lane is unavailable."
    )));
    this.#readLifecycleEpoch = input.readLifecycleEpoch ?? (() => 1);
    if (!Number.isSafeInteger(input.nativeHostId) || input.nativeHostId < 1 ||
        !Number.isSafeInteger(input.hostGeneration) || input.hostGeneration < 1) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_DIVIDER_HOST_INVALID",
        "The Windows divider requires an exact native host generation."
      );
    }
    this.#requestWorkspaceDividerPointer = input.requestWorkspaceDividerPointer;
    this.#nativeHostId = input.nativeHostId;
    this.#hostGeneration = input.hostGeneration;
    this.#send = input.send;
  }

  get contentInset(): number {
    return this.#toolbarVisible()
      ? WINDOWS_RUNTIME_CHROME_INSET
      : WINDOWS_RUNTIME_REVEAL_EDGE_INSET;
  }

  bindLayout(observer: () => Promise<void>): void {
    if (typeof observer !== "function") {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_LAYOUT_OBSERVER_INVALID",
        "The runtime host requires an exact asynchronous layout observer."
      );
    }
    this.#layoutObserver = observer;
  }

  bindPlacement(observer: () => Promise<void>): void {
    if (typeof observer !== "function" || this.#placementObserver) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_OBSERVER_INVALID",
        "The runtime host requires one exact asynchronous placement observer."
      );
    }
    this.#placementObserver = observer;
  }

  async applyCoreProjection(
    projection: ChromiumRuntimeWindowChromeProjection
  ): Promise<void> {
    await this.#applyProjection(projection);
  }

  async applyRetainedPhaseLayoutProjection(
    projection: ChromiumRuntimeWindowChromeLayoutProjection
  ): Promise<void> {
    const phaseByTab = new Map(this.#tabs.map((tab) => [tab.tabId, tab.phase]));
    if (
      projection.tabs.length !== this.#tabs.length ||
      projection.tabs.some((tab, index) => {
        const prior = this.#tabs[index];
        return !prior || prior.tabId !== tab.tabId || prior.name !== tab.name ||
          prior.active !== tab.active || prior.hidden !== tab.hidden ||
          !phaseByTab.has(tab.tabId);
      })
    ) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_LAYOUT_PHASE_FENCE_STALE",
        "A Windows layout-only projection cannot invent or replace Core tab phase state."
      );
    }
    await this.#applyProjection({
      ...projection,
      moveTargets: this.#moveTargets,
      tabs: projection.tabs.map((tab) => ({
        ...tab,
        phase: phaseByTab.get(tab.tabId)!
      }))
    });
  }

  async #applyProjection(
    projection: ChromiumRuntimeWindowChromeProjection
  ): Promise<void> {
    if (
      projection.windowId !== this.#windowId ||
      !Number.isSafeInteger(projection.windowGeneration) ||
      projection.windowGeneration < 1 ||
      !Number.isSafeInteger(projection.topologyRevision) ||
      projection.topologyRevision < 1 ||
      (this.#windowGeneration !== 0 &&
        projection.windowGeneration !== this.#windowGeneration) ||
      projection.topologyRevision < this.#topologyRevision
    ) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_CHROME_PROJECTION_STALE",
        "The Windows toolbar projection lost its exact Core fence."
      );
    }
    const tabs = Object.freeze(projection.tabs.map((tab) => Object.freeze({
      ...tab
    })));
    const contentBounds = Object.freeze({ ...projection.contentBounds });
    const moveTargets = Object.freeze(projection.moveTargets.map((target) =>
      Object.freeze({ ...target })
    ));
    const workspaceDividers = Object.freeze(projection.workspaceDividers.map(
      (divider) => Object.freeze({
        ...divider,
        bounds: Object.freeze({ ...divider.bounds })
      })
    ));
    if (!isWindowsRuntimeHostProjection({
      activeTabId: projection.activeTabId,
      alwaysShowToolbarInFullScreen: this.#alwaysShow,
      contentBounds,
      fullscreen: this.#native.isFullScreen(),
      lifecycleEpoch: this.#currentLifecycleEpoch(),
      moveTargets,
      projectionRevision: 1,
      tabs,
      toolbarVisible: this.#toolbarVisible(),
      topologyRevision: projection.topologyRevision,
      windowGeneration: projection.windowGeneration,
      windowId: projection.windowId,
      workspaceDividers
    })) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_CHROME_PROJECTION_INVALID",
        "Core supplied malformed Windows toolbar or workspace-divider geometry."
      );
    }
    this.#windowGeneration = projection.windowGeneration;
    this.#topologyRevision = projection.topologyRevision;
    this.#activeTabId = projection.activeTabId;
    this.#tabs = tabs;
    this.#moveTargets = moveTargets;
    this.#contentBounds = contentBounds;
    this.#workspaceDividers = workspaceDividers;
    this.#advanceProjection();
    this.#publish();
  }

  async applyPreferences(preferences: RuntimeWindowPreferencesRecord): Promise<void> {
    if (typeof preferences.alwaysShowToolbarInFullScreen !== "boolean") {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_PREFERENCES_INVALID",
        "Core supplied invalid runtime-window preferences."
      );
    }
    if (this.#alwaysShow === preferences.alwaysShowToolbarInFullScreen) return;
    const expectedWindowGeneration = this.#windowGeneration;
    const expectedTopologyRevision = this.#topologyRevision;
    const previousAlwaysShow = this.#alwaysShow;
    const previousRevealed = this.#revealed;
    this.#alwaysShow = preferences.alwaysShowToolbarInFullScreen;
    if (this.#alwaysShow) this.#revealed = false;
    try {
      await this.#relayout();
      if (
        expectedWindowGeneration > 0 && (
          this.#windowGeneration !== expectedWindowGeneration ||
          this.#topologyRevision !== expectedTopologyRevision
        )
      ) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_PREFERENCES_FENCE_STALE",
          "The Windows toolbar preference lost its exact Core window fence."
        );
      }
      this.#advanceProjection();
      this.#publish();
    } catch (error) {
      this.#alwaysShow = previousAlwaysShow;
      this.#revealed = previousRevealed;
      try {
        await this.#relayout();
        this.#advanceProjection();
        this.#publish();
      } catch {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_PREFERENCES_COMPENSATION_FAILED",
          "The Windows toolbar preference could not restore its prior projection."
        );
      }
      throw error;
    }
  }

  documentLoaded(url: string): void {
    if (url !== this.#documentUrl) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_DOCUMENT_MISMATCH",
        "The Windows toolbar loaded outside its canonical packaged document."
      );
    }
    this.#documentReady = true;
    this.#advanceProjection();
    this.#publish();
  }

  async handleCommand(url: string, candidate: unknown): Promise<void> {
    const isReload = typeof candidate === "object" && candidate !== null &&
      "type" in candidate && candidate.type === "reloadTab";
    let reloadCommand: Extract<
      WindowsRuntimeHostTabCommand,
      { type: "reloadTab" }
    > | null = null;
    let reloadTerminal: Promise<void> | null = null;
    const operation = this.#commandLane.then(() => {
      if (
        url !== this.#documentUrl || !isWindowsRuntimeHostCommand(candidate) ||
        candidate.windowId !== this.#windowId ||
        candidate.projectionRevision !== this.#projectionRevision
      ) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_COMMAND_FENCE_STALE",
          "The bundled toolbar command did not match its exact sender projection."
        );
      }
      if (candidate.type === "workspaceDividerPointer") {
        return this.#applyWorkspaceDividerCommand(candidate);
      } else if (
        candidate.type === "activateTab" || candidate.type === "closeTab" ||
        candidate.type === "hideTab" || candidate.type === "moveTab" ||
        candidate.type === "moveTabToNewWindow" ||
        candidate.type === "reloadTab" || candidate.type === "reorderTab"
      ) {
        if (candidate.type === "reloadTab") {
          reloadCommand = candidate;
          reloadTerminal = this.#applyTabCommand(candidate);
          return;
        }
        return this.#applyTabCommand(candidate);
      } else {
        return this.#applyToolbarCommand(candidate);
      }
    });
    const publishFailure = (error: unknown): never => {
      if (!this.#native.isDestroyed()) {
        this.#advanceProjection();
        this.#publish();
      }
      throw error;
    };
    const terminal = isReload
      ? operation.then(() => reloadTerminal!).then(
          () => this.#publishReloadCompletion(reloadCommand!),
          publishFailure
        )
      : operation.catch(publishFailure);
    this.#commandLane = (isReload ? operation : terminal).catch(() => undefined);
    return terminal;
  }

  async setPresentation(
    request: ChromiumRuntimeWindowPresentationRequest
  ): Promise<ChromiumRuntimeHostProjection> {
    if (
      request.windowId !== this.#windowId ||
      request.windowGeneration !== this.#windowGeneration ||
      request.topologyRevision !== this.#topologyRevision ||
      this.#native.isDestroyed()
    ) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_PRESENTATION_FENCE_STALE",
        "The native presentation request lost its exact Windows host fence."
      );
    }
    if (this.#pending) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_PRESENTATION_BUSY",
        "Another event-bound native presentation request is still active."
      );
    }
    if (nativePresentation(this.#native) === request.presentation) {
      await this.#syncNativePresentation();
      return this.#readProjection();
    }
    const completion = deferred<ChromiumRuntimeHostProjection>();
    this.#pending = { request, completion, expectedEvent: null };
    try {
      this.#drivePendingPresentation();
    } catch (error) {
      this.#pending = null;
      completion.reject(error);
    }
    return completion.promise;
  }

  async nativePresentationChanged(event: WindowsNativePresentationEvent): Promise<void> {
    const pending = this.#pending;
    if (!pending) {
      await this.#syncNativePresentation();
      return;
    }
    // Only the exact event armed before the native mutation may advance this
    // transaction. Clearing it before relayout coalesces reentrant duplicate
    // events caused by Chromium view geometry updates.
    if (pending.expectedEvent !== event) return;
    pending.expectedEvent = null;
    try {
      await this.#syncNativePresentation();
    } catch (error) {
      if (this.#pending === pending) this.#pending = null;
      pending.completion.reject(error);
      throw error;
    }
    if (this.#pending !== pending) return;
    if (nativePresentation(this.#native) === pending.request.presentation) {
      this.#pending = null;
      pending.completion.resolve(this.#readProjection());
      return;
    }
    try {
      this.#drivePendingPresentation();
    } catch (error) {
      this.#pending = null;
      pending.completion.reject(error);
    }
  }

  async nativeBoundsChanged(): Promise<void> {
    // Resize/move events emitted by a programmatic presentation transition
    // belong to that pending event-bound transaction. Their intermediate
    // geometry must not enqueue relayout work ahead of the exact native
    // presentation event; that event applies the one authoritative layout.
    if (this.#pending) return;
    await this.#relayout();
    const observer = this.#placementObserver;
    if (!observer || this.#windowGeneration < 1 || this.#topologyRevision < 1) return;
    const next = this.#placementLane.then(observer);
    this.#placementLane = next.catch(() => undefined);
    return next;
  }

  nativeMinimized(): void {
    const pending = this.#pendingMinimize;
    if (!pending) return;
    this.#pendingMinimize = null;
    if (this.#native.isMinimized()) pending.resolve();
    else pending.reject(chromeError(
      "ELECTRON_WINDOWS_RUNTIME_MINIMIZE_READBACK_MISMATCH",
      "The native minimize event did not match BrowserWindow readback."
    ));
  }

  close(): void {
    this.#placementObserver = null;
    void this.drainWorkspaceDividerGestures().catch(() => undefined);
    const pending = this.#pending;
    this.#pending = null;
    pending?.completion.reject(chromeError(
      "ELECTRON_WINDOWS_RUNTIME_PRESENTATION_CLOSED",
      "The native runtime window closed before presentation terminalized."
    ));
    this.#pendingMinimize?.reject(chromeError(
      "ELECTRON_WINDOWS_RUNTIME_MINIMIZE_CLOSED",
      "The native runtime window closed before minimize terminalized."
    ));
    this.#pendingMinimize = null;
  }

  get hasActiveWorkspaceDividerGestures(): boolean {
    return this.#dividerGestures.size > 0;
  }

  drainWorkspaceDividerGestures(): Promise<void> {
    const operation = this.#commandLane.then(
      () => this.#drainWorkspaceDividerGesturesNow()
    );
    this.#commandLane = operation.catch(() => undefined);
    return operation;
  }

  readObservation(): ChromiumRuntimeFullscreenToolbarObservation {
    const fullscreen = this.#native.isFullScreen();
    const nativeControlsVisible = this.#documentReady && this.#toolbarVisible();
    return Object.freeze({
      alwaysShowToolbarInFullScreen: this.#alwaysShow,
      fullscreen,
      nativeControlsVisible,
      nativeWindowControlCount: nativeControlsVisible ? 3 : 0,
      projectionRevision: this.#projectionRevision,
      revealed: this.#revealed,
      toolbarVisible: this.#toolbarVisible(),
      topologyRevision: this.#topologyRevision,
      windowGeneration: this.#windowGeneration,
      windowId: this.#windowId
    });
  }

  readActiveTabId(): string | null {
    return this.#activeTabId;
  }

  async #applyToolbarCommand(
    command: WindowsRuntimeHostToolbarCommand
  ): Promise<void> {
    if (command.type === "minimizeWindow") {
      if (this.#native.isMinimized()) return;
      if (this.#pendingMinimize) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_MINIMIZE_BUSY",
          "Another exact native minimize request is still active."
        );
      }
      const completion = deferred<void>();
      this.#pendingMinimize = completion;
      try {
        this.#native.minimize();
      } catch (error) {
        this.#pendingMinimize = null;
        completion.reject(error);
      }
      await completion.promise;
      return;
    }
    if (
      command.type === "closeWindow" ||
      command.type === "toggleMaximizeWindow"
    ) {
      if (command.type === "closeWindow") {
        await this.#drainWorkspaceDividerGesturesNow();
      }
      await this.#requestWindowControl(command.type);
      return;
    }
    if (!this.#native.isFullScreen() || this.#alwaysShow) return;
    const revealed = command.type === "revealToolbar";
    if (this.#revealed === revealed) return;
    this.#revealed = revealed;
    await this.#relayout();
    this.#advanceProjection();
    this.#publish();
  }

  async #applyTabCommand(command: WindowsRuntimeHostTabCommand): Promise<void> {
    const tab = this.#tabs.find((candidate) => candidate.tabId === command.tabId);
    if (!tab || tab.hidden) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_TAB_COMMAND_STALE",
        "The bundled tab command no longer owns an exact visible tab."
      );
    }
    if (command.type === "activateTab" && command.tabId === this.#activeTabId) return;
    if (command.type === "reloadTab") {
      if (
        command.windowGeneration !== this.#windowGeneration ||
        command.topologyRevision !== this.#topologyRevision ||
        command.lifecycleEpoch !== this.#currentLifecycleEpoch()
      ) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_TAB_RELOAD_FENCE_STALE",
          "The visible Windows Reload command lost its captured source fence."
        );
      }
      await this.#requestTabReload(Object.freeze({
        lifecycleEpoch: command.lifecycleEpoch,
        tabId: command.tabId,
        topologyRevision: command.topologyRevision,
        windowGeneration: command.windowGeneration,
        windowId: command.windowId
      }));
      return;
    }
    if (command.type === "moveTab") {
      const target = this.#moveTargets.find((candidate) =>
        candidate.windowId === command.targetWindowId &&
        candidate.windowGeneration === command.targetWindowGeneration
      );
      if (!target) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_TAB_MOVE_TARGET_STALE",
          "The visible Windows tab menu lost its exact target window generation."
        );
      }
      await this.#requestTabControl(command.tabId, {
        targetWindowId: target.windowId,
        type: "moveTab"
      });
      return;
    }
    if (command.type === "reorderTab") {
      const visibleIds = this.#tabs
        .filter((candidate) => !candidate.hidden)
        .map((candidate) => candidate.tabId);
      const remaining = visibleIds.filter((tabId) => tabId !== command.tabId);
      const insertionIndex = command.beforeTabId === undefined
        ? remaining.length
        : remaining.indexOf(command.beforeTabId);
      if (insertionIndex < 0) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_TAB_REORDER_TARGET_STALE",
          "The Windows tab drag lost its exact visible insertion target."
        );
      }
      const expectedOrder = [...remaining];
      expectedOrder.splice(insertionIndex, 0, command.tabId);
      if (
        expectedOrder.length !== command.orderedVisibleTabIds.length ||
        expectedOrder.some((tabId, index) =>
          tabId !== command.orderedVisibleTabIds[index]
        )
      ) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_TAB_REORDER_PREVIEW_STALE",
          "The Windows tab drag did not match its complete visible-order preview."
        );
      }
      await this.#requestTabControl(command.tabId, {
        ...(command.beforeTabId === undefined
          ? {}
          : { beforeTabId: command.beforeTabId }),
        type: "reorderTab"
      });
      return;
    }
    const action: ChromiumRuntimeNativeTabAction = command.type === "activateTab"
      ? { type: "activateTab" }
      : command.type === "closeTab"
        ? { type: "closeTab" }
        : command.type === "hideTab"
          ? { type: "hideTab" }
          : { type: "moveTabToNewWindow" };
    await this.#requestTabControl(command.tabId, action);
  }

  #publishReloadCompletion(
    command: Extract<WindowsRuntimeHostTabCommand, { type: "reloadTab" }>
  ): void {
    if (
      this.#native.isDestroyed() ||
      command.windowGeneration !== this.#windowGeneration ||
      command.topologyRevision !== this.#topologyRevision ||
      command.lifecycleEpoch !== this.#currentLifecycleEpoch() ||
      !this.#tabs.some((tab) => tab.tabId === command.tabId && !tab.hidden)
    ) return;
    this.#advanceProjection();
    this.#publish();
  }

  async #applyWorkspaceDividerCommand(
    command: WindowsRuntimeWorkspaceDividerPointerCommand
  ): Promise<void> {
    const divider = this.#workspaceDividers.find((candidate) =>
      candidate.visible && candidate.tabId === command.tabId &&
      candidate.attemptGeneration === command.attemptGeneration &&
      candidate.dividerIndex === command.dividerIndex
    );
    if (!divider || this.#windowGeneration < 1 || this.#topologyRevision < 1) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_DIVIDER_PROJECTION_STALE",
        "The native Windows divider no longer matches its exact Core projection."
      );
    }
    let gesture = this.#dividerGestures.get(command.gestureId);
    if (command.phase === "start") {
      if (gesture || command.pointerSequence !== 1 ||
          this.#dividerGestures.size >= 128 ||
          [...this.#dividerGestures.values()].some((candidate) =>
            candidate.tabId === command.tabId &&
            candidate.dividerIndex === command.dividerIndex
          )) {
        throw chromeError(
          "ELECTRON_WINDOWS_RUNTIME_DIVIDER_GESTURE_CONFLICT",
          "The native Windows divider already owns an exact pointer gesture."
        );
      }
      gesture = {
        attemptGeneration: command.attemptGeneration,
        dividerIndex: command.dividerIndex,
        gestureId: command.gestureId,
        lastPointerSequence: 0,
        tabId: command.tabId,
        topologyRevision: this.#topologyRevision
      };
      this.#dividerGestures.set(command.gestureId, gesture);
    } else if (!gesture ||
        gesture.tabId !== command.tabId ||
        gesture.attemptGeneration !== command.attemptGeneration ||
        gesture.dividerIndex !== command.dividerIndex ||
        command.pointerSequence !== gesture.lastPointerSequence + 1) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_DIVIDER_GESTURE_STALE",
        "The native Windows divider lost its gesture or pointer-sequence fence."
      );
    }
    const event: BrowserWorkspaceDividerPointerRecord = Object.freeze({
      eventId: randomUUID(),
      gestureId: command.gestureId,
      pointerSequence: command.pointerSequence,
      phase: command.phase,
      platform: "windows",
      hostIdentity: Object.freeze({
        kind: "windows",
        nativeHostId: this.#nativeHostId,
        hostGeneration: this.#hostGeneration
      }),
      windowId: this.#windowId,
      tabId: command.tabId,
      attemptGeneration: command.attemptGeneration,
      windowGeneration: this.#windowGeneration,
      topologyRevision: gesture!.topologyRevision,
      dividerIndex: command.dividerIndex,
      ...(command.phase === "move"
        ? { requestedPosition: command.requestedPosition }
        : {})
    });
    try {
      const receipt = await this.#requestWorkspaceDividerPointer(event);
      this.#validateWorkspaceDividerReceipt(event, receipt);
      this.#topologyRevision = receipt.topologyRevision;
      gesture!.lastPointerSequence = command.pointerSequence;
      gesture!.topologyRevision = receipt.topologyRevision;
    } catch (error) {
      this.#dividerGestures.delete(command.gestureId);
      throw error;
    }
    if (command.phase === "end" || command.phase === "cancel") {
      this.#dividerGestures.delete(command.gestureId);
    }
  }

  #validateWorkspaceDividerReceipt(
    event: BrowserWorkspaceDividerPointerRecord,
    receipt: BrowserWorkspaceDividerPointerReceiptRecord
  ): void {
    const expectedStatus = event.phase === "cancel" ? "cancelled" : "applied";
    if (receipt.eventId !== event.eventId ||
        receipt.gestureId !== event.gestureId ||
        receipt.pointerSequence !== event.pointerSequence ||
        receipt.phase !== event.phase || receipt.status !== expectedStatus ||
        receipt.windowGeneration !== event.windowGeneration ||
        !Number.isSafeInteger(receipt.topologyRevision) ||
        receipt.topologyRevision < event.topologyRevision ||
        (event.phase !== "move" && receipt.changed) ||
        (event.phase === "end" ? !receipt.durable : receipt.durable)) {
      throw chromeError(
        receipt.failureCode ?? "ELECTRON_WINDOWS_RUNTIME_DIVIDER_RECEIPT_INVALID",
        "Core returned a mismatched Windows workspace-divider terminal receipt."
      );
    }
  }

  async #drainWorkspaceDividerGesturesNow(): Promise<void> {
    const failures: unknown[] = [];
    for (const gesture of [...this.#dividerGestures.values()]) {
      const event: BrowserWorkspaceDividerPointerRecord = Object.freeze({
        eventId: randomUUID(),
        gestureId: gesture.gestureId,
        pointerSequence: gesture.lastPointerSequence + 1,
        phase: "cancel",
        platform: "windows",
        hostIdentity: Object.freeze({
          kind: "windows",
          nativeHostId: this.#nativeHostId,
          hostGeneration: this.#hostGeneration
        }),
        windowId: this.#windowId,
        tabId: gesture.tabId,
        attemptGeneration: gesture.attemptGeneration,
        windowGeneration: this.#windowGeneration,
        topologyRevision: gesture.topologyRevision,
        dividerIndex: gesture.dividerIndex
      });
      try {
        const receipt = await this.#requestWorkspaceDividerPointer(event);
        this.#validateWorkspaceDividerReceipt(event, receipt);
        this.#topologyRevision = Math.max(
          this.#topologyRevision,
          receipt.topologyRevision
        );
      } catch (error) {
        failures.push(error);
      } finally {
        this.#dividerGestures.delete(gesture.gestureId);
      }
    }
    if (failures.length > 0) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_DIVIDER_DRAIN_FAILED",
        "A Windows workspace-divider gesture reached a terminal stream failure."
      );
    }
  }

  #drivePendingPresentation(): void {
    const pending = this.#pending;
    if (!pending) return;
    const desired = pending.request.presentation;
    const current = nativePresentation(this.#native);
    if (desired === "fullscreen") {
      pending.expectedEvent = "enteredFullscreen";
      this.#native.setFullScreen(true);
    } else if (current === "fullscreen") {
      pending.expectedEvent = "leftFullscreen";
      this.#native.setFullScreen(false);
    } else if (desired === "maximized") {
      pending.expectedEvent = "maximized";
      this.#native.maximize();
    } else {
      pending.expectedEvent = "unmaximized";
      this.#native.unmaximize();
    }
  }

  async #syncNativePresentation(): Promise<void> {
    if (!this.#native.isFullScreen()) this.#revealed = false;
    await this.#relayout();
    this.#advanceProjection();
    this.#publish();
  }

  #relayout(): Promise<void> {
    const observer = this.#layoutObserver;
    if (!observer) return Promise.resolve();
    const next = this.#layoutLane.then(observer);
    this.#layoutLane = next.catch(() => undefined);
    return next;
  }

  #advanceProjection(): void {
    if (this.#projectionRevision >= Number.MAX_SAFE_INTEGER) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_PROJECTION_EXHAUSTED",
        "The Windows toolbar projection revision is exhausted."
      );
    }
    this.#projectionRevision += 1;
  }

  #toolbarVisible(): boolean {
    return !this.#native.isFullScreen() || this.#alwaysShow || this.#revealed;
  }

  #currentLifecycleEpoch(): number {
    const epoch = this.#readLifecycleEpoch();
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_LIFECYCLE_EPOCH_INVALID",
        "The Windows runtime host lost its application lifecycle fence."
      );
    }
    return epoch;
  }

  #publish(): void {
    if (!this.#documentReady || !this.#contentBounds ||
        this.#windowGeneration < 1 || this.#topologyRevision < 1) return;
    const projection = Object.freeze({
      activeTabId: this.#activeTabId,
      alwaysShowToolbarInFullScreen: this.#alwaysShow,
      contentBounds: this.#contentBounds,
      fullscreen: this.#native.isFullScreen(),
      lifecycleEpoch: this.#currentLifecycleEpoch(),
      moveTargets: this.#moveTargets,
      projectionRevision: this.#projectionRevision,
      tabs: this.#tabs,
      toolbarVisible: this.#toolbarVisible(),
      topologyRevision: this.#topologyRevision,
      windowGeneration: this.#windowGeneration,
      windowId: this.#windowId,
      workspaceDividers: this.#workspaceDividers
    });
    if (!isWindowsRuntimeHostProjection(projection)) {
      throw chromeError(
        "ELECTRON_WINDOWS_RUNTIME_PROJECTION_INVALID",
        "The Windows host refused to publish malformed native geometry."
      );
    }
    this.#send(WINDOWS_RUNTIME_HOST_PROJECTION_CHANNEL, projection);
  }

}
