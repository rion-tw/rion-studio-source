import type { BaseWindow, Menu, MenuItemConstructorOptions } from "electron";
import type { ApplicationShortcutCommand } from "../../shared/types";

export interface MacosApplicationMenuPort {
  buildFromTemplate: (template: MenuItemConstructorOptions[]) => Menu;
  setApplicationMenu: (menu: Menu | null) => void;
}

export type MacosApplicationMenuShortcut = (
  command: ApplicationShortcutCommand,
  focusedWindow?: BaseWindow
) => void;

export type MacosQuickAccessShortcut = (focusedWindow?: BaseWindow) => void;

const VIEW_MENU_ID = "rion-runtime-window-view-menu";

/**
 * Installs the native macOS application menu. Core-controlled shortcuts use
 * the authenticated typed controller. Fullscreen also uses that lane because
 * Electron's built-in menu role cannot identify the retained AppKit host's
 * Core ownership fences even though the focused NSWindow is native.
 */
export function installMacosApplicationMenu(
  menu: MacosApplicationMenuPort,
  applicationName: string,
  executeShortcut: MacosApplicationMenuShortcut,
  executeQuickAccess: MacosQuickAccessShortcut
): void {
  const execute = (command: ApplicationShortcutCommand) => (
    _item: Electron.MenuItem,
    focusedWindow?: BaseWindow
  ) => {
    executeShortcut(command, focusedWindow);
  };
  const applicationMenu = menu.buildFromTemplate([
    {
      label: applicationName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        {
          accelerator: "Command+Q",
          click: execute("quitApplication"),
          label: `Quit ${applicationName}`
        }
      ]
    },
    {
      label: "File",
      submenu: [
        {
          accelerator: "Command+N",
          click: execute("newGameWindow"),
          label: "New Game Window"
        },
        { role: "close" }
      ]
    },
    { role: "editMenu" },
    {
      id: VIEW_MENU_ID,
      label: "View",
      submenu: [
        {
          accelerator: "Command+K",
          click: (_item, focusedWindow) => executeQuickAccess(focusedWindow),
          label: "Quick Open"
        },
        { type: "separator" },
        {
          accelerator: "Command+0",
          click: execute("zoomReset"),
          label: "Actual Size"
        },
        {
          accelerator: "Command+Plus",
          click: execute("zoomIn"),
          label: "Zoom In"
        },
        {
          accelerator: "Command+-",
          click: execute("zoomOut"),
          label: "Zoom Out"
        },
        { type: "separator" },
        {
          accelerator: "Control+Command+F",
          click: execute("toggleFullscreen"),
          label: "Toggle Full Screen",
        }
      ]
    },
    { role: "windowMenu" }
  ]);
  menu.setApplicationMenu(applicationMenu);
}
