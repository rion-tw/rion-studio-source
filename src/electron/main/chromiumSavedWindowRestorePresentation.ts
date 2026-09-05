import { randomUUID } from "node:crypto";

import type { CoreCommand } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeLaunchCoordinatorInput,
  ChromiumRuntimeLaunchCorePort
} from "./chromiumRuntimeLaunchCoordinator";
import type { MacosAppKitRendererActionPort } from
  "./macosAppKitRuntimeEventBridge";
import type { MacosAppKitRuntimeHostFactoryPort } from
  "./chromiumRuntimeHostFactory";

type RestorePresentationCallbacks = Pick<
  ChromiumRuntimeLaunchCoordinatorInput,
  | "activateRestoredTab"
  | "beginSavedWindowRestore"
  | "finishSavedWindowRestore"
  | "reorderRestoredTab"
>;

interface SavedWindowRestorePresentationRuntimePort {
  beginSavedWindowRestore: (windowId: string) => void;
  finishSavedWindowRestore: (windowId: string) => void;
}

interface SavedWindowRestorePresentationInput {
  readonly appKit?: Readonly<{
    factory: MacosAppKitRuntimeHostFactoryPort;
    events: MacosAppKitRendererActionPort;
  }>;
  readonly core: ChromiumRuntimeLaunchCorePort;
  readonly runtime: SavedWindowRestorePresentationRuntimePort;
}

type RuntimeUiCommand = Extract<CoreCommand, {
  type: "embeddedTabActivate" | "embeddedTabReorder";
}>;

function restoreError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

/** Keeps ordered restore hydration hidden until the saved active tab is committed. */
export function createChromiumSavedWindowRestorePresentation(
  input: SavedWindowRestorePresentationInput
): RestorePresentationCallbacks {
  const logicalWindow = async (windowId: string) => {
    const snapshot = await input.core.invoke({ type: "appSnapshot" });
    const logical = snapshot.logicalWindows.find(
      (candidate) => candidate.windowId === windowId
    );
    if (!logical) {
      throw restoreError(
        "ELECTRON_CHROMIUM_RESTORE_PROJECTION_STALE",
        "The restored Game Window lost its exact Core topology."
      );
    }
    return logical;
  };

  const applyWindowsAction = async (
    command: RuntimeUiCommand,
    expected: Readonly<{
      tabId: string;
      windowGeneration: number;
      windowId: string;
      topologyRevision: number;
    }>
  ): Promise<void> => {
    const summary = await input.core.invoke(command);
    if (
      summary.status !== "applied" || summary.windowId !== expected.windowId ||
      summary.tabId !== expected.tabId ||
      summary.windowGeneration !== expected.windowGeneration ||
      summary.topologyRevision === undefined ||
      summary.topologyRevision <= expected.topologyRevision
    ) {
      throw restoreError(
        "ELECTRON_WINDOWS_RESTORE_PROJECTION_STALE",
        "The restored Game Window did not commit its exact Windows projection."
      );
    }
  };

  return Object.freeze({
    beginSavedWindowRestore: (windowId: string) => {
      input.appKit?.events.beginSavedWindowRestore(windowId);
      input.runtime.beginSavedWindowRestore(windowId);
    },
    finishSavedWindowRestore: async (windowId: string) => {
      await input.appKit?.events.finishSavedWindowRestore(windowId);
      input.runtime.finishSavedWindowRestore(windowId);
      await input.appKit?.events.settleCurrentEvents();
    },
    activateRestoredTab: async (windowId: string, tabId: string) => {
      const logical = await logicalWindow(windowId);
      if (!logical.tabs.some((tab) => tab.id === tabId)) {
        throw restoreError(
          "ELECTRON_CHROMIUM_RESTORE_PROJECTION_STALE",
          "The restored active tab is outside its exact Core topology."
        );
      }
      if (input.appKit) {
        const hosts = input.appKit.factory.captureHostObservations([windowId]);
        const receipt = await input.appKit.events.activateTab(hosts, tabId);
        if (
          !receipt.topologyCommitted || !receipt.nativeApplied ||
          receipt.windowGeneration !== logical.windowGeneration ||
          receipt.topologyRevision <= logical.revision
        ) {
          throw restoreError(
            "ELECTRON_MACOS_APPKIT_RESTORE_PROJECTION_STALE",
            "The restored Game Window did not commit its exact AppKit projection."
          );
        }
        return;
      }
      await applyWindowsAction({
        type: "embeddedTabActivate",
        operationId: randomUUID(),
        tabId,
        windowId,
        windowGeneration: logical.windowGeneration,
        topologyRevision: logical.revision
      }, { tabId, windowId, windowGeneration: logical.windowGeneration,
        topologyRevision: logical.revision });
    },
    reorderRestoredTab: async (
      windowId: string,
      tabId: string,
      beforeTabId?: string
    ) => {
      const logical = await logicalWindow(windowId);
      if (
        !logical.tabs.some((tab) => tab.id === tabId) ||
        (beforeTabId !== undefined &&
          !logical.tabs.some((tab) => tab.id === beforeTabId))
      ) {
        throw restoreError(
          "ELECTRON_CHROMIUM_RESTORE_PROJECTION_STALE",
          "The restored tab reorder is outside its exact Core topology."
        );
      }
      if (input.appKit) {
        const hosts = input.appKit.factory.captureHostObservations([windowId]);
        const receipt = await input.appKit.events.reorderTab(
          hosts,
          tabId,
          beforeTabId
        );
        if (
          !receipt.topologyCommitted || !receipt.nativeApplied ||
          receipt.windowGeneration !== logical.windowGeneration ||
          receipt.topologyRevision <= logical.revision
        ) {
          throw restoreError(
            "ELECTRON_MACOS_APPKIT_RESTORE_PROJECTION_STALE",
            "The restored tab order did not commit its exact AppKit projection."
          );
        }
        return;
      }
      await applyWindowsAction({
        type: "embeddedTabReorder",
        operationId: randomUUID(),
        tabId,
        windowId,
        windowGeneration: logical.windowGeneration,
        topologyRevision: logical.revision,
        ...(beforeTabId === undefined ? {} : { beforeTabId })
      }, { tabId, windowId, windowGeneration: logical.windowGeneration,
        topologyRevision: logical.revision });
    }
  });
}
