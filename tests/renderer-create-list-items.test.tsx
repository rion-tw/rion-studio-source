// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import GamesRoute from "../src/renderer/src/features/games/GamesRoute";
import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import MacrosRoute from "../src/renderer/src/features/macros/MacrosRoute";
import { DEFAULT_MACRO_LIST_SORT } from "../src/renderer/src/features/macros/macroListUtils";
import RolesRoute from "../src/renderer/src/features/roles/RolesRoute";
import LaunchWorkspacesRoute from "../src/renderer/src/features/workspaces/LaunchWorkspacesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, LaunchWorkspace, Macro, Role } from "../src/shared/types";

afterEach(cleanup);

describe("create controls at the end of lists", () => {
  it("appends a create card after game cards", async () => {
    const user = userEvent.setup();
    const onNewGame = vi.fn();
    render(
      <GamesRoute
        games={[game()]}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onNewGame={onNewGame}
        onNewRole={vi.fn()}
      />
    );

    const createButton = screen.getAllByRole("button", { name: "New game" }).at(-1)!;
    expect(createButton.closest(".glass-panel")).toBe(
      document.querySelector(".collection-grid-games")?.lastElementChild
    );
    await user.click(createButton);
    expect(onNewGame).toHaveBeenCalledOnce();
  });

  it("appends a same-ratio create card after role cards", async () => {
    const user = userEvent.setup();
    const onNewRole = vi.fn();
    render(
      <RolesRoute
        activeFilter="all"
        busyRoleIds={new Set()}
        filteredRoles={[role()]}
        games={[]}
        isReordering={false}
        language="en"
        roleStats={{ total: 1, running: 0, stopped: 1 }}
        roles={[role()]}
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
        onLaunch={vi.fn()}
        onNewRole={onNewRole}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    const createButton = screen.getAllByRole("button", { name: "New role" }).at(-1)!;
    const createCard = createButton.closest(".glass-panel");
    expect(createCard).toBe(document.querySelector(".collection-grid-roles")?.lastElementChild);
    expect(createCard?.className).toContain("aspect-[4/5]");
    await user.click(createButton);
    expect(onNewRole).toHaveBeenCalledOnce();
  });

  it("lazy loads the Chrome import flow from the roles list", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmationProvider>
        <RolesRoute
          activeFilter="all"
          busyRoleIds={new Set()}
          filteredRoles={[role()]}
          games={[game()]}
          isReordering={false}
          language="en"
          roleStats={{ total: 1, running: 0, stopped: 1 }}
          roles={[role()]}
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
          onLaunch={vi.fn()}
          onNewRole={vi.fn()}
          onQueryChange={vi.fn()}
          onReorder={vi.fn()}
          onStop={vi.fn()}
        />
      </ConfirmationProvider>
    );

    await user.click(screen.getByRole("button", { name: "Import from Chrome" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByRole("dialog").parentElement?.parentElement).toBe(document.body);
  });

  it("appends a create card after workspace cards", async () => {
    const user = userEvent.setup();
    const onCreateWorkspace = vi.fn();
    render(
      <LaunchWorkspacesRoute
        busyWorkspaceIds={new Set()}
        games={[]}
        isReordering={false}
        query=""
        roles={[]}
        runtimeTabs={[]}
        scrollPositionRef={{ current: 0 }}
        t={t}
        workspaces={[workspace()]}
        onCopyWorkspace={vi.fn()}
        onCreateWorkspace={onCreateWorkspace}
        onDeleteWorkspace={vi.fn()}
        onDeleteWorkspaces={vi.fn().mockResolvedValue(false)}
        onEditWorkspace={vi.fn()}
        onLaunchWorkspace={vi.fn()}
        onQueryChange={vi.fn()}
        onReorderWorkspaces={vi.fn()}
        onStopWorkspace={vi.fn()}
      />
    );

    const createButton = screen.getAllByRole("button", { name: "New workspace" }).at(-1)!;
    expect(createButton.closest(".glass-panel")).toBe(
      document.querySelector(".collection-grid-workspaces")?.lastElementChild
    );
    await user.click(createButton);
    expect(onCreateWorkspace).toHaveBeenCalledOnce();
  });

  it("places a dashed create button below the macro table", async () => {
    const user = userEvent.setup();
    const onNewMacro = vi.fn();
    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        macros={[macro({ roleIds: ["role-1"] })]}
        query=""
        roleFilterId="role-1"
        roles={[role()]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map()}
        t={t}
        onCopyMacro={vi.fn()}
        onDeleteMacro={vi.fn()}
        onDeleteMacros={vi.fn().mockResolvedValue(false)}
        onEditMacro={vi.fn()}
        onNewMacro={onNewMacro}
        onQueryChange={vi.fn()}
        onRoleFilterChange={vi.fn()}
        onSortChange={vi.fn()}
        onStartMacro={vi.fn()}
        onStopMacro={vi.fn()}
      />
    );

    const createButtons = screen.getAllByRole("button", { name: "New macro" });
    const headerCreateButton = createButtons.at(0)!;
    const createButton = createButtons.at(-1)!;
    expect(createButton.className).toContain("h-[var(--control-height)]");
    expect(createButton.className).toContain("border-dashed");
    expect(createButton.className).toContain("gap-1.5");
    expect(createButton.className).toContain("px-2.5");
    expect(createButton.className).not.toContain("w-full");
    expect(createButton.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(headerCreateButton.querySelector("svg")?.getAttribute("width")).toBe("14");
    expect(createButton.closest("table")).toBeNull();
    expect(createButton.closest(".mac-list-surface")).toBeNull();
    expect(createButton.previousElementSibling?.className).toContain("mac-list-surface");
    await user.click(headerCreateButton);
    await user.click(createButton);
    expect(onNewMacro).toHaveBeenNthCalledWith(1, "role-1");
    expect(onNewMacro).toHaveBeenNthCalledWith(2, "role-1");
  });
});

const t: Translator = (key) => en[key];

function game(): Game {
  return {
    id: "game-1",
    source: "custom",
    name: "Game one",
    defaultLaunchUrl: "https://example.test/game",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function role(): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Role one",
    launchUrl: "https://example.test/play",
    notes: "",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function workspace(): LaunchWorkspace {
  return {
    id: "workspace-1",
    name: "Workspace one",
    template: "single",
    slots: [{ id: "slot-1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    id: "macro-1",
    enabled: true,
    name: "Macro one",
    roleIds: [],
    shortcutSourceScope: { type: "all_execution_roles" as const },
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "delay", ms: 100 }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
