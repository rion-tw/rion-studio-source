import type { BaseWindow, Menu, MenuItemConstructorOptions } from "electron";
import type { ApplicationShortcutCommand } from "../../shared/types";

export interface WindowsApplicationMenuPort {
  buildFromTemplate: (template: MenuItemConstructorOptions[]) => Menu;
  setApplicationMenu: (menu: Menu | null) => void;
}

export type WindowsApplicationMenuShortcut = (
  command: ApplicationShortcutCommand,
  focusedWindow?: BaseWindow
) => void;

/**
 * Installs native accelerators without letting Electron roles bypass the
 * authenticated application-shortcut controller. The renderer close button
 * remains a hide action; native quit enters the same unsaved-change handshake.
 */
export function installWindowsApplicationMenu(
  menu: WindowsApplicationMenuPort,
  executeShortcut: WindowsApplicationMenuShortcut
): void {
  const execute = (command: ApplicationShortcutCommand) => (
    _item: Electron.MenuItem,
    focusedWindow?: BaseWindow
  ) => {
    executeShortcut(command, focusedWindow);
  };
  const applicationMenu = menu.buildFromTemplate([
    {
      label: "&File",
      submenu: [
        {
          accelerator: "Ctrl+N",
          click: execute("newGameWindow"),
          label: "&New Game Window"
        },
        { type: "separator" },
        {
          accelerator: "Ctrl+Q",
          click: execute("quitApplication"),
          label: "E&xit Rion Studio"
        }
      ]
    },
    { role: "editMenu" },
    {
      label: "&View",
      submenu: [
        {
          accelerator: "Ctrl+0",
          click: execute("zoomReset"),
          label: "Actual Si&ze"
        },
        {
          accelerator: "Ctrl+Plus",
          click: execute("zoomIn"),
          label: "Zoom &In"
        },
        {
          accelerator: "Ctrl+-",
          click: execute("zoomOut"),
          label: "Zoom &Out"
        },
        { type: "separator" },
        {
          accelerator: "F11",
          click: execute("toggleFullscreen"),
          label: "Toggle Full Screen",
          // Keep the discoverable menu label without registering Electron's
          // native F11 accelerator. Chromium consumes that accelerator before
          // the focused WebContents can fence the exact runtime tab, so the
          // launcher renderer and runtime before-input owners handle F11.
          registerAccelerator: false
        }
      ]
    },
    { role: "windowMenu" }
  ]);
  menu.setApplicationMenu(applicationMenu);
}
