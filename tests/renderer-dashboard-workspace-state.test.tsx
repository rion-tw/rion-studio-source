// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DashboardRoute from "../src/renderer/src/features/dashboard/DashboardRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type {
  EmbeddedRuntimeState,
  LaunchWorkspace,
  Role,
  RoleStatus
} from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

afterEach(cleanup);

describe("Dashboard workspace state", () => {
  it("keeps a workspace launchable when its role is open in a separate role tab", () => {
    const role = createRole();
    const workspace = createWorkspace(role.id);
    const onLaunchWorkspace = vi.fn();
    const onStopWorkspace = vi.fn();

    renderDashboard({
      embeddedRuntime: createRuntime([createRuntimeTab({ sourceId: role.id, type: "role" })]),
      onLaunchWorkspace,
      onStopWorkspace,
      role,
      status: { roleId: role.id, state: "running" },
      workspace
    });

    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByText("1 active")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop: Workspace One" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Launch: Workspace One" }));

    expect(onLaunchWorkspace).toHaveBeenCalledWith(workspace);
    expect(onStopWorkspace).not.toHaveBeenCalled();
  });

  it("shows stop only when the workspace itself has a runtime tab", () => {
    const role = createRole();
    const workspace = createWorkspace(role.id);
    const onLaunchWorkspace = vi.fn();
    const onStopWorkspace = vi.fn();

    renderDashboard({
      embeddedRuntime: createRuntime([
        createRuntimeTab({ roleIds: [role.id], sourceId: workspace.id, type: "workspace" })
      ]),
      onLaunchWorkspace,
      onStopWorkspace,
      role,
      status: { roleId: role.id, state: "running" },
      workspace
    });

    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Launch: Workspace One" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop: Workspace One" }));

    expect(onStopWorkspace).toHaveBeenCalledWith(workspace);
    expect(onLaunchWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ["wkwebview", "WKWebView"],
    ["webview2", "WebView2"]
  ] as const)("does not show %s in a role badge", (resolvedEngine, engineLabel) => {
    const role = createRole();

    renderDashboard({
      embeddedRuntime: createRuntime(),
      role,
      status: { roleId: role.id, state: "running", resolvedEngine }
    });

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText(engineLabel)).toBeNull();
    expect(screen.queryByTitle(`Running with ${engineLabel}.`)).toBeNull();
  });
});

function renderDashboard({
  embeddedRuntime,
  onLaunchWorkspace = vi.fn(),
  onStopWorkspace = vi.fn(),
  role,
  status,
  workspace
}: {
  embeddedRuntime: EmbeddedRuntimeState;
  onLaunchWorkspace?: (workspace: LaunchWorkspace) => void;
  onStopWorkspace?: (workspace: LaunchWorkspace) => void;
  role: Role;
  status?: RoleStatus;
  workspace?: LaunchWorkspace;
}): void {
  render(
    <DashboardRoute
      embeddedRuntime={embeddedRuntime}
      gameCount={0}
      busyMacroIds={new Set()}
      busyRoleIds={new Set()}
      busyRunKeys={new Set()}
      busyWorkspaceIds={new Set()}
      macroStatusByRun={new Map()}
      macroStatuses={[]}
      macros={[]}
      roleStatuses={status ? [status] : []}
      roles={[role]}
      statusByRole={new Map(status ? [[role.id, status]] : [])}
      t={t}
      workspaces={workspace ? [workspace] : []}
      onCreateWorkspace={vi.fn()}
      onDiscardSavedGameWindows={vi.fn()}
      onLaunchRole={vi.fn()}
      onLaunchWorkspace={onLaunchWorkspace}
      onNavigateGames={vi.fn()}
      onNavigateGameWindows={vi.fn()}
      onNavigateMacros={vi.fn()}
      onNavigateRoles={vi.fn()}
      onNavigateWorkspaces={vi.fn()}
      onNewMacro={vi.fn()}
      onNewRole={vi.fn()}
      onRestoreSavedGameWindows={vi.fn()}
      onStartMacro={vi.fn()}
      onStopMacro={vi.fn()}
      onStopRole={vi.fn()}
      onStopWorkspace={onStopWorkspace}
    />
  );
}

function createRole(): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Role One",
    launchUrl: "https://example.test/play",
    notes: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

function createWorkspace(roleId: string): LaunchWorkspace {
  return {
    id: "workspace-1",
    name: "Workspace One",
    template: "single",
    slots: [{ id: "slot-1", roleId, rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

function createRuntime(tabs: EmbeddedRuntimeState["tabs"] = []): EmbeddedRuntimeState {
  return {
    revision: 1,
    capturedAt: "2026-08-01T00:00:00.000Z",
    tabs,
    windows: []
  };
}

function createRuntimeTab({
  roleIds = [],
  sourceId,
  type
}: Pick<EmbeddedRuntimeState["tabs"][number], "sourceId" | "type"> & {
  roleIds?: EmbeddedRuntimeState["tabs"][number]["roleIds"];
}): EmbeddedRuntimeState["tabs"][number] {
  return {
    id: `tab-${sourceId}`,
    type,
    sourceId,
    name: sourceId,
    windowId: "window-1",
    roleIds,
    slots: [],
    hidden: false,
    active: true,
    audible: false,
    audioMuted: false
  };
}
