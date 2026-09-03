import type { Menu, MenuItem, MenuItemConstructorOptions } from "electron";

import { RionBridgeError } from "../ipc/errors";

export interface MacosRuntimeWindowPreferencesMenuHandle {
  setAlwaysShowToolbarInFullScreen: (value: boolean) => void;
}

const VIEW_MENU_ID = "rion-runtime-window-view-menu";

/** Installs a real macOS View-menu checkbox backed by the Core preference. */
export function installMacosRuntimeWindowPreferencesMenu(input: Readonly<{
  initialValue: boolean;
  menu: Readonly<{
    getApplicationMenu: () => Menu | null;
    setApplicationMenu: (menu: Menu | null) => void;
  }>;
  menuItem: new (options: MenuItemConstructorOptions) => MenuItem;
  onError: (error: unknown) => void;
  replace: (value: boolean) => Promise<boolean>;
}>): MacosRuntimeWindowPreferencesMenuHandle {
  let intentSequence = 0;
  let lane: Promise<void> = Promise.resolve();
  let pendingIntents = 0;
  const menu = input.menu.getApplicationMenu();
  const view = menu?.items.find((item) => item.id === VIEW_MENU_ID)?.submenu;
  if (!menu || !view) {
    throw new RionBridgeError({
      code: "ELECTRON_MACOS_VIEW_MENU_UNAVAILABLE",
      message: "The controlled macOS View menu is unavailable."
    });
  }
  const checkbox = new input.menuItem({
    checked: input.initialValue,
    label: "Always Show Toolbar in Full Screen",
    type: "checkbox",
    click: (item) => {
      const requested = item.checked;
      intentSequence += 1;
      const intent = intentSequence;
      pendingIntents += 1;
      checkbox.enabled = false;
      const operation = lane.then(async () => {
        try {
          const applied = await input.replace(requested);
          if (intent === intentSequence) checkbox.checked = applied;
        } catch (error) {
          if (intent === intentSequence) checkbox.checked = !requested;
          input.onError(error);
        } finally {
          pendingIntents -= 1;
          if (pendingIntents === 0) checkbox.enabled = true;
        }
      });
      lane = operation.catch(() => undefined);
    }
  });
  view.append(new input.menuItem({ type: "separator" }));
  view.append(checkbox);
  input.menu.setApplicationMenu(menu);
  return Object.freeze({
    setAlwaysShowToolbarInFullScreen: (value: boolean) => {
      intentSequence += 1;
      checkbox.checked = value;
      checkbox.enabled = pendingIntents === 0;
    }
  });
}
