import { EventEmitter } from "node:events";

import { BrowserLoginCancelledError, type BrowserManager } from "../browser/BrowserManager";
import type { RoleStore } from "../roles/RoleStore";
import type { AuthFlowStatus, AuthState, Role } from "../../shared/types";

export interface AuthManagerEvents {
  change: [AuthFlowStatus[]];
  result: [Role, AuthState];
}

export class AuthManager extends EventEmitter<AuthManagerEvents> {
  private readonly flows = new Map<string, AuthFlowStatus>();

  constructor(
    private readonly roleStore: Pick<RoleStore, "updateAuthState">,
    private readonly browserManager: Pick<
      BrowserManager,
      "startLogin" | "waitForAuthentication"
    >
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
      state: "opening_app",
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
      await this.browserManager.startLogin(role);
      this.setStatus(
        role.id,
        "waiting_for_login",
        "Complete account login and enter the game in the Rion Studio game view."
      );
      const result = await this.browserManager.waitForAuthentication(role.id);
      this.setStatus(role.id, "checking_session", "Checking embedded login session.");
      await this.roleStore.updateAuthState(role.id, result.authState);
      this.emit("result", role, result.authState);

      if (result.authState !== "authenticated") {
        this.setStatus(role.id, "failed", result.message ?? "Login is still required.");
        return;
      }

      this.setStatus(role.id, "launching", "Login confirmed. Opening the game.");
      this.flows.delete(role.id);
      this.emitChange();
    } catch (error) {
      if (error instanceof BrowserLoginCancelledError) {
        this.flows.delete(role.id);
        this.emitChange();
        return;
      }

      await this.roleStore.updateAuthState(role.id, "auth_failed").catch(() => undefined);
      this.emit("result", role, "auth_failed");
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

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected embedded auth flow error.";
}
