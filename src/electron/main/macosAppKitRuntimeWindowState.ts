import type {
  AppKitRuntimeHostObservationRecord,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeWindowStateObservation,
  ChromiumRuntimeWindowStateObserver,
  ChromiumRuntimeWindowStateSource
} from "./chromiumRuntimeHostPorts";
import type {
  AppKitRuntimeHostIdentity,
  MacosAppKitBaseWindowPort,
  MacosAppKitDisplayResolverPort,
  MacosAppKitNativeEventListener
} from "./macosAppKitRuntimePorts";
import { requireMacosAppKitBounds } from "./macosAppKitRuntimeHostValidation";

type PublishedWindowStateSource = Exclude<
  ChromiumRuntimeWindowStateSource,
  "initial"
>;

export interface MacosAppKitRuntimeWindowListeners {
  readonly close: MacosAppKitNativeEventListener;
  readonly closed: MacosAppKitNativeEventListener;
  readonly enteredFullScreen: MacosAppKitNativeEventListener;
  readonly hidden: MacosAppKitNativeEventListener;
  readonly leftFullScreen: MacosAppKitNativeEventListener;
  readonly maximized: MacosAppKitNativeEventListener;
  readonly minimized: MacosAppKitNativeEventListener;
  readonly moved: MacosAppKitNativeEventListener;
  readonly resized: MacosAppKitNativeEventListener;
  readonly restored: MacosAppKitNativeEventListener;
  readonly shown: MacosAppKitNativeEventListener;
}

export interface MacosAppKitRuntimeWindowStateRecord {
  readonly identity: AppKitRuntimeHostIdentity;
  readonly native: MacosAppKitBaseWindowPort;
  readonly nativeId: number;
  normalBounds: EmbeddedLaunchTargetRecord["bounds"];
  readonly readLifecycleEpoch: () => number;
  readonly windowStateObservers: Set<ChromiumRuntimeWindowStateObserver>;
  topologyRevision: number;
  windowGeneration: number;
  windowStateSequence: number;
  windowStateTerminal: boolean;
}

export interface MacosAppKitCapturedWindowState {
  readonly focused: boolean;
  readonly minimized: boolean;
  readonly visible: boolean;
}

function stateError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function nextSequence(record: MacosAppKitRuntimeWindowStateRecord): number {
  const sequence = record.windowStateSequence + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw stateError(
      "ELECTRON_MACOS_APPKIT_WINDOW_STATE_SEQUENCE_EXHAUSTED",
      "The AppKit runtime-window state sequence is exhausted."
    );
  }
  record.windowStateSequence = sequence;
  return sequence;
}

function lifecycleEpoch(record: MacosAppKitRuntimeWindowStateRecord): number {
  const epoch = record.readLifecycleEpoch();
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw stateError(
      "ELECTRON_MACOS_APPKIT_WINDOW_STATE_LIFECYCLE_INVALID",
      "The AppKit runtime-window state stream has no current lifecycle epoch."
    );
  }
  return epoch;
}

function createObservation(
  record: MacosAppKitRuntimeWindowStateRecord,
  source: ChromiumRuntimeWindowStateSource,
  failureCode?: string,
  captured?: MacosAppKitCapturedWindowState
): ChromiumRuntimeWindowStateObservation {
  const closed = source === "closed";
  const failed = source === "failed";
  let visible = false;
  let minimized = false;
  let focused = false;
  if (!closed) {
    try {
      visible = captured?.visible ?? record.native.isVisible();
      minimized = captured?.minimized ?? record.native.isMinimized();
      focused = captured?.focused ?? record.native.isFocused();
    } catch (error) {
      if (!failed) throw error;
    }
  }
  return Object.freeze({
    platform: "macos" as const,
    source,
    sequence: nextSequence(record),
    lifecycleEpoch: lifecycleEpoch(record),
    logicalWindowId: record.identity.logicalWindowId,
    nativeHostId: record.nativeId,
    nativeGeneration: record.identity.nativeGeneration,
    windowGeneration: record.windowGeneration,
    topologyRevision: record.topologyRevision,
    visible,
    minimized,
    focused,
    foreground: focused,
    appKitIdentity: record.identity,
    ...(failureCode === undefined ? {} : { failureCode })
  });
}

export function bindMacosAppKitRuntimeWindowState(
  record: MacosAppKitRuntimeWindowStateRecord,
  observer: ChromiumRuntimeWindowStateObserver
): () => void {
  record.windowStateObservers.add(observer);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    record.windowStateObservers.delete(observer);
  };
}

export function readMacosAppKitRuntimeWindowState(
  record: MacosAppKitRuntimeWindowStateRecord
): ChromiumRuntimeWindowStateObservation {
  return createObservation(record, "initial");
}

export function publishMacosAppKitRuntimeWindowState(
  record: MacosAppKitRuntimeWindowStateRecord,
  source: PublishedWindowStateSource,
  failureCode?: string,
  captured?: MacosAppKitCapturedWindowState
): ChromiumRuntimeWindowStateObservation | null {
  if (record.windowStateTerminal) return null;
  const terminal = source === "closed" || source === "failed";
  if (terminal) record.windowStateTerminal = true;
  const observation = createObservation(record, source, failureCode, captured);
  const observers = [...record.windowStateObservers];
  if (terminal) record.windowStateObservers.clear();
  for (const observer of observers) {
    try {
      observer(observation);
    } catch {
      // A consumer owns its own stream failure. One observer cannot suppress
      // exact native evidence for the remaining consumers.
    }
  }
  return observation;
}

export function publishMacosAppKitRuntimeWindowFocus(
  record: MacosAppKitRuntimeWindowStateRecord,
  captured: MacosAppKitCapturedWindowState
): ChromiumRuntimeWindowStateObservation | null {
  return publishMacosAppKitRuntimeWindowState(
    record,
    captured.focused ? "focus" : "blur",
    undefined,
    captured
  );
}

export function snapshotMacosAppKitRuntimeHostObservation(input: Readonly<{
  captured?: MacosAppKitCapturedWindowState;
  contentBounds: AppKitRuntimeHostObservationRecord["contentBounds"];
  current: boolean;
  displays: MacosAppKitDisplayResolverPort;
  record: MacosAppKitRuntimeWindowStateRecord;
}>): AppKitRuntimeHostObservationRecord {
  const { record } = input;
  if (!input.current || record.native.isDestroyed()) {
    throw stateError(
      "ELECTRON_MACOS_APPKIT_OBSERVATION_STALE",
      "The AppKit host is no longer current for a native observation."
    );
  }
  const liveBounds = record.native.getContentBounds();
  requireMacosAppKitBounds(liveBounds, "live window content");
  const display = input.displays.displayMatching(liveBounds);
  if (!Number.isSafeInteger(display.id)) {
    throw stateError(
      "ELECTRON_MACOS_APPKIT_DISPLAY_INVALID",
      "Electron returned an invalid display for the AppKit window."
    );
  }
  requireMacosAppKitBounds(display.workArea, "display work-area");
  return Object.freeze({
    identity: record.identity,
    windowGeneration: record.windowGeneration,
    topologyRevision: record.topologyRevision,
    contentBounds: input.contentBounds,
    normalBounds: Object.freeze({ ...record.normalBounds }),
    savedWorkArea: Object.freeze({ ...display.workArea }),
    targetDisplay: Object.freeze({ id: display.id }),
    presentation: record.native.isFullScreen()
      ? "fullscreen" as const
      : record.native.isMaximized() ? "maximized" as const : "normal" as const,
    focused: input.captured?.focused ?? record.native.isFocused(),
    minimized: input.captured?.minimized ?? record.native.isMinimized(),
    visible: input.captured?.visible ?? record.native.isVisible()
  });
}

export function installMacosAppKitRuntimeWindowListeners(
  native: MacosAppKitBaseWindowPort,
  listeners: MacosAppKitRuntimeWindowListeners
): void {
  native.on("close", listeners.close);
  native.on("closed", listeners.closed);
  native.on("enter-full-screen", listeners.enteredFullScreen);
  native.on("hide", listeners.hidden);
  native.on("leave-full-screen", listeners.leftFullScreen);
  native.on("maximize", listeners.maximized);
  native.on("minimize", listeners.minimized);
  native.on("move", listeners.moved);
  native.on("resize", listeners.resized);
  native.on("restore", listeners.restored);
  native.on("show", listeners.shown);
}

export function removeMacosAppKitRuntimeWindowListeners(
  native: MacosAppKitBaseWindowPort,
  listeners: MacosAppKitRuntimeWindowListeners
): void {
  native.removeListener("close", listeners.close);
  native.removeListener("closed", listeners.closed);
  native.removeListener("enter-full-screen", listeners.enteredFullScreen);
  native.removeListener("hide", listeners.hidden);
  native.removeListener("leave-full-screen", listeners.leftFullScreen);
  native.removeListener("maximize", listeners.maximized);
  native.removeListener("minimize", listeners.minimized);
  native.removeListener("move", listeners.moved);
  native.removeListener("resize", listeners.resized);
  native.removeListener("restore", listeners.restored);
  native.removeListener("show", listeners.shown);
}
