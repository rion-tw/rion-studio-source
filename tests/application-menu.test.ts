import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ApplicationMenuController,
  buildApplicationMenuTemplate
} from "../src/main/menu/ApplicationMenu";

const { buildFromTemplate, setApplicationMenu } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({ template })),
  setApplicationMenu: vi.fn()
}));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate, setApplicationMenu }
}));

describe("application View menu", () => {
  it.each([
    ["darwin", "Always Show Toolbar in Full Screen"],
    ["win32", "Always Show Toolbar in Full Screen"]
  ] as const)("builds a native checkbox on %s", (platform, expectedLabel) => {
    const template = buildApplicationMenuTemplate({
      alwaysShowToolbarInFullScreen: false,
      language: "en",
      onAlwaysShowToolbarInFullScreenChanged: vi.fn(),
      platform
    });
    const view = getSubmenu(template, "View");
    expect(view[0]).toMatchObject({ checked: false, label: expectedLabel, type: "checkbox" });
    expect(template.find((item) => item.label === "Window")?.role).toBe("windowMenu");
  });

  it("applies immediately and rolls back when persistence fails", async () => {
    const apply = vi.fn();
    const logger = { error: vi.fn() };
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const controller = new ApplicationMenuController({
      alwaysShowToolbarInFullScreen: false,
      applyAlwaysShowToolbarInFullScreen: apply,
      logger,
      platform: "win32",
      saveAlwaysShowToolbarInFullScreen: save
    });
    controller.install();

    const firstTemplate = buildFromTemplate.mock.calls.at(-1)![0];
    const checkbox = getSubmenu(firstTemplate, "View")[0];
    checkbox.click?.({ checked: true } as never, undefined, {} as never);

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(apply.mock.calls).toEqual([[true], [false]]);
    const restoredTemplate = buildFromTemplate.mock.calls.at(-1)![0];
    expect(getSubmenu(restoredTemplate, "View")[0]).toMatchObject({ checked: false });
  });
});

function getSubmenu(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  return template.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[];
}
