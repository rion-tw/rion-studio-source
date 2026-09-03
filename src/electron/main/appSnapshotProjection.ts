import type { CoreAppSnapshotRecord } from "../../shared/generated";
import type {
  AppSnapshot,
  DisplayTopology,
  EmbeddedRuntimeState,
  MacroRunStatus
} from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";

export interface ElectronDisplayDescriptor {
  id: number;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  size: { width: number; height: number };
  scaleFactor: number;
  internal: boolean;
}

export interface ElectronDisplayTopologyInput {
  displays: readonly ElectronDisplayDescriptor[];
  primaryDisplayId: number;
  revision: number;
  capturedAt: string;
  cause: string;
}

function projectionNotReady(message: string): never {
  throw new RionBridgeError({
    code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY",
    message
  });
}

function finiteInteger(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new RionBridgeError({
      code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID",
      message: `The Electron display ${field} is not finite.`
    });
  }
  return Math.round(value);
}

function normalizeMacroStatus(status: CoreAppSnapshotRecord["macroStatuses"][number]): MacroRunStatus {
  return {
    roleId: status.roleId,
    macroId: status.macroId,
    state: status.state,
    ...(status.iteration === null ? {} : { iteration: status.iteration }),
    ...(status.lastClick === null ? {} : { lastClick: status.lastClick }),
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    ...(status.error === null ? {} : { error: status.error })
  };
}

function uniqueMap<Value>(
  values: readonly Value[],
  identity: (value: Value) => string,
  collection: string
): Map<string, Value> {
  const indexed = new Map<string, Value>();
  for (const value of values) {
    const id = identity(value);
    if (typeof id !== "string" || id.length === 0 || indexed.has(id)) {
      projectionNotReady(
        `Core and Electron disagree on the ${collection} identity set.`
      );
    }
    indexed.set(id, value);
  }
  return indexed;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectSavedRuntimeWindows(
  snapshot: CoreAppSnapshotRecord,
  displayTopology: DisplayTopology
): NonNullable<EmbeddedRuntimeState["savedWindows"]> {
  const liveWindowIds = new Set(
    snapshot.browserRuntime.windows.map((window) => window.windowId)
  );
  const restoreSession = snapshot.state.runtimeRestoreSession;
  const restoringWindowIds = new Set(
    restoreSession?.restoreInProgressWindowIds ?? []
  );
  const restoreWindowsById = new Map(
    (restoreSession?.windows ?? []).map((window) => [window.id, window])
  );
  const recoveryWindowIds = new Set<string>();
  if (restoreSession?.cleanExit === false) {
    if (restoreSession.liveWindowIds !== undefined) {
      for (const windowId of restoreSession.liveWindowIds) {
        recoveryWindowIds.add(windowId);
      }
    } else if (restoreWindowsById.size > 0) {
      // Schema-v1 compatibility: before liveWindowIds existed, the retained
      // window snapshots were the unclean-session cohort.
      for (const windowId of restoreWindowsById.keys()) {
        recoveryWindowIds.add(windowId);
      }
    } else {
      // Old journals could contain neither field. Match the retained v22
      // recovery rule and conservatively admit every nonempty dormant window.
      for (const window of snapshot.state.gameWindows) {
        if (window.tabs.length > 0) recoveryWindowIds.add(window.id);
      }
    }
    for (const windowId of restoringWindowIds) {
      recoveryWindowIds.add(windowId);
    }
  }

  return snapshot.state.gameWindows.flatMap((window) => {
    if (liveWindowIds.has(window.id) || window.tabs.length === 0) return [];
    const restored = restoreWindowsById.get(window.id);
    const activeTab = window.tabs.find((tab) => tab.id === window.activeTabId);
    const roleIds = new Set(window.tabs.flatMap((tab) => [
      ...(tab.tabType === "role" ? [tab.sourceId] : []),
      ...tab.roleSlots.map((slot) => slot.roleId),
      ...(tab.workspaceSlots ?? []).flatMap(
        (slot) => slot.roleId === undefined ? [] : [slot.roleId]
      )
    ]));
    const display = displayTopology.displays.find(
      (candidate) => candidate.id === window.targetDisplay.id
    );
    const state = restoreSession?.cleanExit === false &&
      restoringWindowIds.has(window.id)
      ? "restoring" as const
      : recoveryWindowIds.has(window.id)
        ? "awaiting-recovery" as const
        : "dormant" as const;
    return [{
      id: window.id,
      displayId: window.targetDisplay.id,
      displayLabel: display?.label ?? window.targetDisplay.fingerprint?.label
        ?? `Display ${window.targetDisplay.id}`,
      wasVisible: restored?.wasVisible ?? recoveryWindowIds.has(window.id),
      ...(restored?.activeSourceId === undefined && activeTab === undefined
        ? {}
        : { activeSourceId: restored?.activeSourceId ?? activeTab?.sourceId }),
      tabCount: window.tabs.length,
      roleCount: roleIds.size,
      tabNames: window.tabs.map((tab) => tab.name),
      state
    }];
  });
}

function projectRuntimeRecovery(
  snapshot: CoreAppSnapshotRecord,
  savedWindows: NonNullable<EmbeddedRuntimeState["savedWindows"]>
): EmbeddedRuntimeState["recovery"] {
  const session = snapshot.state.runtimeRestoreSession;
  if (session?.cleanExit !== false) return undefined;
  const recoveryWindows = savedWindows.filter(
    ({ state }) => state === "awaiting-recovery" || state === "restoring"
  );
  if (recoveryWindows.length === 0) return undefined;
  const recoveryWindowIds = new Set(recoveryWindows.map(({ id }) => id));
  const interruptedWindowIds = [...new Set(
    session.restoreInProgressWindowIds.filter((id) => recoveryWindowIds.has(id))
  )];
  return {
    reason: "unclean-exit",
    windowCount: recoveryWindows.length,
    tabCount: recoveryWindows.reduce((total, window) => total + window.tabCount, 0),
    ...(interruptedWindowIds.length === 0 ? {} : { interruptedWindowIds }),
    sessionGeneration: session.sessionGeneration
  };
}

function projectOwnedRuntime(
  snapshot: CoreAppSnapshotRecord,
  nativeRuntime: ChromiumRuntimeExecutorSnapshot,
  displayTopology: DisplayTopology,
  capturedAt: string
): EmbeddedRuntimeState {
  const runtime = snapshot.browserRuntime;
  const coreWindows = uniqueMap(runtime.windows, (window) => window.windowId, "window");
  const coreTabs = uniqueMap(runtime.tabs, (tab) => tab.id, "tab");
  const coreRoles = uniqueMap(runtime.roles, (role) => role.roleId, "role");
  const coreWorkspaces = uniqueMap(
    runtime.workspaces,
    (workspace) => workspace.workspaceId,
    "workspace"
  );
  const logicalWindows = uniqueMap(
    snapshot.logicalWindows,
    (window) => window.windowId,
    "logical window"
  );
  const nativeWindows = uniqueMap(
    nativeRuntime.windows,
    (window) => window.windowId,
    "native window"
  );
  const nativeTabs = uniqueMap(nativeRuntime.tabs, (tab) => tab.tabId, "native tab");
  const nativeRoles = uniqueMap(
    nativeRuntime.roles,
    (role) => role.roleId,
    "native role"
  );

  if (
    coreWindows.size !== logicalWindows.size ||
    coreWindows.size !== nativeWindows.size ||
    coreTabs.size !== nativeTabs.size
  ) {
    projectionNotReady(
      "Core logical topology and the Electron Chromium host have not reached the same revision."
    );
  }

  for (const [windowId, coreWindow] of coreWindows) {
    const logicalWindow = logicalWindows.get(windowId);
    const nativeWindow = nativeWindows.get(windowId);
    if (!logicalWindow || !nativeWindow) {
      projectionNotReady(
        "Core logical topology and the Electron Chromium host disagree on a window owner."
      );
    }
    const logicalTabIds = logicalWindow.tabs.map((tab) => tab.id);
    const activeTabId = coreWindow.activeTabId ?? "";
    if (
      !sameOrder(coreWindow.tabIds, logicalTabIds) ||
      !sameOrder(coreWindow.tabIds, nativeWindow.tabIds) ||
      activeTabId !== (logicalWindow.activeTabId ?? "") ||
      activeTabId !== nativeWindow.activeTabId ||
      (nativeWindow.windowGeneration > 0 &&
        nativeWindow.windowGeneration !== logicalWindow.windowGeneration) ||
      (nativeWindow.topologyRevision > 0 &&
        nativeWindow.topologyRevision !== logicalWindow.revision)
    ) {
      projectionNotReady(
        `Core and Electron disagree on runtime window ${windowId}.`
      );
    }
    if (!displayTopology.displays.some((display) => display.id === nativeWindow.displayId)) {
      projectionNotReady(
        `Native runtime window ${windowId} is attached to an unavailable display.`
      );
    }
  }

  const logicalTabs = new Map<string, CoreAppSnapshotRecord["logicalWindows"][number]["tabs"][number]>();
  for (const logicalWindow of snapshot.logicalWindows) {
    for (const tab of logicalWindow.tabs) {
      if (logicalTabs.has(tab.id)) {
        projectionNotReady("Core reported one logical tab in multiple runtime windows.");
      }
      logicalTabs.set(tab.id, tab);
    }
  }

  for (const [tabId, coreTab] of coreTabs) {
    const logicalTab = logicalTabs.get(tabId);
    const nativeTab = nativeTabs.get(tabId);
    const logicalSlots = logicalTab?.roleSlots.map((slot) => ({
      slotId: slot.slotId,
      roleId: slot.roleId,
      rect: slot.rect,
      ...(slot.browserZoomPercent === undefined
        ? {}
        : { browserZoomPercent: slot.browserZoomPercent })
    }));
    const projectedSlots = coreTab.slots.map((slot) => ({
      slotId: slot.slotId,
      roleId: slot.roleId,
      rect: slot.rect,
      ...(slot.browserZoomPercent === undefined
        ? {}
        : { browserZoomPercent: slot.browserZoomPercent })
    }));
    if (
      !logicalTab ||
      !nativeTab ||
      nativeTab.windowId !== coreTab.windowId ||
      nativeTab.audioMuted !== coreTab.audioMuted ||
      logicalTab.tabType !== coreTab.tabType ||
      logicalTab.sourceId !== coreTab.sourceId ||
      logicalTab.name !== coreTab.name ||
      logicalTab.hidden !== coreTab.hidden ||
      logicalTab.audioMuted !== coreTab.audioMuted ||
      !sameValue(logicalSlots, projectedSlots)
    ) {
      projectionNotReady(`Core and Electron disagree on runtime tab ${tabId}.`);
    }
  }

  for (const [roleId, nativeRole] of nativeRoles) {
    const coreRole = coreRoles.get(roleId);
    const coreTab = coreRole ? coreTabs.get(coreRole.owner.tabId) : undefined;
    const ownerSlot = coreTab?.slots.find((slot) =>
      slot.roleId === roleId &&
      slot.slotId === coreRole?.owner.slotId
    );
    if (
      !coreRole ||
      !coreTab ||
      !ownerSlot ||
      nativeRole.tabId !== coreRole.owner.tabId ||
      nativeRole.windowId !== coreTab.windowId ||
      nativeRole.ownerGeneration !== coreRole.owner.generation ||
      ownerSlot.owner?.tabId !== coreRole.owner.tabId ||
      ownerSlot.owner?.generation !== coreRole.owner.generation
    ) {
      projectionNotReady(`Core and Electron disagree on runtime role ${roleId}.`);
    }
  }
  for (const coreRole of runtime.roles) {
    if (coreRole.state !== "launching" && !nativeRoles.has(coreRole.roleId)) {
      projectionNotReady(
        `The native Chromium surface for ${coreRole.roleId} is not live at Core's revision.`
      );
    }
  }

  for (const workspace of coreWorkspaces.values()) {
    const tab = coreTabs.get(workspace.tabId);
    if (
      !tab ||
      tab.tabType !== "workspace" ||
      tab.workspaceId !== workspace.workspaceId ||
      tab.windowId !== workspace.windowId ||
      tab.name !== workspace.name ||
      !sameOrder(tab.slots.map((slot) => slot.roleId), workspace.roleIds)
    ) {
      projectionNotReady(
        `Core reported a workspace without an exact runtime tab: ${workspace.workspaceId}.`
      );
    }
  }

  const roleNames = new Map(snapshot.state.roles.map((role) => [role.id, role.name]));
  const tabs = runtime.tabs.map((tab) => {
    const nativeTab = nativeTabs.get(tab.id)!;
    const active = nativeWindows.get(tab.windowId)!.activeTabId === tab.id;
    const roleIds = tab.slots.map((slot) => slot.roleId);
    return {
      id: tab.id,
      type: tab.tabType,
      sourceId: tab.sourceId,
      name: tab.name,
      windowId: tab.windowId,
      roleIds,
      roleNames: roleIds.flatMap((roleId) => {
        const name = roleNames.get(roleId);
        return name === undefined ? [] : [name];
      }),
      slots: tab.slots,
      hidden: tab.hidden,
      active,
      audible: nativeTab.audible,
      audioMuted: nativeTab.audioMuted
    };
  });
  const windows = runtime.windows.map((window) => {
    const nativeWindow = nativeWindows.get(window.windowId)!;
    return {
      id: window.windowId,
      windowId: window.windowId,
      displayId: nativeWindow.displayId,
      bounds: nativeWindow.bounds,
      visible: nativeWindow.visible,
      focused: nativeWindow.focused,
      ...(nativeWindow.activeTabId.length === 0
        ? {}
        : { activeTabId: nativeWindow.activeTabId }),
      tabCount: nativeWindow.tabIds.length,
      presentation: nativeWindow.presentation
    };
  });
  const savedWindows = projectSavedRuntimeWindows(snapshot, displayTopology);
  const recovery = projectRuntimeRecovery(snapshot, savedWindows);
  return {
    revision: snapshot.runtimeRevision,
    capturedAt,
    windows,
    tabs,
    ...(savedWindows.length === 0 ? {} : { savedWindows }),
    ...(recovery === undefined ? {} : { recovery })
  };
}

export function projectElectronDisplayTopology(
  input: ElectronDisplayTopologyInput
): DisplayTopology {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new RionBridgeError({
      code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID",
      message: "The Electron display topology revision is invalid."
    });
  }
  if (input.displays.length === 0) {
    throw new RionBridgeError({
      code: "ELECTRON_DISPLAY_TOPOLOGY_UNAVAILABLE",
      message: "Electron did not report an available display."
    });
  }

  const displayIds = new Set<number>();
  const displays = input.displays.map((display) => {
    if (!Number.isSafeInteger(display.id) || displayIds.has(display.id)) {
      throw new RionBridgeError({
        code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID",
        message: "Electron reported an invalid or duplicate display identifier."
      });
    }
    displayIds.add(display.id);
    if (!Number.isFinite(display.scaleFactor) || display.scaleFactor <= 0) {
      throw new RionBridgeError({
        code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID",
        message: `Electron reported an invalid scale factor for display ${display.id}.`
      });
    }
    return {
      id: display.id,
      label: display.label.trim() || `Display ${display.id}`,
      bounds: {
        x: finiteInteger(display.bounds.x, "bounds.x"),
        y: finiteInteger(display.bounds.y, "bounds.y"),
        width: finiteInteger(display.bounds.width, "bounds.width"),
        height: finiteInteger(display.bounds.height, "bounds.height")
      },
      workArea: {
        x: finiteInteger(display.workArea.x, "workArea.x"),
        y: finiteInteger(display.workArea.y, "workArea.y"),
        width: finiteInteger(display.workArea.width, "workArea.width"),
        height: finiteInteger(display.workArea.height, "workArea.height")
      },
      resolution: {
        width: finiteInteger(display.size.width, "size.width"),
        height: finiteInteger(display.size.height, "size.height")
      },
      scaleFactor: display.scaleFactor,
      isPrimary: display.id === input.primaryDisplayId,
      isInternal: display.internal
    };
  }).sort((left, right) => left.id - right.id);

  if (!displayIds.has(input.primaryDisplayId)) {
    throw new RionBridgeError({
      code: "ELECTRON_DISPLAY_TOPOLOGY_INVALID",
      message: "Electron's primary display is absent from the display inventory."
    });
  }

  return {
    revision: input.revision,
    capturedAt: input.capturedAt,
    cause: input.cause,
    primaryDisplayId: String(input.primaryDisplayId),
    displays
  };
}

export function projectCoreAppSnapshot(
  snapshot: CoreAppSnapshotRecord,
  nativeRuntime: ChromiumRuntimeExecutorSnapshot,
  displayTopology: DisplayTopology,
  capturedAt: string
): AppSnapshot {
  return {
    revision: snapshot.revision,
    stateRevision: snapshot.stateRevision,
    runtimeRevision: snapshot.runtimeRevision,
    embeddedRuntimeState: projectOwnedRuntime(
      snapshot,
      nativeRuntime,
      displayTopology,
      capturedAt
    ),
    games: snapshot.state.games,
    gameWindows: snapshot.state.gameWindows,
    roles: snapshot.state.roles,
    roleStatuses: snapshot.roleStatuses,
    launchWorkspaces: snapshot.state.launchWorkspaces,
    displayTopology,
    macros: snapshot.state.macros,
    macroStatuses: snapshot.macroStatuses.map(normalizeMacroStatus),
    quickAccessPreferences: snapshot.state.quickAccessPreferences ?? {
      pinnedItems: [],
      recentItems: []
    }
  };
}
