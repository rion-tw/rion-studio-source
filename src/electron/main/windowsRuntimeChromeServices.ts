import type { BrowserWindow, Menu, MenuItemConstructorOptions } from "electron";
import type { WindowsRuntimeHostChromeController } from "./windowsRuntimeHostChromeController";
import { readWorkspaceWebLanguage, subscribeWorkspaceWebLanguage } from "./workspaceStartPage";
import { readWorkspaceWebTheme, subscribeWorkspaceWebTheme } from "./workspaceWebTheme";

export function bindWindowsRuntimeChrome(input: Readonly<{
  parent: BrowserWindow;
  chrome: WindowsRuntimeHostChromeController;
  windowId: string;
  menu: Pick<typeof Menu, "buildFromTemplate">;
  openLauncher: (windowId: string, nativeId: number, popup: (items: MenuItemConstructorOptions[]) => void) => Promise<void>;
}>): void {
  const { parent, chrome } = input;
  let menu: Menu | null = null;
  let menuRevision = 0;
  const popup = (items: MenuItemConstructorOptions[]) => {
    if (parent.isDestroyed()) return;
    const revision = ++menuRevision;
    menu?.closePopup(parent);
    menu = input.menu.buildFromTemplate(items);
    menu.popup({ window: parent, callback: () => {
      if (revision === menuRevision && !parent.isDestroyed()) chrome.nativeMenuClosed();
    } });
  };
  const appearance = () => chrome.applyAppearance({ language: readWorkspaceWebLanguage(), theme: readWorkspaceWebTheme() });
  appearance();
  const subscriptions = [subscribeWorkspaceWebLanguage(appearance), subscribeWorkspaceWebTheme(appearance)];
  chrome.bindTabMenu(popup);
  chrome.bindLauncher(() => input.openLauncher(input.windowId, parent.id, popup));
  parent.once("closed", () => { menuRevision += 1; for (const unsubscribe of subscriptions) unsubscribe(); menu = null; });
}
