import {
  createElectronApplicationMenuCommands,
  type ElectronApplicationMenuPort,
  type ElectronApplicationMenuShortcut
} from "./electronApplicationMenuCommands";

export type WindowsApplicationMenuPort = ElectronApplicationMenuPort;
export type WindowsApplicationMenuShortcut = ElectronApplicationMenuShortcut;

/**
 * Installs native accelerators without letting Electron roles bypass the
 * authenticated application-shortcut controller. The renderer close button
 * remains a hide action; native quit enters the same unsaved-change handshake.
 */
export function installWindowsApplicationMenu(
  menu: WindowsApplicationMenuPort,
  executeShortcut: WindowsApplicationMenuShortcut
): void {
  const commands = createElectronApplicationMenuCommands(
    "win32", "Rion Studio", executeShortcut
  );
  const applicationMenu = menu.buildFromTemplate([
    {
      label: "&File",
      submenu: [commands.newWindow, { type: "separator" }, commands.quit]
    },
    { role: "editMenu" },
    {
      label: "&View",
      submenu: commands.view
    },
    { role: "windowMenu" }
  ]);
  menu.setApplicationMenu(applicationMenu);
}
