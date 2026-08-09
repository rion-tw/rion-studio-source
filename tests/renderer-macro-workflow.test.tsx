// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationContext } from "../src/renderer/src/components/confirmation";
import { useMacroWorkflow } from "../src/renderer/src/hooks/useMacroWorkflow";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Macro } from "../src/shared/types";

afterEach(() => {
  Reflect.deleteProperty(window, "rionStudio");
});

describe("useMacroWorkflow", () => {
  it("opens the macro list for a role while preserving the current sort", () => {
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => vi.fn(),
      macros: [],
      setNotice: vi.fn(),
      t: ((key: string) => key) as Translator
    }), { wrapper: ConfirmationWrapper });

    act(() => {
      result.current.setQuery("old search");
      result.current.setRoleFilterId("old-role");
      result.current.setSort({ direction: "desc", key: "repeat" });
      result.current.listScrollTopRef.current = 480;
    });

    act(() => result.current.openListForRole("role-1"));

    expect(result.current.query).toBe("");
    expect(result.current.roleFilterId).toBe("role-1");
    expect(result.current.listScrollTopRef.current).toBe(0);
    expect(result.current.sort).toEqual({ direction: "desc", key: "repeat" });
  });

  it("keeps the role filter after creating a macro", async () => {
    const savedMacro: Macro = {
      id: "macro-1",
      enabled: true,
      name: "New macro",
      roleIds: ["role-1"],
      shortcutSourceScope: { type: "all_execution_roles" as const },
      repeat: { type: "once" },
      steps: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createMacro: vi.fn().mockResolvedValue(savedMacro) }
    });
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => vi.fn(),
      macros: [],
      setNotice: vi.fn(),
      t: ((key: string) => key) as Translator
    }), { wrapper: ConfirmationWrapper });

    act(() => result.current.setRoleFilterId("role-1"));
    await act(async () => {
      await result.current.saveMacro({
        enabled: true,
        activationMode: "toggle",
        name: "New macro",
        roleIds: ["role-1"],
        shortcutSourceScope: { type: "all_execution_roles" as const },
        repeat: { type: "once" },
        steps: []
      });
    });

    expect(result.current.roleFilterId).toBe("role-1");
  });

  it("copies an unassigned macro as another unassigned macro without a shortcut", async () => {
    const source: Macro = {
      id: "macro-1",
      enabled: true,
      name: "Unassigned",
      roleIds: [],
      shortcutSourceScope: { type: "all_execution_roles" as const },
      trigger: { code: "F2", ctrl: false, alt: false, shift: false, meta: false },
      repeat: { type: "once" },
      steps: [{ id: "step-1", type: "key", code: "F2" }],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const copy = { ...source, id: "macro-2", name: "Unassigned copy", trigger: undefined };
    const createMacro = vi.fn().mockResolvedValue(copy);
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createMacro }
    });
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => vi.fn(),
      macros: [source],
      t: ((key: string) => key === "copyName.suffix" ? "copy" : key) as Translator
    }), { wrapper: ConfirmationWrapper });

    await act(async () => result.current.handleCopyMacro(source));

    expect(createMacro).toHaveBeenCalledWith(expect.objectContaining({
      roleIds: [],
      shortcutSourceScope: { type: "all_execution_roles" as const },
      trigger: null
    }));
    expect(createMacro).toHaveBeenCalledTimes(1);
  });

  it("groups batch starts under one busy lease and blocks overlapping starts", async () => {
    const first = macro("macro-1");
    const second = macro("macro-2");
    const firstStatus = macroStatus(first.id);
    const secondStatus = macroStatus(second.id);
    const resolvers = new Map<string, (statuses: ReturnType<typeof macroStatus>[]) => void>();
    const startMacro = vi.fn((macroId: string) => new Promise<ReturnType<typeof macroStatus>[]>((resolve) => {
      resolvers.set(macroId, resolve);
    }));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        listMacroStatuses: vi.fn().mockResolvedValue([firstStatus, secondStatus]),
        startMacro
      }
    });
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => vi.fn(),
      macros: [first, second],
      setNotice: vi.fn(),
      t
    }), { wrapper: ConfirmationWrapper });

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleStartMacros([first, first, second]);
    });
    expect(result.current.busyMacroIds).toEqual(new Set([first.id, second.id]));

    await act(async () => result.current.handleStartMacros([first]));
    expect(startMacro).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers.get(first.id)?.([firstStatus]);
      resolvers.get(second.id)?.([secondStatus]);
      await pending;
    });
    expect(result.current.busyMacroIds).toEqual(new Set());
  });

  it("leaves enabled-state projection to AppSnapshot and reports partial failures", async () => {
    const first = macro("macro-1");
    const second = macro("macro-2");
    const alreadyDisabled = { ...macro("macro-3"), enabled: false };
    const updatedFirst = { ...first, enabled: false };
    const updateMacro = vi.fn((id: string) =>
      id === first.id ? Promise.resolve(updatedFirst) : Promise.reject(new Error("update failed"))
    );
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        listMacros: vi.fn().mockResolvedValue([updatedFirst, second, alreadyDisabled]),
        listMacroStatuses: vi.fn().mockResolvedValue([]),
        updateMacro
      }
    });
    const reportError = vi.fn();
    const setNotice = vi.fn();
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => reportError,
      macros: [first, second, alreadyDisabled],
      setNotice,
      t
    }), { wrapper: ConfirmationWrapper });

    await act(async () => result.current.handleSetMacrosEnabled(
      [first, second, alreadyDisabled],
      false
    ));

    expect(updateMacro).toHaveBeenCalledTimes(2);
    expect(updateMacro).toHaveBeenNthCalledWith(1, first.id, { enabled: false });
    expect(updateMacro).toHaveBeenNthCalledWith(2, second.id, { enabled: false });
    expect(window.rionStudio.listMacros).not.toHaveBeenCalled();
    expect(window.rionStudio.listMacroStatuses).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenLastCalledWith(
      "Batch operation completed: 1 succeeded and 1 failed."
    );
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Batch operation completed: 1 succeeded and 1 failed."
    }));
  });

  it("leaves stop-status projection to AppSnapshot after partial success", async () => {
    const first = macro("macro-1");
    const second = macro("macro-2");
    const remainingStatus = macroStatus(second.id);
    const stopMacro = vi.fn((id: string) =>
      id === first.id ? Promise.resolve() : Promise.reject(new Error("stop failed"))
    );
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        listMacroStatuses: vi.fn().mockResolvedValue([remainingStatus]),
        stopMacro
      }
    });
    const reportError = vi.fn();
    const setNotice = vi.fn();
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => reportError,
      macros: [first, second],
      setNotice,
      t
    }), { wrapper: ConfirmationWrapper });

    await act(async () => result.current.handleStopMacros([first, second]));

    expect(stopMacro).toHaveBeenCalledTimes(2);
    expect(window.rionStudio.listMacroStatuses).not.toHaveBeenCalled();
    expect(setNotice).toHaveBeenLastCalledWith(
      "Batch operation completed: 1 succeeded and 1 failed."
    );
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Batch operation completed: 1 succeeded and 1 failed."
    }));
  });
});

const t: Translator = (key) => en[key];

function macro(id: string): Macro {
  return {
    id,
    enabled: true,
    name: id,
    roleIds: ["role-1"],
    shortcutSourceScope: { type: "all_execution_roles" as const },
    repeat: { type: "once" },
    steps: [{ id: `${id}-step`, type: "key", code: "F2" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function macroStatus(macroId: string) {
  return {
    macroId,
    roleId: "role-1",
    state: "running" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
}

function ConfirmationWrapper({ children }: { children: ReactNode }) {
  return (
    <ConfirmationContext.Provider value={vi.fn().mockResolvedValue(false)}>
      {children}
    </ConfirmationContext.Provider>
  );
}
