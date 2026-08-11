// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import GameWindowsRoute from "../src/renderer/src/features/game-windows/GameWindowsRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { EmbeddedRuntimeState, GameWindow } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value: function close(this: HTMLDialogElement): void { this.removeAttribute("open"); }
    },
    showModal: {
      configurable: true,
      value: function showModal(this: HTMLDialogElement): void { this.setAttribute("open", ""); }
    }
  });
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
    expect(within(table).getByRole("columnheader", { name: /^Window/ })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Runtime status" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Target display" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Active" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Tabs" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Actions" })).toBeTruthy();
    expect(within(table).getByText("Raid window")).toBeTruthy();
    expect(within(table).getByText("Mina")).toBeTruthy();
  });

  it("separates per-window recovery, visibility, and unopened runtime states", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });
    const gameWindowFor = (id: string, name: string): GameWindow => ({ ...gameWindow, id, name });
    const gameWindows = [
      gameWindowFor("awaiting", "Awaiting window"),
      gameWindowFor("restoring", "Restoring window"),
      gameWindowFor("failed", "Failed window"),
      gameWindowFor("visible", "Visible window"),
      gameWindowFor("hidden", "Hidden window"),
      gameWindowFor("dormant", "Dormant window")
    ];
    const runtimeState: EmbeddedRuntimeState = {
      ...emptyRuntime,
      recovery: { reason: "unclean-exit", windowCount: 4, tabCount: 4 },
      savedWindows: [
        savedWindowSummary("awaiting", "awaiting-recovery"),
        savedWindowSummary("restoring", "restoring"),
        savedWindowSummary("failed", "failed"),
        savedWindowSummary("dormant", "dormant")
      ],
      windows: [
        { ...runtime.windows[0], id: "visible", windowId: "visible", visible: true },
        { ...runtime.windows[0], id: "hidden", windowId: "hidden", visible: false }
      ]
    };

    renderRoute({ gameWindows, runtime: runtimeState });

    expect(windowStatus("Awaiting window").textContent).toBe("Awaiting recovery");
    expect(windowStatus("Restoring window").textContent).toBe("Restoring");
    expect(windowStatus("Failed window").textContent).toBe("Restore failed");
    expect(windowStatus("Visible window").textContent).toBe("Visible");
    expect(windowStatus("Hidden window").textContent).toBe("Hidden");
    expect(windowStatus("Dormant window").textContent).toBe("Not open");
    expect(windowStatus("Awaiting window").className).toContain("bg-warning");
    expect(windowStatus("Restoring window").className).toContain("bg-activity");
    expect(windowStatus("Failed window").className).toContain("bg-destructive");
    expect(windowStatus("Visible window").className).toContain("bg-success");

    const table = screen.getByRole("table", { name: "Game Windows" });
    fireEvent.click(within(table).getByTitle("Sort by Runtime status"));
    expect(windowRowIds(table)).toEqual([
      "awaiting",
      "hidden",
      "dormant",
      "failed",
      "restoring",
      "visible"
    ]);
  });

  it("locks restoring window actions while keeping failed restores retryable", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });
    const restoringWindow = { ...gameWindow, id: "restoring", name: "Restoring window" };
    const failedWindow = { ...gameWindow, id: "failed", name: "Failed window" };

    renderRoute({
      gameWindows: [restoringWindow, failedWindow],
      runtime: {
        ...emptyRuntime,
        savedWindows: [
          savedWindowSummary("restoring", "restoring"),
          savedWindowSummary("failed", "failed")
        ]
      }
    });

    const restoringRow = screen.getByText("Restoring window").closest("tr");
    const failedRow = screen.getByText("Failed window").closest("tr");
    if (!restoringRow || !failedRow) throw new Error("Expected recovery state rows.");
    expect(within(restoringRow).getByRole("button", { name: "Show" })).toHaveProperty("disabled", true);
    expect(within(restoringRow).getByRole("button", { name: "Game window actions" }))
      .toHaveProperty("disabled", true);
    expect(within(failedRow).getByRole("button", { name: "Show" })).toHaveProperty("disabled", false);
    expect(within(failedRow).getByRole("button", { name: "Game window actions" }))
      .toHaveProperty("disabled", false);
  });

  it("opens a game window action menu from the row contextmenu event", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });

    const secondWindow = { ...emptyGameWindow, id: "window-2", name: "Social window" };
    renderRoute({ gameWindows: [gameWindow, secondWindow] });

    const selectedRow = screen.getByText("Raid window").closest("tr");
    const row = screen.getByText("Social window").closest("tr");
    if (!selectedRow || !row) throw new Error("Expected game window rows.");

    fireEvent.click(selectedRow, { ctrlKey: true });
    expect(screen.getByText("1 selected")).toBeTruthy();

    expect(fireEvent.contextMenu(row, { clientX: 240, clientY: 160 })).toBe(false);
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Target display" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete window" })).toBeTruthy();
  });

  it("sorts window rows from each data column like the macro list", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });
    const alphaWindow = { ...emptyGameWindow, id: "window-2", name: "Alpha window" };
    const zuluWindow = { ...emptyGameWindow, id: "window-3", name: "Zulu window" };

    renderRoute({ gameWindows: [gameWindow, zuluWindow, alphaWindow] });

    const table = screen.getByRole("table", { name: "Game Windows" });
    expect(within(table).getByTitle("Sort by Window")).toBeTruthy();
    expect(within(table).getByTitle("Sort by Runtime status")).toBeTruthy();
    expect(within(table).getByTitle("Sort by Target display")).toBeTruthy();
    expect(within(table).getByTitle("Sort by Active")).toBeTruthy();
    expect(within(table).getByTitle("Sort by Tabs")).toBeTruthy();
    expect(windowRowIds(table)).toEqual(["window-2", "window-1", "window-3"]);

    const nameSort = within(table).getByTitle("Sort by Window");
    await user.click(nameSort);

    expect(nameSort.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(windowRowIds(table)).toEqual(["window-3", "window-1", "window-2"]);
  });

  it("applies the shared bulk selection UI to game window rows", async () => {
    const user = userEvent.setup();
    const showGameWindow = vi.fn(() => Promise.resolve());
    const hideGameWindow = vi.fn(() => Promise.resolve());
    const stopGameWindow = vi.fn(() => Promise.resolve());
    const deleteGameWindow = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        showGameWindow,
        hideGameWindow,
        stopGameWindow,
        deleteGameWindow
      }
    });
    const secondWindow = { ...emptyGameWindow, id: "window-2", name: "Social window" };

    renderRoute({ gameWindows: [gameWindow, secondWindow] });

    fireEvent.click(screen.getByText("Raid window").closest("tr")!, { ctrlKey: true });
    fireEvent.click(screen.getByText("Social window").closest("tr")!, { ctrlKey: true });

    expect(screen.getByText("2 selected")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.querySelectorAll("[data-selection-id]")).toHaveLength(2);
    expect(document.querySelector("[data-selection-group-outline]")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show 2" }));
    await waitFor(() => expect(showGameWindow).toHaveBeenNthCalledWith(2, "window-2"));

    await user.click(screen.getByRole("button", { name: "Hide 1" }));
    await waitFor(() => expect(hideGameWindow).toHaveBeenCalledWith("window-1"));

    await user.click(screen.getByRole("button", { name: "Stop 1" }));
    await waitFor(() => expect(stopGameWindow).toHaveBeenCalledWith("window-1"));

    await user.click(screen.getByRole("button", { name: "Delete 2" }));
    const dialog = screen.getByRole("dialog", { name: "Delete 2 windows?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteGameWindow).toHaveBeenNthCalledWith(2, "window-2"));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("keeps window management in the list and changes displays from the action submenu", async () => {
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
    expect(screen.queryByText("Windowed")).toBeNull();
    expect(screen.getByText("1 tabs")).toBeTruthy();
    expect(screen.getByText("Mina")).toBeTruthy();
    expect(screen.getByText("Studio Display · Primary")).toBeTruthy();
    const row = screen.getByText("Raid window").closest("tr");
    if (!row) throw new Error("Expected game window row.");
    const cells = within(row).getAllByRole("cell");
    expect(within(cells[1]).queryByText("Windowed")).toBeNull();
    expect(within(cells[2]).getByText("Studio Display · Primary")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Target display" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Rename or change display" })).toBeNull();

    const showButton = screen.getByRole("button", { name: "Show" });
    expect(showButton.textContent).toBe("");

    const actionsButton = screen.getByRole("button", { name: "Game window actions" });
    await user.click(actionsButton);
    const targetDisplayMenuItem = screen.getByRole("menuitem", { name: "Target display" });
    expect(targetDisplayMenuItem.className).toContain("items-center");
    expect(targetDisplayMenuItem.querySelector("span")?.className).toContain("truncate");
    await user.click(targetDisplayMenuItem);

    const selectedDisplay = await screen.findByRole("menuitemradio", { name: "Studio Display · Primary" });
    expect(selectedDisplay.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Side Display" }));

    await waitFor(() => expect(updateGameWindow).toHaveBeenCalledWith("window-1", {
      targetDisplay: expect.objectContaining({ id: 8 }),
      placement: expect.objectContaining({
        normalBounds: { x: 2027, y: 65, width: 853, height: 545 },
        savedWorkArea: secondaryDisplay.workArea
      })
    }));
    expect(screen.queryByRole("toolbar")).toBeNull();

    await user.click(showButton);
    await waitFor(() => expect(actionsButton).toHaveProperty("disabled", false));
    await user.click(actionsButton);
    await user.click(screen.getByRole("menuitem", { name: "Hide window" }));

    await waitFor(() => expect(showGameWindow).toHaveBeenCalledWith("window-1"));
    await waitFor(() => expect(hideGameWindow).toHaveBeenCalledWith("window-1"));
    expect(screen.queryByRole("button", { name: "Move tab up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move tab down" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mute tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop tab" })).toBeNull();
  });

  it("never presents saved window modes as live target-display information", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });
    const gameWindows = (["normal", "maximized", "fullscreen"] as const).map(
      (presentation, index): GameWindow => ({
        ...gameWindow,
        id: `window-${index + 1}`,
        name: `${presentation} window`,
        placement: { ...gameWindow.placement, presentation }
      })
    );

    renderRoute({ gameWindows });

    expect(screen.queryByText("Windowed")).toBeNull();
    expect(screen.queryByText("Maximized")).toBeNull();
    expect(screen.queryByText("Full screen")).toBeNull();
    expect(screen.getAllByText("Studio Display · Primary")).toHaveLength(3);
  });

  it("shows unavailable targets as text while still offering connected displays in the action submenu", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        updateGameWindow: vi.fn(() => Promise.resolve(gameWindow))
      }
    });

    renderRoute({ gameWindows: [{ ...gameWindow, targetDisplay: { id: 99 } }] });

    expect(screen.getByText("Display unavailable")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Target display" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Game window actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Target display" }));

    expect((await screen.findByRole("menuitemradio", { name: "Studio Display · Primary" }))
      .getAttribute("aria-checked")).toBe("false");
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

  it("renames a window from its action menu and locks the dialog while saving", async () => {
    const user = userEvent.setup();
    let resolveRename: ((value: GameWindow) => void) | undefined;
    const updateGameWindow = vi.fn(() => new Promise<GameWindow>((resolve) => {
      resolveRename = resolve;
    }));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        updateGameWindow
      }
    });

    renderRoute();

    await user.click(screen.getByRole("button", { name: "Game window actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Raid window" });
    const input = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(input.value).toBe("Raid window");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Raid window".length);
    expect(within(dialog).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);

    await user.clear(input);
    await user.type(input, "Dungeon window");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateGameWindow).toHaveBeenCalledWith("window-1", { name: "Dungeon window" }));
    expect(input).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);

    await act(async () => {
      resolveRename?.({ ...gameWindow, name: "Dungeon window" });
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename Raid window" })).toBeNull());
  });

  it("keeps invalid names local and cancels a rename without updating the window", async () => {
    const user = userEvent.setup();
    const updateGameWindow = vi.fn(() => Promise.resolve(gameWindow));
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        updateGameWindow
      }
    });

    renderRoute();

    await user.click(screen.getByRole("button", { name: "Game window actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Raid window" });
    const input = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", true);

    await user.clear(input);
    expect(within(dialog).getByText("Game window name is required.")).toBeTruthy();
    expect(save).toHaveProperty("disabled", true);

    fireEvent.change(input, { target: { value: "x".repeat(81) } });
    expect(within(dialog).getByText("Game window name must be 80 characters or fewer.")).toBeTruthy();
    expect(save).toHaveProperty("disabled", true);

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog", { name: "Rename Raid window" })).toBeNull();
    expect(updateGameWindow).not.toHaveBeenCalled();
  });

  it("keeps the rename dialog and draft open when saving fails", async () => {
    const user = userEvent.setup();
    const updateGameWindow = vi.fn(() => Promise.reject(new Error("Rename failed.")));
    const onError = vi.fn();
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: {
        createGameWindow: vi.fn(() => Promise.resolve(gameWindow)),
        updateGameWindow
      }
    });

    renderRoute({ onError });

    await user.click(screen.getByRole("button", { name: "Game window actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Raid window" });
    const input = within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Failed rename");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(updateGameWindow).toHaveBeenCalledWith("window-1", { name: "Failed rename" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
    expect(screen.getByRole("dialog", { name: "Rename Raid window" })).toBe(dialog);
    expect(input.value).toBe("Failed rename");
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

  it("keeps an unopened empty window as a list-only summary", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });

    renderRoute({ gameWindows: [emptyGameWindow], runtime: emptyRuntime });

    expect(screen.getByText("Not open")).toBeTruthy();
    expect(screen.getByText("0 tabs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: /Add to/ })).toBeNull();
  });

  it("reports an empty live window by visibility instead of tab content", () => {
    Object.defineProperty(window, "rionStudio", {
      configurable: true,
      value: { createGameWindow: vi.fn(() => Promise.resolve(gameWindow)) }
    });

    renderRoute({
      gameWindows: [emptyGameWindow],
      runtime: {
        ...emptyRuntime,
        windows: [{ ...runtime.windows[0], visible: true, tabCount: 0 }]
      }
    });

    expect(screen.getByText("Visible")).toBeTruthy();
    expect(screen.getByText("0 tabs")).toBeTruthy();
    expect(screen.queryByText("Empty")).toBeNull();
  });
});

function renderRoute({
  displays = [display],
  gameWindows = [gameWindow],
  onError = vi.fn(),
  runtime: runtimeState = runtime
}: {
  displays?: typeof display[];
  gameWindows?: GameWindow[];
  onError?: (error: unknown) => void;
  runtime?: EmbeddedRuntimeState;
} = {}): void {
  render(
    <ConfirmationProvider>
      <GameWindowsRoute displays={displays} gameWindows={gameWindows} runtime={runtimeState} t={t} onError={onError} />
    </ConfirmationProvider>
  );
}

function windowRowIds(table: HTMLElement): Array<string | null> {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-selection-id"));
}

function windowStatus(windowName: string): HTMLElement {
  const row = screen.getByText(windowName).closest("tr");
  if (!row) throw new Error(`Expected row for ${windowName}.`);
  return within(within(row).getAllByRole("cell")[1]).getByText(/.+/);
}

function savedWindowSummary(
  id: string,
  state: NonNullable<EmbeddedRuntimeState["savedWindows"]>[number]["state"]
): NonNullable<EmbeddedRuntimeState["savedWindows"]>[number] {
  return {
    id,
    displayId: display.id,
    displayLabel: display.label,
    wasVisible: true,
    activeSourceId: "role-1",
    tabCount: 1,
    roleCount: 1,
    tabNames: ["Mina"],
    state,
    ...(state === "failed" ? { failureMessage: "Restore failed." } : {})
  };
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
    roleSlots: [{
      slotId: "slot-role-1",
      roleId: "role-1",
      rect: { x: 0, y: 0, width: 1, height: 1 }
    }],
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
      roleSlots: [{
        slotId: "slot-role-2",
        roleId: "role-2",
        rect: { x: 0, y: 0, width: 1, height: 1 }
      }],
      sourceId: "role-2"
    },
    {
      ...gameWindow.tabs[0],
      id: "tab-3",
      name: "Sora",
      roleSlots: [{
        slotId: "slot-role-3",
        roleId: "role-3",
        rect: { x: 0, y: 0, width: 1, height: 1 }
      }],
      sourceId: "role-3"
    }
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
    slots: [],
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
    roleIds: tab.roleSlots.map((slot) => slot.roleId),
    slots: [],
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
