import type { MenuItemConstructorOptions } from "electron";

import type { AuthFlowStatus, AuthState, Role, RoleStatus } from "../../shared/types";

export interface DockRoleMenuState {
  roles: Role[];
  statuses: RoleStatus[];
  authStatuses: AuthFlowStatus[];
  legalAccepted: boolean;
}

export interface DockRoleMenuActions {
  openApp: () => void;
  launchRole: (roleId: string) => void;
  startLogin: (roleId: string) => void;
  stopAll: () => void;
}

export function buildDockRoleMenuTemplate(
  state: DockRoleMenuState,
  actions: DockRoleMenuActions
): MenuItemConstructorOptions[] {
  const statusByRole = new Map(state.statuses.map((status) => [status.roleId, status]));
  const authStatusByRole = new Map(state.authStatuses.map((status) => [status.roleId, status]));
  const hasRunningRoles = state.statuses.length > 0;

  const template: MenuItemConstructorOptions[] = [
    {
      label: "Open Rion Studio",
      click: () => {
        actions.openApp();
      }
    },
    { type: "separator" },
    ...(!state.legalAccepted
      ? [
          {
            label: "Review terms in Rion Studio",
            sublabel: "Required before login or launch",
            click: () => {
              actions.openApp();
            }
          } satisfies MenuItemConstructorOptions,
          { type: "separator" as const }
        ]
      : []),
    {
      label: "Roles",
      submenu:
        state.roles.length === 0
          ? [
              {
                label: "No Roles",
                enabled: false
              }
            ]
          : state.roles.map((role) =>
              buildRoleMenuItem(
                role,
                statusByRole.get(role.id),
                authStatusByRole.get(role.id),
                actions,
                state.legalAccepted
              )
            )
    }
  ];

  if (hasRunningRoles) {
    template.push(
      { type: "separator" },
      {
        label: "Stop All Running Roles",
        click: () => {
          actions.stopAll();
        }
      }
    );
  }

  return template;
}

function buildRoleMenuItem(
  role: Role,
  status: RoleStatus | undefined,
  authStatus: AuthFlowStatus | undefined,
  actions: DockRoleMenuActions,
  legalAccepted: boolean
): MenuItemConstructorOptions {
  const isAuthFlowBusy = authStatus !== undefined && authStatus.state !== "failed";
  const isBusy = status?.state === "launching" || status?.state === "stopping" || isAuthFlowBusy;
  const isRunning = status?.state === "running";
  const shouldLaunch = role.authState === "authenticated";

  return {
    label: role.name,
    type: status ? "checkbox" : "normal",
    checked: isRunning,
    enabled: legalAccepted && (!isBusy || isRunning),
    sublabel: !legalAccepted
      ? "Review terms in app"
      : authStatus
        ? getAuthFlowLabel(authStatus.state)
        : status
          ? getRunStateLabel(status.state)
          : getAuthStateLabel(role.authState),
    click: () => {
      if (shouldLaunch) {
        actions.launchRole(role.id);
        return;
      }

      actions.startLogin(role.id);
    }
  };
}

function getRunStateLabel(state: RoleStatus["state"]): string {
  switch (state) {
    case "launching":
      return "Launching";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
  }
}

function getAuthFlowLabel(state: AuthFlowStatus["state"]): string {
  switch (state) {
    case "opening_app":
      return "Opening game view";
    case "opening_chrome":
      return "Opening Chrome";
    case "waiting_for_login":
      return "Waiting for login";
    case "closing_login_window":
      return "Closing login window";
    case "waiting_for_chrome_close":
      return "Waiting for Chrome";
    case "waiting_for_user_data_release":
      return "Waiting for browser data";
    case "checking_session":
      return "Checking login";
    case "launching":
      return "Launching";
    case "failed":
      return "Login failed";
  }
}

function getAuthStateLabel(state: AuthState): string | undefined {
  switch (state) {
    case "authenticated":
      return undefined;
    case "login_required":
      return "Login required";
    case "auth_failed":
      return "Login failed";
    case "unknown":
      return "Login status unknown";
  }
}
