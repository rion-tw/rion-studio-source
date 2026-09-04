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
