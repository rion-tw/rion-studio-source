import { ChromiumRuntimeRestoreSessionCoordinator } from
  "../main/chromiumRuntimeRestoreSessionCoordinator";
import { ChromiumSavedWindowRestoreController } from
  "../main/chromiumSavedWindowRestoreController";
import {
  appendCoreFlowObservation,
  describeCoreFlowError,
  nextCoreFlowIdentity
} from "./coreFlowDiagnosticsObserver";

export function installElectronDesktopE2eSavedWindowRestoreObserver(): void {
  const savedWindows = ChromiumSavedWindowRestoreController.prototype;
  const originalRestore = savedWindows.restore;
  savedWindows.restore = function (input) {
    const identity = nextCoreFlowIdentity("saved-window-restore");
    appendCoreFlowObservation({
      boundary: "launch",
      details: input,
      identity,
      status: "started",
      type: "savedWindowRestore"
    });
    return originalRestore.call(this, input).then(() => {
      appendCoreFlowObservation({
        boundary: "launch",
        identity,
        status: "completed",
        type: "savedWindowRestore"
      });
    }, (error: unknown) => {
      appendCoreFlowObservation({
        boundary: "launch",
        error: describeCoreFlowError(error),
        identity,
        status: "rejected",
        type: "savedWindowRestore"
      });
      throw error;
    });
  };

  const restoreSession = ChromiumRuntimeRestoreSessionCoordinator.prototype;
  const originalMutate = restoreSession.mutate;
  restoreSession.mutate = function (mutation) {
    const identity = nextCoreFlowIdentity("restore-session-mutate");
    appendCoreFlowObservation({
      boundary: "launch",
      identity,
      status: "started",
      type: "restoreSessionMutate"
    });
    return originalMutate.call(this, mutation).then((result) => {
      appendCoreFlowObservation({
        boundary: "launch",
        details: {
          cleanExit: result.cleanExit,
          restoreInProgressWindowIds: result.restoreInProgressWindowIds,
          sessionGeneration: result.sessionGeneration
        },
        identity,
        status: "completed",
        type: "restoreSessionMutate"
      });
      return result;
    }, (error: unknown) => {
      appendCoreFlowObservation({
        boundary: "launch",
        error: describeCoreFlowError(error),
        identity,
        status: "rejected",
        type: "restoreSessionMutate"
      });
      throw error;
    });
  };
}
