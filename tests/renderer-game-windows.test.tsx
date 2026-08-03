// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import GameWindowsRoute from "../src/renderer/src/features/game-windows/GameWindowsRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { EmbeddedRuntimeState, GameWindow } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent
    });
  }
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Game Window management", () => {
  it("presents game windows in labeled management table columns", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });

    renderRoute();

    const table = screen.getByRole("table", { name: "Game Windows" });
    expect(within(table).getByRole("columnheader", { name: "Window" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Target display" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Tabs" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Actions" })).toBeTruthy();
    expect(within(table).getByText("Raid window")).toBeTruthy();
    expect(within(table).getByText("Active: Mina")).toBeTruthy();
  });

  it("keeps window management in the list and delegates tab management to the shown window", async () => {
    const user = userEvent.setup();
    const showGameWindow = vi.fn(() => Promise.resolve());
    const hideGameWindow = vi.fn(() => Promise.resolve());
    const updateGameWindow = vi.fn(() => Promise.resolve(gameWindow));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        showGameWindow,
        showGameWindowTab: vi.fn(() => Promise.resolve()),
        reorderGameWindowTab: vi.fn(() => Promise.resolve()),
        stopGameWindowTab: vi.fn(() => Promise.resolve()),
        updateGameWindow,
        hideGameWindow,
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    renderRoute({ displays: [display, secondaryDisplay] });

    expect(screen.getByText("Raid window")).toBeTruthy();
    expect(screen.getByText("Hidden")).toBeTruthy();
    expect(screen.getByText("1 tabs")).toBeTruthy();
    expect(screen.getByText("Active: Mina")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Target display" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Rename or change display" })).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "Target display" }));
    await user.click(screen.getByRole("option", { name: "Side Display" }));

    await waitFor(() => expect(updateGameWindow).toHaveBeenCalledWith("window-1", {
      targetDisplay: expect.objectContaining({ id: 8 }),
      placement: expect.objectContaining({
        normalBounds: { x: 2027, y: 65, width: 853, height: 545 },
        savedWorkArea: secondaryDisplay.workArea
      })
    }));

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: "Game window actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Hide window" }));

    expect(showGameWindow).toHaveBeenCalledWith("window-1");
    expect(hideGameWindow).toHaveBeenCalledWith("window-1");
    expect(screen.queryByRole("button", { name: "Move tab up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move tab down" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mute tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop tab" })).toBeNull();
  });

  it("creates a default window from the list without opening a window editor", async () => {
    const user = userEvent.setup();
    const createGameWindow = vi.fn(() => Promise.resolve(gameWindow));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute displays={[display]} gameWindows={[]} runtime={emptyRuntime} t={t} onError={vi.fn()} />
      </ConfirmationProvider>
    );

    await user.click(screen.getAllByRole("button", { name: "New game window" })[0]);

    expect(createGameWindow).toHaveBeenCalledWith({
      name: "Game Window 1",
      targetDisplay: expect.objectContaining({ id: 7 }),
      placement: {
        normalBounds: { x: 192, y: 130, width: 1536, height: 845 },
        savedWorkArea: display.workArea,
        presentation: "normal"
      }
    });
  });

  it("does not expose tab reordering or close controls in the list", () => {
    const reorderGameWindowTab = vi.fn(() => Promise.resolve());
    const stopGameWindowTab = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        showGameWindow: vi.fn(() => Promise.resolve()),
        showGameWindowTab: vi.fn(() => Promise.resolve()),
        reorderGameWindowTab,
        stopGameWindowTab,
        hideGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    renderRoute({ gameWindows: [multiTabGameWindow], runtime: multiTabRuntime });

    expect(screen.queryByRole("button", { name: "Move tab up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move tab down" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    expect(reorderGameWindowTab).not.toHaveBeenCalled();
    expect(stopGameWindowTab).not.toHaveBeenCalled();
  });

  it("locks duplicate actions for the same window", async () => {
    let resolveShow: (() => void) | undefined;
    const showGameWindow = vi.fn(() => new Promise<void>((resolve) => {
      resolveShow = resolve;
    }));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        showGameWindow,
        showGameWindowTab: vi.fn(() => Promise.resolve()),
        reorderGameWindowTab: vi.fn(() => Promise.resolve()),
        stopGameWindowTab: vi.fn(() => Promise.resolve()),
        hideGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    renderRoute();

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

  it("keeps an empty window as a list-only summary", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });

    renderRoute({ gameWindows: [emptyGameWindow], runtime: emptyRuntime });

    expect(screen.getByText("Empty")).toBeTruthy();
    expect(screen.getByText("0 tabs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /Add to/ })).toBeNull();
  });
});

function renderRoute({
  displays = [display],
  gameWindows = [gameWindow],
  runtime: runtimeState = runtime
}: {
  displays?: typeof display[];
  gameWindows?: GameWindow[];
  runtime?: EmbeddedRuntimeState;
} = {}): void {
  render(
    <ConfirmationProvider>
      <GameWindowsRoute displays={displays} gameWindows={gameWindows} runtime={runtimeState} t={t} onError={vi.fn()} />
    </ConfirmationProvider>
  );
}

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

const secondaryDisplay = {
  id: 8,
  label: "Side Display",
  bounds: { x: 1920, y: 0, width: 1280, height: 720 },
  workArea: { x: 1920, y: 0, width: 1280, height: 720 },
  resolution: { width: 1280, height: 720 },
  scaleFactor: 1,
  isPrimary: false,
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
    { ...gameWindow.tabs[0], id: "tab-2", name: "Rhea", roleIds: ["role-2"], sourceId: "role-2" },
    { ...gameWindow.tabs[0], id: "tab-3", name: "Sora", roleIds: ["role-3"], sourceId: "role-3" }
  ]
};

const runtime: EmbeddedRuntimeState = {
  revision: 1,
  capturedAt: "2026-07-27T00:00:00Z",
  windows: [{
    id: "runtime-window-1",
    windowId: "window-1",
    displayId: 7,
    bounds: gameWindow.placement.normalBounds,
    visible: false,
    activeTabId: "tab-1",
    tabCount: 1,
    presentation: "normal"
  }],
  tabs: [{
    id: "tab-1",
    windowId: "window-1",
    type: "role",
    sourceId: "role-1",
    roleIds: ["role-1"],
    name: "Mina",
    active: true,
    hidden: false,
    audible: false,
    audioMuted: false
  }]
};

const multiTabRuntime: EmbeddedRuntimeState = {
  ...runtime,
  windows: [{
    ...runtime.windows[0],
    visible: true,
    tabCount: 3
  }],
  tabs: multiTabGameWindow.tabs.map((tab, index) => ({
    id: tab.id,
    windowId: "window-1",
    type: tab.tabType,
    sourceId: tab.sourceId,
    roleIds: tab.roleIds,
    name: tab.name,
    active: index === 0,
    hidden: false,
    audible: false,
    audioMuted: false
  }))
};

const emptyRuntime: EmbeddedRuntimeState = {
  ...runtime,
  windows: [],
  tabs: []
};
