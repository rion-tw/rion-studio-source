import { browser, expect } from "@wdio/globals";
import { resizeWorkspaceWindow } from "../support/workspace-window-resize";
import { electronDesktopE2eFullscreenToolbarRuntime as inspect } from "../support/electron-driver";
import { expectWorkspacePixels } from "./chromium-workspace-gap-evidence";

type ResizeInput = { windowId: string; tabId: string; gap: number; background: "black" | "material" };
/** Every move is real border input. Core dimensions, gaps and native pixels must agree while held. */
export async function exerciseWorkspaceResize(input: ResizeInput): Promise<void> {
  const baseline = await inspect(input.windowId);
  const rects = baseline.workspaceTabs.find(t => t.tabId === input.tabId)!.slots.map(s => s.rect);
  const check = async (name: string) => {
    const current = await inspect(input.windowId);
    expect(current.workspaceTabs.find(t => t.tabId === input.tabId)!.slots.map(s => s.rect)).toEqual(rects);
    const surfaces = current.surfaces.filter(s => s.tabId === input.tabId);
    const left = surfaces.reduce((a,b) => a.bounds.x < b.bounds.x ? a : b).bounds;
    const right = surfaces.filter(s => s.bounds.x > left.x).sort((a,b) => a.bounds.y-b.bounds.y);
    expect(right[0]!.bounds.x - left.x - left.width).toBe(input.gap);
    expect(right[1]!.bounds.y - right[0]!.bounds.y - right[0]!.bounds.height).toBe(input.gap);
    await expectWorkspacePixels({ inspection: current, ...input, name });
  };
  for (const edge of ["right", "bottom", "bottomRight", "left", "top"] as const) {
    const first = { x: edge === "bottom" || edge === "top" ? 0 : edge === "left" ? 72 : -72,
      y: edge === "right" || edge === "left" ? 0 : edge === "top" ? 48 : -48 };
    const extent = (current: Awaited<ReturnType<typeof inspect>>) => {
      const boxes = current.surfaces.filter(s => s.tabId === input.tabId).map(s => s.bounds);
      return {width:Math.max(...boxes.map(b => b.x+b.width))-Math.min(...boxes.map(b => b.x)),
        height:Math.max(...boxes.map(b => b.y+b.height))-Math.min(...boxes.map(b => b.y))};
    };
    const original = extent(await inspect(input.windowId));
    await resizeWorkspaceWindow({ inspection: await inspect(input.windowId), edge,
      // Reverse the drag within the initial frame so a border near the screen
      // edge never asks the OS to grow the window beyond its work area.
      moves: [first, { x: first.x/2, y: first.y/2 }, {x:0,y:0}],
      whileHeld: async (step, frame, initialFrame) => {
        await browser.waitUntil(async () => {
          const current = extent(await inspect(input.windowId));
          return Math.abs(current.width-original.width-(frame.width-initialFrame.width)) <= 1 &&
            Math.abs(current.height-original.height-(frame.height-initialFrame.height)) <= 1;
        }, { timeout:20_000, timeoutMsg:`Core geometry did not match the actual ${edge} native resize` });
        await check(`resize-${input.gap}-${input.background}-${edge}-${step}-held`);
      } });
    await check(`resize-${input.gap}-${input.background}-${edge}-ended`);
  }
  if (input.gap === 16 && input.background === "black") {
    const surfaceBounds = baseline.surfaces.filter(s => s.tabId === input.tabId).map(s => s.bounds);
    const width = Math.max(...surfaceBounds.map(b => b.x+b.width));
    const height = Math.max(...surfaceBounds.map(b => b.y+b.height));
    await resizeWorkspaceWindow({ inspection: await inspect(input.windowId), edge: "bottomRight",
      moves: [{x:640-width,y:400-height}, {x:0,y:0}],
      whileHeld: step => check(`resize-range-${step}-held`) });
    await check("resize-range-ended");
    await resizeWorkspaceWindow({ inspection: await inspect(input.windowId), edge: "bottomRight", rapid: true,
      moves: [{x:-96,y:-72}, {x:0,y:0}],
      whileHeld: step => check(`resize-rapid-reversal-${step}-held`) });
    await check("resize-rapid-reversal-ended");
  }

}
