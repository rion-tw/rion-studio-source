import { browser, expect } from "@wdio/globals";
import { electronDesktopE2eFullscreenToolbarRuntime as inspect, electronDesktopE2eProbe } from "../support/electron-driver";
import { resizeWorkspaceWindow } from "../support/workspace-window-resize";
import { captureWorkspacePixels } from "../support/workspace-pixels";
import { expectWorkspacePixels } from "./chromium-workspace-gap-evidence";

export async function resizeWorkspaceWithLoadingSibling(windowId: string, tabId: string): Promise<number> {
  const before = await inspect(windowId);
  const width = Math.max(...before.surfaces.filter(s => s.tabId === tabId).map(s => s.bounds.x+s.bounds.width));
  const { platform } = await electronDesktopE2eProbe();
  // A wide macOS window can already reach the screen's right edge. Shrink it
  // there; grow narrower windows that may be at the native tracking minimum.
  const delta = platform === "macos" && width >= 800 ? -96 : 96;
  await resizeWorkspaceWindow({ inspection: before, edge: "right", moves:[{x:delta,y:0}],
    whileHeld: async () => {
      await browser.waitUntil(async () => {
        const resizedWidth = Math.max(...(await inspect(windowId)).surfaces
          .filter(s => s.tabId === tabId).map(s => s.bounds.x+s.bounds.width));
        return delta < 0 ? resizedWidth < width : resizedWidth > width;
      }, { timeout:20_000 });
      await expectWorkspacePixels({ inspection: await inspect(windowId), tabId,
        name:"resize-with-loading-sibling-held", background:"black" });
    } });
  const after = await inspect(windowId);
  await expectWorkspacePixels({ inspection:after, tabId, name:"resize-with-loading-sibling-ended", background:"black" });
  return Math.max(...after.surfaces.filter(s => s.tabId === tabId).map(s => s.bounds.x+s.bounds.width));
}

export async function resizeActiveWebsiteTab(windowId: string, tabId: string, expectedWidth: number): Promise<void> {
  const before = await inspect(windowId);
  const surfaces = before.surfaces.filter(s => s.tabId === tabId);
  expect(Math.max(...surfaces.map(s => s.bounds.x+s.bounds.width))).toBe(expectedWidth);
  const check = async (name: string) => {
    const current = await inspect(windowId);
    const slots = current.surfaces.filter(s => s.tabId === tabId).sort((a,b) => a.bounds.x-b.bounds.x);
    expect(slots).toHaveLength(2);
    expect(current.surfaces.filter(s => s.tabId !== tabId).every(s => !s.visible)).toBe(true);
    const left=slots[0]!.bounds, right=slots[1]!.bounds;
    const reference={x:left.x+left.width,y:left.y,width:right.x-left.x-left.width,height:left.height};
    expect(reference.width).toBe(16);
    const evidence=await captureWorkspacePixels({ inspection:current, name, reference,
      region:{x:0,y:left.y,width:right.x+right.width,height:left.height},
      points:[{x:reference.x+8,y:left.y+left.height/2},
        ...slots.map(s=>({x:s.bounds.x+s.bounds.width/2,y:s.bounds.y+s.bounds.height/2}))] });
    expect(Math.max(...evidence.samples[0]!)).toBeLessThanOrEqual(8);
    for(const [r,g,b] of evidence.samples.slice(1)) expect(g!>180 && b!>180 && g!-r!>100).toBe(true);
    expect(evidence.labels).toEqual([]);
  };
  await resizeWorkspaceWindow({ inspection:before, edge:"right", moves:[{x:48,y:0}], whileHeld:async()=>{
    await browser.waitUntil(async()=>Math.max(...(await inspect(windowId)).surfaces.filter(s=>s.tabId===tabId)
      .map(s=>s.bounds.x+s.bounds.width))>expectedWidth,{timeout:20_000});
    await check("resize-b-active-held");
  }});
  await check("resize-b-active-ended");
}
