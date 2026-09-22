import { browser, expect } from "@wdio/globals";
import { captureWorkspacePixels } from "../support/workspace-pixels";
import { switchTrackedWindow } from "../support/electron-role-surface";
import type { ElectronDesktopE2eFullscreenToolbarRuntimeInspection as Inspection } from "../support/electron-driver";

/** Deterministic paint is a precondition; activation and resize still use native UI. */
export async function paintWorkspaceTargets(main: string, color: string, only?: Set<string>): Promise<void> {
  for (const handle of await browser.getWindowHandles()) {
    if (handle === main || (only && !only.has(handle))) continue;
    await switchTrackedWindow(handle);
    await browser.execute((color) => {
      if (document.querySelector("#location, [data-runtime-tabs], #workspace-background-checker")) return;
      // This fixture paints the entire content viewport. Windows non-overlay
      // scrollbars otherwise occupy the edge samples outside the painted DOM.
      for (const root of [document.documentElement, document.body]) {
        root.style.overflow = "hidden";
        root.style.scrollbarGutter = "auto";
      }
      let paint = document.getElementById("workspace-gap-paint");
      if (!paint) { paint = document.createElement("div"); paint.id = "workspace-gap-paint"; document.body.append(paint); }
      paint.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:2147483647;background:${color}`;
    }, color);
  }
  await switchTrackedWindow(main);
}

export async function expectWorkspacePixels(input: {
  inspection: Inspection; tabId: string; name: string; background: "black" | "material";
  indicators?: "horizontal" | "vertical";
}): Promise<void> {
  const surfaces = input.inspection.surfaces.filter(s => s.tabId === input.tabId);
  const main = surfaces.reduce((a, b) => a.bounds.x < b.bounds.x ? a : b).bounds;
  const right = surfaces.filter(s => s.bounds.x > main.x).sort((a,b) => a.bounds.y-b.bounds.y);
  const top = right[0]!.bounds, bottom = right[1]!.bounds;
  const gapX = top.x - (main.x + main.width), gapY = bottom.y - (top.y + top.height);
  // Windows paints its intentional 1px hover/drag affordance at the center
  // of each divider. Sample the background beside that line, including when
  // the pointer still hovers after release; content leakage remains forbidden.
  const gapFraction = input.inspection.hostKind === "windows" ? 0.25 : 0.5;
  const points = Array.from({ length: 9 }, (_, i) => ({
    x: main.x + main.width + gapX * gapFraction,
    y: main.y + main.height * (i + 1) / 10
  })).concat(Array.from({ length: 9 }, (_, i) => ({
    x: top.x + top.width * (i + 1) / 10, y: top.y + top.height + gapY * gapFraction
  })));
  const gapSampleCount = points.length;
  // Interior edge/corner samples catch content lost during native window resizing.
  const contentPoints = surfaces.flatMap(surface => {
    const b = surface.bounds;
    // A 15%-height slot's center can be inside the valid Windows size label
    // (top inset 16px, height 28px). Probe below it while the label is visible;
    // its exact text is independently asserted through native accessibility.
    const centerFraction = input.indicators && input.inspection.hostKind === "windows" ? 0.8 : 0.5;
    return [{x:b.x+b.width/2,y:b.y+b.height*centerFraction},
      {x:b.x+12,y:b.y+Math.min(60,b.height/2)},
      {x:b.x+b.width-12,y:b.y+Math.min(60,b.height/2)},
      {x:b.x+12,y:b.y+b.height-12},{x:b.x+b.width-12,y:b.y+b.height-12}];
  });
  if (input.name !== "gap-restart") points.push(...contentPoints);
  const slots = input.inspection.workspaceTabs.find(t => t.tabId === input.tabId)!.slots;
  const expected = input.indicators ? slots.filter(slot => input.indicators === "vertical" || slot.rect.x > 0)
    .map(slot => `${Math.round(slot.rect.width*1000)/10}% × ${Math.round(slot.rect.height*1000)/10}%`).sort() : [];
  const result = await captureWorkspacePixels({ inspection: input.inspection,
    reference: { x: main.x+main.width, y: main.y, width: gapX, height: main.height },
    region: { x: main.x, y: main.y, width: top.x+top.width-main.x, height: main.height },
    points, name: input.name, expectedLabels: expected });
  for (const [r,g,b] of result.samples.slice(0, gapSampleCount)) {
    // Color differences tolerate macOS display-profile conversion while identifying
    // both saturated surface paints; neither may remain in a gap.
    expect(r! > 180 && b! > 180 && r! - g! > 100 && b! - g! > 100).toBe(false);
    expect(g! > 180 && b! > 180 && g! - r! > 100 && b! - r! > 100).toBe(false);
    if (input.background === "black") expect(Math.max(r!,g!,b!)).toBeLessThanOrEqual(8);
  }
  for (const [r,g,b] of result.samples.slice(gapSampleCount)) {
    expect(r! > 180 && b! > 180 && r! - g! > 100 && b! - g! > 100).toBe(true);
  }
  expect(result.labels.sort()).toEqual(expected);
}
