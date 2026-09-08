import type { ChromiumRuntimeExecutorSnapshot } from
  "../../src/electron/main/chromiumRuntimeEffectExecutor";
import { projectElectronDisplayTopology } from
  "../../src/electron/main/appSnapshotProjection";
import type {
  CoreAppSnapshotRecord,
  DisplayTopologySnapshotRecord
} from "../../src/shared/generated";

export const CAPTURED_AT = "2026-08-30T12:00:00.000Z";
export const ROLE_ID = "11111111-1111-4111-8111-111111111111";
export const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const WINDOW_ID = "33333333-3333-4333-8333-333333333333";
export const TAB_ID = "44444444-4444-4444-8444-444444444441";
export const ATTEMPT_ID = "55555555-5555-4555-8555-555555555551";
export const OPERATION_ID = "66666666-6666-4666-8666-666666666661";
export const WORKSPACE_TAB_ID = "44444444-4444-4444-8444-444444444442";
export const WORKSPACE_ATTEMPT_ID = "55555555-5555-4555-8555-555555555552";
export const WORKSPACE_OPERATION_ID = "66666666-6666-4666-8666-666666666662";
export const WEB_SLOT_ID = "workspace-web-slot";
export const WEB_SURFACE_ID = `web-${WORKSPACE_TAB_ID}-1`;
export const RECT = { x: 0, y: 0, width: 1, height: 1 };
export const MANAGED_RECT = { x: 0, y: 0, width: 0.5, height: 1 };
export const WEB_RECT = { x: 0.5, y: 0, width: 0.5, height: 1 };

export function topology(
  revision = 1,
  workArea = { x: 0, y: 0, width: 1440, height: 900 }
): DisplayTopologySnapshotRecord {
  return projectElectronDisplayTopology({
    displays: [{
      id: 41,
      label: "Built-in Display",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea,
      size: { width: 2880, height: 1800 },
      scaleFactor: 2,
      internal: true
    }],
    primaryDisplayId: 41,
    revision,
    capturedAt: CAPTURED_AT,
    cause: revision === 1 ? "electron-initial" : "screen-display-metrics-changed"
  });
}

export function dualDisplayTopology(): DisplayTopologySnapshotRecord {
  return projectElectronDisplayTopology({
    displays: [
      {
        id: 41,
        label: "Built-in Display",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        size: { width: 2880, height: 1800 },
        scaleFactor: 2,
        internal: true
      },
      {
        id: 99,
        label: "External Display",
        bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
        workArea: { x: 1440, y: 24, width: 1920, height: 1056 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 1,
        internal: false
      }
    ],
    primaryDisplayId: 41,
    revision: 2,
    capturedAt: CAPTURED_AT,
    cause: "screen-display-added"
  });
}

export function emptyCoreSnapshot(): CoreAppSnapshotRecord {
  return {
    revision: 1,
    stateRevision: 1,
    runtimeRevision: 0,
    state: {
      revision: 1,
      games: [],
      roles: [{
        id: ROLE_ID,
        gameId: "77777777-7777-4777-8777-777777777777",
        name: "Pilot",
        launchUrl: "https://game.test/play",
        notes: "",
        createdAt: CAPTURED_AT,
        updatedAt: CAPTURED_AT
      }],
      launchWorkspaces: [{
        id: WORKSPACE_ID,
        name: "Web tools",
        template: "single",
        slots: [],
        createdAt: CAPTURED_AT,
        updatedAt: CAPTURED_AT
      }],
      gameWindows: [],
      macros: []
    },
    browserRuntime: { windows: [], roles: [], tabs: [], workspaces: [] },
    logicalWindows: [],
    roleStatuses: [],
    macroStatuses: []
  };
}

export function configureWorkspaceWebLaunch(
  state: { coreSnapshot: CoreAppSnapshotRecord; nativeSnapshot: ChromiumRuntimeExecutorSnapshot },
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

export function closeRuntimeTab(
  state: { coreSnapshot: CoreAppSnapshotRecord; nativeSnapshot: ChromiumRuntimeExecutorSnapshot },
  tabId: string
): void {
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
