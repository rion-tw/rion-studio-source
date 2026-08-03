// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { GameWindowContentPicker } from "../src/renderer/src/features/game-windows/GameWindowContentPicker";
import GameWindowEditorRoute from "../src/renderer/src/features/game-windows/GameWindowModal";
import GameWindowsRoute from "../src/renderer/src/features/game-windows/GameWindowsRoute";
import { GameWindowSavedTabsEditor } from "../src/renderer/src/features/game-windows/GameWindowSavedTabsEditor";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { EmbeddedRuntimeState, Game, GameWindow, LaunchWorkspace, Role } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

afterEach(cleanup);

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
});

describe("Game Window management", () => {
  it("shows persistent placement and tab state with simplified tab controls", async () => {
    const user = userEvent.setup();
    const showGameWindow = vi.fn(() => Promise.resolve());
    const showGameWindowTab = vi.fn(() => Promise.resolve());
    const hideGameWindow = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        showGameWindow,
        showGameWindowTab,
        reorderGameWindowTab: vi.fn(() => Promise.resolve()),
        stopGameWindowTab: vi.fn(() => Promise.resolve()),
        hideGameWindow,
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[gameWindow]}
          games={[game]}
          roles={[role]}
          runtime={runtime}
          t={t}
          workspaces={[]}
          onEdit={vi.fn()}
          onError={vi.fn()}
          onNew={vi.fn()}
        />
      </ConfirmationProvider>
    );

    expect(screen.getByText("Raid window")).toBeTruthy();
    expect(screen.getByText("Studio Display")).toBeTruthy();
    expect(screen.getByText("Hidden")).toBeTruthy();
    expect(screen.getByText("1 tabs")).toBeTruthy();
    expect(screen.getByText("Active: Mina")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: /Mina/ }));
    await user.click(screen.getByRole("button", { name: "Game window actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Hide window" }));

    expect(showGameWindow).toHaveBeenCalledWith("window-1");
    expect(showGameWindowTab).toHaveBeenCalledWith("tab-1");
    expect(hideGameWindow).toHaveBeenCalledWith("window-1");
    expect(screen.getByRole("button", { name: "Move tab up" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Move tab down" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mute tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop tab" })).toBeNull();
  });

  it("reorders live tabs and closes them through the native tab-close operation", async () => {
    const user = userEvent.setup();
    const reorderGameWindowTab = vi.fn(() => Promise.resolve());
    const stopGameWindowTab = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        showGameWindow: vi.fn(() => Promise.resolve()),
        showGameWindowTab: vi.fn(() => Promise.resolve()),
        reorderGameWindowTab,
        stopGameWindowTab,
        hideGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[multiTabGameWindow]}
          games={[game]}
          roles={[role]}
          runtime={multiTabRuntime}
          t={t}
          workspaces={[]}
          onEdit={vi.fn()}
          onError={vi.fn()}
          onNew={vi.fn()}
        />
      </ConfirmationProvider>
    );

    const moveUpButtons = screen.getAllByRole("button", { name: "Move tab up" });
    const moveDownButtons = screen.getAllByRole("button", { name: "Move tab down" });
    expect(moveUpButtons[0]).toHaveProperty("disabled", true);
    expect(moveDownButtons[2]).toHaveProperty("disabled", true);

    await user.click(moveDownButtons[0]);
    await waitFor(() => expect(reorderGameWindowTab).toHaveBeenCalledWith("tab-1", "tab-3"));
    await user.click(moveUpButtons[1]);
    await waitFor(() => expect(reorderGameWindowTab).toHaveBeenCalledWith("tab-2", "tab-1"));
    await user.click(screen.getAllByRole("button", { name: "Close tab" })[2]);

    expect(stopGameWindowTab).toHaveBeenCalledWith("tab-3");
  });

  it("rejects synchronous duplicate actions for the same window", async () => {
    let resolveShow: (() => void) | undefined;
    const showGameWindow = vi.fn(() => new Promise<void>((resolve) => {
      resolveShow = resolve;
    }));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        showGameWindow,
        showGameWindowTab: vi.fn(() => Promise.resolve()),
        moveGameWindowTab: vi.fn(() => Promise.resolve()),
        moveGameWindowTabToNewWindow: vi.fn(() => Promise.resolve(gameWindow)),
        setGameWindowTabMuted: vi.fn(() => Promise.resolve()),
        setGameWindowTabHidden: vi.fn(() => Promise.resolve()),
        stopGameWindowTab: vi.fn(() => Promise.resolve()),
        hideGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[gameWindow]}
          games={[game]}
          roles={[role]}
          runtime={runtime}
          t={t}
          workspaces={[]}
          onEdit={vi.fn()}
          onError={vi.fn()}
          onNew={vi.fn()}
        />
      </ConfirmationProvider>
    );

    const showButton = screen.getByRole("button", { name: "Show" });
    act(() => {
      showButton.click();
      showButton.click();
    });

    expect(showGameWindow).toHaveBeenCalledTimes(1);
    expect(showButton).toHaveProperty("disabled", true);

    await act(async () => {
      resolveShow?.();
    });
    await waitFor(() => expect(showButton).toHaveProperty("disabled", false));
  });

  it("adds an existing stopped role to the selected game window", async () => {
    const user = userEvent.setup();
    const launchRole = vi.fn(() => Promise.resolve({ windowId: "window-1", status: null }));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        launchRole,
        showGameWindow: vi.fn(() => Promise.resolve()),
        showGameWindowTab: vi.fn(() => Promise.resolve()),
        moveGameWindowTab: vi.fn(() => Promise.resolve()),
        moveGameWindowTabToNewWindow: vi.fn(() => Promise.resolve(gameWindow)),
        setGameWindowTabMuted: vi.fn(() => Promise.resolve()),
        setGameWindowTabHidden: vi.fn(() => Promise.resolve()),
        stopGameWindowTab: vi.fn(() => Promise.resolve()),
        hideGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[emptyGameWindow]}
          games={[game]}
          roles={[role]}
          runtime={liveEmptyRuntime}
          t={t}
          workspaces={[]}
          onEdit={vi.fn()}
          onError={vi.fn()}
          onNew={vi.fn()}
        />
      </ConfirmationProvider>
    );

    await user.click(screen.getAllByRole("button", { name: "Add" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Add to Raid window" });
    expect(within(dialog).getByText("Mina")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    expect(launchRole).toHaveBeenCalledWith("role-1", { windowId: "window-1" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add to Raid window" })).toBeNull());
  });

  it("confirms workspace conflicts while preserving the target window", async () => {
    const user = userEvent.setup();
    const launchWorkspace = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "conflict",
        windowId: "window-1",
        conflicts: [{
          roleIds: ["role-1"],
          roleNames: ["Mina"],
          tabId: "other-tab",
          tabName: "Mina",
          windowId: "window-2",
          windowName: "Other window"
        }]
      })
      .mockResolvedValueOnce({ kind: "launched", windowId: "window-1", statuses: [] });
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        launchWorkspace,
        showGameWindow: vi.fn(() => Promise.resolve()),
        showGameWindowTab: vi.fn(() => Promise.resolve()),
        moveGameWindowTab: vi.fn(() => Promise.resolve()),
        moveGameWindowTabToNewWindow: vi.fn(() => Promise.resolve(gameWindow)),
        setGameWindowTabMuted: vi.fn(() => Promise.resolve()),
        setGameWindowTabHidden: vi.fn(() => Promise.resolve()),
        stopGameWindowTab: vi.fn(() => Promise.resolve()),
        hideGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[emptyGameWindow]}
          games={[game]}
          roles={[role]}
          runtime={liveEmptyRuntime}
          t={t}
          workspaces={[workspace]}
          onEdit={vi.fn()}
          onError={vi.fn()}
          onNew={vi.fn()}
        />
      </ConfirmationProvider>
    );

    await user.click(screen.getAllByRole("button", { name: "Add" })[0]);
    await user.click(screen.getByRole("button", { name: /Workspaces/ }));
    const picker = screen.getByRole("dialog", { name: "Add to Raid window" });
    await user.click(within(picker).getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("button", { name: "Stop and launch" }));

    expect(launchWorkspace).toHaveBeenNthCalledWith(1, "workspace-1", { windowId: "window-1" });
    expect(launchWorkspace).toHaveBeenNthCalledWith(2, "workspace-1", {
      windowId: "window-1",
      stopConflicts: true
    });
  });

  it("opens the editor instead of launching when an offline window is selected", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const launchRole = vi.fn(() => Promise.resolve({ windowId: "window-1", status: null }));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { launchRole }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[emptyGameWindow]}
          games={[game]}
          roles={[role]}
          runtime={{ ...runtime, tabs: [], windows: [] }}
          t={t}
          workspaces={[]}
          onEdit={onEdit}
          onError={vi.fn()}
          onNew={vi.fn()}
        />
      </ConfirmationProvider>
    );

    await user.click(screen.getAllByRole("button", { name: "Add" })[0]);

    expect(onEdit).toHaveBeenCalledWith("window-1");
    expect(launchRole).not.toHaveBeenCalled();
  });

  it("saves an offline tab draft without calling launch or runtime APIs", async () => {
    const user = userEvent.setup();
    const onAddSavedTab = vi.fn();
    const launchRole = vi.fn();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { launchRole }
    });

    render(
      <ConfirmationProvider>
        <GameWindowContentPicker
          gameWindows={[emptyGameWindow]}
          games={[game]}
          mode="saved"
          onClose={vi.fn()}
          onAddSavedTab={onAddSavedTab}
          onError={vi.fn()}
          open
          roles={[role]}
          runtime={{ ...runtime, tabs: [], windows: [] }}
          t={t}
          targetWindow={emptyGameWindow}
          workspaces={[]}
        />
      </ConfirmationProvider>
    );

    const dialog = screen.getByRole("dialog", { name: "Add to Raid window" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(onAddSavedTab).toHaveBeenCalledWith(expect.objectContaining({
      tabType: "role",
      sourceId: "role-1",
      roleIds: ["role-1"]
    }));
    expect(launchRole).not.toHaveBeenCalled();
  });

  it("submits the complete saved tab draft while the window is live", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(emptyGameWindow);
    const launchRole = vi.fn();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { launchRole }
    });
    const router = createMemoryRouter([
      {
        path: "/game-windows/:id/edit",
        element: (
          <GameWindowEditorRoute
            displays={[display]}
            gameWindows={[emptyGameWindow]}
            games={[game]}
            isSaving={false}
            onError={vi.fn()}
            roles={[role]}
            runtime={liveEmptyRuntime}
            t={t}
            workspaces={[]}
            onSave={onSave}
          />
        )
      }
    ], { initialEntries: ["/game-windows/window-1/edit"] });

    render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    expect(screen.getByText("This window is running. Saved tab changes will apply the next time it starts.")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Add" })[0]);
    const dialog = screen.getByRole("dialog", { name: "Add to Raid window" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      id: "window-1",
      tabs: [expect.objectContaining({ sourceId: "role-1", tabType: "role" })],
      activeTabId: expect.any(String)
    });
    expect(launchRole).not.toHaveBeenCalled();
  });

  it("reorders and removes saved tabs without runtime calls", async () => {
    const user = userEvent.setup();
    let tabs = [gameWindow.tabs[0], {
      ...gameWindow.tabs[0],
      id: "tab-2",
      sourceId: "role-2",
      name: "Second",
      roleIds: ["role-2"]
    }];
    const onChange = vi.fn((next: typeof tabs) => {
      tabs = next;
    });
    const { rerender } = render(<GameWindowSavedTabsEditor tabs={tabs} t={t} onAdd={vi.fn()} onChange={onChange} />);

    await user.click(screen.getAllByRole("button", { name: "Move tab down" })[0]);
    expect(tabs.map((tab) => tab.id)).toEqual(["tab-2", "tab-1"]);
    rerender(<GameWindowSavedTabsEditor tabs={tabs} t={t} onAdd={vi.fn()} onChange={onChange} />);
    await user.click(screen.getAllByRole("button", { name: "Remove saved tab" })[0]);

    expect(tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
  });
});

const display = {
  id: 7,
  label: "Studio Display",
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 24, width: 1920, height: 1056 },
  resolution: { width: 3840, height: 2160 },
  scaleFactor: 2,
  isPrimary: true,
  isInternal: false
};

const gameWindow: GameWindow = {
  id: "window-1",
  name: "Raid window",
  targetDisplay: { id: 7 },
  placement: {
    normalBounds: { x: 160, y: 120, width: 1280, height: 800 },
    savedWorkArea: display.workArea,
    presentation: "normal"
  },
  tabs: [{
    id: "tab-1",
    tabType: "role",
    sourceId: "role-1",
    name: "Mina",
    roleIds: ["role-1"],
    roleViews: [],
    hidden: false,
    audioMuted: false
  }],
  activeTabId: "tab-1",
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T00:00:00Z"
};

const emptyGameWindow: GameWindow = {
  ...gameWindow,
  tabs: [],
  activeTabId: undefined
};

const multiTabGameWindow: GameWindow = {
  ...gameWindow,
  tabs: [
    gameWindow.tabs[0],
    {
      ...gameWindow.tabs[0],
      id: "tab-2",
      name: "Rhea",
      roleIds: ["role-2"],
      sourceId: "role-2"
    },
    {
      ...gameWindow.tabs[0],
      id: "tab-3",
      name: "Sora",
      roleIds: ["role-3"],
      sourceId: "role-3"
    }
  ]
};

const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Flyff",
  defaultLaunchUrl: "https://example.com/play",
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T00:00:00Z"
};

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Mina",
  launchUrl: "https://example.com/play",
  notes: "",
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T00:00:00Z"
};

const workspace: LaunchWorkspace = {
  id: "workspace-1",
  name: "Party",
  template: "single",
  slots: [{
    id: "slot-1",
    roleId: "role-1",
    rect: { x: 0, y: 0, width: 1, height: 1 }
  }],
  createdAt: "2026-07-27T00:00:00Z",
  updatedAt: "2026-07-27T00:00:00Z"
};

const runtime: EmbeddedRuntimeState = {
  revision: 1,
  capturedAt: "2026-08-03T00:00:00Z",
  tabs: [{
    id: "tab-1",
    type: "role",
    sourceId: "role-1",
    name: "Mina",
    windowId: "window-1",
    roleIds: ["role-1"],
    hidden: false,
    active: true,
    audible: false,
    audioMuted: false
  }],
  windows: [{
    id: "window-1",
    windowId: "window-1",
    displayId: 7,
    bounds: gameWindow.placement.normalBounds,
    visible: false,
    tabCount: 1
  }],
  savedWindows: []
};

const liveEmptyRuntime: EmbeddedRuntimeState = {
  ...runtime,
  tabs: [],
  windows: [runtime.windows[0]]
};

const multiTabRuntime: EmbeddedRuntimeState = {
  ...runtime,
  tabs: multiTabGameWindow.tabs.map((tab, index) => ({
    ...runtime.tabs[0],
    id: tab.id,
    sourceId: tab.sourceId,
    name: tab.name,
    roleIds: tab.roleIds,
    active: index === 0
  })),
  windows: [{ ...runtime.windows[0], tabCount: multiTabGameWindow.tabs.length }]
};
