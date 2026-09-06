import type { BaseWindow, Menu, MenuItemConstructorOptions } from "electron";
import type { ApplicationShortcutCommand } from "../../shared/types";

export interface ElectronApplicationMenuPort {
  buildFromTemplate: (template: MenuItemConstructorOptions[]) => Menu;
  setApplicationMenu: (menu: Menu | null) => void;
}

export type ElectronApplicationMenuShortcut = (
  command: ApplicationShortcutCommand, focusedWindow?: BaseWindow
) => void;

/** Native menus share command routing; only accelerators and presentation differ. */
export function createElectronApplicationMenuCommands(
  platform: "darwin" | "win32",
  applicationName: string,
  executeShortcut: ElectronApplicationMenuShortcut
): Readonly<{
  newWindow: MenuItemConstructorOptions;
  quit: MenuItemConstructorOptions;
  view: MenuItemConstructorOptions[];
}> {
  const macos = platform === "darwin";
  const modifier = macos ? "Command" : "Ctrl";
  const command = (
    action: ApplicationShortcutCommand,
    key: string,
    label: string,
    windowsLabel = label
  ): MenuItemConstructorOptions => ({
    accelerator: `${modifier}+${key}`,
    label: macos ? label : windowsLabel,
    click: (_item, focusedWindow) => executeShortcut(action, focusedWindow)
  });
  const fullscreen = command("toggleFullscreen", "F", "Toggle Full Screen");
  fullscreen.accelerator = macos ? "Control+Command+F" : "F11";
  if (!macos) {
    // CP-07: native F11 registration would consume input before the exact
    // focused-owner fence. Preserve the existing input owner until parity proves
    // that both key halves can be suppressed and routed exactly once.
    fullscreen.registerAccelerator = false;
  }
  return {
    newWindow: command("newGameWindow", "N", "New Game Window", "&New Game Window"),
    quit: command("quitApplication", "Q", `Quit ${applicationName}`, "E&xit Rion Studio"),
    view: [
      command("zoomReset", "0", "Actual Size", "Actual Si&ze"),
      command("zoomIn", "Plus", "Zoom In", "Zoom &In"),
      command("zoomOut", "-", "Zoom Out", "Zoom &Out"),
      { type: "separator" },
      fullscreen
    ]
  };
}
