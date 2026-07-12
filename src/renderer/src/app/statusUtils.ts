import type { AuthFlowStatus, Role, RoleStatus } from "../../../shared/types";
import type { Translator } from "../i18n";
import type { AppStats } from "./types";

export function createRoleStats(
  roles: Role[],
  statuses: RoleStatus[],
  authStatuses: AuthFlowStatus[]
): AppStats {
  const roleIds = new Set(roles.map((role) => role.id));
  const runningIds = new Set(
    statuses.filter((status) => roleIds.has(status.roleId)).map((status) => status.roleId)
  );
  const failedAuthIds = new Set(
    authStatuses.filter((status) => status.state === "failed").map((status) => status.roleId)
  );

  for (const role of roles) {
    if (role.authState === "auth_failed") {
      failedAuthIds.add(role.id);
    }
  }

  return {
    total: roles.length,
    running: runningIds.size,
    stopped: roles.filter((role) => !runningIds.has(role.id)).length,
    needsLogin: roles.filter((role) => role.authState !== "authenticated").length,
    authFailed: failedAuthIds.size
  };
}

export function mergeStatus(statuses: RoleStatus[], nextStatus: RoleStatus): RoleStatus[] {
  const filtered = statuses.filter((status) => status.roleId !== nextStatus.roleId);
  return [...filtered, nextStatus];
}

export function mergeStatuses(statuses: RoleStatus[], nextStatuses: RoleStatus[]): RoleStatus[] {
  return nextStatuses.reduce((current, status) => mergeStatus(current, status), statuses);
}

export function mergeAuthStatus(statuses: AuthFlowStatus[], nextStatus: AuthFlowStatus): AuthFlowStatus[] {
  const filtered = statuses.filter((status) => status.roleId !== nextStatus.roleId);
  return [...filtered, nextStatus];
}

export function shouldShowLoginGuidance(status: AuthFlowStatus | undefined): status is AuthFlowStatus {
  return status !== undefined && status.state !== "failed";
}

export function formatAuthFlowState(status: AuthFlowStatus, t: Translator): string {
  switch (status.state) {
    case "opening_app":
      return t("auth.openingApp");
    case "opening_chrome":
      return t("auth.openingChrome");
    case "waiting_for_login":
      return t("auth.waitingForLogin");
    case "closing_login_window":
      return t("auth.closingLoginWindow");
    case "waiting_for_chrome_close":
      return t("auth.waitingForChromeClose");
    case "waiting_for_user_data_release":
      return t("auth.waitingForUserDataRelease");
    case "checking_session":
      return t("auth.checkingSession");
    case "launching":
      return t("auth.launching");
    case "failed":
      return t("auth.failed");
  }
}
