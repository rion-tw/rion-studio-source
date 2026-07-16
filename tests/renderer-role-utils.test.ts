import { describe, expect, it } from "vitest";

import {
  createRoleStats,
  mergeAuthStatus,
  mergeStatus,
  mergeStatuses,
  shouldShowLoginGuidance,
  shouldShowUpdateBadge
} from "../src/renderer/src/app/statusUtils";
import type { AppUpdateState, AppUpdateStatus, AuthFlowState, AuthFlowStatus, Role, RoleStatus } from "../src/shared/types";

describe("renderer role status helpers", () => {
  it("summarizes role state from roles, process statuses, and auth statuses", () => {
    expect(
      createRoleStats(
        [
          role({ id: "p1", authState: "authenticated" }),
          role({ id: "p2", authState: "login_required" }),
          role({ id: "p3", authState: "auth_failed" })
        ],
        [
          { roleId: "p1", state: "running" },
          { roleId: "missing", state: "running" }
        ],
        [
          authStatus({ roleId: "p2", state: "failed" }),
          authStatus({ roleId: "p1", state: "waiting_for_login" })
        ]
      )
    ).toEqual({
      total: 3,
      running: 1,
      stopped: 2,
      needsLogin: 2,
      authFailed: 2
    });
  });

  it("replaces matching role statuses while preserving unrelated statuses", () => {
    const current: RoleStatus[] = [
      { roleId: "p1", state: "running" },
      { roleId: "p2", state: "launching" }
    ];

    expect(mergeStatus(current, { roleId: "p1", state: "stopping" })).toEqual([
      { roleId: "p2", state: "launching" },
      { roleId: "p1", state: "stopping" }
    ]);
  });

  it("merges batches of role statuses in order", () => {
    expect(
      mergeStatuses(
        [{ roleId: "p1", state: "running" }],
        [
          { roleId: "p2", state: "launching" },
          { roleId: "p1", state: "stopping" }
        ]
      )
    ).toEqual([
      { roleId: "p2", state: "launching" },
      { roleId: "p1", state: "stopping" }
    ]);
  });

  it("replaces matching auth flow statuses", () => {
    expect(
      mergeAuthStatus(
        [
          authStatus({ roleId: "p1", state: "waiting_for_login" }),
          authStatus({ roleId: "p2", state: "checking_session" })
        ],
        authStatus({ roleId: "p1", state: "failed", message: "Login failed" })
      )
    ).toEqual([
      authStatus({ roleId: "p2", state: "checking_session" }),
      authStatus({ roleId: "p1", state: "failed", message: "Login failed" })
    ]);
  });

  it("shows persistent login guidance for every active auth state and hides it after failure", () => {
    const activeStates: AuthFlowState[] = [
      "opening_chrome",
      "waiting_for_login",
      "closing_login_window",
      "waiting_for_chrome_close",
      "waiting_for_user_data_release",
      "checking_session",
      "launching"
    ];

    for (const state of activeStates) {
      expect(shouldShowLoginGuidance(authStatus({ state }))).toBe(true);
    }

    expect(shouldShowLoginGuidance(authStatus({ state: "failed" }))).toBe(false);
    expect(shouldShowLoginGuidance(undefined)).toBe(false);
  });

  it("shows the update badge only when an update needs user action", () => {
    const inactiveStates: AppUpdateState[] = ["idle", "checking", "downloading", "not_available", "error"];

    expect(shouldShowUpdateBadge(null)).toBe(false);

    for (const state of inactiveStates) {
      expect(shouldShowUpdateBadge(updateStatus({ state }))).toBe(false);
    }

    expect(shouldShowUpdateBadge(updateStatus({ installMode: "manual", state: "available" }))).toBe(false);
    expect(
      shouldShowUpdateBadge(
        updateStatus({
          downloadUrl: "https://example.test/Rion-Studio.dmg",
          installMode: "manual",
          state: "available"
        })
      )
    ).toBe(true);
    expect(
      shouldShowUpdateBadge(
        updateStatus({
          installMode: "manual",
          releasePageUrl: "https://example.test/releases/v1",
          state: "available"
        })
      )
    ).toBe(true);
    expect(shouldShowUpdateBadge(updateStatus({ installMode: "automatic", state: "downloaded" }))).toBe(true);
  });
});

function role(overrides: Partial<Role>): Role {
  return {
    id: "role",
    gameId: "game-1",
    name: "Role",
    launchUrl: "https://example.test/play",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    authState: "unknown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function authStatus(overrides: Partial<AuthFlowStatus>): AuthFlowStatus {
  return {
    roleId: "role",
    state: "waiting_for_login",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function updateStatus(overrides: Partial<AppUpdateStatus>): AppUpdateStatus {
  return {
    currentVersion: "1.0.0",
    installMode: "automatic",
    isPackaged: true,
    state: "idle",
    ...overrides
  };
}
