// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import GameWindowsRoute from "../src/renderer/src/features/game-windows/GameWindowsRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { EmbeddedRuntimeState, GameWindow } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

afterEach(cleanup);

describe("Game Window management", () => {
  it("shows persistent placement and tab state and exposes window-scoped actions", async () => {
    const user = userEvent.setup();
    const showGameWindow = vi.fn(() => Promise.resolve());
    const showGameWindowTab = vi.fn(() => Promise.resolve());
    const moveGameWindowTabToNewWindow = vi.fn(() => Promise.resolve(gameWindow));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        showGameWindow,
        showGameWindowTab,
        moveGameWindowTab: vi.fn(() => Promise.resolve()),
        moveGameWindowTabToNewWindow,
        setGameWindowTabMuted: vi.fn(() => Promise.resolve()),
        setGameWindowTabHidden: vi.fn(() => Promise.resolve()),
        stopGameWindowTab: vi.fn(() => Promise.resolve()),
        closeGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[gameWindow]}
          runtime={runtime}
          t={t}
          onEdit={vi.fn()}
          onError={vi.fn()}
          onNew={vi.fn()}
        />
      </ConfirmationProvider>
    );

    expect(screen.getByText("Raid window")).toBeTruthy();
    expect(screen.getByText("Studio Display")).toBeTruthy();
    expect(screen.getByText("Closed")).toBeTruthy();
    expect(screen.getByText("1 tabs")).toBeTruthy();
    expect(screen.getByText("Active: Mina")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.click(screen.getByRole("button", { name: /Mina/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Move to…" }), "new");

    expect(showGameWindow).toHaveBeenCalledWith("window-1");
    expect(showGameWindowTab).toHaveBeenCalledWith("tab-1");
    expect(moveGameWindowTabToNewWindow).toHaveBeenCalledWith("tab-1");
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
        closeGameWindow: vi.fn(() => Promise.resolve()),
        stopGameWindow: vi.fn(() => Promise.resolve()),
        deleteGameWindow: vi.fn(() => Promise.resolve())
      }
    });

    render(
      <ConfirmationProvider>
        <GameWindowsRoute
          displays={[display]}
          gameWindows={[gameWindow]}
          runtime={runtime}
          t={t}
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

const runtime: EmbeddedRuntimeState = {
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
