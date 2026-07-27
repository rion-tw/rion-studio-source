// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import RolesView from "../src/renderer/src/features/roles/RolesRoute";
import LaunchWorkspacesView from "../src/renderer/src/features/workspaces/LaunchWorkspacesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import type { LaunchWorkspace, Role } from "../src/shared/types";

beforeAll(() => {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
  vi.mocked(document.elementFromPoint).mockReset();
});
afterAll(() => vi.unstubAllGlobals());

describe("list editor navigation", () => {
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

  it.each(["darwin", "win32"] as const)("reorders roles with pointer dragging on %s", (platform) => {
    document.documentElement.dataset.platform = platform === "darwin" ? "mac" : "windows";
    const roles = [role(1), role(2), role(3)];
    const onReorder = vi.fn();
    const { container } = render(
      <RolesView
        activeFilter="all"
        busyRoleIds={new Set()}
        filteredRoles={roles}
        games={[]}
        isReordering={false}
        language="en"
        roleStats={{ total: roles.length, running: 0, stopped: roles.length }}
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
        onNewRole={vi.fn()}
        onQueryChange={vi.fn()}
        onReorder={onReorder}
        onStop={vi.fn()}
      />
    );
    const source = screen.getAllByRole("button", { name: "role.actionsAndReorder" })[0];
    const target = container.querySelector<HTMLElement>("[data-role-reorder-id='role-3']");
    if (!target) throw new Error("Expected role reorder target.");

    pointerDrag(source, target, 21);

    expect(onReorder).toHaveBeenCalledWith(["role-2", "role-3", "role-1"]);
    expect(source.hasAttribute("draggable")).toBe(false);
  });

  it.each(["darwin", "win32"] as const)("reorders workspaces with pointer dragging on %s", (platform) => {
    document.documentElement.dataset.platform = platform === "darwin" ? "mac" : "windows";
    const workspaces = [workspace(1), workspace(2), workspace(3)];
    const onReorderWorkspaces = vi.fn();
    const { container } = render(
      <LaunchWorkspacesView
        busyWorkspaceIds={new Set()}
        games={[]}
        isReordering={false}
        query=""
        roles={[]}
        scrollPositionRef={{ current: 0 }}
        statusByRole={new Map()}
        t={t}
        workspaces={workspaces}
        onCopyWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onDeleteWorkspaces={vi.fn().mockResolvedValue(false)}
        onEditWorkspace={vi.fn()}
        onLaunchWorkspace={vi.fn()}
        onQueryChange={vi.fn()}
        onReorderWorkspaces={onReorderWorkspaces}
        onStopWorkspace={vi.fn()}
      />
    );
    const source = screen.getAllByRole("button", { name: "workspaces.actionsAndReorder" })[2];
    const target = container.querySelector<HTMLElement>("[data-workspace-reorder-id='workspace-1']");
    if (!target) throw new Error("Expected workspace reorder target.");

    pointerDrag(source, target, 22);

    expect(onReorderWorkspaces).toHaveBeenCalledWith(["workspace-3", "workspace-1", "workspace-2"]);
    expect(source.hasAttribute("draggable")).toBe(false);
  });
});

const t: Translator = (key) => key;

function role(index = 1): Role {
  return {
    id: `role-${index}`,
    gameId: "game-1",
    name: `Role ${index}`,
    launchUrl: "https://example.test/play",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function workspace(index = 1): LaunchWorkspace {
  return {
    id: `workspace-${index}`,
    name: `Workspace ${index}`,
    template: "single",
    browserZoomMode: "fixed",
    browserZoomPercent: 90,
    slots: [{ id: "slot-1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function pointerDrag(source: HTMLElement, target: HTMLElement, pointerId: number): void {
  vi.mocked(document.elementFromPoint).mockReturnValue(target);
  fireEvent.pointerDown(source, {
    button: 0,
    clientX: 20,
    clientY: 20,
    isPrimary: true,
    pointerId
  });
  fireEvent.pointerMove(window, {
    clientX: 120,
    clientY: 120,
    isPrimary: true,
    pointerId
  });
  fireEvent.pointerUp(window, {
    clientX: 120,
    clientY: 120,
    isPrimary: true,
    pointerId
  });
}
