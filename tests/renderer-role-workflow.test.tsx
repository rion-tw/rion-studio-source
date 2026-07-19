// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationContext } from "../src/renderer/src/components/confirmation";
import { useRoleWorkflow } from "../src/renderer/src/hooks/useRoleWorkflow";
import type { Translator } from "../src/renderer/src/i18n";
import type { Macro, Role } from "../src/shared/types";

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
});

function ConfirmationWrapper({ children }: { children: ReactNode }) {
  return (
    <ConfirmationContext.Provider value={vi.fn().mockResolvedValue(true)}>
      {children}
    </ConfirmationContext.Provider>
  );
}
