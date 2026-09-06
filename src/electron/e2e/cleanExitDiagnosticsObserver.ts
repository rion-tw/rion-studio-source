import { CoreAddonClient } from "../core/coreAddonClient";
import { ChromiumPopupLifecycleCoordinator } from
  "../main/chromiumPopupLifecycleCoordinator";
import { ChromiumRoleNavigationFailureReporter } from
  "../main/chromiumRoleNavigationFailureReporter";
import { ChromiumRoleSessionRegistry } from
  "../main/chromiumRoleSessionRegistry";
import { ChromiumRoleSurfaceRegistry } from
  "../main/chromiumRoleSurfaceRegistry";
import { ChromiumRuntimeBootstrap } from
  "../main/chromiumRuntimeBootstrap";
import { ChromiumRuntimeEffectExecutor } from
  "../main/chromiumRuntimeEffectExecutor";
import { ChromiumRuntimeRestoreSessionCoordinator } from
  "../main/chromiumRuntimeRestoreSessionCoordinator";
import { ChromiumRuntimeRolePlaceholderRegistry } from
  "../main/chromiumRuntimeRolePlaceholderRegistry";
import { ChromiumWorkspaceWebNavigationFailureReporter } from
  "../main/chromiumWorkspaceWebNavigationFailureReporter";
import { CoreEffectCoordinator } from "../main/coreEffectCoordinator";
import { ElectronMainLifecycle } from "../main/lifecycle";
import { MacosAppKitInputSurfaceAttachmentCoordinator } from
  "../main/macosAppKitInputSurfaceAttachmentCoordinator";
import { MacosAppKitRuntimeEventBridge } from
  "../main/macosAppKitRuntimeEventBridge";
import {
  appendCoreFlowObservation,
  describeCoreFlowError,
  nextCoreFlowIdentity
} from "./coreFlowDiagnosticsObserver";

function observeCleanExit<Value>(
  type: string,
  operation: () => Promise<Value>
): Promise<Value> {
  const identity = nextCoreFlowIdentity(type);
  appendCoreFlowObservation({
    boundary: "command", identity, status: "started", type
  });
  let work: Promise<Value>;
  try {
    work = operation();
  } catch (error) {
    appendCoreFlowObservation({
      boundary: "command", error: describeCoreFlowError(error), identity,
      status: "rejected", type
    });
    throw error;
  }
  return work.then((result) => {
    appendCoreFlowObservation({
      boundary: "command", identity, status: "completed", type
    });
    return result;
  }, (error: unknown) => {
    appendCoreFlowObservation({
      boundary: "command", error: describeCoreFlowError(error), identity,
      status: "rejected", type
    });
    throw error;
  });
}

/** Journals the exact owner boundary at each event-bound clean-exit stage. */
export function installElectronDesktopE2eCleanExitDiagnosticsObserver(): void {
  const lifecycle = ElectronMainLifecycle.prototype;
  const originalPrepareCleanQuit = lifecycle.prepareCleanQuit;
  lifecycle.prepareCleanQuit = function () {
    return observeCleanExit(
      "cleanExitLifecycle",
      () => originalPrepareCleanQuit.call(this)
    );
  };

  const runtime = ChromiumRuntimeBootstrap.prototype;
  const originalPrepareCleanExit = runtime.prepareCleanExit;
  runtime.prepareCleanExit = function (persist) {
    return observeCleanExit(
      "cleanExitRuntimePrepare",
      () => originalPrepareCleanExit.call(this, persist)
    );
  };
  const originalRuntimeShutdown = runtime.shutdown;
  runtime.shutdown = function () {
    return observeCleanExit(
      "cleanExitRuntimeShutdown",
      () => originalRuntimeShutdown.call(this)
    );
  };

  const appKitEvents = MacosAppKitRuntimeEventBridge.prototype;
  const originalAppKitDispose = appKitEvents.dispose;
  appKitEvents.dispose = function () {
    return observeCleanExit(
      "cleanExitAppKitEvents",
      () => originalAppKitDispose.call(this)
    );
  };

  const roleNavigation = ChromiumRoleNavigationFailureReporter.prototype;
  const originalRoleNavigationDrain = roleNavigation.closeAndDrain;
  roleNavigation.closeAndDrain = function () {
    return observeCleanExit(
      "cleanExitRoleNavigation",
      () => originalRoleNavigationDrain.call(this)
    );
  };

  const webNavigation = ChromiumWorkspaceWebNavigationFailureReporter.prototype;
  const originalWebNavigationDrain = webNavigation.closeAndDrain;
  webNavigation.closeAndDrain = function () {
    return observeCleanExit(
      "cleanExitWorkspaceWebNavigation",
      () => originalWebNavigationDrain.call(this)
    );
  };

  const popups = ChromiumPopupLifecycleCoordinator.prototype;
  const originalPopupDispose = popups.dispose;
  popups.dispose = function () {
    return observeCleanExit(
      "cleanExitPopups",
      () => originalPopupDispose.call(this)
    );
  };

  const originalPopupRetireOwner = popups.retireOwner;
  popups.retireOwner = function (owner) {
    return observeCleanExit(
      "cleanExitOwnerPopups",
      () => originalPopupRetireOwner.call(this, owner)
    );
  };

  const appKitAttachments = MacosAppKitInputSurfaceAttachmentCoordinator.prototype;
  const originalAppKitRetire = appKitAttachments.retire;
  appKitAttachments.retire = function (roleId, generation, parent) {
    return observeCleanExit(
      "cleanExitAppKitInputSurface",
      () => originalAppKitRetire.call(this, roleId, generation, parent)
    );
  };

  const effects = CoreEffectCoordinator.prototype;
  const originalEffectsDispose = effects.dispose;
  effects.dispose = function () {
    return observeCleanExit(
      "cleanExitCoreEffects",
      () => originalEffectsDispose.call(this)
    );
  };

  const executor = ChromiumRuntimeEffectExecutor.prototype;
  const originalExecutorDispose = executor.dispose;
  executor.dispose = function () {
    return observeCleanExit(
      "cleanExitRuntimeExecutor",
      () => originalExecutorDispose.call(this)
    );
  };

  const roleSurfaces = ChromiumRoleSurfaceRegistry.prototype;
  const originalCloseRole = roleSurfaces.closeRole;
  roleSurfaces.closeRole = function (roleId, generation) {
    return observeCleanExit(
      "cleanExitRoleSurface",
      () => originalCloseRole.call(this, roleId, generation)
    );
  };

  const roleSessions = ChromiumRoleSessionRegistry.prototype;
  const originalReleaseRole = roleSessions.releaseRole;
  roleSessions.releaseRole = function (roleId, chromiumUserDataDir) {
    return observeCleanExit(
      "cleanExitRoleSession",
      () => originalReleaseRole.call(this, roleId, chromiumUserDataDir)
    );
  };

  const rolePlaceholders = ChromiumRuntimeRolePlaceholderRegistry.prototype;
  const originalReconcilePlaceholders = rolePlaceholders.reconcile;
  rolePlaceholders.reconcile = function (descriptors) {
    return observeCleanExit(
      "cleanExitRolePlaceholders",
      () => originalReconcilePlaceholders.call(this, descriptors)
    );
  };

  const restoreSession = ChromiumRuntimeRestoreSessionCoordinator.prototype;
  const originalPersistCleanExit = restoreSession.persistCleanExit;
  restoreSession.persistCleanExit = function (snapshot) {
    return observeCleanExit(
      "cleanExitRestoreSession",
      () => originalPersistCleanExit.call(this, snapshot)
    );
  };

  const core = CoreAddonClient.prototype;
  const originalWaitForClearDrain = core.waitForRoleBrowserDataClearCommandDrain;
  core.waitForRoleBrowserDataClearCommandDrain = function (timeoutMs) {
    return observeCleanExit(
      "cleanExitRoleBrowserDataClear",
      () => originalWaitForClearDrain.call(this, timeoutMs)
    );
  };
  const originalCoreShutdown = core.shutdown;
  core.shutdown = function () {
    return observeCleanExit(
      "cleanExitCoreShutdown",
      () => originalCoreShutdown.call(this)
    );
  };
}
