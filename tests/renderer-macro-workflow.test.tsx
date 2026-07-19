// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationContext } from "../src/renderer/src/components/confirmation";
import { useMacroWorkflow } from "../src/renderer/src/hooks/useMacroWorkflow";
import type { Translator } from "../src/renderer/src/i18n";
import type { Macro } from "../src/shared/types";

afterEach(() => {
  Reflect.deleteProperty(window, "rionStudio");
});

describe("useMacroWorkflow", () => {
  it("opens the macro list for a role while preserving the current sort", () => {
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => vi.fn(),
      macros: [],
      setMacros: vi.fn(),
      setMacroStatuses: vi.fn(),
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

  it("copies an unassigned macro as another unassigned macro without a shortcut", async () => {
    const source: Macro = {
      id: "macro-1",
      enabled: true,
      name: "Unassigned",
      roleIds: [],
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
    const setMacros = vi.fn();
    const { result } = renderHook(() => useMacroWorkflow({
      beginErrorOperation: () => vi.fn(),
      macros: [source],
      setMacros,
      setMacroStatuses: vi.fn(),
      t: ((key: string) => key === "copyName.suffix" ? "copy" : key) as Translator
    }), { wrapper: ConfirmationWrapper });

    await act(async () => result.current.handleCopyMacro(source));

    expect(createMacro).toHaveBeenCalledWith(expect.objectContaining({
      roleIds: [],
      trigger: null
    }));
    expect(setMacros).toHaveBeenCalledWith(expect.any(Function));
  });
});

function ConfirmationWrapper({ children }: { children: ReactNode }) {
  return (
    <ConfirmationContext.Provider value={vi.fn().mockResolvedValue(false)}>
      {children}
    </ConfirmationContext.Provider>
  );
}
