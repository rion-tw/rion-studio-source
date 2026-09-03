import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { installMacosRuntimeWindowPreferencesMenu } from
  "../src/electron/main/macosRuntimeWindowPreferencesMenu";

class FakeMenuItem {
  checked: boolean;
  enabled = true;
  readonly id: string;
  readonly label: string;
  readonly role: string | undefined;
  readonly type: string | undefined;
  readonly click: ((item: FakeMenuItem) => void) | undefined;
  readonly submenu: FakeMenu | null;

  constructor(options: MenuItemConstructorOptions & {
    submenu?: FakeMenu;
  }) {
    this.checked = options.checked ?? false;
    this.id = options.id ?? "";
    this.label = options.label ?? "";
    this.role = options.role;
    this.type = options.type;
    this.submenu = options.submenu ?? null;
    this.click = options.click
      ? (item) => options.click!(item as never, undefined as never, {} as never)
      : undefined;
  }
}

class FakeMenu {
  readonly items: FakeMenuItem[];

  constructor(items: FakeMenuItem[] = []) {
    this.items = items;
  }

  append(item: FakeMenuItem): void {
    this.items.push(item);
  }
}

function harness(replace: (value: boolean) => Promise<boolean>) {
  const view = new FakeMenu();
  const applicationMenu = new FakeMenu([
    new FakeMenuItem({
      id: "rion-runtime-window-view-menu",
      label: "View",
      submenu: view
    } as never)
  ]);
  const setApplicationMenu = vi.fn();
  const onError = vi.fn();
  const handle = installMacosRuntimeWindowPreferencesMenu({
    initialValue: false,
    menu: {
      getApplicationMenu: () => applicationMenu as never,
      setApplicationMenu
    },
    menuItem: FakeMenuItem as never,
    onError,
    replace
  });
  const checkbox = view.items.find(
    (item) => item.label === "Always Show Toolbar in Full Screen"
  )!;
  return { checkbox, handle, onError, setApplicationMenu };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("macOS runtime-window preferences menu", () => {
  it("fails closed when the exact controlled application View menu is unavailable", () => {
    const view = new FakeMenu();
    const roleOnlyApplicationMenu = new FakeMenu([
      new FakeMenuItem({ role: "appMenu" } as never),
      new FakeMenuItem({ role: "editMenu" } as never),
      new FakeMenuItem({ role: "viewmenu", submenu: view } as never),
      new FakeMenuItem({ role: "windowMenu" } as never)
    ]);
    const setApplicationMenu = vi.fn();
    const install = (applicationMenu: FakeMenu | null) => () =>
      installMacosRuntimeWindowPreferencesMenu({
        initialValue: false,
        menu: {
          getApplicationMenu: () => applicationMenu as never,
          setApplicationMenu
        },
        menuItem: FakeMenuItem as never,
        onError: vi.fn(),
        replace: async (value) => value
      });

    expect(install(null)).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_VIEW_MENU_UNAVAILABLE"
    }));
    expect(install(roleOnlyApplicationMenu)).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_VIEW_MENU_UNAVAILABLE"
    }));
    expect(view.items).toHaveLength(0);
    expect(setApplicationMenu).not.toHaveBeenCalled();
  });

  it("serializes rapid dual toggles so only the latest authoritative intent wins", async () => {
    const requests: boolean[] = [];
    const resolvers: Array<(value: boolean) => void> = [];
    const subject = harness((value) => {
      requests.push(value);
      return new Promise<boolean>((resolve) => resolvers.push(resolve));
    });

    subject.checkbox.checked = true;
    subject.checkbox.click?.(subject.checkbox);
    subject.checkbox.checked = false;
    subject.checkbox.click?.(subject.checkbox);
    await flush();
    expect(requests).toEqual([true]);
    expect(subject.checkbox.enabled).toBe(false);

    resolvers.shift()!(true);
    await flush();
    expect(requests).toEqual([true, false]);
    resolvers.shift()!(false);
    await flush();
    expect(subject.checkbox.checked).toBe(false);
    expect(subject.checkbox.enabled).toBe(true);
    expect(subject.onError).not.toHaveBeenCalled();
  });

  it("keeps an external Core projection authoritative while an intent is pending", async () => {
    let settle!: (value: boolean) => void;
    const subject = harness(() => new Promise<boolean>((resolve) => {
      settle = resolve;
    }));
    subject.checkbox.checked = true;
    subject.checkbox.click?.(subject.checkbox);
    await flush();
    subject.handle.setAlwaysShowToolbarInFullScreen(false);
    settle(true);
    await flush();

    expect(subject.checkbox.checked).toBe(false);
    expect(subject.checkbox.enabled).toBe(true);
  });
});
