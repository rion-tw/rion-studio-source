import type { MenuItemConstructorOptions } from "electron";

import type {
  EmbeddedRuntimeWindowSummary,
  LaunchWorkspace,
  Role,
  RoleStatus,
  SavedEmbeddedRuntimeWindowSummary,
  WorkspaceDisplayInfo
} from "../../shared/types";
import type { BrowserWorkspaceRuntimeStatus } from "../browser/ElectronBrowserRuntime";

export interface AppQuickMenuState {
  includeQuit: boolean;
  legalAccepted: boolean;
  platform: NodeJS.Platform;
  roles: Role[];
  runtimeWindows: EmbeddedRuntimeWindowSummary[];
  savedWindows: SavedEmbeddedRuntimeWindowSummary[];
  statuses: RoleStatus[];
  systemVersion?: string;
  workspaceDisplays: WorkspaceDisplayInfo[];
  workspaces: LaunchWorkspace[];
  workspaceStatuses: BrowserWorkspaceRuntimeStatus[];
}

export interface AppQuickMenuActions {
  launchRole: (roleId: string) => void;
  launchWorkspace: (workspaceId: string) => void;
  openApp: () => void;
  showAllGameWindows: () => void;
  showGameWindow: (displayId: number) => void;
  restoreGameWindow: (windowId: string) => void;
  quitApp?: () => void;
  stopAll: () => void;
  stopWorkspace: (workspaceId: string) => void;
}

export function buildAppQuickMenuTemplate(
  state: AppQuickMenuState,
  actions: AppQuickMenuActions
): MenuItemConstructorOptions[] {
  const statusByRole = new Map(state.statuses.map((status) => [status.roleId, status]));
  const roleById = new Map(state.roles.map((role) => [role.id, role]));
  const workspaceStatusById = new Map(
    state.workspaceStatuses.map((status) => [status.workspaceId, status])
  );
  const displayLabelById = new Map(
    state.workspaceDisplays.map((display) => [display.id, display.label.trim()])
  );
  const gameWindowItems = state.runtimeWindows.length > 0 || state.savedWindows.length > 0
    ? [
        buildGameWindowsHeader(state.platform, state.systemVersion),
        ...state.runtimeWindows.map((window) => {
          const displayLabel = displayLabelById.get(window.displayId) || `Display ${window.displayId}`;
          return {
            label: `${displayLabel} · ${window.tabCount} tab${window.tabCount === 1 ? "" : "s"}`,
            sublabel: window.visible ? "Visible" : "Hidden",
            click: () => actions.showGameWindow(window.displayId)
          };
        }),
        ...state.savedWindows.map((window) => ({
          label: `${window.displayLabel} · ${window.tabCount} tab${window.tabCount === 1 ? "" : "s"}`,
          sublabel: !state.legalAccepted
            ? "Review terms in app"
            : window.state === "restoring"
              ? "Restoring"
              : window.state === "failed"
                ? "Restore failed"
                : "Saved",
          enabled: window.state !== "restoring",
          click: () => {
            if (state.legalAccepted) actions.restoreGameWindow(window.id);
            else actions.openApp();
          }
        })),
        { type: "separator" as const }
      ]
    : [];
  const template: MenuItemConstructorOptions[] = [
    ...gameWindowItems,
    ...(!state.legalAccepted
      ? [
          {
            label: "Review terms in Rion Studio",
            sublabel: "Required before launch",
            click: actions.openApp
          } satisfies MenuItemConstructorOptions,
          { type: "separator" as const }
        ]
      : []),
    {
      label: "Roles",
      submenu:
        state.roles.length === 0
          ? [{ label: "No Roles", enabled: false }]
          : state.roles.map((role) =>
              buildRoleMenuItem(
                role,
                statusByRole.get(role.id),
                actions,
                state.legalAccepted
              )
            )
    },
    {
      label: "Workspaces",
      submenu:
        state.workspaces.length === 0
          ? [{ label: "No Workspaces", enabled: false }]
          : state.workspaces.map((workspace) =>
              buildWorkspaceMenuItem(
                workspace,
                workspaceStatusById.get(workspace.id),
                roleById,
                actions,
                state.legalAccepted
              )
            )
    }
  ];

  if (
    state.runtimeWindows.length > 0 ||
    state.savedWindows.length > 0 ||
    state.statuses.length > 0
  ) {
    template.push(
      { type: "separator" },
      ...(state.runtimeWindows.length > 0 || state.savedWindows.length > 0
          ? [{
            label: "Show All Game Windows",
            click: state.legalAccepted ? actions.showAllGameWindows : actions.openApp
          }]
        : []),
      ...(state.statuses.length > 0
        ? [{
            label: "Stop All Running Roles",
            click: actions.stopAll
          }]
        : [])
    );
  }

  if (state.includeQuit) {
    template.push(
      { type: "separator" },
      {
        label: "Quit Rion Studio",
        click: actions.quitApp
      }
    );
  }

  return template;
}

function buildGameWindowsHeader(
  platform: NodeJS.Platform,
  systemVersion: string | undefined
): MenuItemConstructorOptions {
  if (supportsNativeMenuHeaders(platform, systemVersion)) {
    return {
      label: "Game Windows",
      type: "header"
    };
  }

  return {
    label: "Game Windows",
    enabled: false
  };
}

function supportsNativeMenuHeaders(
  platform: NodeJS.Platform,
  systemVersion: string | undefined
): boolean {
  if (platform !== "darwin" || !systemVersion) return false;
  const majorVersion = Number.parseInt(systemVersion.split(".")[0], 10);
  return Number.isFinite(majorVersion) && majorVersion >= 14;
}

function buildWorkspaceMenuItem(
  workspace: LaunchWorkspace,
  runtimeStatus: BrowserWorkspaceRuntimeStatus | undefined,
  roleById: ReadonlyMap<string, Role>,
  actions: AppQuickMenuActions,
  legalAccepted: boolean
): MenuItemConstructorOptions {
  const assignedRoleIds = workspace.slots.flatMap((slot) => slot.roleId ? [slot.roleId] : []);
  const assignedRoles = assignedRoleIds.map((roleId) => roleById.get(roleId));
  const hasMissingRole = assignedRoles.some((role) => role === undefined);
  const isRunning = runtimeStatus?.state === "running";
  const isBusy = runtimeStatus?.state === "launching" || runtimeStatus?.state === "stopping";
  const enabled = legalAccepted && (
    isRunning || (
      !isBusy &&
      assignedRoleIds.length > 0 &&
      !hasMissingRole
    )
  );

  return {
    label: workspace.name,
    type: runtimeStatus ? "checkbox" : "normal",
    checked: isRunning,
    enabled,
    sublabel: getWorkspaceStateLabel({
      assignedRoleIds,
      hasMissingRole,
      legalAccepted,
      runtimeStatus
    }),
    click: () => {
      if (isRunning) {
        actions.stopWorkspace(workspace.id);
        return;
      }
      actions.launchWorkspace(workspace.id);
    }
  };
}

function getWorkspaceStateLabel({
  assignedRoleIds,
  hasMissingRole,
  legalAccepted,
  runtimeStatus
}: {
  assignedRoleIds: string[];
  hasMissingRole: boolean;
  legalAccepted: boolean;
  runtimeStatus: BrowserWorkspaceRuntimeStatus | undefined;
}): string | undefined {
  if (!legalAccepted) return "Review terms in app";
  if (runtimeStatus?.state === "launching") return "Launching";
  if (runtimeStatus?.state === "running") return "Running";
  if (runtimeStatus?.state === "stopping") return "Stopping";
  if (assignedRoleIds.length === 0) return "No assigned roles";
  if (hasMissingRole) return "Assigned role unavailable";
  return undefined;
}

function buildRoleMenuItem(
  role: Role,
  status: RoleStatus | undefined,
  actions: AppQuickMenuActions,
  legalAccepted: boolean
): MenuItemConstructorOptions {
  const isBusy = status?.state === "launching" || status?.state === "stopping";
  const isRunning = status?.state === "running";

  return {
    label: role.name,
    type: status ? "checkbox" : "normal",
    checked: isRunning,
    enabled: legalAccepted && (!isBusy || isRunning),
    sublabel: !legalAccepted ? "Review terms in app" : status ? getRunStateLabel(status.state) : undefined,
    click: () => {
      actions.launchRole(role.id);
    }
  };
}

function getRunStateLabel(state: RoleStatus["state"]): string {
  switch (state) {
    case "launching": return "Launching";
    case "running": return "Running";
    case "stopping": return "Stopping";
  }
}
