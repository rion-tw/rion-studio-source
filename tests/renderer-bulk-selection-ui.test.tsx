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
        roles={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={onDeleteMany}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
      />
    );

    const card = getSelectionItem("game-1");
    expect(screen.queryByRole("button", { name: "Select One" })).toBeNull();
    await user.click(card);
    expect(screen.getByText("1 selected")).toBeTruthy();
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.className).toContain("fixed");
    expect(toolbar.className).toContain("bottom-5");
    expect(toolbar.className).toContain("flex-nowrap");
    expect(toolbar.className).toContain("max-w-[calc(100%-1rem)]");
    expect(toolbar.className).toContain("overflow-x-auto");
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
        roles={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
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
    expect(screen.queryByText("1 selected")).toBeNull();
    fireEvent.pointerUp(page!, { clientX: 140, clientY: 200, isPrimary: true, pointerId: 7 });

    expect(screen.getByText("1 selected")).toBeTruthy();
    expectSelectedCardOverlay(item);
  });

  it("adds a selectable state to role cards", async () => {
    const user = userEvent.setup();
    const item = role("role-1", "Main role");
    const otherItem = role("role-2", "Secondary role");
    const onLaunch = vi.fn();
    render(
      <RolesRoute
        activeFilter="all"
        busyRoleIds={new Set()}
        filteredRoles={[item, otherItem]}
        games={[]}
        isReordering={false}
        language="en"
        roleStats={{ total: 2, running: 0, stopped: 2 }}
        roles={[item, otherItem]}
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
        onError={vi.fn()}
        onFilterChange={vi.fn()}
        onLaunch={onLaunch}
        onNewRole={vi.fn()}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    const card = getSelectionItem("role-1");
    const launchButton = screen.getAllByRole("button", { name: "Launch" })[0];
    const primaryActionLayer = launchButton.closest<HTMLElement>("[data-role-primary-action-layer]");
    expect(primaryActionLayer?.className).toContain("z-[var(--layer-popover)]");
    expect(primaryActionLayer?.className).not.toContain("z-[var(--layer-selection)]");
    await user.click(launchButton);
    expect(onLaunch).toHaveBeenCalledWith(item.id);
    const actionButton = screen.getAllByRole("button", {
      name: "Click for actions or drag to reorder"
    })[0];
    const actionLayer = actionButton.closest<HTMLElement>("[data-role-action-layer]");
    expect(actionLayer?.className).toContain("z-[var(--layer-tooltip)]");
    expect(actionLayer?.className).not.toContain("z-[var(--layer-popover)]");
    expect(actionLayer?.className).not.toContain("z-[var(--layer-selection)]");
    await user.click(actionButton);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select Main role" })).toBeNull();
    await user.click(card);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expectSelectedCardOverlay(card);
  });

  it("adds a selectable state to workspace cards", async () => {
    const user = userEvent.setup();
    const item = workspace("workspace-1", "Party");
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
    expect(screen.queryByText("Adaptive (recommended)")).toBeNull();
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
    expect(checkbox.className).not.toContain("size-[var(--control-min-size)]");
    const checkboxVisual = checkbox.querySelector<HTMLElement>('[data-slot="checkbox-visual"]');
    expect(checkboxVisual?.className).toContain("size-3.5");
    expect(checkboxVisual?.className).toContain("group-data-[state=checked]/checkbox:bg-activity");
    expect(checkbox.className).toContain("opacity-100");
    expect(checkbox.className).not.toContain("shadow-sm");
    const checkboxLayout = checkbox.closest("[data-macro-selection-control]");
    expect(checkboxLayout?.className).toContain("absolute");
    expect(checkboxLayout?.className).toContain("inset-0");
    expect(checkboxLayout?.className).toContain("place-items-center");
    expect(checkboxLayout?.parentElement?.className).toContain("relative");
    expect(checkboxLayout?.parentElement?.className).toContain("p-0");
    const macroRow = checkbox.closest("tr");
    expect(macroRow?.className).toContain("align-middle");
    expect(macroRow?.querySelector("td:nth-child(2)")?.className).toContain("py-2");
    expect(macroRow?.querySelector("td:nth-child(2)")?.className).toContain("align-middle");
    expect(screen.getByText("None")).toBeTruthy();

    const startButton = screen.getByRole("button", { name: "Start" });
    const nameButton = screen.getByText("Auto heal").closest("button")!;
    const nameLayout = nameButton.closest("[data-macro-name-control]");
    const runLayout = startButton.closest("[data-macro-run-control]");
    const activationIndicator = screen.getByRole("img", { name: "Tap to toggle" });
    const repeatIndicator = screen.getByRole("img", { name: "Once" });
    expect(nameLayout).not.toBeNull();
    expect(nameLayout?.className).not.toContain("pl-9");
    expect(runLayout?.className).toContain("shrink-0");
    expect(runLayout?.parentElement?.className).toContain("gap-1.5");
    expect(activationIndicator.className).toContain("h-7");
    expect(activationIndicator.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(startButton.compareDocumentPosition(activationIndicator) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(activationIndicator.compareDocumentPosition(nameButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(repeatIndicator).toBeTruthy();
    const actionLayout = screen.getByRole("button", { name: "Macro actions" }).closest("[data-macro-actions-control]");
    expect(actionLayout?.className).toContain("absolute");
    expect(actionLayout?.className).toContain("inset-0");
    expect(actionLayout?.className).toContain("items-center");
    expect(actionLayout?.contains(startButton)).toBe(false);
    await user.click(checkbox);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(document.querySelector("[data-selection-overlay]")).toBeNull();
  });

  it("shows the loop wait duration beside its timer icon", () => {
    const item = { ...macro("macro-loop", "Auto loop"), repeat: { type: "loop" as const, intervalMs: 1000 } };
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

    const repeatIndicator = screen.getByRole("img", { name: "Wait 1000 ms after completion" });
    const delay = screen.getByText("1 sec");
    expect(repeatIndicator.className).toContain("gap-1.5");
    expect(repeatIndicator.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(delay.className).toContain("text-body");
    expect(delay.className).toContain("leading-5");
  });

  it("runs each bulk macro action only for applicable selected rows", async () => {
    const user = userEvent.setup();
    const runnable = { ...macro("macro-run", "Runnable"), roleIds: ["role-1"] };
    const running = { ...macro("macro-stop", "Running"), roleIds: ["role-1"] };
    const disabled = { ...macro("macro-enable", "Disabled"), enabled: false, roleIds: ["role-1"] };
    const unassigned = macro("macro-unassigned", "Unassigned");
    const runningStatus = {
      macroId: running.id,
      roleId: "role-1",
      state: "running" as const,
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:01.000Z"
    };
    const onStartMacros = vi.fn().mockResolvedValue(undefined);
    const onStopMacros = vi.fn().mockResolvedValue(undefined);
    const onSetMacrosEnabled = vi.fn().mockResolvedValue(undefined);

    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[runnable, running, disabled, unassigned]}
        macroStatuses={[runningStatus]}
        macroStatusByRun={new Map([[`role-1:${running.id}`, runningStatus]])}
        query=""
        roleFilterId=""
        roles={[role("role-1", "Main role")]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([["role-1", { roleId: "role-1", state: "running" }]])}
        t={t}
        onCopyMacro={vi.fn()}
        onDeleteMacro={vi.fn()}
        onDeleteMacros={vi.fn().mockResolvedValue(false)}
        onEditMacro={vi.fn()}
        onNewMacro={vi.fn()}
        onQueryChange={vi.fn()}
        onRoleFilterChange={vi.fn()}
        onSetMacrosEnabled={onSetMacrosEnabled}
        onSortChange={vi.fn()}
        onStartMacro={vi.fn()}
        onStartMacros={onStartMacros}
        onStopMacro={vi.fn()}
        onStopMacros={onStopMacros}
      />
    );

    for (const name of ["Runnable", "Running", "Disabled", "Unassigned"]) {
      await user.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    }

    await user.click(screen.getByRole("button", { name: "Run 1" }));
    await user.click(screen.getByRole("button", { name: "Stop 1" }));
    await user.click(screen.getByRole("button", { name: "Enable 1" }));
    await user.click(screen.getByRole("button", { name: "Disable 3" }));

    expect(onStartMacros).toHaveBeenCalledWith([runnable]);
    expect(onStopMacros).toHaveBeenCalledWith([running]);
    expect(onSetMacrosEnabled).toHaveBeenNthCalledWith(1, [disabled], true);
    expect(onSetMacrosEnabled).toHaveBeenNthCalledWith(2, [runnable, running, unassigned], false);
    expect(screen.getByText("4 selected")).toBeTruthy();
  });

  it("disables every bulk macro action while a selected macro is busy", async () => {
    const user = userEvent.setup();
    const item = { ...macro("macro-busy", "Busy macro"), roleIds: ["role-1"] };
    render(
      <MacrosRoute
        busyMacroIds={new Set([item.id])}
        busyRunKeys={new Set([item.id])}
        macros={[item]}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        query=""
        roleFilterId=""
        roles={[role("role-1", "Main role")]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([["role-1", { roleId: "role-1", state: "running" }]])}
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

    await user.click(screen.getByRole("checkbox", { name: "Select Busy macro" }));

    for (const label of ["Run 0", "Stop 0", "Enable 0", "Disable 0"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("draws one activity outline around adjacent selected macro rows", async () => {
    const user = userEvent.setup();
    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[
          macro("macro-alpha", "Alpha"),
          macro("macro-beta", "Beta"),
          macro("macro-gamma", "Gamma")
        ]}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        query=""
        roleFilterId=""
        roles={[]}
        scrollPositionRef={{ current: 0 }}
        sort={{ direction: "asc", key: "name" }}
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

    await user.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Beta" }));

    const alpha = getSelectionItem("macro-alpha");
    const beta = getSelectionItem("macro-beta");
    const gamma = getSelectionItem("macro-gamma");
    expect(alpha.getAttribute("data-selection-group-start")).toBe("true");
    expect(alpha.hasAttribute("data-selection-group-end")).toBe(false);
    expect(beta.hasAttribute("data-selection-group-start")).toBe(false);
    expect(beta.getAttribute("data-selection-group-end")).toBe("true");
    expect(alpha.className).toContain("[&>td]:border-t-activity/80");
    expect(alpha.className).not.toContain("[&>td]:border-b-activity/80");
    expect(beta.className).not.toContain("[&>td]:border-t-activity/80");
    expect(beta.className).toContain("[&>td]:border-b-activity/80");
    expect(alpha.className).toContain("[&>td:first-child]:border-l-activity/80");
    expect(beta.className).toContain("[&>td:last-child]:border-r-activity/80");
    expect(gamma.className).not.toContain("border-activity/80");
    expect(alpha.closest("tbody")?.className).toContain("divide-y");
  });
});

const t: Translator = (key) => en[key];

function game(id: string, name: string): Game {
  return {
    id,
    source: "custom",
    name,
    defaultLaunchUrl: `https://example.test/${id}`,
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
    notes: "",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function workspace(id: string, name: string): LaunchWorkspace {
  return {
    id,
    name,
    template: "single",
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
    shortcutSourceScope: { type: "all_execution_roles" as const },
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
  expect(overlay!.className).toContain("bg-activity/10");
  expect(overlay!.className).toContain("outline-activity/90");
  expect(overlay!.className).toContain("outline-1");
}

function getSelectionItem(id: string): HTMLElement {
  const item = document.querySelector<HTMLElement>(`[data-selection-id="${id}"]`);
  expect(item).not.toBeNull();
  return item!;
}
