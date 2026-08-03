import type { AppUpdateStatus, Role, RoleStatus } from "../../../shared/types";
import type { AppStats } from "./types";

export function createRoleStats(
  roles: Role[],
  statuses: RoleStatus[]
): AppStats {
  const roleIds = new Set(roles.map((role) => role.id));
  const runningIds = new Set(
    statuses.filter((status) => roleIds.has(status.roleId)).map((status) => status.roleId)
  );
  return {
    total: roles.length,
    running: runningIds.size,
    stopped: roles.filter((role) => !runningIds.has(role.id)).length,
  };
}

export function mergeStatus(statuses: RoleStatus[], nextStatus: RoleStatus): RoleStatus[] {
  const filtered = statuses.filter((status) => status.roleId !== nextStatus.roleId);
  return [...filtered, nextStatus];
}

export function mergeStatuses(statuses: RoleStatus[], nextStatuses: RoleStatus[]): RoleStatus[] {
  return nextStatuses.reduce((current, status) => mergeStatus(current, status), statuses);
}

export function shouldShowUpdateBadge(status: AppUpdateStatus | null): boolean {
  if (!status) {
    return false;
  }

  if (status.state === "downloaded" || status.state === "install_failed") {
    return true;
  }

  return status.installMode === "manual" && status.state === "available" && Boolean(status.downloadUrl ?? status.releasePageUrl);
}
