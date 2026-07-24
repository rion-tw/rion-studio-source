import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  buildAppQuickMenuTemplate,
  type AppQuickMenuActions,
  type AppQuickMenuState
} from "../src/main/menu/AppQuickMenuTemplate";
import type {
  EmbeddedRuntimeWindowSummary,
  WorkspaceDisplayInfo
} from "../src/shared/types";

describe("buildAppQuickMenuTemplate", () => {
  it("renders macOS 14 game windows as a direct native-header group with display names", () => {
    const actions = createActions();
    const template = buildAppQuickMenuTemplate(
      createState({
        platform: "darwin",
        runtimeWindows: [
          runtimeWindow(11, 1, true),
          runtimeWindow(12, 2, false)
        ],
        statuses: [{ roleId: "role-1", state: "running" }],
        systemVersion: "14.6.1",
        workspaceDisplays: [
          workspaceDisplay(11, "Built-in Retina Display"),
          workspaceDisplay(12, "Studio Display")
        ]
      }),
      actions
    );

    expect(template.map((item) => item.label ?? item.type)).toEqual([
      "Game Windows",
      "Built-in Retina Display · 1 tab",
      "Studio Display · 2 tabs",
      "separator",
      "Roles",
      "Workspaces",
      "separator",
      "Show All Game Windows",
      "Stop All Running Roles"
    ]);
    expect(template.some((item) => item.label === "Open Rion Studio")).toBe(false);

    const header = getItem(template, "Game Windows");
    expect(header).toMatchObject({ type: "header" });
    expect(header.submenu).toBeUndefined();
    expect(getItem(template, "Built-in Retina Display · 1 tab").sublabel).toBe("Visible");
    expect(getItem(template, "Studio Display · 2 tabs").sublabel).toBe("Hidden");

    getItem(template, "Show All Game Windows").click?.({} as never, undefined, {} as never);
    getItem(template, "Stop All Running Roles").click?.({} as never, undefined, {} as never);
    getItem(template, "Studio Display · 2 tabs").click?.({} as never, undefined, {} as never);

    expect(actions.showAllGameWindows).toHaveBeenCalledOnce();
    expect(actions.stopAll).toHaveBeenCalledOnce();
    expect(actions.showGameWindow).toHaveBeenCalledWith(12);
  });

  it.each([
    { platform: "darwin" as const, systemVersion: "13.7.8" },
    { platform: "win32" as const, systemVersion: undefined }
  ])("uses a disabled direct group label on $platform", ({ platform, systemVersion }) => {
    const template = buildAppQuickMenuTemplate(
      createState({
        platform,
        runtimeWindows: [runtimeWindow(11, 1, true)],
        ...(systemVersion ? { systemVersion } : {})
      }),
      createActions()
    );

    const header = getItem(template, "Game Windows");
    expect(header.enabled).toBe(false);
    expect(header.type).toBeUndefined();
    expect(header.submenu).toBeUndefined();
  });

  it("falls back to the display id when a display label is blank or unavailable", () => {
    const template = buildAppQuickMenuTemplate(
      createState({
        runtimeWindows: [
          runtimeWindow(12, 1, true),
          runtimeWindow(13, 3, true)
        ],
        workspaceDisplays: [workspaceDisplay(12, "   ")]
      }),
      createActions()
    );

    expect(getItem(template, "Display 12 · 1 tab")).toBeDefined();
    expect(getItem(template, "Display 13 · 3 tabs")).toBeDefined();
  });

  it("omits the entire group and leading separator when there are no game windows", () => {
    const template = buildAppQuickMenuTemplate(createState(), createActions());

    expect(template[0]?.label).toBe("Roles");
    expect(template.some((item) => item.label === "Game Windows")).toBe(false);
    expect(template.some((item) => item.label === "Show All Game Windows")).toBe(false);
    expect(template.some((item) => item.label === "Open Rion Studio")).toBe(false);
  });
});

function createState(overrides: Partial<AppQuickMenuState> = {}): AppQuickMenuState {
  return {
    includeQuit: false,
    legalAccepted: true,
    platform: "win32",
    roles: [],
    runtimeWindows: [],
    statuses: [],
    workspaceDisplays: [],
    workspaces: [],
    workspaceStatuses: [],
    ...overrides
  };
}

function createActions(): AppQuickMenuActions {
  return {
    launchRole: vi.fn(),
    launchWorkspace: vi.fn(),
    openApp: vi.fn(),
    showAllGameWindows: vi.fn(),
    showGameWindow: vi.fn(),
    stopAll: vi.fn(),
    stopWorkspace: vi.fn()
  };
}

function runtimeWindow(
  displayId: number,
  tabCount: number,
  visible: boolean
): EmbeddedRuntimeWindowSummary {
  return {
    displayId,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    tabCount,
    visible
  };
}

function workspaceDisplay(id: number, label: string): WorkspaceDisplayInfo {
  return {
    id,
    label,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    resolution: { width: 1920, height: 1080 },
    scaleFactor: 1,
    isPrimary: id === 11,
    isInternal: id === 11
  };
}

function getItem(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions {
  const item = template.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`Menu item not found: ${label}`);
  return item;
}
