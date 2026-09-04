// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { QuickAccessPalette } from "../src/renderer/src/features/quick-access/QuickAccessPalette";
import {
  createQuickAccessCatalog,
  filterQuickAccessItems,
  isQuickAccessShortcut,
  normalizeQuickAccessSearch,
  type QuickAccessItem
} from "../src/renderer/src/features/quick-access/quickAccessModel";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type {
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  LaunchWorkspace,
  Macro,
  QuickAccessPreferences,
  Role,
  RoleStatus
} from "../src/shared/types";

const t: Translator = (key) => en[key];

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value: function close(this: HTMLDialogElement): void {
        this.removeAttribute("open");
        queueMicrotask(() => this.dispatchEvent(new Event("close")));
      }
    },
    showModal: {
      configurable: true,
      value: function showModal(this: HTMLDialogElement): void {
        this.setAttribute("open", "");
      }
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("quick access model", () => {
  it("recognizes only the fixed platform shortcut and ignores IME and repeat events", () => {
    const event = {
      altKey: false,
      ctrlKey: false,
      isComposing: false,
      key: "k",
      metaKey: true,
      repeat: false,
      shiftKey: false
    };
    expect(isQuickAccessShortcut(event, "mac")).toBe(true);
    expect(isQuickAccessShortcut({ ...event, repeat: true }, "mac")).toBe(false);
    expect(isQuickAccessShortcut({ ...event, isComposing: true }, "mac")).toBe(false);
    expect(isQuickAccessShortcut({ ...event, metaKey: false, ctrlKey: true }, "windows")).toBe(true);
    expect(isQuickAccessShortcut({ ...event, metaKey: true, ctrlKey: true }, "windows")).toBe(false);
  });

  it("normalizes Unicode queries and indexes only safe names and associations", () => {
    expect(normalizeQuickAccessSearch("  ＭＡＩＮ   Role ")).toBe("main role");
    const catalog = catalogFor({
      runtime: runtimeWithRoleOwner(),
      preferences: { pinnedItems: [], recentItems: [] }
    });

    expect(filterQuickAccessItems(catalog, "Game Alpha").some((item) => item.key === "role:r1")).toBe(true);
    expect(filterQuickAccessItems(catalog, "Role One").some((item) => item.key === "workspace:w1")).toBe(true);
    expect(filterQuickAccessItems(catalog, "Main Window").some((item) => item.key === "role:r1")).toBe(true);
    expect(filterQuickAccessItems(catalog, "secret-note")).toEqual([]);
    expect(filterQuickAccessItems(catalog, "example.test/private")).toEqual([]);
    expect(filterQuickAccessItems(catalog, "delay-step-secret")).toEqual([]);
  });

  it("groups blank results by pinned insertion, MRU, and pages", () => {
    const preferences: QuickAccessPreferences = {
      pinnedItems: [
        { kind: "workspace", id: "w1" },
        { kind: "role", id: "r1" }
      ],
      recentItems: [
        { kind: "macro", id: "m1" },
        { kind: "workspace", id: "w1" },
        { kind: "gameWindow", id: "gw1" }
      ]
    };
    const results = filterQuickAccessItems(catalogFor({ preferences }), "");

    expect(results.slice(0, 4).map((item) => [item.key, item.group])).toEqual([
      ["workspace:w1", "pinned"],
      ["role:r1", "pinned"],
      ["macro:m1", "recent"],
      ["gameWindow:gw1", "recent"]
    ]);
    expect(results.filter((item) => item.kind === "route").map((item) => item.routeId)).toEqual([
      "dashboard", "games", "roles", "workspaces", "gameWindows", "macros", "settings"
    ]);
  });

  it("ranks text match before pin, active state, MRU, and name and caps results", () => {
    const catalog = catalogFor({
      preferences: {
        pinnedItems: [{ kind: "workspace", id: "w1" }],
        recentItems: [{ kind: "macro", id: "m1" }, { kind: "role", id: "r1" }]
      },
      runtime: runtimeWithRoleOwner()
    });
    const broad = catalog.map((item) => ({ ...item, searchText: "shared" })) as QuickAccessItem[];
    const ranked = filterQuickAccessItems(broad, "shared");
    expect(ranked[0].key).toBe("workspace:w1");
    expect(ranked[1].key).toBe("role:r1");
    expect(ranked[2].key).toBe("gameWindow:gw1");
    expect(ranked[3].key).toBe("macro:m1");
    expect(filterQuickAccessItems(Array.from({ length: 70 }, (_, index) => ({
      ...broad[0], key: `role:${index}`, label: `Role ${index}`
    })), "shared")).toHaveLength(50);
  });

  it("projects exact runtime ownership and running macro behavior onto source rows", () => {
    const catalog = catalogFor({ runtime: runtimeWithRoleOwner(), macroRunning: true });
    const role = catalog.find((item) => item.key === "role:r1");
    const macro = catalog.find((item) => item.key === "macro:m1");
    expect(role?.active).toBe(true);
    expect(role?.subtitle).toBe("Main Window · Role One");
    expect(catalog.filter((item) => item.key === "role:r1")).toHaveLength(1);
    expect(macro?.active).toBe(true);
    expect(macro?.disabled).toBe(false);
    expect(macro?.subtitle).toContain("Open in macro list");
  });

  it("enables Web-only workspaces and disables saved empty workspaces", () => {
    const webWorkspace = webOnlyWorkspace();
    const emptyWorkspace = emptyWorkspaceDefinition();
    const catalog = catalogFor({ workspaces: [webWorkspace, emptyWorkspace] });
    const webItem = catalog.find((item) => item.key === `workspace:${webWorkspace.id}`);
    const emptyItem = catalog.find((item) => item.key === `workspace:${emptyWorkspace.id}`);

    expect(webItem).toMatchObject({ disabled: false, subtitle: "1 Web App" });
    expect(emptyItem).toMatchObject({ disabled: true, subtitle: "Not configured" });
    expect(
      filterQuickAccessItems(catalog, "Video room").some((item) => item.key === webItem?.key)
    ).toBe(true);
  });
});

describe("quick access palette", () => {
  it("settles modal focus restoration before launch and reopens only after failure", async () => {
    const user = userEvent.setup();
    let finishExecution!: (succeeded: boolean) => void;
    let dialogCloseCompleted = false;
    const onExecute = vi.fn(() => new Promise<boolean>((resolve) => {
      expect(dialogCloseCompleted).toBe(true);
      finishExecution = resolve;
    }));
    render(<PaletteHarness onExecute={onExecute} onSetPinned={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    const dialog = screen.getByTestId("quick-access-palette");
    dialog.addEventListener("close", () => {
      dialogCloseCompleted = true;
    }, { once: true });
    const execution = user.keyboard("{Enter}");
    await waitFor(() => expect(onExecute).toHaveBeenCalledOnce());
    expect(dialog.hasAttribute("open")).toBe(false);

    finishExecution(false);
    await execution;
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("supports mouse and keyboard, preserves failed queries, and restores focus on close", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn().mockResolvedValue(false);
    const onSetPinned = vi.fn().mockResolvedValue(true);
    render(<PaletteHarness onExecute={onExecute} onSetPinned={onSetPinned} />);

    const trigger = screen.getByRole("button", { name: "Open palette" });
    trigger.focus();
    await user.click(trigger);
    const search = screen.getByRole("combobox");
    expect(document.activeElement).toBe(search);
    await user.type(search, "Role One");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ key: "role:r1" }),
      undefined
    ));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Role One");
    expect(screen.getByTestId("quick-access-palette").hasAttribute("open")).toBe(true);

    const roleOption = screen.getByRole("option", { name: /Role One/ });
    const roleRow = roleOption.parentElement;
    const openIn = roleRow?.querySelector<HTMLButtonElement>("button[aria-label='Open in…']");
    if (!openIn) throw new Error("Role destination menu is unavailable");
    await user.click(openIn);
    const destination = screen.getByRole("menuitem", { name: /New Game Window/ });
    expect(destination.closest("dialog")).toBe(screen.getByTestId("quick-access-palette"));
    await user.click(destination);
    await waitFor(() => expect(onExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: "role:r1" }),
      { kind: "new-window" }
    ));

    await user.click(screen.getByRole("button", { name: "Pin Role One" }));
    expect(onSetPinned).toHaveBeenCalledWith(
      { kind: "role", id: "r1" },
      true
    );

    search.focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("does not restore launcher focus after committing a runtime destination", async () => {
    const user = userEvent.setup();
    const onExecute = vi.fn(() => new Promise<boolean>(() => undefined));
    render(<PaletteHarness onExecute={onExecute} onSetPinned={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await user.type(screen.getByRole("combobox"), "Role One");
    const roleOption = screen.getByRole("option", { name: /Role One/ });
    const openIn = roleOption.parentElement?.querySelector<HTMLButtonElement>(
      "button[aria-label='Open in…']"
    );
    if (!openIn) throw new Error("Role destination menu is unavailable");
    await user.click(openIn);
    await user.click(screen.getByRole("menuitem", { name: /New Game Window/ }));

    await waitFor(() => expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({ key: "role:r1" }),
      { kind: "new-window" }
    ));
    expect(document.activeElement).not.toBe(openIn);
  });
});

function PaletteHarness({
  onExecute,
  onSetPinned
}: {
  onExecute: (item: QuickAccessItem) => Promise<boolean>;
  onSetPinned: (item: { kind: "role" | "workspace" | "gameWindow" | "macro"; id: string }, pinned: boolean) => Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [restoreFocus, setRestoreFocus] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open palette</button>
      <QuickAccessPalette
        catalog={catalogFor({})}
        gameWindows={[gameWindow()]}
        open={open}
        runtime={emptyRuntime()}
        shortcutLabel="Ctrl+K"
        t={t}
        onExecute={onExecute}
        onClose={(reason) => {
          setRestoreFocus(reason === "cancel");
          setOpen(false);
        }}
        onDidClose={() => setRestoreFocus(true)}
        onSetPinned={onSetPinned}
        restoreDomFocusOnClose={restoreFocus}
      />
    </>
  );
}

function catalogFor({
  macroRunning = false,
  preferences = { pinnedItems: [], recentItems: [] },
  runtime = emptyRuntime(),
  workspaces = [workspace()]
}: {
  macroRunning?: boolean;
  preferences?: QuickAccessPreferences;
  runtime?: EmbeddedRuntimeState;
  workspaces?: LaunchWorkspace[];
}): QuickAccessItem[] {
  const roles = [role()];
  const status: RoleStatus = {
    roleId: "r1",
    state: "running",
    automationState: "ready",
    pageHealth: "healthy"
  };
  return createQuickAccessCatalog({
    busyMacroIds: new Set(),
    busyRoleIds: new Set(),
    busyRunKeys: new Set(),
    busyWorkspaceIds: new Set(),
    games: [game()],
    gameWindows: [gameWindow()],
    macros: [macro()],
    macroStatusByRun: macroRunning
      ? new Map([["r1:m1", {
          roleId: "r1",
          macroId: "m1",
          state: "running",
          startedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z"
        }]])
      : new Map(),
    preferences,
    roles,
    runtime,
    statusByRole: new Map([["r1", status]]),
    t,
    workspaces
  });
}

function emptyRuntime(): EmbeddedRuntimeState {
  return { revision: 1, capturedAt: "2026-01-01T00:00:00Z", tabs: [], windows: [] };
}

function runtimeWithRoleOwner(): EmbeddedRuntimeState {
  return {
    revision: 2,
    capturedAt: "2026-01-01T00:00:00Z",
    windows: [{
      id: "gw1",
      windowId: "gw1",
      displayId: 1,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
      visible: true,
      activeTabId: "tab-r1",
      tabCount: 1,
      presentation: "normal"
    }],
    tabs: [{
      id: "tab-r1",
      type: "role",
      sourceId: "r1",
      name: "Role One",
      windowId: "gw1",
      roleIds: ["r1"],
      slots: [],
      hidden: false,
      active: true,
      audible: false,
      audioMuted: false
    }]
  };
}

function game(): Game {
  return {
    id: "g1",
    source: "custom",
    name: "Game Alpha",
    defaultLaunchUrl: "https://example.test/play",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function role(): Role {
  return {
    id: "r1",
    gameId: "g1",
    name: "Role One",
    launchUrl: "https://example.test/private",
    notes: "secret-note",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function workspace(): LaunchWorkspace {
  return {
    id: "w1",
    name: "Workspace One",
    template: "single",
    slots: [{ id: "slot-1", roleId: "r1", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function webOnlyWorkspace(): LaunchWorkspace {
  return {
    id: "w-web",
    name: "Web Workspace",
    template: "single",
    slots: [{
      id: "slot-web",
      web: { name: "Video room", startUrl: "https://example.test/watch" },
      rect: { x: 0, y: 0, width: 1, height: 1 }
    }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function emptyWorkspaceDefinition(): LaunchWorkspace {
  return {
    id: "w-empty",
    name: "Empty Workspace",
    template: "single",
    slots: [{ id: "slot-empty", rect: { x: 0, y: 0, width: 1, height: 1 } }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function gameWindow(): GameWindow {
  return {
    id: "gw1",
    name: "Main Window",
    targetDisplay: { id: 1 },
    placement: {
      normalBounds: { x: 0, y: 0, width: 1000, height: 700 },
      savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
      presentation: "normal"
    },
    tabs: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}

function macro(): Macro {
  return {
    id: "m1",
    enabled: true,
    activationMode: "toggle",
    name: "Macro One",
    roleIds: ["r1"],
    shortcutSourceScope: { type: "all_execution_roles" },
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "delay", ms: 10 }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z"
  };
}
