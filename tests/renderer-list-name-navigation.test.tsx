// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import RolesView from "../src/renderer/src/features/roles/RolesRoute";
import LaunchWorkspacesView from "../src/renderer/src/features/workspaces/LaunchWorkspacesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import type { LaunchWorkspace, Role } from "../src/shared/types";

afterEach(cleanup);

describe("list name navigation", () => {
  it("opens a role editor when its name is clicked", async () => {
    const user = userEvent.setup();
    const item = role();
    const onEdit = vi.fn();

    render(
      <RolesView
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
        onEdit={onEdit}
        onFilterChange={vi.fn()}
        onLaunch={vi.fn()}
        onLogin={vi.fn()}
        onNewRole={vi.fn()}
        onQueryChange={vi.fn()}
        onReorder={vi.fn()}
        onStop={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: item.name }));

    expect(onEdit).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledWith(item);
  });

  it("opens a workspace editor when its name is clicked", async () => {
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

    await user.click(screen.getByRole("button", { name: item.name }));

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
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    authState: "login_required",
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
    browserZoomPercent: 90,
    resourcePolicy: { mode: "unrestricted" },
    slots: [{ id: "slot-1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
