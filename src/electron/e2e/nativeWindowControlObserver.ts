import { WindowsRuntimeWindowStateStream } from "../main/windowsRuntimeWindowState";
import { ChromiumRuntimeOwnershipTransitionCoordinator } from
  "../main/chromiumRuntimeOwnershipTransitionCoordinator";
import { ChromiumRuntimeBootstrap } from
  "../main/chromiumRuntimeBootstrap";
import { ChromiumRuntimeNativeWindowController } from
  "../main/chromiumRuntimeNativeWindowController";
import { WindowsRuntimeHostChromeController } from
  "../main/windowsRuntimeHostChromeController";
import {
  appendCoreFlowObservation,
  describeCoreFlowError,
  nextCoreFlowIdentity
} from "./coreFlowDiagnosticsObserver";

/** Journals each boundary after the exact native Windows F11 callback. */
export function installElectronDesktopE2eNativeWindowControlObserver(): void {
  installWindowTransitionObservation();
  const chrome = WindowsRuntimeHostChromeController.prototype;
  const originalReadActiveTabId = chrome.readActiveTabId;
  chrome.readActiveTabId = function () {
    const identity = nextCoreFlowIdentity("windows-shortcut-active-tab");
    appendCoreFlowObservation({
      boundary: "command", identity, status: "started",
      type: "readWindowsShortcutActiveTab"
    });
    try {
      const tabId = originalReadActiveTabId.call(this);
      appendCoreFlowObservation({
        boundary: "command", details: { tabId }, identity, status: "completed",
        type: "readWindowsShortcutActiveTab"
      });
      return tabId;
    } catch (error) {
      appendCoreFlowObservation({
        boundary: "command", error: describeCoreFlowError(error), identity,
        status: "rejected", type: "readWindowsShortcutActiveTab"
      });
      throw error;
    }
  };

  const originalBootstrapStart = ChromiumRuntimeBootstrap.start;
  ChromiumRuntimeBootstrap.start = (input) => {
    const originalFullscreen = input.onRuntimeTabFullscreen;
    return originalBootstrapStart({
      ...input,
      ...(originalFullscreen ? {
        onRuntimeTabFullscreen: (tabId, focusAdmission) => {
          const identity = nextCoreFlowIdentity(
            `runtime-fullscreen-ingress:${tabId}`
          );
          appendCoreFlowObservation({
            boundary: "command", details: {
              focusAdmission: focusAdmission ?? null, tabId
            }, identity, status: "started", type: "runtimeFullscreenIngress"
          });
          try {
            originalFullscreen(tabId, focusAdmission);
            appendCoreFlowObservation({
              boundary: "command", identity, status: "completed",
              type: "runtimeFullscreenIngress"
            });
          } catch (error) {
            appendCoreFlowObservation({
              boundary: "command", error: describeCoreFlowError(error), identity,
              status: "rejected", type: "runtimeFullscreenIngress"
            });
            throw error;
          }
        }
      } : {})
    });
  };

  const controller = ChromiumRuntimeNativeWindowController.prototype;
  const originalToggleFullscreenForTab = controller.toggleFullscreenForTab;
  controller.toggleFullscreenForTab = function (tabId, focusAdmission) {
    const identity = nextCoreFlowIdentity(`native-fullscreen:${tabId}`);
    appendCoreFlowObservation({
      boundary: "command", details: {
        focusAdmission: focusAdmission ?? null, tabId
      }, identity, status: "started", type: "toggleFullscreenForTab"
    });
    let operation: ReturnType<typeof originalToggleFullscreenForTab>;
    try {
      operation = originalToggleFullscreenForTab.call(this, tabId, focusAdmission);
    } catch (error) {
      appendCoreFlowObservation({
        boundary: "command", error: describeCoreFlowError(error), identity,
        status: "rejected", type: "toggleFullscreenForTab"
      });
      throw error;
    }
    return operation.then((result) => {
      appendCoreFlowObservation({
        boundary: "command", details: { result }, identity, status: "completed",
        type: "toggleFullscreenForTab"
      });
      return result;
    }, (error: unknown) => {
      appendCoreFlowObservation({
        boundary: "command", error: describeCoreFlowError(error), identity,
        status: "rejected", type: "toggleFullscreenForTab"
      });
      throw error;
    });
  };
}

/** Records the exact native event and continuation without synthesizing progress. */
function installWindowTransitionObservation(): void {
  const state = WindowsRuntimeWindowStateStream.prototype;
  const originalRead = state.read;
  state.read = function () {
    const observation = originalRead.call(this);
    appendCoreFlowObservation({
      boundary: "command", identity: observation.logicalWindowId,
      status: "completed", type: "windowsNativeStateRead", details: observation
    });
    return observation;
  };
  const originalBind = state.bind;
  state.bind = function (observer) {
    return originalBind.call(this, (observation) => {
      appendCoreFlowObservation({
        boundary: "command", identity: observation.logicalWindowId,
        status: "completed", type: "windowsNativeStateEvent", details: observation
      });
      observer(observation);
    });
  };
  const transitions = ChromiumRuntimeOwnershipTransitionCoordinator.prototype;
  const originalBegin = transitions.begin;
  transitions.begin = function (effect, lifecycleEpoch, windows) {
    appendCoreFlowObservation({
      boundary: "effect", identity: effect.effectId, status: "started",
      type: "nativeWindowTransition", details: {
        lifecycleEpoch, windows: windows.map((window) => ({
          windowId: window.host.logicalWindowId, mode: window.mode,
          topologyRevision: window.topologyRevision,
          windowGeneration: window.windowGeneration
        }))
      }
    });
    const continuation = originalBegin.call(this, effect, lifecycleEpoch, windows);
    void continuation.completion.then((receipt) => {
      appendCoreFlowObservation({
        boundary: "effect", identity: effect.effectId, status: "completed",
        type: "nativeWindowTransition", details: receipt
      });
    }, (error: unknown) => {
      appendCoreFlowObservation({
        boundary: "effect", identity: effect.effectId, status: "rejected",
        type: "nativeWindowTransition", error: describeCoreFlowError(error)
      });
    });
    return continuation;
  };
}
