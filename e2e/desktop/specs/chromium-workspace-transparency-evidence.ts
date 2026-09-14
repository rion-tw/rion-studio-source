import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { electronDesktopE2eFullscreenToolbarRuntime } from "../support/electron-driver";
import { switchTrackedWindow } from "../support/electron-role-surface";
import { captureWorkspacePixels } from "../support/workspace-pixels";

type WebsiteHandles = { chrome: string; content: string };
/** Bind the only Website in A before B adds other local toolbars. */
export async function captureWorkspaceWebsiteHandles(main: string): Promise<WebsiteHandles> {
  const chrome: string[] = [], content: string[] = [];
  try {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === main) continue;
      await switchTrackedWindow(handle);
      const document = await browser.execute(() => ({ chrome: !!window.document.querySelector("#location"), url:location.href }));
      if (document.chrome) chrome.push(handle);
      else if (document.url.startsWith("rion-start:")) content.push(handle);
    }
  } finally { await switchTrackedWindow(main); }
  expect(chrome).toHaveLength(1);
  expect(content).toHaveLength(1);
  return { chrome:chrome[0]!, content:content[0]! };
}

/** A real document keeps its opaque paint while transparent regions reveal the native underlay. */
export async function exerciseWorkspaceTransparency(input: {
  windowId: string; tabId: string; mainWindowHandle: string; fixtureOrigin: string;
  handles: WebsiteHandles; platform: "macos" | "windows";
  background: (mode: "black" | "material") => Promise<void>;
}): Promise<void> {
  const url = `${input.fixtureOrigin}/workspace-transparency`;
  let chromeHeight: number;
  try {
    await switchTrackedWindow(input.handles.chrome);
    chromeHeight = await browser.execute(() => innerHeight);
    const location = await $("#location");
    await location.click();
    await browser.keys([input.platform === "macos" ? Key.Command : Key.Ctrl, "a"]);
    await browser.keys(url);
    await browser.keys(Key.Enter);
    await switchTrackedWindow(input.handles.content);
    await browser.waitUntil(async () => await browser.getUrl() === url, { timeout:20_000 });
    await $("#opaque").waitForDisplayed({ timeout:20_000 });
  } finally { await switchTrackedWindow(input.mainWindowHandle); }
  const transparentSamples: number[][] = [];
  for (const background of ["black", "material"] as const) {
    await input.background(background);
    const inspection = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
    const slot = inspection.surfaces.find(s => s.tabId === input.tabId && s.kind === "web")!.bounds;
    const b = { ...slot, y:slot.y+chromeHeight, height:slot.height-chromeHeight };
    const surfaces = inspection.surfaces.filter(s => s.tabId === input.tabId);
    const left = surfaces.reduce((a,c) => a.bounds.x < c.bounds.x ? a : c).bounds;
    const right = surfaces.find(s => s.bounds.x > left.x)!.bounds;
    const evidence = await captureWorkspacePixels({ inspection, name: `transparent-document-${background}`,
      reference: { x: left.x+left.width, y:left.y, width:right.x-left.x-left.width, height:left.height },
      region:b, points:[{x:b.x+b.width/2,y:b.y+b.height/2}, {x:b.x+b.width/8,y:b.y+b.height/2}] });
    const [r,g,blue] = evidence.samples[0]!;
    expect(g! > 140 && g!-r! > 90 && g!-blue! > 60).toBe(true);
    const transparent = evidence.samples[1]!;
    if (background === "black") expect(Math.max(...transparent)).toBeLessThanOrEqual(8);
    transparentSamples.push(transparent);
    expect(evidence.labels).toEqual([]);
  }
  expect(transparentSamples[1]).not.toEqual(transparentSamples[0]);
  await input.background("black");
}
