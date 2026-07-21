import { EventEmitter } from "node:events";

import {
  BrowserLoginCancelledError,
  type BrowserLaunchOptions,
  type BrowserManager
} from "../browser/BrowserManager";
import {
  ImportedChromeProfileLoginCancelledError,
  ImportedChromeProfileLoginRetryableError,
  type ImportedChromeProfileLoginVerifier
} from "../browser/ImportedChromeProfileLoginVerifier";
import type { RoleStore } from "../roles/RoleStore";
import type { AuthFlowStatus, AuthState, Role } from "../../shared/types";

export interface AuthManagerEvents {
  change: [AuthFlowStatus[]];
  result: [Role, AuthState];
}

interface AuthManagerOptions {
  importedChromeProfileLoginVerifier?: Pick<
    ImportedChromeProfileLoginVerifier,
    "complete" | "hasPendingVerification" | "verify"
  >;
}

export class AuthManager extends EventEmitter<AuthManagerEvents> {
  private readonly flows = new Map<string, AuthFlowStatus>();

  constructor(
    private readonly roleStore: Pick<RoleStore, "updateAuthState">,
    private readonly browserManager: Pick<
      BrowserManager,
      "startLogin" | "waitForAuthentication"
    >,
    private readonly options: AuthManagerOptions = {}
  ) {
    super();
  }

  listStatuses(): AuthFlowStatus[] {
    return [...this.flows.values()];
  }

  startLogin(role: Role, options: BrowserLaunchOptions = {}): AuthFlowStatus {
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
    void this.runLoginFlow(role, options);
    return status;
  }

  private async runLoginFlow(role: Role, options: BrowserLaunchOptions): Promise<void> {
    try {
      const importedChromeProfileLoginVerifier = this.options.importedChromeProfileLoginVerifier;
      const usesImportedChromeProfile = importedChromeProfileLoginVerifier
        ? await importedChromeProfileLoginVerifier.hasPendingVerification(role.id)
        : false;
      if (usesImportedChromeProfile) {
        this.setStatus(
          role.id,
          "opening_chrome",
          "Complete account login and enter the game in the external Chrome window."
        );
        await importedChromeProfileLoginVerifier!.verify(role);
        this.setStatus(role.id, "checking_session", "Opening the embedded game session.");
      }
      const browserLaunchOptions = usesImportedChromeProfile
        ? { ...options, forceLaunchUrl: true }
        : options;
      await (Object.keys(browserLaunchOptions).length > 0
        ? this.browserManager.startLogin(role, browserLaunchOptions)
        : this.browserManager.startLogin(role));
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

      if (usesImportedChromeProfile) {
        await importedChromeProfileLoginVerifier!.complete(role.id).catch(() => undefined);
      }

      this.setStatus(role.id, "launching", "Login confirmed. Opening the game.");
      this.flows.delete(role.id);
      this.emitChange();
    } catch (error) {
      if (error instanceof BrowserLoginCancelledError ||
        error instanceof ImportedChromeProfileLoginCancelledError) {
        this.flows.delete(role.id);
        this.emitChange();
        return;
      }

      if (error instanceof ImportedChromeProfileLoginRetryableError) {
        this.setStatus(role.id, "failed", error.message);
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
