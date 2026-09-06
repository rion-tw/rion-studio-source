import type { BaseWindow } from "electron";
import {
  createElectronApplicationMenuCommands,
  type ElectronApplicationMenuPort,
  type ElectronApplicationMenuShortcut
} from "./electronApplicationMenuCommands";

export type MacosApplicationMenuPort = ElectronApplicationMenuPort;
export type MacosApplicationMenuShortcut = ElectronApplicationMenuShortcut;

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
  const commands = createElectronApplicationMenuCommands(
    "darwin", applicationName, executeShortcut
  );
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
        commands.quit
      ]
    },
    {
      label: "File",
      submenu: [
        commands.newWindow,
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
        ...commands.view
      ]
    },
    { role: "windowMenu" }
  ]);
  menu.setApplicationMenu(applicationMenu);
}
