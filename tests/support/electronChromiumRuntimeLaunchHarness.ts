import { vi } from "vitest";

import { ChromiumRuntimeLaunchCoordinator, type ChromiumRuntimeExistingTabActivationFence, type ChromiumRuntimeLaunchCorePort } from "../../src/electron/main/chromiumRuntimeLaunchCoordinator";
import { projectCoreAppSnapshot } from "../../src/electron/main/appSnapshotProjection";
import type { ChromiumRuntimeExecutorSnapshot } from "../../src/electron/main/chromiumRuntimeEffectExecutor";
import { RionBridgeError } from "../../src/electron/ipc/errors";
import type { BrowserLaunchAdmissionRecord, CoreAppSnapshotRecord, CoreCommand, DisplayTopologySnapshotRecord } from "../../src/shared/generated";
import { ATTEMPT_ID, CAPTURED_AT, emptyCoreSnapshot, OPERATION_ID, RECT, ROLE_ID, TAB_ID, topology, WINDOW_ID, WORKSPACE_ATTEMPT_ID, WORKSPACE_ID, WORKSPACE_OPERATION_ID, WORKSPACE_TAB_ID } from "./electronChromiumRuntimeLaunchFixtures";

export interface HarnessOptions {
  readonly observedSnapshots?: boolean;
  readonly settleWindowNativeEvents?: (windowId: string) => Promise<boolean>;
  readonly settleWindowProjection?: (windowId: string) => Promise<boolean>;
  readonly settleNativeEvents?: () => Promise<void>;
  readonly settleRuntimeProjection?: () => Promise<number>;
  readonly waitForRuntimeProjection?: (afterSequence: number) => Promise<number>;
  readonly beginSavedWindowRestore?: (windowId: string, foreground?: boolean) => void;
  readonly finishSavedWindowRestore?: (windowId: string) => void | Promise<void>;
  readonly activateRestoredTab?: (
    windowId: string, tabId: string, harness: LaunchHarness
  ) => Promise<void>;
  readonly reorderRestoredTab?: (
    windowId: string, tabId: string, beforeTabId: string | undefined,
    harness: LaunchHarness
  ) => Promise<void>;
  readonly activateExistingTab?: (
    fence: ChromiumRuntimeExistingTabActivationFence,
    harness: LaunchHarness
  ) => Promise<void>;
  readonly onShow?: () => void;
  readonly completeRestores?: boolean;
  readonly nativeReady?: boolean;
  readonly projectionRevisionOffset?: number;
  readonly retireLeavesWindow?: boolean;
  readonly onRegister?: (
    command: Extract<CoreCommand, { type: "embeddedWindowRegister" }>,
    harness: LaunchHarness
  ) => void;
  readonly onLaunch?: (
    command: Extract<CoreCommand, { type: "browserRoleLaunch" | "browserWorkspaceLaunch" }>,
    harness: LaunchHarness
  ) => void;
}

export interface LaunchHarness {
  coreSnapshot: CoreAppSnapshotRecord;
  nativeSnapshot: ChromiumRuntimeExecutorSnapshot;
  projectionReady: boolean;
  topology: DisplayTopologySnapshotRecord;
}

export function launchHarness(options: HarnessOptions = {}) {
  const state: LaunchHarness = {
    coreSnapshot: emptyCoreSnapshot(),
    nativeSnapshot: { windows: [], tabs: [], roles: [], webSurfaces: [] },
    projectionReady: true,
    topology: topology()
  };
  const launchCommands: Array<Extract<CoreCommand, {
    type: "browserRoleLaunch" | "browserWorkspaceLaunch";
  }>> = [];
  const claimCommands: Array<Extract<CoreCommand, {
    type: "browserRoleSlotClaim";
  }>> = [];

  const admit = (
    command: Extract<CoreCommand, {
      type: "browserRoleLaunch" | "browserWorkspaceLaunch";
    }>
  ): BrowserLaunchAdmissionRecord => {
    const roleLaunch = command.type === "browserRoleLaunch";
    const sourceId = roleLaunch ? command.roleId : command.workspaceId;
    const tabId = roleLaunch ? TAB_ID : WORKSPACE_TAB_ID;
    const attemptId = roleLaunch ? ATTEMPT_ID : WORKSPACE_ATTEMPT_ID;
    const operationId = roleLaunch ? OPERATION_ID : WORKSPACE_OPERATION_ID;
    const status = {
      roleId: ROLE_ID,
      state: "launching" as const,
      runtimeMode: "embedded" as const
    };
    const existingSourceTab = state.coreSnapshot.browserRuntime.tabs.find(
      (tab) => tab.tabType === (roleLaunch ? "role" : "workspace") &&
        tab.sourceId === sourceId
    );
    if (existingSourceTab) {
      return {
        attemptId,
        completion: "completed",
        disposition: "existing",
        operationId,
        statuses: roleLaunch ? [status] : [],
        tabId: existingSourceTab.id
      };
    }
    const existingWindow = state.coreSnapshot.browserRuntime.windows.find(
      (window) => window.windowId === command.target.windowId
    );
    const logicalWindow = state.coreSnapshot.logicalWindows.find(
      (window) => window.windowId === command.target.windowId
    );
    const nextLogicalRevision = (logicalWindow?.revision ?? 0) + 1;
    const nextWindowGeneration = logicalWindow?.windowGeneration ?? 1;
    const logicalTab = {
      id: tabId,
      tabType: roleLaunch ? "role" as const : "workspace" as const,
      sourceId,
      name: roleLaunch ? "Pilot" : "Web tools",
      roleSlots: roleLaunch
        ? [{ slotId: "slot-1", roleId: ROLE_ID, rect: RECT }]
        : [],
      ...(roleLaunch ? {} : { workspaceSlots: [] }),
      hidden: false,
      audioMuted: false
    };
    const runtimeTab: CoreAppSnapshotRecord["browserRuntime"]["tabs"][number] = {
      id: tabId,
      audioMuted: false,
      attemptGeneration: attemptId,
      sourceId,
      name: roleLaunch ? "Pilot" : "Web tools",
      windowId: command.target.windowId,
      tabType: roleLaunch ? "role" as const : "workspace" as const,
      ...(roleLaunch ? {} : { workspaceId: WORKSPACE_ID }),
      slots: roleLaunch
        ? [{
            slotId: "slot-1",
            roleId: ROLE_ID,
            rect: RECT,
            state: "launching" as const,
            owner: {
              tabId,
              slotId: "slot-1",
              generation: 1
            }
          }]
        : [],
      webSurfaces: [],
      hidden: false
    };

    if (existingWindow && logicalWindow) {
      existingWindow.tabIds.push(tabId);
      existingWindow.activeTabId = tabId;
      logicalWindow.tabs.push(logicalTab);
      logicalWindow.activeTabId = tabId;
      logicalWindow.revision = nextLogicalRevision;
    } else {
      state.coreSnapshot.browserRuntime.windows.push({
        windowId: command.target.windowId,
        activeTabId: tabId,
        tabIds: [tabId]
      });
      state.coreSnapshot.logicalWindows.push({
        windowId: command.target.windowId,
        windowGeneration: nextWindowGeneration,
        revision: nextLogicalRevision,
        windowZoomFactor: 1,
        tabs: [logicalTab],
        activeTabId: tabId
      });
    }
    state.coreSnapshot.browserRuntime.tabs.push(runtimeTab);
    if (roleLaunch) {
      state.coreSnapshot.browserRuntime.roles.push({
        roleId: ROLE_ID,
        runtime: "embedded",
        owner: { tabId, slotId: "slot-1", generation: 1 },
        state: "launching"
      });
      state.coreSnapshot.roleStatuses = [status];
    } else {
      state.coreSnapshot.browserRuntime.workspaces.push({
        workspaceId: WORKSPACE_ID,
        name: "Web tools",
        runtime: "embedded",
        windowId: command.target.windowId,
        tabId,
        roleIds: [],
        state: "launching"
      });
    }
    state.coreSnapshot.revision += 1;
    state.coreSnapshot.runtimeRevision += 1;

    if (options.nativeReady !== false) {
      const currentLogical = state.coreSnapshot.logicalWindows.find(
        (window) => window.windowId === command.target.windowId
      )!;
      const nativeWindow = state.nativeSnapshot.windows.find(
        (window) => window.windowId === command.target.windowId
      );
      const projectedWindow = {
        windowId: command.target.windowId,
        activeTabId: tabId,
        tabIds: currentLogical.tabs.map((tab) => tab.id),
        displayId: command.target.displayId,
        bounds: { ...command.target.bounds },
        visible: true,
        focused: false,
        presentation: command.target.presentation,
        windowGeneration: currentLogical.windowGeneration,
        topologyRevision: currentLogical.revision
      };
      state.nativeSnapshot = {
        windows: nativeWindow
          ? state.nativeSnapshot.windows.map((window) =>
              window.windowId === command.target.windowId ? projectedWindow : window)
          : [...state.nativeSnapshot.windows, projectedWindow],
        tabs: [...state.nativeSnapshot.tabs, {
          attemptGeneration: attemptId,
          tabId,
          windowId: command.target.windowId,
          audioMuted: false,
          audible: false
        }],
        roles: state.nativeSnapshot.roles,
        webSurfaces: state.nativeSnapshot.webSurfaces
      };
    }

    const completedRestore = options.completeRestores === true &&
      command.launchTabId !== undefined;
    if (completedRestore && roleLaunch) {
      runtimeTab.slots = runtimeTab.slots.map((slot) => ({
        ...slot,
        state: "running"
      }));
      state.coreSnapshot.browserRuntime.roles =
        state.coreSnapshot.browserRuntime.roles.map((role) => ({
          ...role,
          state: "running"
        }));
      state.coreSnapshot.roleStatuses = [{ ...status, state: "running" }];
      state.nativeSnapshot = {
        ...state.nativeSnapshot,
        roles: [...state.nativeSnapshot.roles, {
          roleId: ROLE_ID,
          tabId,
          windowId: command.target.windowId,
          generation: 1,
          ownerGeneration: 1,
          zoomFactor: 1
        }]
      };
    }
    return {
      attemptId,
      completion: completedRestore ? "completed" : "pendingNativeCompletion",
      disposition: "admitted",
      operationId,
      statuses: roleLaunch
        ? [{ ...status, state: completedRestore ? "running" : "launching" }]
        : [],
      tabId
    };
  };

  const coreInvoke = vi.fn(async (command: CoreCommand): Promise<unknown> => {
    if (command.type === "appSnapshot") return state.coreSnapshot;
    if (command.type === "embeddedWindowsShow") {
      options.onShow?.();
      return state.coreSnapshot.browserRuntime;
    }
    if (command.type === "embeddedWindowRegister") {
      state.coreSnapshot.browserRuntime.windows.push({
        windowId: command.target.windowId,
        tabIds: []
      });
      state.coreSnapshot.logicalWindows.push({
        windowId: command.target.windowId,
        windowGeneration: 1,
        revision: 1,
        windowZoomFactor: 1,
        presentation: command.target.presentation,
        tabs: []
      });
      state.coreSnapshot.revision += 1;
      state.coreSnapshot.runtimeRevision += 1;
      state.nativeSnapshot = {
        ...state.nativeSnapshot,
        windows: [...state.nativeSnapshot.windows, {
          windowId: command.target.windowId,
          activeTabId: "",
          tabIds: [],
          displayId: command.target.displayId,
          bounds: { ...command.target.bounds },
          visible: true,
          focused: true,
          presentation: command.target.presentation,
          windowGeneration: 1,
          topologyRevision: 1
        }]
      };
      options.onRegister?.(command, state);
      return state.coreSnapshot.browserRuntime;
    }
    if (command.type === "embeddedWindowRetireProvision") {
      if (!options.retireLeavesWindow) {
        state.coreSnapshot.browserRuntime.windows =
          state.coreSnapshot.browserRuntime.windows.filter(
            (window) => window.windowId !== command.windowId
          );
        state.coreSnapshot.logicalWindows = state.coreSnapshot.logicalWindows.filter(
          (window) => window.windowId !== command.windowId
        );
        state.coreSnapshot.revision += 1;
        state.coreSnapshot.runtimeRevision += 1;
        state.nativeSnapshot = {
          windows: state.nativeSnapshot.windows.filter(
            (window) => window.windowId !== command.windowId
          ),
          tabs: state.nativeSnapshot.tabs.filter(
            (tab) => tab.windowId !== command.windowId
          ),
          roles: state.nativeSnapshot.roles.filter(
            (role) => role.windowId !== command.windowId
          ),
          webSurfaces: state.nativeSnapshot.webSurfaces.filter(
            (surface) => surface.windowId !== command.windowId
          )
        };
      }
      return { retired: !options.retireLeavesWindow };
    }
    if (command.type === "browserRoleLaunch" || command.type === "browserWorkspaceLaunch") {
      launchCommands.push(command);
      const admission = admit(command);
      options.onLaunch?.(command, state);
      return admission;
    }
    if (command.type === "browserRoleSlotClaim") {
      claimCommands.push(command);
      const role = state.coreSnapshot.browserRuntime.roles.find(
        (candidate) => candidate.roleId === ROLE_ID
      );
      if (!role || role.owner.generation !== command.expectedOwnerGeneration) {
        throw new Error("Stale Role claim generation");
      }
      role.owner = {
        tabId: command.tabId,
        slotId: command.slotId,
        generation: role.owner.generation + 1
      };
      for (const tab of state.coreSnapshot.browserRuntime.tabs) {
        for (const slot of tab.slots.filter((candidate) => candidate.roleId === ROLE_ID)) {
          slot.owner = { ...role.owner };
          slot.state = tab.id === command.tabId ? "running" : "blocked";
        }
      }
      state.nativeSnapshot = {
        ...state.nativeSnapshot,
        roles: state.nativeSnapshot.roles.map((candidate) =>
          candidate.roleId === ROLE_ID
            ? {
                ...candidate,
                tabId: command.tabId,
                ownerGeneration: role.owner.generation
              }
            : candidate)
      };
      return state.coreSnapshot.browserRuntime;
    }
    throw new Error(`Unexpected Core command: ${command.type}`);
  });
  const coordinator = new ChromiumRuntimeLaunchCoordinator({
    observedSnapshots: options.observedSnapshots,
    settleWindowProjection: options.settleWindowProjection,
    settleWindowNativeEvents: options.settleWindowNativeEvents,
    core: {
      invoke: coreInvoke as unknown as ChromiumRuntimeLaunchCorePort["invoke"]
    },
    ...(options.settleNativeEvents === undefined
      ? {}
      : { settleNativeEvents: options.settleNativeEvents }),
    ...(options.settleRuntimeProjection === undefined
      ? {}
      : { settleRuntimeProjection: options.settleRuntimeProjection }),
    ...(options.waitForRuntimeProjection === undefined
      ? {}
      : { waitForRuntimeProjection: options.waitForRuntimeProjection }),
    ...(options.beginSavedWindowRestore === undefined
      ? {}
      : {
          beginSavedWindowRestore: options.beginSavedWindowRestore
        }),
    ...(options.finishSavedWindowRestore === undefined
      ? {}
      : {
          finishSavedWindowRestore: (windowId: string) =>
            options.finishSavedWindowRestore!(windowId)
        }),
    ...(options.activateRestoredTab === undefined
      ? {}
      : {
          activateRestoredTab: (windowId: string, tabId: string) =>
            options.activateRestoredTab!(windowId, tabId, state)
        }),
    ...(options.reorderRestoredTab === undefined
      ? {}
      : {
          reorderRestoredTab: (
            windowId: string,
            tabId: string,
            beforeTabId?: string
          ) => options.reorderRestoredTab!(windowId, tabId, beforeTabId, state)
        }),
    ...(options.activateExistingTab === undefined
      ? {}
      : {
          activateExistingTab: (fence) =>
            options.activateExistingTab!(fence, state)
        }),
    createId: () => WINDOW_ID,
    projectAppSnapshot: async (coreSnapshot, nativeSnapshot, displayTopology) => {
      if (!state.projectionReady) {
        throw new RionBridgeError({
          code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY",
          message: "The native launch effect has not reconciled."
        });
      }
      const projection = projectCoreAppSnapshot(
        coreSnapshot,
        nativeSnapshot as ChromiumRuntimeExecutorSnapshot,
        displayTopology,
        CAPTURED_AT, options.observedSnapshots ? "observed" : "exact"
      );
      return {
        ...projection,
        revision: projection.revision + (options.projectionRevisionOffset ?? 0)
      };
    },
    readDisplayTopology: () => state.topology,
    readNativeSnapshot: () => state.nativeSnapshot
  });
  return { claimCommands, coordinator, coreInvoke, launchCommands, state };
}

