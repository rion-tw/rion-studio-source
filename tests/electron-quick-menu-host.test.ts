import type { MenuItemConstructorOptions, NativeImage } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ElectronQuickMenuHost,
  type ElectronQuickMenuTrayPort
} from "../src/electron/main/electronQuickMenuHost";

const icon = { isEmpty: () => false } as unknown as NativeImage;

describe("Electron Quick Menu native host", () => {
  it.each(["darwin", "win32"] as const)("dispatches a direct window item through the native template (%s)", (platform) => {
    let template: MenuItemConstructorOptions[] = [];
    const applyMenu = vi.fn();
    const host = new ElectronQuickMenuHost({
      platform, icon,
      dock: { setMenu: applyMenu },
      createTray: () => ({ destroy: vi.fn(), on: vi.fn(), setContextMenu: applyMenu, setToolTip: vi.fn() }),
      menu: { buildFromTemplate: (entries) => { template = entries; return entries; } },
      onPrimaryActivation: vi.fn()
    });
    const entry = { id: "show-display:live", label: "Live", enabled: true, checked: true };
    const onAction = vi.fn();
    host.apply([entry, { label: "Windows", submenu: [entry] }], onAction);
    expect(template[0]).toEqual(expect.objectContaining({ id: entry.id, label: entry.label, type: "checkbox", checked: true }));
    template[0]!.click?.({} as never, {} as never, {} as never);
    expect(onAction).toHaveBeenCalledExactlyOnceWith(entry.id);
    expect(applyMenu).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("applies one shared template to the macOS Dock", () => {
    const setMenu = vi.fn();
    let template: MenuItemConstructorOptions[] = [];
    const host = new ElectronQuickMenuHost({
      platform: "darwin",
      icon,
      dock: { setMenu },
      menu: {
        buildFromTemplate: vi.fn((value) => {
          template = value;
          return { native: "menu" };
        })
      },
      onPrimaryActivation: vi.fn()
    });
    const onAction = vi.fn();
    host.apply([{ id: "open-app", label: "Open", enabled: true }], onAction);
    expect(setMenu).toHaveBeenCalledWith({ native: "menu" });
    template[0]?.click?.({} as never, {} as never, {} as never);
    expect(onAction).toHaveBeenCalledWith("open-app");
  });

  it("retains one Windows Tray and binds left-click activation", () => {
    let click: () => void = () => undefined;
    const tray: ElectronQuickMenuTrayPort = {
      destroy: vi.fn(),
      on: vi.fn((_event: "click", listener: () => void) => {
        click = listener;
        return undefined;
      }),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn()
    };
    const createTray = vi.fn(() => tray);
    const activate = vi.fn();
    const host = new ElectronQuickMenuHost({
      platform: "win32",
      icon,
      createTray,
      menu: { buildFromTemplate: vi.fn(() => ({ native: "menu" })) },
      onPrimaryActivation: activate
    });
    host.apply([{ id: "open-app", label: "Open", enabled: true }], vi.fn());
    host.apply([{ id: "quit-app", label: "Quit", enabled: true }], vi.fn());
    expect(createTray).toHaveBeenCalledOnce();
    expect(tray.setToolTip).toHaveBeenCalledWith("Rion Studio");
    expect(tray.setContextMenu).toHaveBeenCalledTimes(2);
    click();
    expect(activate).toHaveBeenCalledOnce();
    host.dispose();
    expect(tray.destroy).toHaveBeenCalledOnce();
  });
});
