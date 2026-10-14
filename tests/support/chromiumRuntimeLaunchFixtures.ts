import type { ChromiumRuntimeExecutorSnapshot } from "../../src/electron/main/chromiumRuntimeEffectExecutor";
import type { StateGameWindowRecord } from "../../src/shared/generated";
import type { LaunchHarness } from "./electronChromiumRuntimeLaunchHarness";
import { CAPTURED_AT, RECT, ROLE_ID, TAB_ID, WINDOW_ID } from "./electronChromiumRuntimeLaunchFixtures";

export function advanceWindowTopology(
  state: LaunchHarness,
  increment: number,
  native: Partial<ChromiumRuntimeExecutorSnapshot["windows"][number]> = {}
): void {
  const logical = state.coreSnapshot.logicalWindows[0]!;
  logical.revision += increment;
  state.coreSnapshot.revision += 1;
  state.coreSnapshot.runtimeRevision += 1;
  state.nativeSnapshot = {
    ...state.nativeSnapshot,
    windows: state.nativeSnapshot.windows.map((window) => ({
      ...window,
      ...native,
      topologyRevision: logical.revision
    }))
  };
}

export function nonemptySavedWindow(): StateGameWindowRecord {
  return {
    id: WINDOW_ID,
    name: "Saved",
    targetDisplay: {
      id: 41,
      fingerprint: {
        label: "Built-in Display",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        resolution: { width: 2880, height: 1800 },
        scaleFactor: 2,
        isPrimary: true,
        isInternal: true
      }
    },
    placement: {
      normalBounds: { x: 120, y: 90, width: 1080, height: 720 },
      savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
      presentation: "normal"
    },
    tabs: [{
      id: TAB_ID,
      tabType: "role",
      sourceId: ROLE_ID,
      name: "Pilot",
      roleSlots: [{ slotId: "slot-1", roleId: ROLE_ID, rect: RECT }],
      hidden: false,
      audioMuted: false
    }],
    activeTabId: TAB_ID,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT
  };
}

export function emptySavedWindow(): StateGameWindowRecord {
  const window = nonemptySavedWindow();
  return { ...window, tabs: [], activeTabId: undefined };
}

export function moveSavedWindowToExternalDisplay(window: StateGameWindowRecord): void {
  window.targetDisplay = {
    id: 99,
    fingerprint: {
      label: "External Display",
      bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
      resolution: { width: 1920, height: 1080 },
      scaleFactor: 1,
      isPrimary: false,
      isInternal: false
    }
  };
  window.placement = {
    normalBounds: { x: 1560, y: 80, width: 1200, height: 760 },
    savedWorkArea: { x: 1440, y: 24, width: 1920, height: 1056 },
    presentation: "normal"
  };
}

export function emptyTransientTarget() {
  return {
    windowId: WINDOW_ID,
    displayId: 41,
    scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    bounds: { x: 120, y: 90, width: 1080, height: 720 },
    presentation: "normal" as const
  };
}
