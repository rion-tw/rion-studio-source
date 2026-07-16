// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationContext } from "../src/renderer/src/components/confirmation";
import { useMacroWorkflow } from "../src/renderer/src/hooks/useMacroWorkflow";
import type { Translator } from "../src/renderer/src/i18n";

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
});

function ConfirmationWrapper({ children }: { children: ReactNode }) {
  return (
    <ConfirmationContext.Provider value={vi.fn().mockResolvedValue(false)}>
      {children}
    </ConfirmationContext.Provider>
  );
}
