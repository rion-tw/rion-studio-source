import type { MenuItemConstructorOptions } from "electron";

export interface WindowsTrayMenuActions {
  openApp: () => void;
  quitApp: () => void;
}

export function buildWindowsTrayMenuTemplate(
  actions: WindowsTrayMenuActions
): MenuItemConstructorOptions[] {
  return [
    {
      label: "Open Rion Studio",
      click: actions.openApp
    },
    { type: "separator" },
    {
      label: "Quit Rion Studio",
      click: actions.quitApp
    }
  ];
}
