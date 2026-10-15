import type { CoreAppSnapshotRecord } from "../../shared/generated";
import type { ChromiumRuntimeBootstrap } from "../main/chromiumRuntimeBootstrap";
import type { ChromiumRuntimeExecutorSnapshot } from "../main/chromiumRuntimeSnapshot";
import { MacosAppKitRuntimeEventBridge } from "../main/macosAppKitRuntimeEventBridge";
import type { RuntimeWindowProjectionProgress } from "../main/runtimeWindowProjectionFence";
import type { ElectronDesktopE2eGameWindowRuntimeInspection } from "./desktopE2eBridge";

type RuntimePort = Pick<ChromiumRuntimeBootstrap, "snapshot" | "desktopE2eStatusPresentation" |
  "observeWindowProjection" | "settleWindowProjection">;
type NativeEvents = Pick<MacosAppKitRuntimeEventBridge, "observeWindowEvents" | "settleWindowEvents">;
type NativeWindow = ChromiumRuntimeExecutorSnapshot["windows"][number];

class PendingWindowRevision extends Error {}

function ownerIdentity(window: NativeWindow): string {
  return JSON.stringify([window.windowId, window.windowGeneration, window.parentNativeHostId,
    window.appKitIdentity?.logicalWindowId, window.appKitIdentity?.launchGeneration,
    window.appKitIdentity?.nativeGeneration]);
}

/** E2E evidence follows admitted work; it never advances the runtime itself. */
export class ElectronDesktopE2eGameWindowRuntimeObservation {
  #events: NativeEvents | undefined;
  readonly #readers = new Set<(events: NativeEvents) => void>();

  install(): void {
    const captureEvents = (owner: NativeEvents): void => this.#captureEvents(owner);
    const events = MacosAppKitRuntimeEventBridge.prototype;
    const receiveAction = events.receiveAction;
    events.receiveAction = function (event) {
      captureEvents(this);
      return receiveAction.call(this, event);
    };
    const receiveLayout = events.receiveLayout;
    events.receiveLayout = function (event) {
      captureEvents(this);
      return receiveLayout.call(this, event);
    };
  }

  #captureEvents(events: NativeEvents): void {
    this.#events = events;
    for (const reader of this.#readers) reader(events);
  }

  async read(input: Readonly<{
    windowId: string;
    platform: string;
    runtime: RuntimePort;
    readCore: () => Promise<CoreAppSnapshotRecord>;
  }>): Promise<ElectronDesktopE2eGameWindowRuntimeInspection> {
    const { runtime, windowId } = input;
    const initialWindow = runtime.snapshot().windows.find(window => window.windowId === windowId);
    const originalOwner = initialWindow && ownerIdentity(initialWindow);
    const projection = runtime.observeWindowProjection(windowId);
    let events: NativeEvents | undefined;
    let nativeProgress: RuntimeWindowProjectionProgress | undefined;
    let ownerFailure: { reason: unknown } | undefined;
    const bindEvents = (received: NativeEvents): void => {
      if (events && events !== received) {
        ownerFailure ??= { reason: new Error(`Game Window ${windowId} changed its AppKit event owner.`) };
      } else if (!events) {
        events = received;
        try { nativeProgress = events.observeWindowEvents(windowId); }
        catch (reason) { ownerFailure ??= { reason }; }
      }
    };
    const readProgress = (): number => {
      if (ownerFailure) throw ownerFailure.reason;
      return projection.readSequence() + (nativeProgress?.readSequence() ?? 0);
    };
    this.#readers.add(bindEvents);
    try {
      if (this.#events) bindEvents(this.#events);
      while (true) {
        const beforeRead = readProgress();
        const core = await input.readCore();
        const native = runtime.snapshot();
        // A failed receipt completed during the RPC must also reject a pair
        // whose revisions happen to agree. The observer owns no failure history.
        readProgress();
        const currentWindow = native.windows.find(window => window.windowId === windowId);
        if (originalOwner && currentWindow && ownerIdentity(currentWindow) !== originalOwner) {
          throw new Error(`Game Window ${windowId} changed its exact native owner during observation.`);
        }
        try {
          return projectGameWindowRuntime(core, native, windowId, input.platform,
            () => runtime.desktopE2eStatusPresentation(windowId));
        } catch (error) {
          if (!(error instanceof PendingWindowRevision)) throw error;
          const nativeEvents = await events?.settleWindowEvents(windowId) ?? false;
          const projected = await runtime.settleWindowProjection(windowId);
          if (readProgress() === beforeRead && !nativeEvents && !projected) throw error;
          // Only newly admitted/completed exact-window work permits another
          // observation. Its fresh pair must pass every original strict fence.
        }
      }
    } finally {
      this.#readers.delete(bindEvents);
      try { nativeProgress?.dispose(); } finally { projection.dispose(); }
    }
  }
}

function projectGameWindowRuntime(
  coreSnapshot: CoreAppSnapshotRecord,
  nativeSnapshot: ChromiumRuntimeExecutorSnapshot,
  windowId: string,
  platform: string,
  readStatusPresentation: () => number | undefined
): ElectronDesktopE2eGameWindowRuntimeInspection {
  const logicalWindows = coreSnapshot.logicalWindows.filter(
    (window) => window.windowId === windowId
  );
  const browserWindows = coreSnapshot.browserRuntime.windows.filter(
    (window) => window.windowId === windowId
  );
  const nativeWindows = nativeSnapshot.windows.filter(
    (window) => window.windowId === windowId
  );
  if (
    logicalWindows.length === 0 &&
    browserWindows.length === 0 &&
    nativeWindows.length === 0
  ) {
    const inspection = Object.freeze({
      currentRuntime: null,
      windowId
    } satisfies ElectronDesktopE2eGameWindowRuntimeInspection);
    return inspection;
  }
  if (
    logicalWindows.length !== 1 ||
    browserWindows.length !== 1 ||
    nativeWindows.length !== 1
  ) {
    throw new Error(
      `Game Window ${windowId} has divergent Core/browser/native Chromium ownership.`
    );
  }
  const logical = logicalWindows[0]!;
  const browserWindow = browserWindows[0]!;
  const native = nativeWindows[0]!;
  const nativeTarget = native.target;
  const coreTabIds = logical.tabs.map((tab) => tab.id);
  const invalidFence = (
    logical.windowGeneration !== native.windowGeneration ||
    JSON.stringify(coreTabIds) !== JSON.stringify(browserWindow.tabIds) ||
    JSON.stringify(coreTabIds) !== JSON.stringify(native.tabIds) ||
    !nativeTarget ||
    nativeTarget.windowId !== windowId ||
    nativeTarget.displayId !== native.displayId ||
    nativeTarget.presentation !== native.presentation ||
    JSON.stringify(nativeTarget.bounds) !== JSON.stringify(native.bounds) ||
    !Number.isFinite(nativeTarget.scaleFactor) || nativeTarget.scaleFactor <= 0 ||
    !Number.isSafeInteger(native.parentNativeHostId) ||
    (native.parentNativeHostId ?? 0) < 1
  );
  if (invalidFence || logical.revision !== native.topologyRevision) {
    const fence = {
      browserTabIds: browserWindow.tabIds,
      coreTabIds,
      logicalRevision: logical.revision,
      logicalWindowGeneration: logical.windowGeneration,
      nativeBounds: native.bounds,
      nativeDisplayId: native.displayId,
      nativeParentHostId: native.parentNativeHostId,
      nativePresentation: native.presentation,
      nativeTabIds: native.tabIds,
      nativeTarget,
      nativeTopologyRevision: native.topologyRevision,
      nativeWindowGeneration: native.windowGeneration
    };
    const FenceError = invalidFence ? Error : PendingWindowRevision;
    throw new FenceError(
      `Game Window ${windowId} has a stale Core/native Chromium fence: ${JSON.stringify(fence)}`
    );
  }
  if (
    (platform === "darwin" && !native.appKitIdentity) ||
    (platform === "win32" && native.appKitIdentity)
  ) {
    throw new Error(
      `Game Window ${windowId} has an invalid platform-native Chromium host.`
    );
  }
  const rawStatusPresentation = native.appKitIdentity
    ? readStatusPresentation()
    : undefined;
  if (native.appKitIdentity && (
    rawStatusPresentation === undefined ||
    !new Set([0, 1, 2]).has(rawStatusPresentation)
  )) {
    throw new Error(
      `Game Window ${windowId} has no exact AppKit status presentation.`
    );
  }
  const appKitStatusPresentation = rawStatusPresentation === 1
    ? "loading"
    : rawStatusPresentation === 2
      ? "failed"
      : native.appKitIdentity
        ? "ready"
        : null;
  const inspection = Object.freeze({
    currentRuntime: Object.freeze({
      appKitIdentity: native.appKitIdentity
        ? Object.freeze({ ...native.appKitIdentity })
        : null,
      appKitStatusPresentation,
      coreTabIds: Object.freeze([...coreTabIds]),
      focused: native.focused,
      hostKind: native.appKitIdentity ? "appkit-chromium" : "bundled-chromium",
      nativeDisplay: Object.freeze({
        bounds: Object.freeze({ ...native.bounds }),
        displayId: native.displayId,
        presentation: native.presentation,
        scaleFactor: nativeTarget.scaleFactor,
        workArea: Object.freeze({ ...nativeTarget.workArea })
      }),
      nativeTabIds: Object.freeze([...native.tabIds]),
      parentNativeHostId: native.parentNativeHostId!,
      topologyRevision: native.topologyRevision,
      visible: native.visible,
      windowGeneration: native.windowGeneration,
      windowId
    }),
    windowId
  } satisfies ElectronDesktopE2eGameWindowRuntimeInspection);
  return inspection;
}
