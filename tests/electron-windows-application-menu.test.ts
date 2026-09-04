import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { installWindowsApplicationMenu } from
  "../src/electron/main/windowsApplicationMenu";

describe("Windows native application menu", () => {
  it("routes native accelerators through the shared application controller", () => {
    const nativeMenu = { identity: "windows-native-menu" };
    let capturedTemplate: MenuItemConstructorOptions[] = [];
    const buildFromTemplate = vi.fn((template: MenuItemConstructorOptions[]) => {
      capturedTemplate = template;
      return nativeMenu;
    });
    const setApplicationMenu = vi.fn();

    const executeShortcut = vi.fn();
    installWindowsApplicationMenu(
      {
        buildFromTemplate: buildFromTemplate as never,
        setApplicationMenu: setApplicationMenu as never
      },
      executeShortcut
    );

    const fileMenu = capturedTemplate[0];
    const fileItems = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const create = fileItems[0];
    const quit = fileItems[2];
    const viewMenu = capturedTemplate[2];
    const viewItems = Array.isArray(viewMenu?.submenu) ? viewMenu.submenu : [];
    const zoomIn = viewItems[1];
    const fullscreen = viewItems[4];
    expect(fileMenu?.label).toBe("&File");
    expect(create).toMatchObject({
      accelerator: "Ctrl+N",
      label: "&New Game Window"
    });
    expect(quit).toMatchObject({
      accelerator: "Ctrl+Q",
      label: "E&xit Rion Studio"
    });
    expect(viewItems.map((item) => "accelerator" in item
      ? item.accelerator
      : null)).toEqual(["Ctrl+0", "Ctrl+Plus", "Ctrl+-", null, "F11"]);
    expect(fullscreen).toMatchObject({
      accelerator: "F11",
      label: "Toggle Full Screen",
      registerAccelerator: false
    });
    if (
      typeof create !== "object" || create === null ||
      typeof create.click !== "function" ||
      typeof quit !== "object" || quit === null ||
      typeof quit.click !== "function" ||
      typeof zoomIn !== "object" || zoomIn === null ||
      typeof zoomIn.click !== "function" ||
      typeof fullscreen !== "object" || fullscreen === null ||
      typeof fullscreen.click !== "function"
    ) throw new Error("Expected native shortcut callbacks");
    const focusedWindow = { id: 92 };
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
    expect(setApplicationMenu).toHaveBeenCalledWith(nativeMenu);
  });
});
