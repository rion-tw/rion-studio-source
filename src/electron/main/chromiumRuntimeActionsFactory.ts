import type {
  DisplayTopologySnapshotRecord,
  RuntimeWindowPreferencesRecord,
  RuntimeWindowZoomReceiptRecord,
  StateGameWindowRecord,
  SystemRuntimeOperationSummaryRecord
} from "../../shared/generated";
import type { QuickAccessPresentationRequest } from "../../shared/types";
import {
  CoreOwnedChromiumRuntimeActionBackend
} from "./chromiumRuntimeActionBackend";
import {
  ChromiumRuntimeActionController,
  type ElectronChromiumRuntimeActionPort
} from "./chromiumRuntimeActionController";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";
import {
  ChromiumNewWindowMoveController
} from "./chromiumNewWindowMoveController";
import { ChromiumNewWindowTargetResolver } from
  "./chromiumNewWindowTargetResolver";
import { ChromiumQuickAccessRequestController } from
  "./chromiumQuickAccessRequestController";
import {
  ChromiumSavedWindowRestoreController
} from "./chromiumSavedWindowRestoreController";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { MacosAppKitRuntimeHostFactoryPort } from
  "./chromiumRuntimeHostFactory";
import type { MacosAppKitRendererActionPort } from
  "./macosAppKitRuntimeEventBridge";
import type { ChromiumRuntimeWindowPreferencesProjectionPort } from
  "./chromiumRuntimeFullscreenToolbar";
import type { ChromiumRuntimeRestoreSessionMutationPort } from
  "./chromiumRuntimeRestoreSessionCoordinator";
import {
  ChromiumRuntimeNativeWindowController,
  type ChromiumRuntimeFullscreenFocusAdmission,
  type ChromiumRuntimeNativeTabAction,
  type ChromiumRuntimeWindowActionTarget
} from "./chromiumRuntimeNativeWindowController";

export interface ChromiumRuntimeActionsFactoryInput {
  readonly core: ElectronCoreCommandPort;
  readonly platform: "darwin" | "win32";
  readonly readDisplayTopology: () => DisplayTopologySnapshotRecord;
  readonly readNativeSnapshot: () => ChromiumRuntimeExecutorSnapshot;
  readonly restoreSavedGameWindow: (
    window: StateGameWindowRecord
  ) => Promise<void>;
  readonly restoreSession: ChromiumRuntimeRestoreSessionMutationPort;
  readonly openEmptySavedGameWindow: (
    window: StateGameWindowRecord
  ) => Promise<void>;
  readonly publishQuickAccessRequest: (
    request: QuickAccessPresentationRequest
  ) => void;
  readonly presentMainWindow: (requestId: string) => Promise<void>;
  readonly windowPreferences: ChromiumRuntimeWindowPreferencesProjectionPort;
  readonly appKit?: Readonly<{
    factory: MacosAppKitRuntimeHostFactoryPort;
    events: MacosAppKitRendererActionPort;
  }>;
}

export interface ChromiumRuntimeActionsServices {
  readonly actions: ElectronChromiumRuntimeActionPort;
  readonly beginMainWindowQuickAccess: () => QuickAccessPresentationRequest;
  readonly beginRuntimeTabQuickAccess: (
    tabId: string
  ) => QuickAccessPresentationRequest;
  readonly resumeInterruptedSavedWindows: () => Promise<void>;
  readonly requestRuntimeWindowControl: (
    windowId: string,
    action: "closeWindow" | "toggleMaximizeWindow"
  ) => Promise<void>;
  readonly requestRuntimeTabControl: (
    tabId: string,
    action: ChromiumRuntimeNativeTabAction
  ) => Promise<void>;
  readonly setAlwaysShowToolbarInFullScreen: (value: boolean) =>
    Promise<RuntimeWindowPreferencesRecord>;
  readonly toggleRuntimeTabFullscreen: (
    tabId: string,
    focusAdmission?: ChromiumRuntimeFullscreenFocusAdmission
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  readonly toggleRuntimeWindowFullscreen: (
    target: ChromiumRuntimeWindowActionTarget
  ) => Promise<SystemRuntimeOperationSummaryRecord>;
  readonly zoomRuntimeWindow: (
    target: ChromiumRuntimeWindowActionTarget,
    action: "in" | "out" | "reset"
  ) => Promise<RuntimeWindowZoomReceiptRecord>;
}

/**
 * Composes the single privileged runtime-action topology. A missing macOS
 * AppKit adapter returns no lane so the dispatcher can fail closed.
 */
export function createCoreOwnedChromiumRuntimeActions(
  input: ChromiumRuntimeActionsFactoryInput
): ChromiumRuntimeActionsServices | null {
  if ((input.platform === "darwin") !== (input.appKit !== undefined)) {
    return null;
  }
  const quickAccess = new ChromiumQuickAccessRequestController({
    publishRequest: input.publishQuickAccessRequest,
    presentMainWindow: input.presentMainWindow
  });
  const savedWindows = new ChromiumSavedWindowRestoreController({
    core: input.core,
    restoreSession: input.restoreSession,
    launches: {
      openEmptySavedGameWindow: input.openEmptySavedGameWindow,
      restoreSavedGameWindow: input.restoreSavedGameWindow
    }
  });
  const newWindowMoves = new ChromiumNewWindowMoveController({
    core: input.core,
    platform: input.platform,
    readDisplayTopology: input.readDisplayTopology,
    readNativeSnapshot: input.readNativeSnapshot,
    targets: new ChromiumNewWindowTargetResolver({
      readDisplayTopology: input.readDisplayTopology
    }),
    ...(input.appKit === undefined ? {} : { appKit: input.appKit })
  });
  const backend = new CoreOwnedChromiumRuntimeActionBackend({
    core: input.core,
    platform: input.platform,
    readNativeSnapshot: input.readNativeSnapshot,
    savedWindows,
    newWindowMoves,
    quickAccess,
    windowPreferences: input.windowPreferences,
    ...(input.appKit === undefined ? {} : { appKit: input.appKit })
  });
  const nativeWindows = new ChromiumRuntimeNativeWindowController({
    backend,
    core: input.core,
    platform: input.platform,
    readNativeSnapshot: input.readNativeSnapshot
  });
  return Object.freeze({
    actions: new ChromiumRuntimeActionController({ backend }),
    beginMainWindowQuickAccess: () => quickAccess.beginMainWindowRequest(),
    beginRuntimeTabQuickAccess: (tabId: string) =>
      quickAccess.beginRuntimeTabRequest(tabId),
    resumeInterruptedSavedWindows: () => savedWindows.resumeInterrupted(),
    requestRuntimeWindowControl: (
      windowId: string,
      action: "closeWindow" | "toggleMaximizeWindow"
    ) =>
      nativeWindows.requestWindowControl(windowId, action),
    requestRuntimeTabControl: (
      tabId: string,
      action: ChromiumRuntimeNativeTabAction
    ) =>
      nativeWindows.requestTabControl(tabId, action),
    setAlwaysShowToolbarInFullScreen: (value: boolean) =>
      nativeWindows.setAlwaysShowToolbarInFullScreen(value),
    toggleRuntimeTabFullscreen: (
      tabId: string,
      focusAdmission?: ChromiumRuntimeFullscreenFocusAdmission
    ) => nativeWindows.toggleFullscreenForTab(tabId, focusAdmission),
    toggleRuntimeWindowFullscreen: (target: ChromiumRuntimeWindowActionTarget) =>
      nativeWindows.toggleFullscreenForTarget(target),
    zoomRuntimeWindow: (
      target: ChromiumRuntimeWindowActionTarget,
      action: "in" | "out" | "reset"
    ) => nativeWindows.zoomRuntimeWindow(target, action)
  });
}
