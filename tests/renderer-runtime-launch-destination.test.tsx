// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import RolesRoute from "../src/renderer/src/features/roles/RolesRoute";
import LaunchWorkspacesRoute from "../src/renderer/src/features/workspaces/LaunchWorkspacesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type {
  EmbeddedRuntimeState,
  GameWindow,
  LaunchWorkspace,
  Role,
  RuntimeLaunchDestination
} from "../src/shared/types";

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("runtime launch destination menu", () => {
  it("keeps automatic launch as the primary action and submits an explicit saved target", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    const role = runtimeRole();
    const runtime: EmbeddedRuntimeState = {
      revision: 1,
      capturedAt: "2026-01-01T00:00:00.000Z",
      windows: [],
      tabs: []
    };

    renderRoles(role, runtime, [gameWindow("saved-empty", "Quiet Window")], onLaunch);

    const primary = screen.getByRole("button", { name: "Open" });
    expect(primary.title).toBe("Open in a new Game Window");
    await user.click(primary);
    expect(onLaunch).toHaveBeenLastCalledWith(role.id);

    await user.click(screen.getByRole("button", { name: "Role actions" }));
    const openIn = screen.getByRole("menuitem", { name: "Open in…" });
    openIn.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("menuitem", { name: /Quiet Window/ }));

    expect(onLaunch).toHaveBeenLastCalledWith(role.id, {
      kind: "game-window",
      windowId: "saved-empty"
    });
  });

  it("disables destination overrides when the source already has a live owner", async () => {
    const user = userEvent.setup();
    const role = runtimeRole();
    const runtime: EmbeddedRuntimeState = {
      revision: 2,
      capturedAt: "2026-01-01T00:00:00.000Z",
      windows: [{
        id: "live-window",
        windowId: "live-window",
        displayId: 1,
        bounds: { x: 0, y: 0, width: 900, height: 700 },
        visible: true,
        activeTabId: "tab-role",
        tabCount: 1
      }],
      tabs: [{
        id: "tab-role",
        type: "role",
        sourceId: role.id,
        name: role.name,
        windowId: "live-window",
        roleIds: [role.id],
        slots: [],
        hidden: false,
        active: true,
        audible: false,
        audioMuted: false
      }]
    };

    renderRoles(role, runtime, [gameWindow("live-window", "Main Window")], vi.fn());

    expect(screen.getByRole("button", { name: "Open" }).title).toBe(
      "Switch to the existing source in Main Window"
    );
    await user.click(screen.getByRole("button", { name: "Role actions" }));
    expect(screen.getByRole("menuitem", { name: "Open in…" }).hasAttribute("data-disabled")).toBe(true);
  });

  it("offers the same explicit destination choices from a workspace context menu", async () => {
    const user = userEvent.setup();
    const role = runtimeRole();
    const workspace = runtimeWorkspace(role.id);
    const onLaunchWorkspace = vi.fn();
    const runtime: EmbeddedRuntimeState = {
      revision: 3,
      capturedAt: "2026-01-01T00:00:00.000Z",
      windows: [],
      tabs: []
    };
    const { container } = render(
      <LaunchWorkspacesRoute
        busyWorkspaceIds={new Set()}
        games={[]}
        gameWindows={[]}
        isReordering={false}
        query=""
        roles={[role]}
        runtime={runtime}
        scrollPositionRef={{ current: 0 }}
        t={t}
        workspaces={[workspace]}
        onCopyWorkspace={vi.fn()}
        onCreateWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onDeleteWorkspaces={vi.fn().mockResolvedValue(false)}
        onEditWorkspace={vi.fn()}
        onLaunchWorkspace={onLaunchWorkspace}
        onQueryChange={vi.fn()}
        onReorderWorkspaces={vi.fn()}
      />
    );

    const card = container.querySelector<HTMLElement>("[data-workspace-reorder-id]");
    if (!card) throw new Error("Expected workspace card.");
    fireEvent.contextMenu(card, { clientX: 100, clientY: 100 });
    const openIn = screen.getByRole("menuitem", { name: "Open in…" });
    openIn.focus();
    await user.keyboard("{ArrowRight}");
    await user.click(screen.getByRole("menuitem", { name: /New Game Window/ }));

    expect(onLaunchWorkspace).toHaveBeenCalledWith(workspace, { kind: "new-window" });
  });
});

function renderRoles(
  role: Role,
  runtime: EmbeddedRuntimeState,
  gameWindows: GameWindow[],
  onLaunch: (roleId: string, destination?: RuntimeLaunchDestination) => void
): void {
  render(
    <RolesRoute
      activeFilter="all"
      busyRoleIds={new Set()}
      filteredRoles={[role]}
      games={[]}
      gameWindows={gameWindows}
      isReordering={false}
      language="en"
      roleStats={{ total: 1, running: runtime.tabs.length > 0 ? 1 : 0, stopped: 0 }}
      roles={[role]}
      runtime={runtime}
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
    />
  );
}

const t: Translator = (key) => en[key];

function runtimeRole(): Role {
  return {
    id: "role-main",
    gameId: "game-main",
    name: "Main Role",
    launchUrl: "https://example.test/play",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function gameWindow(id: string, name: string): GameWindow {
  const bounds = { x: 0, y: 0, width: 900, height: 700 };
  return {
    id,
    name,
    targetDisplay: { id: 1 },
    placement: {
      normalBounds: bounds,
      savedWorkArea: bounds,
      presentation: "normal"
    },
    tabs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function runtimeWorkspace(roleId: string): LaunchWorkspace {
  return {
    id: "workspace-main",
    name: "Main Workspace",
    template: "single",
    slots: [{
      id: "slot-main",
      roleId,
      rect: { x: 0, y: 0, width: 1, height: 1 }
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
