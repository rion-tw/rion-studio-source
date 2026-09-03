import { describe, expect, it } from "vitest";

import {
  projectCoreAppSnapshot,
  projectElectronDisplayTopology,
  type ElectronDisplayDescriptor
} from "../src/electron/main/appSnapshotProjection";
import type { CoreAppSnapshotRecord } from "../src/shared/generated";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";

const capturedAt = "2026-08-30T12:00:00.000Z";

function coreSnapshot(): CoreAppSnapshotRecord {
  return {
    revision: 9,
    stateRevision: 7,
    runtimeRevision: 5,
    state: {
      revision: 7,
      games: [],
      roles: [],
      launchWorkspaces: [],
      gameWindows: [],
      macros: []
    },
    browserRuntime: {
      windows: [],
      roles: [],
      tabs: [],
      workspaces: []
    },
    logicalWindows: [],
    roleStatuses: [],
    macroStatuses: []
  };
}

function display(overrides: Partial<ElectronDisplayDescriptor> = {}): ElectronDisplayDescriptor {
  return {
    id: 41,
    label: "Built-in Display",
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 25, width: 1512, height: 932 },
    size: { width: 3024, height: 1964 },
    scaleFactor: 2,
    internal: true,
    ...overrides
  };
}

function topology() {
  return projectElectronDisplayTopology({
    displays: [display()],
    primaryDisplayId: 41,
    revision: 3,
    capturedAt,
    cause: "electron-snapshot"
  });
}

function nativeSnapshot(): ChromiumRuntimeExecutorSnapshot {
  return { windows: [], tabs: [], roles: [], webSurfaces: [] };
}

describe("Electron app snapshot projection", () => {
  it("projects the authoritative Core state and an empty owned Chromium runtime", () => {
    const snapshot = coreSnapshot();
    snapshot.macroStatuses.push({
      roleId: "role-1",
      macroId: "macro-1",
      state: "cancelled",
      iteration: null,
      lastClick: null,
      startedAt: capturedAt,
      updatedAt: capturedAt,
      error: null
    });

    expect(projectCoreAppSnapshot(
      snapshot,
      nativeSnapshot(),
      topology(),
      capturedAt
    )).toEqual({
      revision: 9,
      stateRevision: 7,
      runtimeRevision: 5,
      embeddedRuntimeState: {
        revision: 5,
        capturedAt,
        windows: [],
        tabs: []
      },
      games: [],
      gameWindows: [],
      roles: [],
      roleStatuses: [],
      launchWorkspaces: [],
      displayTopology: topology(),
      macros: [],
      macroStatuses: [{
        roleId: "role-1",
        macroId: "macro-1",
        state: "cancelled",
        startedAt: capturedAt,
        updatedAt: capturedAt
      }],
      quickAccessPreferences: { pinnedItems: [], recentItems: [] }
    });
  });

  it("projects an exact live Core/native Chromium topology including AppKit state", () => {
    const snapshot = coreSnapshot();
    const owner = { tabId: "tab-1", slotId: "slot-1", generation: 4 };
    const rect = { x: 0, y: 0, width: 1, height: 1 };
    snapshot.state.roles.push({
      id: "role-1",
      gameId: "game-1",
      name: "Pilot",
      launchUrl: "https://game.test/play",
      notes: "",
      createdAt: capturedAt,
      updatedAt: capturedAt
    });
    snapshot.browserRuntime.windows.push({
      windowId: "window-1",
      activeTabId: "tab-1",
      tabIds: ["tab-1"]
    });
    snapshot.browserRuntime.tabs.push({
      id: "tab-1",
      audioMuted: false,
      attemptGeneration: "attempt-1",
      sourceId: "role-1",
      name: "Pilot",
      windowId: "window-1",
      tabType: "role",
      slots: [{
        slotId: "slot-1",
        roleId: "role-1",
        rect,
        state: "running",
        owner
      }],
      webSurfaces: [],
      hidden: false
    });
    snapshot.browserRuntime.roles.push({
      roleId: "role-1",
      runtime: "embedded",
      owner,
      state: "running",
      launchedAt: capturedAt
    });
    snapshot.logicalWindows.push({
      windowId: "window-1",
      windowGeneration: 3,
      revision: 7,
      windowZoomFactor: 1,
      tabs: [{
        id: "tab-1",
        tabType: "role",
        sourceId: "role-1",
        name: "Pilot",
        roleSlots: [{ slotId: "slot-1", roleId: "role-1", rect }],
        hidden: false,
        audioMuted: false
      }],
      activeTabId: "tab-1"
    });
    const native: ChromiumRuntimeExecutorSnapshot = {
      windows: [{
        windowId: "window-1",
        activeTabId: "tab-1",
        tabIds: ["tab-1"],
        displayId: 41,
        bounds: { x: 100, y: 80, width: 960, height: 680 },
        visible: true,
        focused: false,
        presentation: "fullscreen",
        windowGeneration: 3,
        topologyRevision: 7
      }],
      tabs: [{
        tabId: "tab-1",
        windowId: "window-1",
        audioMuted: false,
        audible: true
      }],
      roles: [{
        roleId: "role-1",
        tabId: "tab-1",
        windowId: "window-1",
        generation: 2,
        ownerGeneration: 4
      }],
      webSurfaces: []
    };

    expect(projectCoreAppSnapshot(snapshot, native, topology(), capturedAt)
      .embeddedRuntimeState).toEqual({
      revision: 5,
      capturedAt,
      windows: [{
        id: "window-1",
        windowId: "window-1",
        displayId: 41,
        bounds: { x: 100, y: 80, width: 960, height: 680 },
        visible: true,
        focused: false,
        activeTabId: "tab-1",
        tabCount: 1,
        presentation: "fullscreen"
      }],
      tabs: [{
        id: "tab-1",
        type: "role",
        sourceId: "role-1",
        name: "Pilot",
        windowId: "window-1",
        roleIds: ["role-1"],
        roleNames: ["Pilot"],
        slots: snapshot.browserRuntime.tabs[0]!.slots,
        hidden: false,
        active: true,
        audible: true,
        audioMuted: false
      }]
    });
  });

  it("projects only nonempty dormant Game Windows with exact restore state", () => {
    const snapshot = coreSnapshot();
    const savedBounds = { x: 100, y: 80, width: 960, height: 680 };
    snapshot.state.gameWindows.push({
      id: "window-saved",
      name: "Saved Window",
      targetDisplay: { id: 41 },
      placement: {
        normalBounds: savedBounds,
        savedWorkArea: { x: 0, y: 25, width: 1512, height: 932 },
        presentation: "normal"
      },
      tabs: [{
        id: "tab-saved",
        tabType: "workspace",
        sourceId: "workspace-1",
        name: "Two Roles",
        roleSlots: [{
          slotId: "slot-a",
          roleId: "role-a",
          rect: { x: 0, y: 0, width: 0.5, height: 1 }
        }, {
          slotId: "slot-b",
          roleId: "role-b",
          rect: { x: 0.5, y: 0, width: 0.5, height: 1 }
        }],
        hidden: false,
        audioMuted: false
      }],
      activeTabId: "tab-saved",
      createdAt: capturedAt,
      updatedAt: capturedAt
    }, {
      id: "window-empty",
      name: "Empty Window",
      targetDisplay: { id: 41 },
      placement: {
        normalBounds: savedBounds,
        savedWorkArea: { x: 0, y: 25, width: 1512, height: 932 },
        presentation: "normal"
      },
      tabs: [],
      createdAt: capturedAt,
      updatedAt: capturedAt
    });
    snapshot.state.runtimeRestoreSession = {
      schemaVersion: 1,
      sessionGeneration: 3,
      updatedAt: capturedAt,
      cleanExit: true,
      restoreInProgressWindowIds: [],
      windows: [{
        id: "window-saved",
        targetDisplay: { id: 41 },
        wasVisible: true,
        activeSourceId: "workspace-1",
        tabs: []
      }]
    };

    expect(projectCoreAppSnapshot(
      snapshot,
      nativeSnapshot(),
      topology(),
      capturedAt
    ).embeddedRuntimeState.savedWindows).toEqual([{
      id: "window-saved",
      displayId: 41,
      displayLabel: "Built-in Display",
      wasVisible: true,
      activeSourceId: "workspace-1",
      tabCount: 1,
      roleCount: 2,
      tabNames: ["Two Roles"],
      state: "dormant"
    }]);
  });

  it("projects the schema-v2 unclean live cohort without legacy window copies", () => {
    const snapshot = coreSnapshot();
    const savedBounds = { x: 100, y: 80, width: 960, height: 680 };
    for (const id of ["window-live", "window-restoring", "window-closed"]) {
      snapshot.state.gameWindows.push({
        id,
        name: id,
        targetDisplay: { id: 41 },
        placement: {
          normalBounds: savedBounds,
          savedWorkArea: { x: 0, y: 25, width: 1512, height: 932 },
          presentation: "normal"
        },
        tabs: [{
          id: `${id}-tab`,
          tabType: "role",
          sourceId: `${id}-role`,
          name: `${id} role`,
          roleSlots: [],
          hidden: false,
          audioMuted: false
        }],
        activeTabId: `${id}-tab`,
        createdAt: capturedAt,
        updatedAt: capturedAt
      });
    }
    snapshot.state.runtimeRestoreSession = {
      schemaVersion: 2,
      sessionGeneration: 8,
      updatedAt: capturedAt,
      cleanExit: false,
      lastFocusedWindowId: "window-restoring",
      liveWindowIds: ["window-live"],
      restoreInProgressWindowIds: ["window-restoring"]
    };

    const runtime = projectCoreAppSnapshot(
      snapshot,
      nativeSnapshot(),
      topology(),
      capturedAt
    ).embeddedRuntimeState;
    expect(runtime.savedWindows).toEqual([
      expect.objectContaining({
        id: "window-live",
        state: "awaiting-recovery",
        wasVisible: true
      }),
      expect.objectContaining({
        id: "window-restoring",
        state: "restoring",
        wasVisible: true
      }),
      expect.objectContaining({
        id: "window-closed",
        state: "dormant",
        wasVisible: false
      })
    ]);
    expect(runtime.recovery).toEqual({
      reason: "unclean-exit",
      windowCount: 2,
      tabCount: 2,
      interruptedWindowIds: ["window-restoring"],
      sessionGeneration: 8
    });
  });

  it("does not resurrect stale recovery fields after a clean exit", () => {
    const snapshot = coreSnapshot();
    snapshot.state.gameWindows.push({
      id: "window-clean",
      name: "Clean Window",
      targetDisplay: { id: 41 },
      placement: {
        normalBounds: { x: 100, y: 80, width: 960, height: 680 },
        savedWorkArea: { x: 0, y: 25, width: 1512, height: 932 },
        presentation: "normal"
      },
      tabs: [{
        id: "window-clean-tab",
        tabType: "role",
        sourceId: "window-clean-role",
        name: "Clean role",
        roleSlots: [],
        hidden: false,
        audioMuted: false
      }],
      activeTabId: "window-clean-tab",
      createdAt: capturedAt,
      updatedAt: capturedAt
    });
    snapshot.state.runtimeRestoreSession = {
      schemaVersion: 2,
      sessionGeneration: 9,
      updatedAt: capturedAt,
      cleanExit: true,
      liveWindowIds: ["window-clean"],
      restoreInProgressWindowIds: ["window-clean"]
    };

    const runtime = projectCoreAppSnapshot(
      snapshot,
      nativeSnapshot(),
      topology(),
      capturedAt
    ).embeddedRuntimeState;
    expect(runtime.savedWindows).toEqual([
      expect.objectContaining({
        id: "window-clean",
        state: "dormant",
        wasVisible: false
      })
    ]);
    expect(runtime.recovery).toBeUndefined();
  });

  it("normalizes and deterministically orders Electron's display inventory", () => {
    const result = projectElectronDisplayTopology({
      displays: [
        display({
          id: 99,
          label: "",
          bounds: { x: 1512.2, y: 0, width: 1280.4, height: 720.4 },
          workArea: { x: 1512.2, y: 0, width: 1280.4, height: 680.4 },
          size: { width: 1280.4, height: 720.4 },
          scaleFactor: 1,
          internal: false
        }),
        display()
      ],
      primaryDisplayId: 41,
      revision: 4,
      capturedAt,
      cause: "display-added"
    });

    expect(result).toMatchObject({
      revision: 4,
      capturedAt,
      cause: "display-added",
      primaryDisplayId: "41"
    });
    expect(result.displays.map(({ id, label, isPrimary }) => ({ id, label, isPrimary })))
      .toEqual([
        { id: 41, label: "Built-in Display", isPrimary: true },
        { id: 99, label: "Display 99", isPrimary: false }
      ]);
    expect(result.displays[1]?.bounds).toEqual({
      x: 1512,
      y: 0,
      width: 1280,
      height: 720
    });
  });

  it.each([
    "windows",
    "roles",
    "tabs",
    "workspaces"
  ] as const)("fails closed while Core still owns browserRuntime.%s", (collection) => {
    const snapshot = coreSnapshot();
    snapshot.browserRuntime[collection].push({} as never);

    expect(() => projectCoreAppSnapshot(
      snapshot,
      nativeSnapshot(),
      topology(),
      capturedAt
    )).toThrowError(
      expect.objectContaining({ code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY" })
    );
  });

  it("fails closed while Core still reports logical runtime windows", () => {
    const snapshot = coreSnapshot();
    snapshot.logicalWindows.push({} as never);

    expect(() => projectCoreAppSnapshot(
      snapshot,
      nativeSnapshot(),
      topology(),
      capturedAt
    )).toThrowError(
      expect.objectContaining({ code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY" })
    );
  });

  it("rejects an unavailable or internally inconsistent display inventory", () => {
    expect(() => projectElectronDisplayTopology({
      displays: [],
      primaryDisplayId: 41,
      revision: 1,
      capturedAt,
      cause: "test"
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_DISPLAY_TOPOLOGY_UNAVAILABLE"
    }));

    expect(() => projectElectronDisplayTopology({
      displays: [display(), display()],
      primaryDisplayId: 41,
      revision: 1,
      capturedAt,
      cause: "test"
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID"
    }));

    expect(() => projectElectronDisplayTopology({
      displays: [display()],
      primaryDisplayId: 99,
      revision: 1,
      capturedAt,
      cause: "test"
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID"
    }));
  });
});
