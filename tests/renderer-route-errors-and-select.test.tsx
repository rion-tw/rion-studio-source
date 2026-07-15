// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouteError } from "../src/renderer/src/components/AppRouteError";
import MacrosRoute from "../src/renderer/src/features/macros/MacrosRoute";
import { DEFAULT_MACRO_LIST_SORT } from "../src/renderer/src/features/macros/macroListUtils";
import { LANGUAGE_STORAGE_KEY } from "../src/renderer/src/app/constants";
import type { Translator } from "../src/renderer/src/i18n";
import type { Macro, Role } from "../src/shared/types";

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent
    });
  }

  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value: () => false
    },
    releasePointerCapture: {
      configurable: true,
      value: () => undefined
    },
    scrollIntoView: {
      configurable: true,
      value: () => undefined
    },
    setPointerCapture: {
      configurable: true,
      value: () => undefined
    }
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("macro role filter", () => {
  it("renders roles without game groups and selects a role", async () => {
    const user = userEvent.setup();
    const onRoleFilterChange = vi.fn();
    const roles = [
      role({ id: "role-main", gameId: "game-1", name: "Main" }),
      role({ id: "role-alt", gameId: "game-1", name: "Alt" }),
      role({ id: "role-second", gameId: "game-2", name: "Second" })
    ];

    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[macro({ roleIds: ["role-main"] })]}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        query=""
        roleFilterId=""
        roles={roles}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map()}
        t={t}
        onCopyMacro={vi.fn()}
        onDeleteMacro={vi.fn()}
        onEditMacro={vi.fn()}
        onNewMacro={vi.fn()}
        onQueryChange={vi.fn()}
        onRoleFilterChange={onRoleFilterChange}
        onSortChange={vi.fn()}
        onStartMacro={vi.fn()}
        onStopMacro={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Filter role" }));

    expect(screen.getByRole("option", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Alt" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Second" })).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();

    await user.click(screen.getByRole("option", { name: "Alt" }));

    expect(onRoleFilterChange).toHaveBeenCalledWith("role-alt");
  });
});

describe("app route error boundary", () => {
  it("shows a localized recovery page with collapsed technical details", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-TW");
    const onReload = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = createMemoryRouter([
      {
        path: "*",
        element: <ThrowingRoute />,
        errorElement: <AppRouteError onReload={onReload} />
      }
    ]);

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Rion Studio 發生問題" })).toBeTruthy();
    expect(screen.queryByText("Unexpected Application Error!")).toBeNull();

    const detailsSummary = screen.getByText("技術詳情");
    const details = detailsSummary.closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("render failed for regression test");

    await userEvent.click(screen.getByRole("button", { name: "重新載入" }));
    expect(onReload).toHaveBeenCalledOnce();
  });
});

function ThrowingRoute(): JSX.Element {
  throw new Error("render failed for regression test");
}

const translations: Partial<Record<Parameters<Translator>[0], string>> = {
  "macros.filterAllRoles": "All roles",
  "macros.filterRole": "Filter role"
};

const t: Translator = (key) => translations[key] ?? key;

function role(overrides: Partial<Role>): Role {
  return {
    id: "role",
    gameId: "game-1",
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

function macro(overrides: Partial<Macro>): Macro {
  return {
    id: "macro",
    name: "Macro",
    roleIds: [],
    repeat: { type: "once" },
    steps: [{ id: "step", type: "key", code: "Tab", label: "Tab" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
