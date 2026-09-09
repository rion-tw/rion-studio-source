import type {
  MenuItemConstructorOptions,
  NativeImage
} from "electron";

import { RionBridgeError } from "../ipc/errors";
import type {
  ElectronQuickMenuEntry,
  ElectronQuickMenuPlatform
} from "./electronQuickMenuModel";

interface ElectronQuickMenuMenuPort {
  buildFromTemplate: (template: MenuItemConstructorOptions[]) => unknown;
}

interface ElectronQuickMenuDockPort {
  setMenu: (menu: unknown) => void;
}

export interface ElectronQuickMenuTrayPort {
  destroy: () => void;
  on: (event: "click", listener: () => void) => unknown;
  setContextMenu: (menu: unknown) => void;
  setToolTip: (toolTip: string) => void;
}

export interface ElectronQuickMenuHostInput {
  readonly platform: ElectronQuickMenuPlatform;
  readonly menu: ElectronQuickMenuMenuPort;
  readonly icon: NativeImage;
  readonly dock?: ElectronQuickMenuDockPort;
  readonly createTray?: (icon: NativeImage) => ElectronQuickMenuTrayPort;
  readonly onPrimaryActivation: () => void;
}

export type ElectronQuickMenuActionHandler = (id: string) => void;

function hostError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function menuTemplate(
  entries: readonly ElectronQuickMenuEntry[],
  onAction: ElectronQuickMenuActionHandler
): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    if ("type" in entry) return { type: "separator" };
    if ("submenu" in entry) {
      return {
        label: entry.label,
        submenu: menuTemplate(entry.submenu, onAction)
      };
    }
    return {
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      ...(entry.checked === true
        ? { type: "checkbox" as const, checked: true }
        : {}),
      click: () => onAction(entry.id)
    };
  });
}

/** Owns only the native presentation boundary; Core remains the state owner. */
export class ElectronQuickMenuHost {
  readonly #input: ElectronQuickMenuHostInput;
  #tray: ElectronQuickMenuTrayPort | null = null;
  #disposed = false;

  constructor(input: ElectronQuickMenuHostInput) {
    this.#input = input;
    if (input.platform === "darwin" && !input.dock) {
      throw hostError(
        "ELECTRON_QUICK_MENU_DOCK_UNAVAILABLE",
        "Electron did not expose the macOS Dock menu boundary."
      );
    }
    if (input.platform === "win32" && !input.createTray) {
      throw hostError(
        "ELECTRON_QUICK_MENU_TRAY_UNAVAILABLE",
        "Electron did not expose the Windows notification-area boundary."
      );
    }
  }

  apply(
    entries: readonly ElectronQuickMenuEntry[],
    onAction: ElectronQuickMenuActionHandler
  ): void {
    if (this.#disposed) {
      throw hostError(
        "ELECTRON_QUICK_MENU_HOST_RETIRED",
        "The native Quick Menu host has already been retired."
      );
    }
    const menu = this.#input.menu.buildFromTemplate(
      menuTemplate(entries, onAction)
    );
    if (this.#input.platform === "darwin") {
      this.#input.dock!.setMenu(menu);
      return;
    }
    const tray = this.#tray ?? this.#createWindowsTray();
    tray.setContextMenu(menu);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tray?.destroy();
    this.#tray = null;
  }

  #createWindowsTray(): ElectronQuickMenuTrayPort {
    const tray = this.#input.createTray!(this.#input.icon);
    tray.setToolTip("Rion Studio");
    tray.on("click", this.#input.onPrimaryActivation);
    this.#tray = tray;
    return tray;
  }
}
