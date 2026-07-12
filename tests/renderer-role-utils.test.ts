import { describe, expect, it } from "vitest";

import {
  createRoleStats,
  mergeAuthStatus,
  mergeStatus,
  mergeStatuses,
  shouldShowLoginGuidance
} from "../src/renderer/src/app/statusUtils";
import type { AuthFlowState, AuthFlowStatus, Role, RoleStatus } from "../src/shared/types";

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
});

function role(overrides: Partial<Role>): Role {
  return {
    id: "role",
    name: "Role",
    launchUrl: "https://example.test/play",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    launchPreset: "performance",
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
