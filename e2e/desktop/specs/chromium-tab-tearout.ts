import { browser, expect } from "@wdio/globals";
import { rendererCall } from "../support/renderer-bridge";
import { electronDesktopE2eGameWindowRuntime, electronDesktopE2eRoleSessionRuntime } from "../support/electron-driver";
import { nativeTabPoint, nativeTabPointer, writeWindowsTabDragEvidence } from "../support/native-tab-tearout";

export async function exerciseVisibleTabTearout(input: { mainWindowHandle: string; platform: "macos" | "windows";
  windowId: string; tabId: string; tabName: string; roleId: string; verifyOwner?: (windowId: string) => Promise<void> }): Promise<void> {
  const before = await electronDesktopE2eRoleSessionRuntime(input.roleId);
  const saved = (await rendererCall("listGameWindows")).map(w => w.id);
  const owner = async () => (await rendererCall("getEmbeddedRuntimeState")).tabs.find(t => t.id === input.tabId)?.windowId;
  let floating: string | undefined;
  // WebDriver evidence queries can restore launcher focus. Resolve/focus the
  // physical tab only after those reads, immediately before mouse-down.
  const start = await nativeTabPoint({ ...input, focus: true });
  const outside = { x: start.x, y: start.y + 260 };
  let pointer = start;
  try {
    await nativeTabPointer(input.platform, "start", start, outside); pointer = outside;
    await browser.waitUntil(async () => {
      floating = await owner();
      return !!floating && floating !== input.windowId;
    }, { timeout: 15_000, timeoutMsg: "A held tab tearout did not create a live floating owner" });
    await input.verifyOwner?.(floating!);
    await browser.waitUntil(async () => {
      const preview = await electronDesktopE2eGameWindowRuntime(floating!);
      return preview.currentRuntime?.visible === true &&
        preview.currentRuntime.nativeTabIds.includes(input.tabId);
    }, { timeout: 15_000, timeoutMsg: "The held floating host did not publish its exact visible native projection" });
    expect((await rendererCall("listGameWindows")).map(w => w.id)).toEqual(saved);
    await nativeTabPointer(input.platform, "move", outside, start); pointer = start;
    await browser.waitUntil(async () => await owner() === input.windowId,
      { timeout: 15_000, timeoutMsg: "Held floating tab did not reattach to its original window" });
    await nativeTabPointer(input.platform, "end", start, outside); pointer = outside;
    await browser.waitUntil(async () => await owner() === floating,
      { timeout: 15_000, timeoutMsg: "Second tearout did not reuse the same provisional host" });
    await input.verifyOwner?.(floating!);
    const after = await electronDesktopE2eRoleSessionRuntime(input.roleId);
    expect(after.currentRuntime?.generation).toBe(before.currentRuntime?.generation);
    expect(after.latestSessionEnsure.nativeSessionInstance).toBe(before.latestSessionEnsure.nativeSessionInstance);
    expect((await rendererCall("listGameWindows")).map(w => w.id)).toEqual(saved);
    // Core ownership can precede the final native placement projection after
    // mouse-up. Capture the next gesture's baseline only through the strict
    // Core/native inspector once that exact visible host is coherent.
    let singleBefore!: NonNullable<Awaited<ReturnType<typeof electronDesktopE2eGameWindowRuntime>>["currentRuntime"]>;
    await browser.waitUntil(async () => {
      const current = (await electronDesktopE2eGameWindowRuntime(floating!)).currentRuntime;
      if (!current?.visible || !current.nativeTabIds.includes(input.tabId)) return false;
      singleBefore = current;
      return true;
    }, { timeout: 15_000, timeoutMsg: "The dropped floating host did not publish its exact native placement projection" });
    let temporaryTab = await nativeTabPoint({ ...input, windowId: floating!, focus: true });
    const shifted = { x: temporaryTab.x - 80, y: temporaryTab.y + 90 };
    await nativeTabPointer(input.platform, "start", temporaryTab, shifted); pointer = shifted;
    await browser.waitUntil(async () => {
      const current = (await electronDesktopE2eGameWindowRuntime(floating!)).currentRuntime;
      return !!current && (current.nativeDisplay.bounds.x !== singleBefore.nativeDisplay.bounds.x ||
        current.nativeDisplay.bounds.y !== singleBefore.nativeDisplay.bounds.y);
    }, { timeout: 15_000, timeoutMsg: "Single-tab drag did not move its existing native host" });
    await nativeTabPointer(input.platform, "cancel", shifted, shifted);
    expect(await owner()).toBe(floating);
    expect((await electronDesktopE2eGameWindowRuntime(floating!)).currentRuntime?.windowGeneration).toBe(singleBefore.windowGeneration);
    expect((await rendererCall("listGameWindows")).map(w => w.id)).toEqual(saved);
    temporaryTab = await nativeTabPoint({ ...input, windowId: floating!, focus: true });
    await nativeTabPointer(input.platform, "start", temporaryTab, start); pointer = start;
    await nativeTabPointer(input.platform, "end", start, start);
    await browser.waitUntil(async () => await owner() === input.windowId &&
      !(await electronDesktopE2eGameWindowRuntime(floating!)).currentRuntime,
      { timeout: 15_000, timeoutMsg: "Temporary source host was not retired after a visible tab merge" });
    await input.verifyOwner?.(input.windowId);
  } finally {
    await nativeTabPointer(input.platform, "end", pointer, pointer);
    if (input.platform === "windows") await writeWindowsTabDragEvidence(input.mainWindowHandle, input.tabId);
  }
}
