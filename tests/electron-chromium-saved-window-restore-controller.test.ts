import { describe, expect, it, vi } from "vitest";

import {
  ChromiumSavedWindowRestoreController,
  type ChromiumSavedWindowRestoreCorePort
} from "../src/electron/main/chromiumSavedWindowRestoreController";
import type {
  ChromiumRuntimeRestoreSessionMutationPort
} from "../src/electron/main/chromiumRuntimeRestoreSessionCoordinator";
import type {
  CoreAppSnapshotRecord,
  CoreCommand,
  RuntimeRestoreSessionRecord,
  StateGameWindowRecord
} from "../src/shared/generated";

const CAPTURED_AT = "2026-08-30T12:00:00.000Z";
const WINDOW_ONE = "saved-window-one";
const WINDOW_TWO = "saved-window-two";

function savedWindow(id: string, tabCount = 1): StateGameWindowRecord {
  const tabs = Array.from({ length: tabCount }, (_, index) => ({
    id: id + "-tab-" + (index + 1),
    tabType: "role" as const,
    sourceId: id + "-role-" + (index + 1),
    name: "Role " + (index + 1),
    roleSlots: [],
    hidden: false,
    audioMuted: false
  }));
  return {
    id,
    name: "Saved " + id,
    targetDisplay: { id: 41 },
    placement: {
      normalBounds: { x: 100, y: 80, width: 900, height: 640 },
      savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
      presentation: "normal"
    },
    tabs,
    ...(tabs[0] === undefined ? {} : { activeTabId: tabs[0].id }),
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT
  };
}

function restoreSession(
  windows: readonly StateGameWindowRecord[]
): RuntimeRestoreSessionRecord {
  return {
    schemaVersion: 1,
    sessionGeneration: 1,
    updatedAt: CAPTURED_AT,
    cleanExit: false,
    lastFocusedWindowId: windows[0]?.id,
    restoreInProgressWindowIds: [],
    liveWindowIds: [],
    windows: windows.map((window) => ({
      id: window.id,
      targetDisplay: structuredClone(window.targetDisplay),
      wasVisible: true,
      ...(window.activeTabId === undefined
        ? {}
        : {
            activeSourceId: window.tabs.find(
              (tab) => tab.id === window.activeTabId
            )?.sourceId
          }),
      tabs: window.tabs.map((tab) => ({
        tabType: tab.tabType,
        sourceId: tab.sourceId,
        name: tab.name,
        roleIds: tab.roleSlots.map((slot) => slot.roleId),
        hidden: tab.hidden,
        audioMuted: tab.audioMuted
      }))
    }))
  };
}

function appSnapshot(
  windows: readonly StateGameWindowRecord[]
): CoreAppSnapshotRecord {
  return {
    revision: 1,
    stateRevision: 1,
    runtimeRevision: 0,
    state: {
      revision: 1,
      games: [],
      roles: [],
      launchWorkspaces: [],
      gameWindows: windows.map((window) => structuredClone(window)),
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

class RestoreHarness {
  readonly snapshot: CoreAppSnapshotRecord;
  session: RuntimeRestoreSessionRecord;
  readonly commands: CoreCommand[] = [];
  readonly openEmpty = vi.fn(async (_window: StateGameWindowRecord) => undefined);
  readonly launches = vi.fn(async (_window: StateGameWindowRecord) => undefined);

  constructor(windows: StateGameWindowRecord[]) {
    this.snapshot = appSnapshot(windows);
    this.session = restoreSession(windows);
  }

  readonly invoke = async (command: CoreCommand): Promise<unknown> => {
    this.commands.push(structuredClone(command));
    switch (command.type) {
      case "appSnapshot":
        return structuredClone(this.snapshot);
      case "runtimeRestoreSessionGet":
        return structuredClone(this.session);
      case "runtimeRestoreSessionReplace":
        this.session = structuredClone(command.session);
        return structuredClone(this.session);
      default:
        throw new Error("Unexpected Core command: " + command.type);
    }
  };

  readonly restoreSessions: ChromiumRuntimeRestoreSessionMutationPort = {
    inspect: async () => structuredClone(this.session),
    mutate: async (mutation) => {
      this.session = {
        ...structuredClone(this.session),
        ...structuredClone(mutation(structuredClone(this.session))),
        schemaVersion: 2,
        sessionGeneration: this.session.sessionGeneration + 1,
        updatedAt: CAPTURED_AT
      };
      return structuredClone(this.session);
    }
  };

  controller(): ChromiumSavedWindowRestoreController {
    return new ChromiumSavedWindowRestoreController({
      core: { invoke: this.invoke } as unknown as ChromiumSavedWindowRestoreCorePort,
      restoreSession: this.restoreSessions,
      launches: {
        openEmptySavedGameWindow: this.openEmpty,
        restoreSavedGameWindow: this.launches
      }
    });
  }
}

describe("Chromium saved Game Window restore controller", () => {
  it("persists only v2 in-progress evidence before restoring a nonempty window", async () => {
    const sharedRole = "shared-role";
    const saved = savedWindow(WINDOW_ONE, 2);
    saved.tabs = saved.tabs.map((tab) => ({
      ...tab,
      tabType: "workspace",
      roleSlots: [{
        roleId: sharedRole,
        slotId: "slot-1",
        rect: { x: 0, y: 0, width: 1, height: 1 }
      }]
    }));
    const harness = new RestoreHarness([saved]);
    harness.launches.mockImplementationOnce(async (window) => {
      expect(window.id).toBe(WINDOW_ONE);
      expect(harness.session.restoreInProgressWindowIds).toEqual([WINDOW_ONE]);
      expect(harness.session.windows).toEqual([]);
    });

    await harness.controller().restore({
      scope: "window",
      windowId: WINDOW_ONE
    });

    expect(harness.launches).toHaveBeenCalledOnce();
    expect(harness.session.restoreInProgressWindowIds).toEqual([]);
    expect(harness.session.liveWindowIds).toEqual([WINDOW_ONE]);
    expect(harness.session.windows).toEqual([]);
  });

  it("discards the complete schema-v2 recovery cohort without legacy snapshots", async () => {
    const harness = new RestoreHarness([
      savedWindow(WINDOW_ONE),
      savedWindow(WINDOW_TWO)
    ]);
    harness.session = {
      ...harness.session,
      schemaVersion: 2,
      lastFocusedWindowId: WINDOW_TWO,
      restoreInProgressWindowIds: [WINDOW_ONE],
      liveWindowIds: [WINDOW_ONE, WINDOW_TWO],
      windows: []
    };

    await harness.controller().discard({ scope: "all" });

    expect(harness.session.restoreInProgressWindowIds).toEqual([]);
    expect(harness.session.liveWindowIds).toEqual([]);
    expect(harness.session.windows).toEqual([]);
    expect(harness.session.lastFocusedWindowId).toBeUndefined();
  });

  it("resumes from the Core in-progress marker after a launch crash", async () => {
    const harness = new RestoreHarness([savedWindow(WINDOW_ONE)]);
    harness.launches.mockRejectedValueOnce(new Error("host process exited"));

    await expect(harness.controller().restore({
      scope: "window",
      windowId: WINDOW_ONE
    })).rejects.toThrow("host process exited");
    expect(harness.session.restoreInProgressWindowIds).toEqual([WINDOW_ONE]);

    const resumed = harness.controller();
    await resumed.resumeInterrupted();

    expect(harness.launches).toHaveBeenCalledTimes(2);
    expect(harness.session.restoreInProgressWindowIds).toEqual([]);
    expect(harness.session.liveWindowIds).toEqual([WINDOW_ONE]);
  });

  it("restores the complete schema-v2 recovery cohort with final focus last", async () => {
    const first = savedWindow(WINDOW_ONE);
    const second = savedWindow(WINDOW_TWO);
    const harness = new RestoreHarness([second, first]);
    harness.session = {
      ...harness.session,
      schemaVersion: 2,
      lastFocusedWindowId: WINDOW_TWO,
      liveWindowIds: [WINDOW_ONE, WINDOW_TWO],
      windows: []
    };

    await harness.controller().restore({ scope: "last-visible" });

    expect(harness.launches.mock.calls.map(([window]) => window.id))
      .toEqual([WINDOW_ONE, WINDOW_TWO]);
    expect(harness.session.restoreInProgressWindowIds).toEqual([]);
    expect(harness.session.liveWindowIds).toEqual([WINDOW_ONE, WINDOW_TWO]);
  });

  it("restores only the last visible window outside recovery", async () => {
    const first = savedWindow(WINDOW_ONE);
    const second = savedWindow(WINDOW_TWO);
    const harness = new RestoreHarness([first, second]);
    harness.session = {
      ...harness.session,
      schemaVersion: 2,
      cleanExit: true,
      lastFocusedWindowId: WINDOW_TWO,
      liveWindowIds: [WINDOW_ONE, WINDOW_TWO],
      windows: []
    };

    await harness.controller().restore({ scope: "last-visible" });

    expect(harness.launches).toHaveBeenCalledOnce();
    expect(harness.launches).toHaveBeenCalledWith(second);
  });

  it("discards only the selected recovery window and retains its peer", async () => {
    const first = savedWindow(WINDOW_ONE);
    const second = savedWindow(WINDOW_TWO);
    const harness = new RestoreHarness([first, second]);
    harness.session = {
      ...harness.session,
      restoreInProgressWindowIds: [WINDOW_ONE, WINDOW_TWO],
      liveWindowIds: [WINDOW_ONE, WINDOW_TWO]
    };

    await harness.controller().discard({
      scope: "window",
      windowId: WINDOW_ONE
    });

    expect(harness.session.restoreInProgressWindowIds).toEqual([WINDOW_TWO]);
    expect(harness.session.liveWindowIds).toEqual([WINDOW_TWO]);
    expect(harness.session.windows?.map((window) => window.id))
      .toEqual([WINDOW_TWO]);
    expect(harness.session.lastFocusedWindowId).toBeUndefined();
  });

  it("fails closed for an empty requested window and clears stale resume state", async () => {
    const harness = new RestoreHarness([savedWindow(WINDOW_ONE, 0)]);

    await expect(harness.controller().restore({
      scope: "window",
      windowId: WINDOW_ONE
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_SAVED_WINDOW_EMPTY"
    });
    expect(harness.launches).not.toHaveBeenCalled();

    harness.session = {
      ...harness.session,
      restoreInProgressWindowIds: [WINDOW_ONE]
    };
    await harness.controller().resumeInterrupted();
    expect(harness.launches).not.toHaveBeenCalled();
    expect(harness.session.restoreInProgressWindowIds).toEqual([]);
    expect(harness.session.liveWindowIds).toEqual([WINDOW_ONE]);
  });

  it("opens an exact empty dormant window without entering tab restore state", async () => {
    const saved = savedWindow(WINDOW_ONE, 0);
    const harness = new RestoreHarness([saved]);

    await harness.controller().openEmpty(WINDOW_ONE);

    expect(harness.openEmpty).toHaveBeenCalledOnce();
    expect(harness.openEmpty).toHaveBeenCalledWith(saved);
    expect(harness.launches).not.toHaveBeenCalled();
    expect(harness.commands.map((command) => command.type)).toEqual(["appSnapshot"]);
    expect(harness.session.restoreInProgressWindowIds).toEqual([]);
  });
});
