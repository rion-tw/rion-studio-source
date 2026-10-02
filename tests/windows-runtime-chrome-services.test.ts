import { EventEmitter } from "node:events";
import type { BrowserWindow, Menu } from "electron";
import { expect, it, vi } from "vitest";
import { bindWindowsRuntimeChrome } from "../src/electron/main/windowsRuntimeChromeServices";
import type { WindowsRuntimeHostChromeController } from "../src/electron/main/windowsRuntimeHostChromeController";
import { updateWorkspaceStartAppearance } from "../src/electron/main/workspaceStartPage";

it("parents native menus above role views and follows acknowledged appearance until exact close", async () => {
  const parent = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false });
  const chrome = { applyAppearance: vi.fn(), bindTabMenu: vi.fn(), bindLauncher: vi.fn(), nativeMenuClosed: vi.fn() };
  const menu = { popup: vi.fn(), closePopup: vi.fn() };
  const buildFromTemplate = vi.fn(() => menu as unknown as Menu);
  const openLauncher = vi.fn(async () => undefined);
  bindWindowsRuntimeChrome({ parent: parent as unknown as BrowserWindow,
    chrome: chrome as unknown as WindowsRuntimeHostChromeController, menu: { buildFromTemplate }, windowId: "window-1", openLauncher });
  const items = [{ label: "Reload" }];
  chrome.bindTabMenu.mock.calls[0]![0](items);
  expect(buildFromTemplate).toHaveBeenCalledWith(items);
  expect(menu.popup).toHaveBeenCalledWith({ window: parent, callback: expect.any(Function) });
  menu.popup.mock.calls[0]![0].callback();
  expect(chrome.nativeMenuClosed).toHaveBeenCalledOnce();
  chrome.bindTabMenu.mock.calls[0]![0](items);
  menu.popup.mock.calls[0]![0].callback();
  expect(chrome.nativeMenuClosed).toHaveBeenCalledOnce();
  menu.popup.mock.calls[1]![0].callback();
  expect(chrome.nativeMenuClosed).toHaveBeenCalledTimes(2);
  await chrome.bindLauncher.mock.calls[0]![0]();
  expect(openLauncher).toHaveBeenCalledWith("window-1", 41, expect.any(Function));
  updateWorkspaceStartAppearance({ language: "ja", theme: "dark" });
  expect(chrome.applyAppearance).toHaveBeenLastCalledWith({ language: "ja", theme: "dark" });
  parent.emit("closed"); chrome.applyAppearance.mockClear();
  menu.popup.mock.calls[1]![0].callback();
  expect(chrome.nativeMenuClosed).toHaveBeenCalledTimes(2);
  updateWorkspaceStartAppearance({ language: "en", theme: "light" });
  expect(chrome.applyAppearance).not.toHaveBeenCalled();
});
