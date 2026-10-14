import { describe, expect, it } from "vitest";
import type { StateGameWindowRecord } from "../src/shared/generated";
import { CAPTURED_AT, configureWorkspaceWebLaunch, RECT, ROLE_ID, TAB_ID, WEB_SLOT_ID,
  WINDOW_ID, WORKSPACE_ID, WORKSPACE_TAB_ID } from "./support/electronChromiumRuntimeLaunchFixtures";
import { launchHarness } from "./support/electronChromiumRuntimeLaunchHarness";

function savedWindow(presentation: "maximized" | "fullscreen"): StateGameWindowRecord {
  return {
    id: WINDOW_ID, name: "Saved",
    targetDisplay: { id: 41, fingerprint: { label: "Built-in Display",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      resolution: { width: 2880, height: 1800 }, scaleFactor: 2, isPrimary: true, isInternal: true } },
    placement: { normalBounds: { x: 120, y: 90, width: 1080, height: 720 },
      savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 }, presentation },
    tabs: [{ id: TAB_ID, tabType: "role", sourceId: ROLE_ID, name: "Pilot",
      roleSlots: [{ slotId: "slot-1", roleId: ROLE_ID, rect: RECT }], hidden: false, audioMuted: false }],
    activeTabId: TAB_ID, createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT,
  };
}

describe.each(["maximized", "fullscreen"] as const)("saved %s window staged restore", presentation => {
  it("keeps a saved native-mode target across hidden restore hydration until exact reveal", async () => {
    let stagedNativePresentation: string | undefined;
    const harness = launchHarness({
      completeRestores: true,
      beginSavedWindowRestore: () => undefined,
      activateRestoredTab: async () => undefined,
      reorderRestoredTab: async () => undefined,
      onLaunch: (command, state) => {
        if (command.type === "browserWorkspaceLaunch") configureWorkspaceWebLaunch(state);
        const logical = state.coreSnapshot.logicalWindows[0]!;
        logical.presentation = presentation;
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window => ({
          ...window, presentation: "normal", visible: false, parentNativeHostId: 71,
          pendingInitialPresentation: { presentation, nativeHostId: 71,
            windowGeneration: logical.windowGeneration, topologyRevision: logical.revision },
          target: { ...command.target, presentation },
        })) };
      },
      finishSavedWindowRestore: () => {
        stagedNativePresentation = harness.state.nativeSnapshot.windows[0]!.presentation;
        harness.state.nativeSnapshot = { ...harness.state.nativeSnapshot,
          windows: harness.state.nativeSnapshot.windows.map(window => {
            const { pendingInitialPresentation: _pending, ...current } = window;
            return { ...current, visible: true, presentation };
          }) };
      },
    });
    const saved = savedWindow(presentation);
    saved.tabs.push({ id: WORKSPACE_TAB_ID, tabType: "workspace", sourceId: WORKSPACE_ID,
      name: "Web tools", roleSlots: [], workspaceSlots: [{ id: WEB_SLOT_ID, rect: RECT,
        web: { lastUrl: "https://workspace-web.example.test/" }, browserZoomPercent: 100 }],
      hidden: false, audioMuted: false });
    saved.activeTabId = WORKSPACE_TAB_ID;
    harness.state.coreSnapshot.state.gameWindows.push(saved);
    await expect(harness.coordinator.restoreSavedGameWindow(saved)).resolves.toBeUndefined();
    expect(stagedNativePresentation).toBe("normal");
    expect(harness.launchCommands.map(command => command.target.presentation)).toEqual([presentation, presentation]);
    expect(harness.state.nativeSnapshot.windows[0]!.tabIds).toEqual([TAB_ID, WORKSPACE_TAB_ID]);
    expect(harness.state.nativeSnapshot.windows[0]).toMatchObject({ visible: true, presentation });
  });

  it("refuses to finish saved native-mode restore before its staged native mode is acknowledged", async () => {
    const harness = launchHarness({
      completeRestores: true, beginSavedWindowRestore: () => undefined,
      activateRestoredTab: async () => undefined,
      finishSavedWindowRestore: () => undefined,
      onLaunch: (command, state) => {
        const logical = state.coreSnapshot.logicalWindows[0]!;
        logical.presentation = presentation;
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window => ({
          ...window, presentation: "normal", visible: false, parentNativeHostId: 71,
          pendingInitialPresentation: { presentation, nativeHostId: 71,
            windowGeneration: logical.windowGeneration, topologyRevision: logical.revision },
          target: { ...command.target, presentation },
        })) };
      },
    });
    const saved = savedWindow(presentation);
    harness.state.coreSnapshot.state.gameWindows.push(saved);
    await expect(harness.coordinator.restoreSavedGameWindow(saved))
      .rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_RESTORE_PRESENTATION_STALE" });
  });

});
