import { EventEmitter } from "node:events";

import type { BrowserManager } from "../browser/BrowserManager";
import type { BrowserUserDataLockWatcher } from "../browser/BrowserUserDataLockWatcher";
import type { RoleStore } from "../roles/RoleStore";
import type { LoginWindowMonitorResult, SystemChromeLauncher } from "../system-browser/SystemChromeLauncher";
import type { AuthFlowStatus, Role } from "../../shared/types";
import type { AuthSessionChecker } from "./AuthSessionChecker";

export interface AuthManagerEvents {
  change: [AuthFlowStatus[]];
}

export class AuthManager extends EventEmitter<AuthManagerEvents> {
  private readonly flows = new Map<string, AuthFlowStatus>();

  constructor(
    private readonly roleStore: Pick<RoleStore, "updateAuthState">,
    private readonly browserManager: Pick<BrowserManager, "stop" | "launch">,
    private readonly systemChromeLauncher: Pick<SystemChromeLauncher, "openLoginWindow">,
    private readonly authSessionChecker: Pick<AuthSessionChecker, "check">,
    private readonly userDataLockWatcher: Pick<BrowserUserDataLockWatcher, "waitForRelease">
  ) {
    super();
  }

  listStatuses(): AuthFlowStatus[] {
    return [...this.flows.values()];
  }

  startLogin(role: Role): AuthFlowStatus {
    const existing = this.flows.get(role.id);

    if (existing && existing.state !== "failed") {
      return existing;
    }

    const now = new Date().toISOString();
    const status: AuthFlowStatus = {
      roleId: role.id,
      state: "opening_chrome",
      startedAt: now,
      updatedAt: now
    };

    this.flows.set(role.id, status);
    this.emitChange();
    void this.runLoginFlow(role);

    return status;
  }

  private async runLoginFlow(role: Role): Promise<void> {
    try {
      await this.browserManager.stop(role.id);
      const loginSession = await this.systemChromeLauncher.openLoginWindow(role);
      this.setStatus(
        role.id,
        "waiting_for_login",
        "Complete account login, select the target character, enter its game screen, then close Chrome."
      );
      const monitorResult = await loginSession.monitor;

      if (monitorResult.state === "login_completed") {
        this.setStatus(role.id, "closing_login_window", "Login detected. Closing Chrome login window.");
        await loginSession.close();
      } else {
        this.setStatus(role.id, "waiting_for_chrome_close", toManualCloseMessage(monitorResult));
        await loginSession.closed;
      }

      this.setStatus(role.id, "waiting_for_user_data_release", "Waiting for Chrome to fully close.");
      await this.userDataLockWatcher.waitForRelease(loginSession.userDataDir);

      this.setStatus(role.id, "checking_session", "Checking login session.");
      const result = await this.authSessionChecker.check(role);
      const updatedRole = await this.roleStore.updateAuthState(role.id, result.authState);

      if (result.authState !== "authenticated") {
        this.setStatus(role.id, "failed", result.message ?? "Login is still required.");
        return;
      }

      this.setStatus(role.id, "launching", "Login confirmed. Launching role.");
      await this.browserManager.launch(updatedRole);
      this.flows.delete(role.id);
      this.emitChange();
    } catch (error) {
      await this.roleStore.updateAuthState(role.id, "auth_failed").catch(() => undefined);
      this.setStatus(role.id, "failed", toMessage(error));
    }
  }

  private setStatus(roleId: string, state: AuthFlowStatus["state"], message?: string): void {
    const current = this.flows.get(roleId);
    const now = new Date().toISOString();

    this.flows.set(roleId, {
      roleId,
      state,
      message,
      startedAt: current?.startedAt ?? now,
      updatedAt: now
    });
    this.emitChange();
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }
}

function toManualCloseMessage(monitorResult: LoginWindowMonitorResult): string {
  if (monitorResult.state === "manual") {
    return monitorResult.message;
  }

  if ("message" in monitorResult) {
    return `Complete account login, select the target character, enter its game screen, then close Chrome. ${monitorResult.message}`;
  }

  return "Complete account login, select the target character, enter its game screen, then close Chrome.";
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected auth flow error.";
}
