// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationContext, type Confirm } from "../src/renderer/src/components/confirmation";
import { useRoleWorkflow } from "../src/renderer/src/hooks/useRoleWorkflow";
import type { Translator } from "../src/renderer/src/i18n";
import type { AuthFlowStatus, Macro, Role, RoleStatus } from "../src/shared/types";

afterEach(() => {
  Reflect.deleteProperty(window, "rionStudio");
});

describe("useRoleWorkflow", () => {
  it("preserves a macro while optimistically clearing a deleted role assignment", async () => {
    const selectedRole: Role = {
      id: "role-1",
      gameId: "game-1",
      name: "Main",
      launchUrl: "https://example.test/play",
      windowWidth: 1280,
      windowHeight: 720,
      notes: "",
      authState: "authenticated",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    let macros: Macro[] = [{
      id: "macro-1",
      enabled: true,
      name: "Heal",
      roleIds: [selectedRole.id],
      repeat: { type: "once" },
      steps: [{ id: "step-1", type: "key", code: "F2" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }];
    const deleteRoles = vi.fn().mockResolvedValue({ deletedIds: [selectedRole.id], skipped: [] });
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        deleteRoles,
        listAuthStatuses: vi.fn().mockRejectedValue(new Error("recovery unavailable")),
        listLaunchWorkspaces: vi.fn().mockResolvedValue([]),
        listMacros: vi.fn().mockResolvedValue([]),
        listRoles: vi.fn().mockResolvedValue([]),
        listRoleStatuses: vi.fn().mockResolvedValue([])
      }
    });
    const setMacros = vi.fn((update: Macro[] | ((current: Macro[]) => Macro[])) => {
      macros = typeof update === "function" ? update(macros) : update;
    });
    const { result } = renderHook(() => useRoleWorkflow({
      beginErrorOperation: () => vi.fn(),
      gameNamesById: new Map([["game-1", "Game"]]),
      roles: [selectedRole],
      setAuthStatuses: vi.fn(),
      setMacros,
      setRoles: vi.fn(),
      setStatuses: vi.fn(),
      setWorkspaces: vi.fn(),
      statusByRole: new Map(),
      t: ((key: string) => key) as Translator
    }), { wrapper: ConfirmationWrapper });

    await act(async () => {
      await result.current.handleDeleteMany([selectedRole]);
    });

    expect(deleteRoles).toHaveBeenCalledWith({ ids: [selectedRole.id] });
    expect(macros).toEqual([expect.objectContaining({ id: "macro-1", roleIds: [] })]);
  });

  it("describes the clear targets and leaves data untouched when cancelled", async () => {
    const selectedRole = role();
    const confirm = vi.fn().mockResolvedValue(false);
    const clearRoleBrowserData = vi.fn();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { clearRoleBrowserData }
    });
    const { result } = renderHook(() => useRoleWorkflow({
      beginErrorOperation: () => vi.fn(),
      gameNamesById: new Map(),
      roles: [selectedRole],
      setAuthStatuses: vi.fn(),
      setMacros: vi.fn(),
      setRoles: vi.fn(),
      setStatuses: vi.fn(),
      setWorkspaces: vi.fn(),
      statusByRole: new Map(),
      t: ((key: string) => key) as Translator
    }), { wrapper: createConfirmationWrapper(confirm) });

    await act(async () => {
      await expect(result.current.handleClearBrowserData(selectedRole)).resolves.toBe(false);
    });

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "confirm.clearRoleData.title",
      details: [
        "confirm.clearRoleData.target",
        "confirm.clearRoleData.stop",
        "confirm.clearRoleData.preserve"
      ],
      warning: "confirm.clearRoleData.warning",
      tone: "destructive"
    }));
    expect(clearRoleBrowserData).not.toHaveBeenCalled();
  });

  it("updates the role and removes runtime state after clearing browser data", async () => {
    const selectedRole = role();
    const updatedRole = { ...selectedRole, authState: "login_required" as const };
    let roles = [selectedRole];
    let statuses: RoleStatus[] = [{ roleId: selectedRole.id, state: "running" }];
    let authStatuses: AuthFlowStatus[] = [{
      roleId: selectedRole.id,
      state: "waiting_for_login",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }];
    const setNotice = vi.fn();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        clearRoleBrowserData: vi.fn().mockResolvedValue(updatedRole)
      }
    });
    const { result } = renderHook(() => useRoleWorkflow({
      beginErrorOperation: () => vi.fn(),
      gameNamesById: new Map(),
      roles,
      setAuthStatuses: applySetter((next) => { authStatuses = next; }, () => authStatuses),
      setMacros: vi.fn(),
      setNotice,
      setRoles: applySetter((next) => { roles = next; }, () => roles),
      setStatuses: applySetter((next) => { statuses = next; }, () => statuses),
      setWorkspaces: vi.fn(),
      statusByRole: new Map(statuses.map((status) => [status.roleId, status])),
      t: ((key: string) => key) as Translator
    }), { wrapper: ConfirmationWrapper });

    await act(async () => {
      await expect(result.current.handleClearBrowserData(selectedRole)).resolves.toBe(true);
    });

    expect(roles).toEqual([updatedRole]);
    expect(statuses).toEqual([]);
    expect(authStatuses).toEqual([]);
    expect(setNotice).toHaveBeenLastCalledWith("notice.roleBrowserDataCleared");
  });

  it("refreshes role and runtime state after a partial clear failure", async () => {
    const selectedRole = role();
    const recoveredRole = { ...selectedRole, authState: "login_required" as const };
    let roles = [selectedRole];
    let statuses: RoleStatus[] = [{ roleId: selectedRole.id, state: "running" }];
    let authStatuses: AuthFlowStatus[] = [];
    const clearError = new Error("clear failed");
    const reportError = vi.fn();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        clearRoleBrowserData: vi.fn().mockRejectedValue(clearError),
        listAuthStatuses: vi.fn().mockResolvedValue([]),
        listRoles: vi.fn().mockResolvedValue([recoveredRole]),
        listRoleStatuses: vi.fn().mockResolvedValue([])
      }
    });
    const { result } = renderHook(() => useRoleWorkflow({
      beginErrorOperation: () => reportError,
      gameNamesById: new Map(),
      roles,
      setAuthStatuses: applySetter((next) => { authStatuses = next; }, () => authStatuses),
      setMacros: vi.fn(),
      setRoles: applySetter((next) => { roles = next; }, () => roles),
      setStatuses: applySetter((next) => { statuses = next; }, () => statuses),
      setWorkspaces: vi.fn(),
      statusByRole: new Map(statuses.map((status) => [status.roleId, status])),
      t: ((key: string) => key) as Translator
    }), { wrapper: ConfirmationWrapper });

    await act(async () => {
      await expect(result.current.handleClearBrowserData(selectedRole)).resolves.toBe(false);
    });

    expect(reportError).toHaveBeenCalledWith(clearError);
    expect(roles).toEqual([recoveredRole]);
    expect(statuses).toEqual([]);
    expect(authStatuses).toEqual([]);
  });
});

function ConfirmationWrapper({ children }: { children: ReactNode }) {
  return (
    <ConfirmationContext.Provider value={vi.fn().mockResolvedValue(true)}>
      {children}
    </ConfirmationContext.Provider>
  );
}

function createConfirmationWrapper(confirm: Confirm) {
  return function TestConfirmationWrapper({ children }: { children: ReactNode }) {
    return <ConfirmationContext.Provider value={confirm}>{children}</ConfirmationContext.Provider>;
  };
}

function applySetter<T>(set: (value: T) => void, get: () => T) {
  return vi.fn((update: T | ((current: T) => T)) => {
    set(typeof update === "function" ? (update as (current: T) => T)(get()) : update);
  });
}

function role(): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Main",
    launchUrl: "https://example.test/play",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    authState: "authenticated",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
