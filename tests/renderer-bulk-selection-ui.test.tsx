// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import GamesRoute from "../src/renderer/src/features/games/GamesRoute";
import MacrosRoute from "../src/renderer/src/features/macros/MacrosRoute";
import { DEFAULT_MACRO_LIST_SORT } from "../src/renderer/src/features/macros/macroListUtils";
import RolesRoute from "../src/renderer/src/features/roles/RolesRoute";
import LaunchWorkspacesRoute from "../src/renderer/src/features/workspaces/LaunchWorkspacesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, LaunchWorkspace, Macro, Role } from "../src/shared/types";

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
    setPointerCapture: {
      configurable: true,
      value: () => undefined
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("bulk selection UI", () => {
  it("selects games and keeps the selection when bulk deletion is cancelled", async () => {
    const user = userEvent.setup();
    const items = [game("game-1", "One"), game("game-2", "Two")];
    const onDeleteMany = vi.fn().mockResolvedValue(false);
    render(
      <GamesRoute
        games={items}
        reports={[]}
        roles={[]}
        runStatuses={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={onDeleteMany}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
        onRunCheck={vi.fn()}
      />
    );

    const card = getSelectionItem("game-1");
    expect(screen.queryByRole("button", { name: "Select One" })).toBeNull();
    await user.click(card);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("toolbar").className).toContain("fixed");
    expect(screen.getByRole("toolbar").className).toContain("bottom-5");
    await user.click(screen.getByRole("button", { name: "Delete 1" }));

    expect(onDeleteMany).toHaveBeenCalledWith([items[0]]);
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("starts a marquee from the page header instead of requiring the grid", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(
      <GamesRoute
        games={[game("game-1", "One")]}
        reports={[]}
        roles={[]}
        runStatuses={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
        onRunCheck={vi.fn()}
      />
    );

    const page = document.querySelector<HTMLElement>(".app-page");
    const item = getSelectionItem("game-1");
    expect(page).not.toBeNull();
    setBounds(item, 20, 80, 100, 100);

    fireEvent.pointerDown(screen.getByRole("heading", { name: "Games" }), {
      button: 0,
      clientX: 0,
      clientY: 0,
      isPrimary: true,
      pointerId: 7
    });
    fireEvent.pointerMove(page!, { clientX: 140, clientY: 200, isPrimary: true, pointerId: 7 });

    expect(screen.getByText("1 selected")).toBeTruthy();
    expectSelectedCardOverlay(item);
    fireEvent.pointerUp(page!, { clientX: 140, clientY: 200, isPrimary: true, pointerId: 7 });
  });

  it("adds a selectable state to role cards", async () => {
    const user = userEvent.setup();
    const item = role("role-1", "Main role");
    render(
      <RolesRoute
        activeFilter="all"
        authStatusByRole={new Map()}
        busyRoleIds={new Set()}
        filteredRoles={[item]}
        games={[]}
        isReordering={false}
        language="en"
        roleStats={{ total: 1, running: 0, stopped: 1, needsLogin: 1, authFailed: 0 }}
        roles={[item]}
        scrollPositionRef={{ current: 0 }}
        query=""
        statusByRole={new Map()}
        t={t}
        onClearQuery={vi.fn()}
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

    const card = getSelectionItem("role-1");
    expect(screen.queryByRole("button", { name: "Select Main role" })).toBeNull();
    await user.click(card);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expectSelectedCardOverlay(card);
  });

  it("adds a selectable state to workspace cards", async () => {
    const user = userEvent.setup();
    const item = { ...workspace("workspace-1", "Party"), browserZoomMode: "adaptive" as const };
    render(
      <LaunchWorkspacesRoute
        busyWorkspaceIds={new Set()}
        games={[]}
        isReordering={false}
        query=""
        roles={[]}
        scrollPositionRef={{ current: 0 }}
        statusByRole={new Map()}
        t={t}
        workspaces={[item]}
        workspaceDisplays={[]}
        onCopyWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onDeleteWorkspaces={vi.fn().mockResolvedValue(false)}
        onEditWorkspace={vi.fn()}
        onLaunchWorkspace={vi.fn()}
        onQueryChange={vi.fn()}
        onReorderWorkspaces={vi.fn()}
        onStopWorkspace={vi.fn()}
      />
    );

    const card = getSelectionItem("workspace-1");
    expect(screen.getByText("Adaptive (recommended)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Party" })).toBeNull();
    await user.click(card);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expectSelectedCardOverlay(card);
  });

  it("adds a selectable state and selection column to macro rows", async () => {
    const user = userEvent.setup();
    const item = macro("macro-1", "Auto heal");
    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[item]}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        query=""
        roleFilterId=""
        roles={[]}
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
        onRoleFilterChange={vi.fn()}
        onSortChange={vi.fn()}
        onStartMacro={vi.fn()}
        onStopMacro={vi.fn()}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "Select Auto heal" });
    expect(checkbox.className).toContain("size-3.5");
    expect(checkbox.className).toContain("data-[state=checked]:bg-blue-500");
    expect(checkbox.className).toContain("opacity-100");
    expect(checkbox.className).not.toContain("shadow-sm");
    const checkboxLayout = checkbox.closest("[data-macro-selection-control]");
    expect(checkboxLayout?.className).toContain("absolute");
    expect(checkboxLayout?.className).toContain("inset-0");
    expect(checkboxLayout?.className).toContain("place-items-center");
    expect(checkboxLayout?.parentElement?.className).toContain("relative");
    expect(checkboxLayout?.parentElement?.className).toContain("p-0");

    const actionLayout = screen.getByRole("button", { name: "Start" }).closest("[data-macro-actions-control]");
    expect(actionLayout?.className).toContain("absolute");
    expect(actionLayout?.className).toContain("inset-0");
    expect(actionLayout?.className).toContain("items-center");
    expect(screen.getByRole("button", { name: "Macro actions" }).closest("[data-macro-actions-control]"))
      .toBe(actionLayout);
    await user.click(checkbox);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(document.querySelector("[data-selection-overlay]")).toBeNull();
  });
});

const t: Translator = (key) => en[key];

function game(id: string, name: string): Game {
  return {
    id,
    source: "custom",
    name,
    defaultLaunchUrl: `https://example.test/${id}`,
    browserLaunchMode: "inherit",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function role(id: string, name: string): Role {
  return {
    id,
    gameId: "game-1",
    name,
    launchUrl: "https://example.test/play",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    authState: "login_required",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function workspace(id: string, name: string): LaunchWorkspace {
  return {
    id,
    name,
    template: "single",
    browserLaunchMode: "inherit",
    browserZoomMode: "fixed",
    browserZoomPercent: 90,
    resourcePolicy: { mode: "unrestricted" },
    slots: [{ id: "slot-1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function macro(id: string, name: string): Macro {
  return {
    id,
    enabled: true,
    name,
    roleIds: [],
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function setBounds(element: HTMLElement, left: number, top: number, width: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
      toJSON: () => ({})
    })
  });
}

function expectSelectedCardOverlay(card: HTMLElement): void {
  const overlay = card.querySelector<HTMLElement>("[data-selection-overlay]");
  expect(overlay).not.toBeNull();
  expect(overlay!.className).toContain("bg-blue-500/10");
  expect(overlay!.className).toContain("outline-blue-500/90");
  expect(overlay!.className).toContain("outline-1");
}

function getSelectionItem(id: string): HTMLElement {
  const item = document.querySelector<HTMLElement>(`[data-selection-id="${id}"]`);
  expect(item).not.toBeNull();
  return item!;
}
