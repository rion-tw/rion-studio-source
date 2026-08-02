// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import RolesView from "../src/renderer/src/features/roles/RolesRoute";
import LaunchWorkspacesView from "../src/renderer/src/features/workspaces/LaunchWorkspacesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import type { Game, LaunchWorkspace, Role } from "../src/shared/types";

afterEach(cleanup);

describe("list editor navigation", () => {
  it("opens Chrome profile import before the new role action", async () => {
    const user = userEvent.setup();
    const onOpenChromeProfileImport = vi.fn();

    render(
      <RolesView
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
        onFilterChange={vi.fn()}
        onLaunch={vi.fn()}
        onNewRole={vi.fn()}
        onOpenChromeProfileImport={onOpenChromeProfileImport}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    const importButton = screen.getByRole("button", { name: "roles.importChromeProfiles" });
    const newRoleButton = screen.getAllByRole("button", { name: "roles.newRole" })[0]!;
    expect(importButton.compareDocumentPosition(newRoleButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(importButton);
    expect(onOpenChromeProfileImport).toHaveBeenCalledOnce();
  });

  it("offers Chrome profile import from the empty role state", async () => {
    const user = userEvent.setup();
    const onOpenChromeProfileImport = vi.fn();

    render(
      <RolesView
        activeFilter="all"
        busyRoleIds={new Set()}
        filteredRoles={[]}
        games={[game()]}
        isReordering={false}
        language="en"
        roleStats={{ total: 0, running: 0, stopped: 0 }}
        roles={[]}
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
        onNewRole={vi.fn()}
        onOpenChromeProfileImport={onOpenChromeProfileImport}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "roles.importChromeProfiles" }));
    expect(onOpenChromeProfileImport).toHaveBeenCalledOnce();
  });

  it("disables Chrome profile import when no game is available", () => {
    render(
      <RolesView
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
        onFilterChange={vi.fn()}
        onLaunch={vi.fn()}
        onNewRole={vi.fn()}
        onOpenChromeProfileImport={vi.fn()}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "roles.importChromeProfiles" })).toHaveProperty("disabled", true);
  });

  it("opens a role editor from its action menu", async () => {
    const user = userEvent.setup();
    const item = role();
    const onEdit = vi.fn();

    render(
      <RolesView
        activeFilter="all"
        busyRoleIds={new Set()}
        filteredRoles={[item]}
        games={[]}
        isReordering={false}
        language="en"
        roleStats={{ total: 1, running: 0, stopped: 1 }}
        roles={[item]}
        scrollPositionRef={{ current: 0 }}
        query=""
        statusByRole={new Map()}
        t={t}
        onClearQuery={vi.fn()}
        onClearBrowserData={vi.fn()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={onEdit}
        onFilterChange={vi.fn()}
        onLaunch={vi.fn()}
        onNewRole={vi.fn()}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "role.actions" }));
    await user.click(screen.getByRole("menuitem", { name: "role.edit" }));

    expect(onEdit).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith(item);
  });

  it("opens saved browser data clearing from the role action menu", async () => {
    const user = userEvent.setup();
    const item = role();
    const onClearBrowserData = vi.fn();

    render(
      <RolesView
        activeFilter="all"
        busyRoleIds={new Set()}
        filteredRoles={[item]}
        games={[]}
        isReordering={false}
        language="en"
        roleStats={{ total: 1, running: 0, stopped: 1 }}
        roles={[item]}
        scrollPositionRef={{ current: 0 }}
        query=""
        statusByRole={new Map()}
        t={t}
        onClearQuery={vi.fn()}
        onClearBrowserData={onClearBrowserData}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onFilterChange={vi.fn()}
        onLaunch={vi.fn()}
        onNewRole={vi.fn()}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "role.actions" }));
    await user.click(screen.getByRole("menuitem", { name: "role.clearSavedData" }));

    expect(onClearBrowserData).toHaveBeenCalledWith(item);
  });

  it("opens a workspace editor from its action menu", async () => {
    const user = userEvent.setup();
    const item = workspace();
    const onEditWorkspace = vi.fn();

    render(
      <LaunchWorkspacesView
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
        onEditWorkspace={onEditWorkspace}
        onLaunchWorkspace={vi.fn()}
        onQueryChange={vi.fn()}
        onReorderWorkspaces={vi.fn()}
        onStopWorkspace={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "workspaces.actions" }));
    await user.click(screen.getByRole("menuitem", { name: "workspaces.edit" }));

    expect(onEditWorkspace).toHaveBeenCalledOnce();
    expect(onEditWorkspace).toHaveBeenCalledWith(item);
  });
});

const t: Translator = (key) => key;

function role(): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Main role",
    launchUrl: "https://example.test/play",
    notes: "",
    browserZoomPercent: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function game(): Game {
  return {
    id: "game-1",
    source: "custom",
    name: "Example game",
    defaultLaunchUrl: "https://example.test/play",
    browserLaunchMode: "inherit",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function workspace(): LaunchWorkspace {
  return {
    id: "workspace-1",
    name: "Main workspace",
    template: "single",
    browserLaunchMode: "inherit",
    browserZoomMode: "fixed",
    browserZoomPercent: 90,
    slots: [{ id: "slot-1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
