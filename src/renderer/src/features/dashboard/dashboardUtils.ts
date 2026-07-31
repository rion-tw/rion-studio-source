import type {
  LaunchWorkspace,
  Macro,
  MacroRunStatus,
  Role,
  RoleStatus
} from "../../../../shared/types";
import { findUnassignedMacroDependency } from "../../../../shared/macroDependencies";

interface DashboardSummary {
  runningMacros: number;
  runningRoles: number;
  totalMacros: number;
  totalRoles: number;
  workspaceCount: number;
}

interface DashboardSummaryInput {
  macroStatuses: MacroRunStatus[];
  macros: Macro[];
  roleStatuses: RoleStatus[];
  roles: Role[];
  workspaces: LaunchWorkspace[];
}

export interface DashboardRoleItem {
  action: DashboardRoleActionState;
  role: Role;
  status?: RoleStatus;
}

type DashboardRoleActionKind = "launch" | "stop";

export interface DashboardRoleActionState {
  disabled: boolean;
  isBusy: boolean;
  kind: DashboardRoleActionKind;
}

export interface DashboardWorkspaceItem {
  action: DashboardWorkspaceActionState;
  assignedCount: number;
  runningCount: number;
  workspace: LaunchWorkspace;
}

type DashboardWorkspaceActionKind = "launch" | "stop";

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

type DashboardMacroActionKind = "start" | "stop";

export interface DashboardMacroActionState {
  disabled: boolean;
  disabledReason?:
    | "automationUnavailable"
    | "macroDisabled"
    | "noRoles"
    | "rolesNotRunning"
    | "unassignedDependency";
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
    runningMacros: runningMacroIds.size,
    runningRoles: runningRoleIds.size,
    totalMacros: macros.length,
    totalRoles: roles.length,
    workspaceCount: workspaces.length
  };
}

export function getDashboardRoleItems({
  busyRoleIds,
  roles,
  statusByRole
}: {
  busyRoleIds: ReadonlySet<string>;
  roles: Role[];
  statusByRole: Map<string, RoleStatus>;
}): DashboardRoleItem[] {
  return roles
    .map((role) => {
      const status = statusByRole.get(role.id);
      return {
        action: createRoleActionState({ busyRoleIds, role, status }),
        role,
        status
      };
    })
    .sort(compareRoleItems);
}

function createWorkspaceActionState({
  assignedCount,
  busyWorkspaceIds,
  runningCount,
  workspaceId
}: {
  assignedCount: number;
  busyWorkspaceIds: ReadonlySet<string>;
  runningCount: number;
  workspaceId: string;
}): DashboardWorkspaceActionState {
  const isBusy = busyWorkspaceIds.has(workspaceId);
  const isRunning = runningCount > 0;

  return {
    disabled: isBusy || (!isRunning && assignedCount === 0),
    isBusy,
    kind: isRunning ? "stop" : "launch"
  };
}

export function getDashboardWorkspaceItems({
  busyWorkspaceIds,
  statusByRole,
  workspaces
}: {
  busyWorkspaceIds: ReadonlySet<string>;
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
          busyWorkspaceIds,
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

function createMacroActionState({
  busyMacroIds,
  busyRunKeys,
  macro,
  macroStatusByRun,
  hasUnassignedDependency,
  roleIds,
  statusByRole
}: {
  busyMacroIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
  macro: Macro;
  macroStatusByRun: Map<string, MacroRunStatus>;
  hasUnassignedDependency: boolean;
  roleIds: Set<string>;
  statusByRole: Map<string, RoleStatus>;
}): DashboardMacroActionState {
  const assignedRunStatuses = macro.roleIds
    .map((roleId) => macroStatusByRun.get(createMacroRunKey(roleId, macro.id)))
    .filter((status): status is MacroRunStatus => Boolean(status));
  const isRunning = assignedRunStatuses.some((status) => status.state === "running");
  const isStopping = assignedRunStatuses.some((status) => status.state === "stopping");
  const hasRoles = macro.roleIds.length > 0;
  const hasRunningBrowser = macro.roleIds.some(
    (roleId) => roleIds.has(roleId) && statusByRole.get(roleId)?.state === "running"
  );
  const hasRunnableRole = macro.roleIds.some(
    (roleId) =>
      roleIds.has(roleId) &&
      statusByRole.get(roleId)?.state === "running" &&
      statusByRole.get(roleId)?.automationState !== "unavailable" &&
      statusByRole.get(roleId)?.pageHealth !== "unresponsive"
  );
  const isBusy = busyRunKeys.has(macro.id) || busyMacroIds.has(macro.id) || isStopping;
  const disabledReason = !isRunning && !hasRoles
    ? "noRoles"
    : !isRunning && hasUnassignedDependency
      ? "unassignedDependency"
    : !macro.enabled && !isRunning
      ? "macroDisabled"
    : !hasRunningBrowser && !isRunning
      ? "rolesNotRunning"
      : !hasRunnableRole && !isRunning
        ? "automationUnavailable"
        : undefined;

  return {
    disabled: isBusy || Boolean(disabledReason),
    disabledReason,
    isBusy,
    isRunning,
    kind: isRunning || isStopping ? "stop" : "start"
  };
}

export function getDashboardMacroItems({
  busyMacroIds,
  busyRunKeys,
  macroStatusByRun,
  macros,
  roles,
  statusByRole
}: {
  busyMacroIds: ReadonlySet<string>;
  busyRunKeys: ReadonlySet<string>;
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
          busyMacroIds,
          busyRunKeys,
          macro,
          macroStatusByRun,
          hasUnassignedDependency: Boolean(findUnassignedMacroDependency(macros, macro.id)),
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
  busyRoleIds,
  role,
  status
}: {
  busyRoleIds: ReadonlySet<string>;
  role: Role;
  status?: RoleStatus;
}): DashboardRoleActionState {
  const isStatusBusy = status?.state === "launching" || status?.state === "stopping";
  const isBusy = busyRoleIds.has(role.id) || isStatusBusy;
  const kind: DashboardRoleActionKind = status ? "stop" : "launch";

  return {
    disabled: isBusy,
    isBusy,
    kind
  };
}

function compareRoleItems(left: DashboardRoleItem, right: DashboardRoleItem): number {
  const rankDelta = getRoleSortRank(left) - getRoleSortRank(right);
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

  return 3;
}

function createMacroRunKey(roleId: string, macroId: string): string {
  return `${roleId}:${macroId}`;
}

function compareIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}
