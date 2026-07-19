// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRouteError } from "../src/renderer/src/components/AppRouteError";
import MacrosRoute from "../src/renderer/src/features/macros/MacrosRoute";
import { DEFAULT_MACRO_LIST_SORT } from "../src/renderer/src/features/macros/macroListUtils";
import RolesRoute from "../src/renderer/src/features/roles/RolesRoute";
import { LANGUAGE_STORAGE_KEY } from "../src/renderer/src/app/constants";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Macro, Role } from "../src/shared/types";

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

describe("list select filters", () => {
  it("filters macros by role without starting a marquee from the portaled option", async () => {
    const user = userEvent.setup();
    const roles = [
      role({ id: "role-main", gameId: "game-1", name: "Main" }),
      role({ id: "role-alt", gameId: "game-1", name: "Alt" }),
      role({ id: "role-second", gameId: "game-2", name: "Second" })
    ];

    render(<MacroFilterHarness roles={roles} />);

    const page = document.querySelector<HTMLElement>(".app-page");
    expect(page).not.toBeNull();
    const setPointerCapture = vi.spyOn(page!, "setPointerCapture");

    await user.click(screen.getByRole("combobox", { name: "Filter by role" }));

    expect(screen.getByRole("option", { name: "Main" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Alt" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Second" })).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();

    await user.click(screen.getByRole("option", { name: "Alt" }));

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Filter by role" }).textContent).toContain("Alt");
    expect(screen.queryByRole("button", { name: "Main macro" })).toBeNull();
    expect(screen.getByRole("button", { name: "Alt macro" })).toBeTruthy();
  });

  it("filters roles by game without starting a marquee from the portaled option", async () => {
    const user = userEvent.setup();
    const games = [
      game({ id: "game-one", name: "Game One" }),
      game({ id: "game-two", name: "Game Two" })
    ];
    const roles = [
      role({ id: "role-one", gameId: "game-one", name: "Role One" }),
      role({ id: "role-two", gameId: "game-two", name: "Role Two" })
    ];

    render(
      <RolesRoute
        activeFilter="all"
        authStatusByRole={new Map()}
        busyRoleIds={new Set()}
        filteredRoles={roles}
        games={games}
        isReordering={false}
        language="en"
        roleStats={{ total: 2, running: 0, stopped: 2, needsLogin: 2, authFailed: 0 }}
        roles={roles}
        scrollPositionRef={{ current: 0 }}
        query=""
        statusByRole={new Map()}
        t={t}
        onClearQuery={vi.fn()}
        onClearBrowserData={vi.fn()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onFilterChange={vi.fn()}
        onLaunch={vi.fn()}
        onLogin={vi.fn()}
        onNewRole={vi.fn()}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    const page = document.querySelector<HTMLElement>(".app-page");
    expect(page).not.toBeNull();
    const setPointerCapture = vi.spyOn(page!, "setPointerCapture");

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "Game Two" }));

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox").textContent).toContain("Game Two");
    expect(screen.getByText("1 of 2 shown")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Role One" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Role Two" })).toBeTruthy();
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

const t: Translator = (key) => en[key];

function MacroFilterHarness({ roles }: { roles: Role[] }): JSX.Element {
  const [roleFilterId, setRoleFilterId] = useState("");

  return (
    <MacrosRoute
      busyMacroIds={new Set()}
      busyRunKeys={new Set()}
      macros={[
        macro({ id: "macro-main", name: "Main macro", roleIds: ["role-main"] }),
        macro({ id: "macro-alt", name: "Alt macro", roleIds: ["role-alt"] })
      ]}
      macroStatuses={[]}
      macroStatusByRun={new Map()}
      query=""
      roleFilterId={roleFilterId}
      roles={roles}
      scrollPositionRef={{ current: 0 }}
      sort={DEFAULT_MACRO_LIST_SORT}
      statusByRole={new Map()}
      t={t}
      onCopyMacro={vi.fn()}
      onDeleteMacro={vi.fn()}
      onDeleteMacros={vi.fn().mockResolvedValue(false)}
      onEditMacro={vi.fn()}
      onNewMacro={vi.fn()}
      onQueryChange={vi.fn()}
      onRoleFilterChange={setRoleFilterId}
      onSortChange={vi.fn()}
      onStartMacro={vi.fn()}
      onStopMacro={vi.fn()}
    />
  );
}

function game(overrides: Partial<Game>): Game {
  return {
    id: "game",
    source: "custom",
    name: "Game",
    defaultLaunchUrl: "https://example.test/play",
    browserLaunchMode: "inherit",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

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

function macro(overrides: Partial<Macro>): Macro {
  return {
    id: "macro",
    enabled: true,
    name: "Macro",
    roleIds: [],
    repeat: { type: "once" },
    steps: [{ id: "step", type: "key", code: "Tab", label: "Tab" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
