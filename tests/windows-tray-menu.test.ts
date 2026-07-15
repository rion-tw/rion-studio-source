import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  buildWindowsTrayMenuTemplate,
  type WindowsTrayMenuActions
} from "../src/main/tray/WindowsTrayMenu";

describe("Windows tray menu", () => {
  it("opens and quits Rion Studio through explicit menu actions", () => {
    const actions: WindowsTrayMenuActions = {
      openApp: vi.fn(),
      quitApp: vi.fn()
    };
    const template = buildWindowsTrayMenuTemplate(actions);

    click(template[0]);
    click(template[2]);

    expect(template[0]).toMatchObject({ label: "Open Rion Studio" });
    expect(template[1]).toEqual({ type: "separator" });
    expect(template[2]).toMatchObject({ label: "Quit Rion Studio" });
    expect(actions.openApp).toHaveBeenCalledOnce();
    expect(actions.quitApp).toHaveBeenCalledOnce();
  });
});

function click(item: MenuItemConstructorOptions): void {
  item.click?.({} as never, undefined, {} as never);
}
