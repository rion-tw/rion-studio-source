import type {
  AuthFlowStatus,
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus
} from "../../../../shared/types";

export interface DashboardSummary {
  rolesNeedingLogin: number;
  runningMacros: number;
  runningRoles: number;
  totalMacros: number;
  totalRoles: number;
  workspaceCount: number;
}

export interface DashboardSummaryInput {
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  roleStatuses: RoleStatus[];
  roles: Role[];
  workspaces: LaunchWorkspace[];
}

export interface DashboardRoleItem {
  action: DashboardRoleActionState;
  authStatus?: AuthFlowStatus;
  role: Role;
  status?: RoleStatus;
}

export type DashboardRoleActionKind = "launch" | "login" | "stop";

export interface DashboardRoleActionState {
  disabled: boolean;
  isBusy: boolean;
  kind: DashboardRoleActionKind;
}

export type DashboardPendingAuthKind = "authFailed" | "authFlow" | "loginRequired";

export interface DashboardPendingAuthItem extends DashboardRoleItem {
  pendingKind: DashboardPendingAuthKind;
}

export interface DashboardWorkspaceItem {
  action: DashboardWorkspaceActionState;
  assignedCount: number;
  runningCount: number;
  workspace: LaunchWorkspace;
}

export type DashboardWorkspaceActionKind = "launch" | "stop";

export interface DashboardWorkspaceActionState {
  disabled: boolean;
  isBusy: boolean;
  kind: DashboardWorkspaceActionKind;
}

export interface DashboardMacroItem {
  action: DashboardMacroActionState;
  assignedCount: number;
  macro: Macro;
  runningCount: number;
}

export type DashboardMacroActionKind = "start" | "stop";

export interface DashboardMacroActionState {
  disabled: boolean;
  disabledReason?: "noRoles" | "rolesNotRunning";
  isBusy: boolean;
  isRunning: boolean;
  kind: DashboardMacroActionKind;
}

export function createDashboardSummary({
  macroStatuses,
  macros,
  roleStatuses,
  roles,
  workspaces
}: DashboardSummaryInput): DashboardSummary {
  const roleIds = new Set(roles.map((role) => role.id));
  const macroIds = new Set(macros.map((macro) => macro.id));
  const runningRoleIds = new Set(
    roleStatuses.filter((status) => roleIds.has(status.roleId)).map((status) => status.roleId)
  );
  const runningMacroIds = new Set(
    macroStatuses
      .filter(
        (status) => status.state === "running" && roleIds.has(status.roleId) && macroIds.has(status.macroId)
      )
      .map((status) => status.macroId)
  );

  return {
    rolesNeedingLogin: roles.filter((role) => role.authState !== "authenticated").length,
    runningMacros: runningMacroIds.size,
    runningRoles: runningRoleIds.size,
    totalMacros: macros.length,
    totalRoles: roles.length,
    workspaceCount: workspaces.length
  };
}

export function getDashboardRoleItems({
  authStatusByRole,
  busyRoleId,
  roles,
  statusByRole
}: {
  authStatusByRole: Map<string, AuthFlowStatus>;
  busyRoleId: string | null;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
}): DashboardRoleItem[] {
  return roles
    .map((role) => {
      const status = statusByRole.get(role.id);
      const authStatus = authStatusByRole.get(role.id);

      return {
        action: createRoleActionState({ authStatus, busyRoleId, role, status }),
        authStatus,
        role,
        status
      };
    })
    .sort(compareRoleItems);
}

export function getPendingAuthItems({
  authStatusByRole,
  busyRoleId,
  roles,
  statusByRole
}: {
  authStatusByRole: Map<string, AuthFlowStatus>;
  busyRoleId: string | null;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
}): DashboardPendingAuthItem[] {
  return getDashboardRoleItems({ authStatusByRole, busyRoleId, roles, statusByRole })
    .flatMap((item): DashboardPendingAuthItem[] => {
      const pendingKind = getPendingAuthKind(item.role, item.authStatus);
      return pendingKind ? [{ ...item, pendingKind }] : [];
    })
    .sort(comparePendingAuthItems);
}

export function createWorkspaceActionState({
  assignedCount,
  busyWorkspaceId,
  runningCount,
  workspaceId
}: {
  assignedCount: number;
  busyWorkspaceId: string | null;
  runningCount: number;
  workspaceId: string;
}): DashboardWorkspaceActionState {
  const isBusy = busyWorkspaceId === workspaceId;
  const isRunning = runningCount > 0;

  return {
    disabled: isBusy || (!isRunning && assignedCount === 0),
    isBusy,
    kind: isRunning ? "stop" : "launch"
  };
}

export function getDashboardWorkspaceItems({
  busyWorkspaceId,
  statusByRole,
  workspaces
}: {
  busyWorkspaceId: string | null;
  statusByRole: Map<string, RoleStatus>;
  workspaces: LaunchWorkspace[];
}): DashboardWorkspaceItem[] {
  return workspaces
    .map((workspace) => {
      const assignedRoleIds = workspace.slots.flatMap((slot) => (slot.roleId ? [slot.roleId] : []));
      const runningCount = assignedRoleIds.filter((roleId) => statusByRole.has(roleId)).length;

      return {
        action: createWorkspaceActionState({
          assignedCount: assignedRoleIds.length,
          busyWorkspaceId,
          runningCount,
          workspaceId: workspace.id
        }),
        assignedCount: assignedRoleIds.length,
        runningCount,
        workspace
      };
    })
    .sort((left, right) => compareIsoDesc(left.workspace.updatedAt, right.workspace.updatedAt));
}

export function createMacroActionState({
  busyMacroId,
  busyRunKey,
  macro,
  macroStatusByRun,
  roleIds,
  statusByRole
}: {
  busyMacroId: string | null;
  busyRunKey: string | null;
  macro: Macro;
  macroStatusByRun: Map<string, MacroRunStatus>;
  roleIds: Set<string>;
  statusByRole: Map<string, RoleStatus>;
}): DashboardMacroActionState {
  const assignedRunStatuses = macro.roleIds
    .map((roleId) => macroStatusByRun.get(createMacroRunKey(roleId, macro.id)))
    .filter((status): status is MacroRunStatus => Boolean(status));
  const isRunning = assignedRunStatuses.some((status) => status.state === "running");
  const isStopping = assignedRunStatuses.some((status) => status.state === "stopping");
  const hasRoles = macro.roleIds.length > 0;
  const areBrowsersRunning =
    hasRoles && macro.roleIds.every((roleId) => roleIds.has(roleId) && statusByRole.get(roleId)?.state === "running");
  const isBusy = busyRunKey === macro.id || busyMacroId === macro.id || isStopping;
  const disabledReason = !hasRoles ? "noRoles" : !areBrowsersRunning && !isRunning ? "rolesNotRunning" : undefined;

  return {
    disabled: isBusy || Boolean(disabledReason),
    disabledReason,
    isBusy,
    isRunning,
    kind: isRunning || isStopping ? "stop" : "start"
  };
}

export function getDashboardMacroItems({
  busyMacroId,
  busyRunKey,
  macroStatusByRun,
  macros,
  roles,
  statusByRole
}: {
  busyMacroId: string | null;
  busyRunKey: string | null;
  macroStatusByRun: Map<string, MacroRunStatus>;
  macros: Macro[];
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
}): DashboardMacroItem[] {
  const roleIds = new Set(roles.map((role) => role.id));

  return macros
    .map((macro) => {
      const runningCount = macro.roleIds.filter(
        (roleId) => macroStatusByRun.get(createMacroRunKey(roleId, macro.id))?.state === "running"
      ).length;

      return {
        action: createMacroActionState({
          busyMacroId,
          busyRunKey,
          macro,
          macroStatusByRun,
          roleIds,
          statusByRole
        }),
        assignedCount: macro.roleIds.length,
        macro,
        runningCount
      };
    })
    .sort(compareMacroItems);
}

function createRoleActionState({
  authStatus,
  busyRoleId,
  role,
  status
}: {
  authStatus?: AuthFlowStatus;
  busyRoleId: string | null;
  role: Role;
  status?: RoleStatus;
}): DashboardRoleActionState {
  const isAuthFlowRunning = Boolean(authStatus && authStatus.state !== "failed");
  const isStatusBusy = status?.state === "launching" || status?.state === "stopping";
  const isBusy = busyRoleId === role.id || isAuthFlowRunning || isStatusBusy;
  const kind: DashboardRoleActionKind = status ? "stop" : role.authState === "authenticated" ? "launch" : "login";

  return {
    disabled: isBusy,
    isBusy,
    kind
  };
}

function getPendingAuthKind(role: Role, authStatus: AuthFlowStatus | undefined): DashboardPendingAuthKind | null {
  if (authStatus && authStatus.state !== "failed") {
    return "authFlow";
  }

  if (authStatus?.state === "failed" || role.authState === "auth_failed") {
    return "authFailed";
  }

  if (role.authState !== "authenticated") {
    return "loginRequired";
  }

  return null;
}

function compareRoleItems(left: DashboardRoleItem, right: DashboardRoleItem): number {
  const rankDelta = getRoleSortRank(left) - getRoleSortRank(right);
  return rankDelta || compareIsoDesc(left.role.updatedAt, right.role.updatedAt);
}

function comparePendingAuthItems(left: DashboardPendingAuthItem, right: DashboardPendingAuthItem): number {
  const rankDelta = getPendingSortRank(left.pendingKind) - getPendingSortRank(right.pendingKind);
  return rankDelta || compareIsoDesc(left.role.updatedAt, right.role.updatedAt);
}

function compareMacroItems(left: DashboardMacroItem, right: DashboardMacroItem): number {
  if (left.action.isRunning !== right.action.isRunning) {
    return left.action.isRunning ? -1 : 1;
  }

  if (left.action.disabled !== right.action.disabled) {
    return left.action.disabled ? 1 : -1;
  }

  return compareIsoDesc(left.macro.updatedAt, right.macro.updatedAt);
}

function getRoleSortRank(item: DashboardRoleItem): number {
  if (item.status?.state === "running") {
    return 0;
  }

  if (item.status?.state === "launching") {
    return 1;
  }

  if (item.status?.state === "stopping") {
    return 2;
  }

  if (item.role.authState === "authenticated") {
    return 3;
  }

  return 4;
}

function getPendingSortRank(kind: DashboardPendingAuthKind): number {
  switch (kind) {
    case "authFlow":
      return 0;
    case "authFailed":
      return 1;
    case "loginRequired":
      return 2;
  }
}

function createMacroRunKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
}

function compareIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}
