import { $, browser, expect } from "@wdio/globals";
import { electronDesktopE2eFullscreenToolbarRuntime } from "../support/electron-driver";
import { readVisibleWindowsRuntimeHostLayout, withWindowsRuntimeHost } from "../support/native-runtime-tabs";
import { resizeWorkspaceWindow } from "../support/workspace-window-resize";

/** Real border resize and visible arrow clicks keep both ends of a crowded tab row reachable. */
export async function exerciseWindowsTabOverflow(input: {
  mainWindowHandle: string; windowId: string; tabId: string;
}): Promise<void> {
  const before = await readVisibleWindowsRuntimeHostLayout(input);
  const delta = 760 - before.viewport.width;
  const resize = async (x: number) => resizeWorkspaceWindow({
    inspection: await electronDesktopE2eFullscreenToolbarRuntime(input.windowId),
    edge: "right", moves: [{ x, y: 0 }], requireRequestedFrame: true,
    whileHeld: async () => undefined
  });
  await resize(delta);
  try {
    await withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
      const left = await $("[data-runtime-toolbar-action='scrollLeft']");
      const right = await $("[data-runtime-toolbar-action='scrollRight']");
      const add = await $("[data-runtime-toolbar-action='openLauncher']");
      await expect(left).toBeDisplayed();
      await expect(right).toBeDisplayed();
      await expect(add).toBeClickable();
      const scrollToEnd = async (direction: "left" | "right") => {
        const control = direction === "left" ? left : right;
        // At most three 180px tabs: four visible clicks cover the narrowest host.
        for (let step = 0; step < 4 && await control.isEnabled(); step++) await control.click();
        await expect(control).toBeDisabled();
        expect(await browser.execute((end) => {
          const row = document.querySelector<HTMLElement>("[data-runtime-tabs]")!;
          const tab = (end === "left" ? row.firstElementChild : row.lastElementChild)!;
          const a = tab.getBoundingClientRect(); const b = row.getBoundingClientRect();
          return a.left >= b.left - 1 && a.right <= b.right + 1;
        }, direction)).toBe(true);
      };
      await scrollToEnd("left");
      await scrollToEnd("right");
      await expect(add).toBeClickable();
    }, input.windowId);
  } finally {
    await resize(-delta);
  }
}
