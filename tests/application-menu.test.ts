import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  APPLICATION_MENU_ZOOM_ITEM_IDS,
  ApplicationMenuController,
  buildApplicationMenuTemplate
} from "../src/main/menu/ApplicationMenu";

const { buildFromTemplate, nativeZoomClicks, setApplicationMenu } = vi.hoisted(() => {
  const nativeZoomClicks: Record<string, ReturnType<typeof vi.fn>> = {
    "rion-browser-reset-zoom": vi.fn(),
    "rion-browser-zoom-in": vi.fn(),
    "rion-browser-zoom-out": vi.fn()
  };
  return {
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({
      getMenuItemById: (id: string) => {
        const source = findMenuItemById(template, id);
        return source ? { ...source, click: nativeZoomClicks[id] ?? source.click } : null;
      },
      template
    })),
    nativeZoomClicks,
    setApplicationMenu: vi.fn()
  };
});

vi.mock("electron", () => ({
  Menu: { buildFromTemplate, setApplicationMenu }
}));

describe("application View menu", () => {
  it.each([
    ["darwin", "Always Show Toolbar in Full Screen"],
    ["win32", "Always Show Toolbar in Full Screen"]
  ] as const)("builds a native checkbox on %s", (platform, expectedLabel) => {
    const template = buildApplicationMenuTemplate({
      alwaysShowToolbarInFullScreen: false,
      language: "en",
      onAlwaysShowToolbarInFullScreenChanged: vi.fn(),
      onToggleFullScreen: vi.fn(),
      platform
    });
    const view = getSubmenu(template, "View");
    expect(view[0]).toMatchObject({ checked: false, label: expectedLabel, type: "checkbox" });
    expect(view.at(-1)).toMatchObject(platform === "darwin"
      ? { accelerator: "Control+Command+F", label: "Toggle Full Screen" }
      : { role: "togglefullscreen" });
    expect(template.find((item) => item.label === "Window")?.role).toBe("windowMenu");
    expect(view.slice(2, 5).map((item) => item.id)).toEqual([
      APPLICATION_MENU_ZOOM_ITEM_IDS.reset,
      APPLICATION_MENU_ZOOM_ITEM_IDS.in,
      APPLICATION_MENU_ZOOM_ITEM_IDS.out
    ]);
  });

  it("runs a native zoom role against the explicitly supplied web contents", () => {
    const controller = new ApplicationMenuController({
      alwaysShowToolbarInFullScreen: false,
      applyAlwaysShowToolbarInFullScreen: vi.fn(),
      platform: "darwin",
      saveAlwaysShowToolbarInFullScreen: vi.fn().mockResolvedValue(undefined)
    });
    const event = { metaKey: true, triggeredByAccelerator: true };
    const runtimeWindow = { id: 42 };
    const gameWebContents = { id: 84 };
    controller.install();

    expect(controller.performZoom(
      "out",
      event as never,
      runtimeWindow as never,
      gameWebContents as never
    )).toBe(true);
    expect(nativeZoomClicks[APPLICATION_MENU_ZOOM_ITEM_IDS.out]).toHaveBeenCalledWith(
      event,
      runtimeWindow,
      gameWebContents
    );
  });

  it("applies immediately and rolls back when persistence fails", async () => {
    const apply = vi.fn();
    const logger = { error: vi.fn() };
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const controller = new ApplicationMenuController({
      alwaysShowToolbarInFullScreen: false,
      applyAlwaysShowToolbarInFullScreen: apply,
      logger,
      platform: "win32",
      saveAlwaysShowToolbarInFullScreen: save
    });
    controller.install();

    const firstTemplate = buildFromTemplate.mock.calls.at(-1)![0];
    const checkbox = getSubmenu(firstTemplate, "View")[0];
    checkbox.click?.({ checked: true } as never, undefined, {} as never);

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(apply.mock.calls).toEqual([[true], [false]]);
    const restoredTemplate = buildFromTemplate.mock.calls.at(-1)![0];
    expect(getSubmenu(restoredTemplate, "View")[0]).toMatchObject({ checked: false });
  });

  it("routes the macOS fullscreen accelerator through the runtime-aware callback", () => {
    const toggleFullScreen = vi.fn();
    const template = buildApplicationMenuTemplate({
      alwaysShowToolbarInFullScreen: false,
      language: "en",
      onAlwaysShowToolbarInFullScreenChanged: vi.fn(),
      onToggleFullScreen: toggleFullScreen,
      platform: "darwin"
    });
    const toggle = getSubmenu(template, "View").at(-1)!;

    toggle.click?.({} as never, undefined, {} as never);

    expect(toggleFullScreen).toHaveBeenCalledOnce();
  });
});

function getSubmenu(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  return template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[];
}

function findMenuItemById(
  template: MenuItemConstructorOptions[],
  id: string
): MenuItemConstructorOptions | undefined {
  for (const item of template) {
    if (item.id === id) {
      return item;
    }
    if (Array.isArray(item.submenu)) {
      const nested = findMenuItemById(item.submenu, id);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}
