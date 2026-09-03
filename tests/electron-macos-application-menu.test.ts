import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { installMacosApplicationMenu } from
  "../src/electron/main/macosApplicationMenu";

describe("macOS native application menu", () => {
  it("routes retained AppKit fullscreen and other Core shortcuts through the controller", () => {
    const nativeMenu = { identity: "macos-native-menu" };
    let capturedTemplate: MenuItemConstructorOptions[] = [];
    const buildFromTemplate = vi.fn((template: MenuItemConstructorOptions[]) => {
      capturedTemplate = template;
      return nativeMenu;
    });
    const setApplicationMenu = vi.fn();
    const executeShortcut = vi.fn();
    const executeQuickAccess = vi.fn();

    installMacosApplicationMenu(
      {
        buildFromTemplate: buildFromTemplate as never,
        setApplicationMenu: setApplicationMenu as never
      },
      "Rion Studio",
      executeShortcut,
      executeQuickAccess
    );

    const appItems = Array.isArray(capturedTemplate[0]?.submenu)
      ? capturedTemplate[0].submenu
      : [];
    const fileItems = Array.isArray(capturedTemplate[1]?.submenu)
      ? capturedTemplate[1].submenu
      : [];
    const viewMenu = capturedTemplate[3];
    const viewItems = Array.isArray(viewMenu?.submenu) ? viewMenu.submenu : [];
    const quit = appItems[8];
    const create = fileItems[0];
    const quickAccess = viewItems[0];
    const zoomIn = viewItems[3];
    const fullscreen = viewItems[6];

    expect(capturedTemplate[0]?.label).toBe("Rion Studio");
    expect(create).toMatchObject({
      accelerator: "Command+N",
      label: "New Game Window"
    });
    expect(quit).toMatchObject({
      accelerator: "Command+Q",
      label: "Quit Rion Studio"
    });
    expect(viewMenu).toMatchObject({
      id: "rion-runtime-window-view-menu",
      label: "View"
    });
    expect(viewItems.map((item) => "accelerator" in item
      ? item.accelerator
      : null)).toEqual([
      "Command+K",
      null,
      "Command+0",
      "Command+Plus",
      "Command+-",
      null,
      "Control+Command+F"
    ]);
    expect(fullscreen).toMatchObject({
      accelerator: "Control+Command+F",
      label: "Toggle Full Screen"
    });
    if (
      typeof create !== "object" || create === null ||
      typeof create.click !== "function" ||
      typeof quit !== "object" || quit === null ||
      typeof quit.click !== "function" ||
      typeof quickAccess !== "object" || quickAccess === null ||
      typeof quickAccess.click !== "function" ||
      typeof zoomIn !== "object" || zoomIn === null ||
      typeof zoomIn.click !== "function" ||
      typeof fullscreen !== "object" || fullscreen === null ||
      typeof fullscreen.click !== "function"
    ) throw new Error("Expected native shortcut callbacks");
    const focusedWindow = { id: 91 };
    quickAccess.click({} as never, focusedWindow as never, {} as never);
    create.click({} as never, focusedWindow as never, {} as never);
    zoomIn.click({} as never, focusedWindow as never, {} as never);
    fullscreen.click({} as never, focusedWindow as never, {} as never);
    quit.click({} as never, undefined as never, {} as never);
    expect(executeShortcut.mock.calls).toEqual([
      ["newGameWindow", focusedWindow],
      ["zoomIn", focusedWindow],
      ["toggleFullscreen", focusedWindow],
      ["quitApplication", undefined]
    ]);
    expect(executeQuickAccess).toHaveBeenCalledWith(focusedWindow);
    expect(setApplicationMenu).toHaveBeenCalledWith(nativeMenu);
  });
});
