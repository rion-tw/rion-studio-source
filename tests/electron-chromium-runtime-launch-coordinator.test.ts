import { describe, expect, it, vi } from "vitest";

import {
  ChromiumRuntimeLaunchCoordinator,
  type ChromiumRuntimeExistingTabActivationFence,
  type ChromiumRuntimeLaunchCorePort
} from "../src/electron/main/chromiumRuntimeLaunchCoordinator";
import { projectCoreAppSnapshot } from "../src/electron/main/appSnapshotProjection";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";
import { RionBridgeError } from "../src/electron/ipc/errors";
import type {
  BrowserLaunchAdmissionRecord,
  CoreAppSnapshotRecord,
  CoreCommand,
  DisplayTopologySnapshotRecord,
  StateGameWindowRecord
} from "../src/shared/generated";
import {
  ATTEMPT_ID,
  CAPTURED_AT,
  dualDisplayTopology,
  emptyCoreSnapshot,
  MANAGED_RECT,
  OPERATION_ID,
  RECT,
  ROLE_ID,
  TAB_ID,
  topology,
  WEB_RECT,
  WEB_SLOT_ID,
  WEB_SURFACE_ID,
  WINDOW_ID,
  WORKSPACE_ATTEMPT_ID,
  WORKSPACE_ID,
  WORKSPACE_OPERATION_ID,
  WORKSPACE_TAB_ID
} from "./support/electronChromiumRuntimeLaunchFixtures";

interface HarnessOptions {
  readonly settleNativeEvents?: () => Promise<void>;
  readonly settleRuntimeProjection?: () => Promise<number>;
  readonly waitForRuntimeProjection?: (afterSequence: number) => Promise<number>;
  readonly beginSavedWindowRestore?: (windowId: string) => void;
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

interface LaunchHarness {
  coreSnapshot: CoreAppSnapshotRecord;
  nativeSnapshot: ChromiumRuntimeExecutorSnapshot;
  projectionReady: boolean;
  topology: DisplayTopologySnapshotRecord;
}

function launchHarness(options: HarnessOptions = {}) {
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
          beginSavedWindowRestore: (windowId: string) =>
            options.beginSavedWindowRestore!(windowId)
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
        CAPTURED_AT
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

function configureWorkspaceWebLaunch(
  state: LaunchHarness,
  options: Readonly<{
    mixed?: boolean;
    nativeSurface?: false | Partial<
      ChromiumRuntimeExecutorSnapshot["webSurfaces"][number]
    >;
  }> = {}
): void {
  const runtimeTab = state.coreSnapshot.browserRuntime.tabs.find(
    (tab) => tab.id === WORKSPACE_TAB_ID
  )!;
  const logicalTab = state.coreSnapshot.logicalWindows
    .flatMap((window) => window.tabs)
    .find((tab) => tab.id === WORKSPACE_TAB_ID)!;
  const runtimeWorkspace = state.coreSnapshot.browserRuntime.workspaces.find(
    (workspace) => workspace.tabId === WORKSPACE_TAB_ID
  )!;
  const savedWorkspace = state.coreSnapshot.state.launchWorkspaces.find(
    (workspace) => workspace.id === WORKSPACE_ID
  )!;
  const webSlot = {
    id: WEB_SLOT_ID,
    web: {
      name: "Workspace Web",
      startUrl: "https://workspace-web.example.test/"
    },
    browserZoomPercent: 100,
    rect: options.mixed ? WEB_RECT : RECT
  };
  runtimeTab.webSurfaces = [{
    surfaceId: WEB_SURFACE_ID,
    slotId: WEB_SLOT_ID
  }];
  logicalTab.workspaceSlots = options.mixed
    ? [{
        id: "workspace-managed-slot",
        roleId: ROLE_ID,
        browserZoomPercent: 100,
        rect: MANAGED_RECT
      }, webSlot]
    : [webSlot];
  savedWorkspace.slots = [...logicalTab.workspaceSlots];

  if (options.mixed) {
    logicalTab.roleSlots = [{
      slotId: "workspace-managed-slot",
      roleId: ROLE_ID,
      browserZoomPercent: 100,
      rect: MANAGED_RECT
    }];
    runtimeTab.slots = [{
      slotId: "workspace-managed-slot",
      roleId: ROLE_ID,
      browserZoomPercent: 100,
      rect: MANAGED_RECT,
      state: "launching",
      owner: {
        tabId: WORKSPACE_TAB_ID,
        slotId: "workspace-managed-slot",
        generation: 1
      }
    }];
    runtimeWorkspace.roleIds = [ROLE_ID];
    state.coreSnapshot.browserRuntime.roles = [{
      roleId: ROLE_ID,
      runtime: "embedded",
      owner: {
        tabId: WORKSPACE_TAB_ID,
        slotId: "workspace-managed-slot",
        generation: 1
      },
      state: "launching"
    }];
    state.nativeSnapshot = {
      ...state.nativeSnapshot,
      roles: [{
        roleId: ROLE_ID,
        tabId: WORKSPACE_TAB_ID,
        windowId: runtimeTab.windowId,
        generation: 1,
        ownerGeneration: 1
      }]
    };
  }

  const exactNativeSurface = {
    surfaceId: WEB_SURFACE_ID,
    slotId: WEB_SLOT_ID,
    tabId: WORKSPACE_TAB_ID,
    windowId: runtimeTab.windowId,
    generation: 1
  };
  state.nativeSnapshot = {
    ...state.nativeSnapshot,
    webSurfaces: options.nativeSurface === false
      ? []
      : [{ ...exactNativeSurface, ...options.nativeSurface }]
  };
}

function advanceWindowTopology(
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

function closeRuntimeTab(state: LaunchHarness, tabId: string): void {
  const runtimeTab = state.coreSnapshot.browserRuntime.tabs.find(
    (tab) => tab.id === tabId
  )!;
  state.coreSnapshot.browserRuntime.tabs =
    state.coreSnapshot.browserRuntime.tabs.filter((tab) => tab.id !== tabId);
  state.coreSnapshot.browserRuntime.roles =
    state.coreSnapshot.browserRuntime.roles.filter((role) => role.owner.tabId !== tabId);
  state.coreSnapshot.browserRuntime.workspaces =
    state.coreSnapshot.browserRuntime.workspaces.filter((item) => item.tabId !== tabId);
  const runtimeWindow = state.coreSnapshot.browserRuntime.windows.find(
    (window) => window.windowId === runtimeTab.windowId
  )!;
  runtimeWindow.tabIds = runtimeWindow.tabIds.filter((id) => id !== tabId);
  runtimeWindow.activeTabId = runtimeWindow.tabIds.at(-1);
  const logical = state.coreSnapshot.logicalWindows.find(
    (window) => window.windowId === runtimeTab.windowId
  )!;
  logical.tabs = logical.tabs.filter((tab) => tab.id !== tabId);
  logical.activeTabId = logical.tabs.at(-1)?.id;
  logical.revision += 1;
  state.nativeSnapshot = {
    windows: state.nativeSnapshot.windows.map((window) => ({
      ...window,
      tabIds: window.tabIds.filter((id) => id !== tabId),
      activeTabId: window.tabIds.filter((id) => id !== tabId).at(-1) ?? "",
      topologyRevision: logical.revision
    })),
    tabs: state.nativeSnapshot.tabs.filter((tab) => tab.tabId !== tabId),
    roles: state.nativeSnapshot.roles.filter((role) => role.tabId !== tabId),
    webSurfaces: state.nativeSnapshot.webSurfaces.filter(
      (surface) => surface.tabId !== tabId
    )
  };
  state.coreSnapshot.revision += 1;
  state.coreSnapshot.runtimeRevision += 1;
}

function removeRuntimeWindow(state: LaunchHarness): void {
  state.coreSnapshot.browserRuntime = {
    windows: [],
    roles: [],
    tabs: [],
    workspaces: []
  };
  state.coreSnapshot.logicalWindows = [];
  state.coreSnapshot.roleStatuses = [];
  state.coreSnapshot.revision += 1;
  state.coreSnapshot.runtimeRevision += 1;
  state.nativeSnapshot = { windows: [], tabs: [], roles: [], webSurfaces: [] };
}

function nonemptySavedWindow(): StateGameWindowRecord {
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

function emptySavedWindow(): StateGameWindowRecord {
  const window = nonemptySavedWindow();
  return { ...window, tabs: [], activeTabId: undefined };
}

function emptyTransientTarget() {
  return {
    windowId: WINDOW_ID,
    displayId: 41,
    scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    bounds: { x: 120, y: 90, width: 1080, height: 720 },
    presentation: "normal" as const
  };
}

describe("Electron Chromium runtime launch coordinator", () => {
  it("settles admitted native host events before reading launch state", async () => {
    let release!: () => void;
    const nativeFence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settleNativeEvents = vi.fn(async () => nativeFence);
    const { coordinator, coreInvoke } = launchHarness({ settleNativeEvents });

    const launch = coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    await Promise.resolve();
    expect(coreInvoke).not.toHaveBeenCalled();

    release();
    await expect(launch).resolves.toMatchObject({
      launchReceipt: { status: "applied" },
      windowId: WINDOW_ID
    });
    expect(settleNativeEvents).toHaveBeenCalled();
  });

  it("waits for the current runtime projection fence before reading launch state", async () => {
    let release!: () => void;
    const projectionFence = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settleRuntimeProjection = vi.fn(async () => {
      await projectionFence;
      return 1;
    });
    const { coordinator, coreInvoke } = launchHarness({ settleRuntimeProjection });

    const launch = coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    await Promise.resolve();
    expect(coreInvoke).not.toHaveBeenCalled();

    release();
    await expect(launch).resolves.toMatchObject({
      launchReceipt: { status: "applied" },
      windowId: WINDOW_ID
    });
    expect(settleRuntimeProjection).toHaveBeenCalled();
  });

  it("waits for the next projection effect when Core is ahead of Electron", async () => {
    const settleRuntimeProjection = vi.fn(async () => 0);
    const waitForRuntimeProjection = vi.fn(async (afterSequence: number) => {
      harness.state.projectionReady = true;
      return afterSequence + 1;
    });
    const harness: ReturnType<typeof launchHarness> = launchHarness({
      settleRuntimeProjection,
      waitForRuntimeProjection
    });
    harness.state.projectionReady = false;

    await expect(harness.coordinator.launchRole(ROLE_ID, { kind: "new-window" }))
      .resolves.toMatchObject({
        launchReceipt: { status: "applied" },
        windowId: WINDOW_ID
      });
    expect(waitForRuntimeProjection).toHaveBeenCalledWith(0);
  });

  it("requires the projection to preserve its single Core snapshot envelope", async () => {
    const { coordinator } = launchHarness({ projectionRevisionOffset: 1 });

    await expect(coordinator.launchRole(ROLE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LAUNCH_SNAPSHOT_CHANGED"
    });
  });

  it("admits a new Role with exact geometry, then reuses only its reconciled target", async () => {
    const { coordinator, launchCommands } = launchHarness();

    await expect(coordinator.launchRole(ROLE_ID, { kind: "new-window" })).resolves.toEqual({
      launchReceipt: {
        intentId: OPERATION_ID,
        status: "applied",
        destinationReason: "requested-new-game-window",
        windowId: WINDOW_ID,
        windowGeneration: 1,
        topologyRevision: 1
      },
      windowId: WINDOW_ID,
      status: {
        roleId: ROLE_ID,
        state: "launching",
        runtimeMode: "embedded"
      }
    });
    expect(launchCommands[0]).toEqual({
      type: "browserRoleLaunch",
      roleId: ROLE_ID,
      target: {
        windowId: WINDOW_ID,
        displayId: 41,
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        bounds: { x: 144, y: 90, width: 1152, height: 720 },
        presentation: "normal"
      }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({
      kind: "launched",
      windowId: WINDOW_ID,
      statuses: [],
      launchReceipt: {
        intentId: WORKSPACE_OPERATION_ID,
        destinationReason: "requested-live-game-window",
        windowGeneration: 1,
        topologyRevision: 2
      }
    });
    expect(launchCommands[1]).toMatchObject({
      type: "browserWorkspaceLaunch",
      workspaceId: WORKSPACE_ID,
      target: launchCommands[0]!.target
    });
  });

  it("promotes a Web-only workspace only after its exact native Web surface exists", async () => {
    const { coordinator, launchCommands, state } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type === "browserWorkspaceLaunch") {
          configureWorkspaceWebLaunch(harness);
        }
      }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" }))
      .resolves.toMatchObject({ windowId: WINDOW_ID });
    expect(state.coreSnapshot.browserRuntime.tabs[0]!.webSurfaces).toEqual([{
      surfaceId: WEB_SURFACE_ID,
      slotId: WEB_SLOT_ID
    }]);
    expect(state.nativeSnapshot.webSurfaces).toEqual([{
      surfaceId: WEB_SURFACE_ID,
      slotId: WEB_SLOT_ID,
      tabId: WORKSPACE_TAB_ID,
      windowId: WINDOW_ID,
      generation: 1
    }]);

    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      launchReceipt: { existingTabId: WORKSPACE_TAB_ID },
      windowId: WINDOW_ID
    });
    expect(launchCommands).toHaveLength(2);
  });

  it("rejects malformed Core Web surface identities before target reconciliation", async () => {
    const { coordinator, launchCommands } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type !== "browserWorkspaceLaunch") return;
        configureWorkspaceWebLaunch(harness);
        harness.coreSnapshot.browserRuntime.tabs[0]!.webSurfaces.push({
          surfaceId: `web-${WORKSPACE_TAB_ID}-2`,
          slotId: WEB_SLOT_ID
        });
      }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" }))
      .rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_LAUNCH_WEB_SURFACE_IDENTITY_MISMATCH"
      });
    expect(launchCommands).toHaveLength(1);
  });

  it("keeps a mixed workspace pending despite an exact managed Role until its Web surface exists", async () => {
    const { coordinator, launchCommands, state } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type === "browserWorkspaceLaunch") {
          configureWorkspaceWebLaunch(harness, {
            mixed: true,
            nativeSurface: false
          });
        }
      }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" }))
      .resolves.toMatchObject({ windowId: WINDOW_ID });
    expect(state.nativeSnapshot.roles).toEqual([{
      roleId: ROLE_ID,
      tabId: WORKSPACE_TAB_ID,
      windowId: WINDOW_ID,
      generation: 1,
      ownerGeneration: 1
    }]);
    expect(state.nativeSnapshot.webSurfaces).toEqual([]);
    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);

    configureWorkspaceWebLaunch(state, { mixed: true });
    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      launchReceipt: { existingTabId: WORKSPACE_TAB_ID },
      windowId: WINDOW_ID
    });
    expect(launchCommands).toHaveLength(2);
  });

  it("promotes a pending target after an exact admission revision 3 to terminal revision 6", async () => {
    let admitted = false;
    const { coordinator, launchCommands, state } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type !== "browserWorkspaceLaunch" || admitted) return;
        admitted = true;
        configureWorkspaceWebLaunch(harness, { nativeSurface: false });
        advanceWindowTopology(harness, 2);
      }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" }))
      .resolves.toMatchObject({
        launchReceipt: { topologyRevision: 3 },
        windowId: WINDOW_ID
      });

    advanceWindowTopology(state, 3, {
      bounds: { x: 120, y: 72, width: 1104, height: 756 }
    });
    configureWorkspaceWebLaunch(state);
    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).resolves.toMatchObject({
      launchReceipt: {
        existingTabId: WORKSPACE_TAB_ID,
        topologyRevision: 6
      },
      windowId: WINDOW_ID
    });
    expect(launchCommands[1]!.target.bounds).toEqual({
      x: 120,
      y: 72,
      width: 1104,
      height: 756
    });
    expect(launchCommands).toHaveLength(2);
  });

  it.each([
    ["presentation", (state: LaunchHarness) => {
      state.nativeSnapshot = {
        ...state.nativeSnapshot,
        windows: state.nativeSnapshot.windows.map((window) => ({
          ...window,
          presentation: "maximized" as const
        }))
      };
    }],
    ["display work area", (state: LaunchHarness) => {
      state.topology = topology(2, { x: 0, y: 30, width: 1440, height: 870 });
    }]
  ] as const)("rejects a pending target whose %s identity changed", async (
    _identity,
    mutateIdentity
  ) => {
    let admitted = false;
    const { coordinator, launchCommands, state } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type !== "browserWorkspaceLaunch" || admitted) return;
        admitted = true;
        configureWorkspaceWebLaunch(harness, { nativeSurface: false });
      }
    });

    await coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" });
    configureWorkspaceWebLaunch(state);
    mutateIdentity(state);

    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("rejects a pending target whose current revision regresses below admission", async () => {
    let admitted = false;
    const { coordinator, launchCommands, state } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type !== "browserWorkspaceLaunch" || admitted) return;
        admitted = true;
        configureWorkspaceWebLaunch(harness, { nativeSurface: false });
        advanceWindowTopology(harness, 2);
      }
    });

    await coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" });
    advanceWindowTopology(state, -1);
    configureWorkspaceWebLaunch(state);

    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("rejects a pending target when native and Core ordered tabs differ", async () => {
    const wrongTabId = "44444444-4444-4444-8444-444444444499";
    const { coordinator, launchCommands, state } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type === "browserWorkspaceLaunch") {
          configureWorkspaceWebLaunch(harness, { nativeSurface: false });
        }
      }
    });

    await coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" });
    configureWorkspaceWebLaunch(state);
    state.nativeSnapshot = {
      ...state.nativeSnapshot,
      windows: state.nativeSnapshot.windows.map((window) => ({
        ...window,
        activeTabId: wrongTabId,
        tabIds: [wrongTabId]
      }))
    };

    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it.each([
    ["surfaceId", { surfaceId: "web-other-surface" }],
    ["slotId", { slotId: "other-web-slot" }],
    ["tabId", { tabId: "44444444-4444-4444-8444-444444444499" }],
    ["windowId", { windowId: "33333333-3333-4333-8333-333333333399" }],
    ["generation", { generation: 0 }]
  ] as const)("fails closed when native Web surface %s differs from Core", async (
    _field,
    mismatch
  ) => {
    const { coordinator, launchCommands } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type === "browserWorkspaceLaunch") {
          configureWorkspaceWebLaunch(harness, { nativeSurface: mismatch });
        }
      }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" }))
      .resolves.toMatchObject({ windowId: WINDOW_ID });
    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("does not promote an exact Web surface after its Core launch attempt changes", async () => {
    const { coordinator, launchCommands, state } = launchHarness({
      onLaunch: (command, harness) => {
        if (command.type === "browserWorkspaceLaunch") {
          configureWorkspaceWebLaunch(harness);
          harness.projectionReady = false;
        }
      }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, { kind: "new-window" }))
      .resolves.toMatchObject({ windowId: WINDOW_ID });
    state.projectionReady = true;
    state.coreSnapshot.browserRuntime.tabs[0]!.attemptGeneration =
      "55555555-5555-4555-8555-555555555599";
    await expect(coordinator.launchWorkspace(WORKSPACE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("never reuses a target whose native effect was not reconciled and was superseded", async () => {
    const { coordinator, launchCommands, state } = launchHarness({
      nativeReady: false,
      onLaunch: (_command, harness) => {
        harness.projectionReady = false;
      }
    });

    await expect(coordinator.launchRole(ROLE_ID, { kind: "new-window" }))
      .resolves.toMatchObject({ windowId: WINDOW_ID });
    state.projectionReady = true;
    const target = launchCommands[0]!.target;
    const logical = state.coreSnapshot.logicalWindows[0]!;
    state.nativeSnapshot = {
      windows: [{
        windowId: WINDOW_ID,
        activeTabId: TAB_ID,
        tabIds: [TAB_ID],
        displayId: target.displayId,
        bounds: target.bounds,
        visible: true,
        focused: false,
        presentation: target.presentation,
        windowGeneration: logical.windowGeneration,
        topologyRevision: logical.revision
      }],
      tabs: [{
        tabId: TAB_ID,
        windowId: WINDOW_ID,
        audioMuted: false,
        audible: false
      }],
      roles: [],
      webSurfaces: []
    };
    state.coreSnapshot.browserRuntime.tabs[0]!.attemptGeneration =
      "55555555-5555-4555-8555-555555555599";

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("materializes moved, resized, and maximized live geometry from one native snapshot", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    advanceWindowTopology(state, 1, {
      bounds: { x: 80, y: 40, width: 1040, height: 680 },
      presentation: "maximized"
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({ windowId: WINDOW_ID });
    expect(launchCommands[1]!.target).toMatchObject({
      displayId: 41,
      scaleFactor: 2,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 80, y: 40, width: 1040, height: 680 },
      presentation: "maximized"
    });
  });

  it("materializes an exact live target after a reconciled cross-display move", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    state.topology = dualDisplayTopology();
    advanceWindowTopology(state, 1, {
      displayId: 99,
      bounds: { x: 1560, y: 80, width: 1200, height: 760 }
    });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({ windowId: WINDOW_ID });
    expect(launchCommands[1]!.target).toMatchObject({
      displayId: 99,
      scaleFactor: 1,
      workArea: { x: 1440, y: 24, width: 1920, height: 1056 },
      bounds: { x: 1560, y: 80, width: 1200, height: 760 }
    });
  });

  it.each([false, true])(
    "activates an existing source before its focus-only launch (hidden: %s)",
    async (hidden) => {
    const activateExistingTab = vi.fn(async (
      fence: ChromiumRuntimeExistingTabActivationFence,
      harness: LaunchHarness
    ) => {
      expect(fence).toMatchObject({
        hidden,
        tabId: TAB_ID,
        windowId: WINDOW_ID
      });
      const logical = harness.coreSnapshot.logicalWindows[0]!;
      const logicalTab = logical.tabs.find((tab) => tab.id === TAB_ID)!;
      const runtimeTab = harness.coreSnapshot.browserRuntime.tabs.find(
        (tab) => tab.id === TAB_ID
      )!;
      const runtimeWindow = harness.coreSnapshot.browserRuntime.windows[0]!;
      logicalTab.hidden = false;
      runtimeTab.hidden = false;
      logical.activeTabId = TAB_ID;
      runtimeWindow.activeTabId = TAB_ID;
      logical.revision += 1;
      harness.coreSnapshot.revision += 1;
      harness.coreSnapshot.runtimeRevision += 1;
      harness.nativeSnapshot = {
        ...harness.nativeSnapshot,
        windows: harness.nativeSnapshot.windows.map((window) => ({
          ...window,
          activeTabId: TAB_ID,
          topologyRevision: logical.revision
        }))
      };
    });
    const { coordinator, launchCommands, state } = launchHarness({
      activateExistingTab
    });
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    await coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    });
    state.coreSnapshot.logicalWindows[0]!.tabs.find(
      (tab) => tab.id === TAB_ID
    )!.hidden = hidden;
    state.coreSnapshot.browserRuntime.tabs.find(
      (tab) => tab.id === TAB_ID
    )!.hidden = hidden;
    advanceWindowTopology(state, 1);

    await expect(coordinator.launchRole(ROLE_ID)).resolves.toMatchObject({
      launchReceipt: {
        existingTabId: TAB_ID,
        topologyRevision: 4
      },
      windowId: WINDOW_ID
    });
    expect(activateExistingTab).toHaveBeenCalledOnce();
    expect(launchCommands).toHaveLength(3);
    expect(launchCommands[2]).toMatchObject({
      type: "browserRoleLaunch",
      roleId: ROLE_ID
    });
    }
  );

  it("rejects an inactive existing source before issuing another Core launch", async () => {
    const { coordinator, launchCommands } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    await coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    });

    await expect(coordinator.launchRole(ROLE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EXISTING_TAB_ACTIVATION_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(2);
  });

  it("rejects revision progress that leaves the existing source inactive", async () => {
    const activateExistingTab = vi.fn(async (
      _fence: ChromiumRuntimeExistingTabActivationFence,
      harness: LaunchHarness
    ) => {
      advanceWindowTopology(harness, 1);
    });
    const { coordinator, launchCommands } = launchHarness({
      activateExistingTab
    });
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    await coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    });

    await expect(coordinator.launchRole(ROLE_ID)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EXISTING_TAB_ACTIVATION_STALE"
    });
    expect(activateExistingTab).toHaveBeenCalledOnce();
    expect(launchCommands).toHaveLength(2);
  });

  it("accepts an exact monotonic revision jump but rejects a later rollback", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    advanceWindowTopology(state, 3, {
      bounds: { x: 96, y: 64, width: 1056, height: 704 }
    });

    await expect(coordinator.launchRole(ROLE_ID)).resolves.toMatchObject({
      launchReceipt: {
        topologyRevision: 4,
        existingTabId: TAB_ID
      }
    });
    const logical = state.coreSnapshot.logicalWindows[0]!;
    logical.revision = 3;
    state.nativeSnapshot = {
      ...state.nativeSnapshot,
      windows: state.nativeSnapshot.windows.map((window) => ({
        ...window,
        topologyRevision: 3
      }))
    };
    state.coreSnapshot.revision += 1;
    state.coreSnapshot.runtimeRevision += 1;

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(2);
  });

  it("rejects a Core/native topology revision mismatch before admission", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    state.coreSnapshot.logicalWindows[0]!.revision += 1;
    state.coreSnapshot.revision += 1;
    state.coreSnapshot.runtimeRevision += 1;

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("keeps a reconciled window launchable after its latest admission tab closes", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    await coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    });
    closeRuntimeTab(state, WORKSPACE_TAB_ID);
    expect(state.coreSnapshot.browserRuntime.tabs.map((tab) => tab.id)).toEqual([TAB_ID]);

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({ windowId: WINDOW_ID });
    expect(launchCommands).toHaveLength(3);
    expect(launchCommands[2]!.target.windowId).toBe(WINDOW_ID);
  });

  it("drops the reconciled cache when the last-tab window is gone", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    removeRuntimeWindow(state);

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LAUNCH_TARGET_NOT_FOUND"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("rejects an exact projection with a stale window generation", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    await coordinator.launchRole(ROLE_ID, { kind: "new-window" });
    state.coreSnapshot.logicalWindows[0]!.windowGeneration += 1;
    advanceWindowTopology(state, 1, { windowGeneration: 2 });

    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("fails closed before admission for a nonempty dormant saved Game Window", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    state.coreSnapshot.state.gameWindows.push(nonemptySavedWindow());

    await expect(coordinator.launchRole(ROLE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_SAVED_WINDOW_RESTORE_UNSUPPORTED"
    });
    expect(launchCommands).toHaveLength(0);
  });

  it("accepts a synchronously completed exact saved-tab hydration", async () => {
    const activateRestoredTab = vi.fn(async () => undefined);
    const beginRestore = vi.fn();
    const finishRestore = vi.fn();
    const { coordinator, launchCommands, state } = launchHarness({
      activateRestoredTab,
      beginSavedWindowRestore: beginRestore,
      completeRestores: true,
      finishSavedWindowRestore: finishRestore
    });
    const saved = nonemptySavedWindow();
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.restoreSavedGameWindow(saved)).resolves.toBeUndefined();

    expect(launchCommands).toHaveLength(1);
    expect(launchCommands[0]).toMatchObject({
      launchTabId: TAB_ID,
      restoreRoleSlots: saved.tabs[0]!.roleSlots,
      roleId: ROLE_ID,
      target: { windowId: WINDOW_ID },
      type: "browserRoleLaunch"
    });
    expect(beginRestore).toHaveBeenCalledExactlyOnceWith(WINDOW_ID);
    expect(activateRestoredTab).not.toHaveBeenCalled();
    expect(finishRestore).toHaveBeenCalledExactlyOnceWith(WINDOW_ID);
  });

  it("restores saved tabs and active Role ownership before reveal", async () => {
    const beginRestore = vi.fn();
    const finishRestore = vi.fn();
    const activateRestoredTab = vi.fn(async (
      windowId: string,
      tabId: string,
      state: LaunchHarness
    ) => {
      const logical = state.coreSnapshot.logicalWindows.find(
        (window) => window.windowId === windowId
      )!;
      logical.activeTabId = tabId;
      logical.revision += 1;
      state.coreSnapshot.browserRuntime.windows.find(
        (window) => window.windowId === windowId
      )!.activeTabId = tabId;
      state.nativeSnapshot = {
        ...state.nativeSnapshot,
        windows: state.nativeSnapshot.windows.map((window) =>
          window.windowId === windowId
            ? { ...window, activeTabId: tabId, topologyRevision: logical.revision }
            : window
        )
      };
      state.coreSnapshot.revision += 1;
      state.coreSnapshot.runtimeRevision += 1;
    });
    const reorderRestoredTab = vi.fn(async (
      windowId: string,
      tabId: string,
      beforeTabId: string | undefined,
      state: LaunchHarness
    ) => {
      const logical = state.coreSnapshot.logicalWindows.find(
        (window) => window.windowId === windowId
      )!;
      const ordered = logical.tabs.filter((tab) => tab.id !== tabId);
      const moved = logical.tabs.find((tab) => tab.id === tabId)!;
      const insertion = beforeTabId === undefined
        ? ordered.length
        : ordered.findIndex((tab) => tab.id === beforeTabId);
      ordered.splice(insertion, 0, moved);
      logical.tabs.splice(0, logical.tabs.length, ...ordered);
      logical.revision += 1;
      const runtimeWindow = state.coreSnapshot.browserRuntime.windows.find(
        (window) => window.windowId === windowId
      )!;
      runtimeWindow.tabIds.splice(
        0,
        runtimeWindow.tabIds.length,
        ...ordered.map((tab) => tab.id)
      );
      state.nativeSnapshot = {
        ...state.nativeSnapshot,
        windows: state.nativeSnapshot.windows.map((window) =>
          window.windowId === windowId
            ? {
                ...window,
                tabIds: ordered.map((tab) => tab.id),
                topologyRevision: logical.revision
              }
            : window
        )
      };
      state.coreSnapshot.revision += 1;
      state.coreSnapshot.runtimeRevision += 1;
    });
    const { claimCommands, coordinator, launchCommands, state } = launchHarness({
      activateRestoredTab,
      beginSavedWindowRestore: beginRestore,
      completeRestores: true,
      finishSavedWindowRestore: finishRestore,
      reorderRestoredTab,
      onLaunch: (command, current) => {
        if (command.type !== "browserWorkspaceLaunch") return;
        const role = current.coreSnapshot.browserRuntime.roles[0]!;
        role.owner = {
          tabId: WORKSPACE_TAB_ID,
          slotId: "slot-1",
          generation: role.owner.generation + 1
        };
        for (const tab of current.coreSnapshot.browserRuntime.tabs) {
          const slot = tab.slots.find((candidate) => candidate.roleId === ROLE_ID);
          if (slot) {
            slot.owner = { ...role.owner };
            slot.state = tab.id === WORKSPACE_TAB_ID ? "running" : "blocked";
          } else if (tab.id === WORKSPACE_TAB_ID) {
            tab.slots.push({
              slotId: "slot-1",
              roleId: ROLE_ID,
              rect: RECT,
              state: "running",
              owner: { ...role.owner }
            });
          }
        }
        const logicalWorkspaceTab = current.coreSnapshot.logicalWindows
          .flatMap((window) => window.tabs)
          .find((tab) => tab.id === WORKSPACE_TAB_ID)!;
        logicalWorkspaceTab.roleSlots = [{
          slotId: "slot-1",
          roleId: ROLE_ID,
          rect: RECT
        }];
        current.coreSnapshot.browserRuntime.workspaces.find(
          (workspace) => workspace.tabId === WORKSPACE_TAB_ID
        )!.roleIds = [ROLE_ID];
        current.nativeSnapshot = {
          ...current.nativeSnapshot,
          roles: current.nativeSnapshot.roles.map((candidate) => ({
            ...candidate,
            tabId: WORKSPACE_TAB_ID,
            ownerGeneration: role.owner.generation
          }))
        };
      }
    });
    const roleTab = nonemptySavedWindow().tabs[0]!;
    const workspaceTab = {
      id: WORKSPACE_TAB_ID,
      tabType: "workspace" as const,
      sourceId: WORKSPACE_ID,
      name: "Web tools",
      roleSlots: [{ slotId: "slot-1", roleId: ROLE_ID, rect: RECT }],
      hidden: false,
      audioMuted: false
    };
    const saved: StateGameWindowRecord = {
      ...nonemptySavedWindow(),
      tabs: [roleTab, workspaceTab],
      activeTabId: TAB_ID
    };
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.restoreSavedGameWindow(saved)).resolves.toBeUndefined();

    expect(launchCommands.map((command) => command.type)).toEqual([
      "browserRoleLaunch",
      "browserWorkspaceLaunch"
    ]);
    expect(reorderRestoredTab).not.toHaveBeenCalled();
    expect(activateRestoredTab).toHaveBeenCalledExactlyOnceWith(
      WINDOW_ID,
      TAB_ID,
      state
    );
    expect(claimCommands).toEqual([expect.objectContaining({
      expectedOwnerGeneration: 2,
      slotId: "slot-1",
      tabId: TAB_ID
    })]);
    expect(state.coreSnapshot.logicalWindows[0]!.tabs.map((tab) => tab.id)).toEqual([
      TAB_ID,
      WORKSPACE_TAB_ID
    ]);
    expect(finishRestore).toHaveBeenCalledExactlyOnceWith(WINDOW_ID);
  });

  it("rejects a saved active tab outside the exact restore cohort", async () => {
    const { coordinator, launchCommands, state } = launchHarness();
    const saved = {
      ...nonemptySavedWindow(),
      activeTabId: WORKSPACE_TAB_ID
    };
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.restoreSavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_RESTORE_ACTIVE_TAB_INVALID"
    });
    expect(launchCommands).toHaveLength(0);
  });

  it("registers an empty saved Game Window through one exact Core/native projection", async () => {
    const { coordinator, coreInvoke, launchCommands, state } = launchHarness();
    const saved = emptySavedWindow();
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.openEmptySavedGameWindow(saved)).resolves.toBeUndefined();

    expect(coreInvoke).toHaveBeenCalledWith({
      type: "embeddedWindowRegister",
      target: {
        windowId: WINDOW_ID,
        persistedName: "Saved",
        displayId: 41,
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        bounds: { x: 120, y: 90, width: 1080, height: 720 },
        presentation: "normal"
      }
    });
    expect(state.coreSnapshot.logicalWindows[0]).toMatchObject({
      windowId: WINDOW_ID,
      windowGeneration: 1,
      revision: 1,
      tabs: []
    });
    expect(state.nativeSnapshot.windows[0]).toMatchObject({
      windowId: WINDOW_ID,
      tabIds: [],
      visible: true,
      windowGeneration: 1,
      topologyRevision: 1
    });
    expect(coreInvoke.mock.calls.filter(
      ([command]) => command.type === "appSnapshot"
    )).toHaveLength(2);

    await expect(coordinator.launchRole(ROLE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({
      windowId: WINDOW_ID,
      launchReceipt: { destinationReason: "requested-live-game-window" }
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("registers a transient empty Game Window before admitting a launch into it", async () => {
    const { coordinator, coreInvoke, launchCommands, state } = launchHarness();
    const target = emptyTransientTarget();

    await expect(coordinator.openEmptyTransientGameWindow(target))
      .resolves.toBeUndefined();

    expect(coreInvoke).toHaveBeenCalledWith({
      type: "embeddedWindowRegister",
      target
    });
    expect(coreInvoke).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedWindowsShow"
    }));
    expect(state.coreSnapshot.state.gameWindows).toEqual([]);
    expect(state.coreSnapshot.logicalWindows[0]).toMatchObject({
      windowId: WINDOW_ID,
      windowGeneration: 1,
      revision: 1,
      tabs: []
    });
    expect(state.nativeSnapshot.windows[0]).toMatchObject({
      windowId: WINDOW_ID,
      tabIds: [],
      visible: true,
      windowGeneration: 1,
      topologyRevision: 1
    });

    await expect(coordinator.launchRole(ROLE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({
      windowId: WINDOW_ID,
      launchReceipt: { destinationReason: "requested-live-game-window" }
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("accepts fractional-DPI normal-bound rounding and reuses the live geometry", async () => {
    const liveBounds = { x: 121, y: 89, width: 1079, height: 721 };
    const { coordinator, launchCommands } = launchHarness({
      onRegister: (_command, harness) => {
        harness.nativeSnapshot = {
          ...harness.nativeSnapshot,
          windows: harness.nativeSnapshot.windows.map((window) => ({
            ...window,
            bounds: liveBounds
          }))
        };
      }
    });

    await expect(coordinator.openEmptyTransientGameWindow(emptyTransientTarget()))
      .resolves.toBeUndefined();
    await expect(coordinator.launchRole(ROLE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({ windowId: WINDOW_ID });

    expect(launchCommands[0]!.target.bounds).toEqual(liveBounds);
  });

  it("accepts Core-committed native work-area fitting and reuses its geometry", async () => {
    const liveBounds = { x: 120, y: 70, width: 1080, height: 692 };
    const persistedFrame = { x: 120, y: 84, width: 1080, height: 700 };
    const { coordinator, launchCommands, state } = launchHarness({
      onRegister: (_command, harness) => {
        harness.coreSnapshot.state.gameWindows =
          harness.coreSnapshot.state.gameWindows.map((window) => ({
            ...window,
            placement: {
              ...window.placement,
              normalBounds: persistedFrame
            },
            updatedAt: "2026-08-30T12:00:01.000Z"
          }));
        advanceWindowTopology(harness, 1, { bounds: liveBounds });
      }
    });
    const saved = emptySavedWindow();
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.openEmptySavedGameWindow(saved)).resolves.toBeUndefined();
    await expect(coordinator.launchRole(ROLE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).resolves.toMatchObject({ windowId: WINDOW_ID });

    expect(state.coreSnapshot.logicalWindows[0]!.revision).toBeGreaterThan(1);
    expect(state.coreSnapshot.state.gameWindows[0]!.placement.normalBounds)
      .toEqual(persistedFrame);
    expect(launchCommands[0]!.target.bounds).toEqual(liveBounds);
  });

  it("rejects an unrelated saved-window identity change during empty registration", async () => {
    const { coordinator, coreInvoke, state } = launchHarness({
      onRegister: (_command, harness) => {
        harness.coreSnapshot.state.gameWindows =
          harness.coreSnapshot.state.gameWindows.map((window) => ({
            ...window,
            name: "Changed outside the registration"
          }));
      }
    });
    const saved = emptySavedWindow();
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE"
    });
    expect(coreInvoke).toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedWindowRetireProvision",
      windowId: WINDOW_ID
    }));
    expect(state.coreSnapshot.logicalWindows).toEqual([]);
    expect(state.nativeSnapshot.windows).toEqual([]);
  });

  it("retires and does not cache a transient empty window whose receipt diverges", async () => {
    const { coordinator, coreInvoke, launchCommands, state } = launchHarness({
      onRegister: (_command, harness) => {
        harness.nativeSnapshot = {
          ...harness.nativeSnapshot,
          windows: harness.nativeSnapshot.windows.map((window) => ({
            ...window,
            bounds: { ...window.bounds, x: window.bounds.x + 2 }
          }))
        };
      }
    });

    await expect(coordinator.openEmptyTransientGameWindow(emptyTransientTarget()))
      .rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE"
      });
    expect(coreInvoke).toHaveBeenCalledWith({
      type: "embeddedWindowRetireProvision",
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      ),
      windowId: WINDOW_ID,
      windowGeneration: 1,
      topologyRevision: 1
    });
    expect(state.coreSnapshot.logicalWindows).toEqual([]);
    expect(state.coreSnapshot.browserRuntime.windows).toEqual([]);
    expect(state.nativeSnapshot.windows).toEqual([]);
    await expect(coordinator.launchRole(ROLE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LAUNCH_TARGET_NOT_FOUND"
    });
    expect(launchCommands).toHaveLength(0);
  });

  it("reports indeterminate compensation and never caches an unretired window", async () => {
    const { coordinator, coreInvoke, launchCommands } = launchHarness({
      retireLeavesWindow: true,
      onRegister: (_command, harness) => {
        harness.nativeSnapshot = {
          ...harness.nativeSnapshot,
          windows: harness.nativeSnapshot.windows.map((window) => ({
            ...window,
            bounds: { ...window.bounds, x: window.bounds.x + 2 }
          }))
        };
      }
    });

    await expect(coordinator.openEmptyTransientGameWindow(emptyTransientTarget()))
      .rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_COMPENSATION_INDETERMINATE"
      });
    expect(coreInvoke).toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedWindowRetireProvision",
      windowId: WINDOW_ID
    }));
    await expect(coordinator.launchRole(ROLE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(0);
  });

  it("compensates a saved empty registration after its display fence changes", async () => {
    const saved = emptySavedWindow();
    const { coordinator, coreInvoke, state } = launchHarness({
      onRegister: (_command, harness) => {
        harness.topology = topology(2, {
          x: 0,
          y: 30,
          width: 1440,
          height: 870
        });
      }
    });
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_DISPLAY_CHANGED"
    });
    expect(coreInvoke).toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedWindowRetireProvision",
      windowId: WINDOW_ID
    }));
    expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
    expect(state.coreSnapshot.logicalWindows).toEqual([]);
    expect(state.nativeSnapshot.windows).toEqual([]);
  });

  it("keeps nonempty saved windows out of the empty-host registration lane", async () => {
    const { coordinator, coreInvoke, state } = launchHarness();
    const saved = nonemptySavedWindow();
    state.coreSnapshot.state.gameWindows.push(saved);

    await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_TABS_PRESENT"
    });
    expect(coreInvoke).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "embeddedWindowRegister"
    }));
  });

  it("fences a semantic display change after Core admission and leaves no reusable target", async () => {
    const { coordinator, launchCommands } = launchHarness({
      onLaunch: (_command, harness) => {
        harness.topology = topology(2, { x: 0, y: 30, width: 1440, height: 870 });
      }
    });

    await expect(coordinator.launchRole(ROLE_ID, { kind: "new-window" }))
      .rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_LAUNCH_DISPLAY_CHANGED"
      });
    await expect(coordinator.launchWorkspace(WORKSPACE_ID, {
      kind: "game-window",
      windowId: WINDOW_ID
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_LIVE_WINDOW_TARGET_UNAVAILABLE"
    });
    expect(launchCommands).toHaveLength(1);
  });

  it("rejects a Core admission whose exact tab/window identity is inconsistent", async () => {
    const { coordinator, state } = launchHarness({
      onLaunch: (_command, harness) => {
        harness.coreSnapshot.browserRuntime.tabs[0]!.windowId =
          "33333333-3333-4333-8333-333333333399";
      }
    });

    await expect(coordinator.launchRole(ROLE_ID, { kind: "new-window" }))
      .rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_LAUNCH_ADMISSION_IDENTITY_MISMATCH"
      });
    expect(state.coreSnapshot.browserRuntime.tabs).toHaveLength(1);
  });
});
