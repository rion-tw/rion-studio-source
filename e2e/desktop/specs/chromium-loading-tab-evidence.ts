import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { browser, expect } from "@wdio/globals";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eApplicationShortcutRuntime, electronDesktopE2eGameWindowRuntime } from "../support/electron-driver";
import { captureWorkspacePixels } from "../support/workspace-pixels";
import { resizeWorkspaceWindow } from "../support/workspace-window-resize";

type ResizeInspection = Awaited<ReturnType<typeof electronDesktopE2eFullscreenToolbarRuntime>>;

function requireOriginalResizeOwner(original: ResizeInspection, current: ResizeInspection): void {
  const surfaceIdentities = (inspection: ResizeInspection) => inspection.surfaces
    .map(({ id, kind, tabId, generation }) => JSON.stringify([id, kind, tabId, generation])).sort();
  const originalSurfaces = surfaceIdentities(original);
  const currentSurfaces = surfaceIdentities(current);
  if (current.windowId !== original.windowId || current.windowGeneration !== original.windowGeneration ||
      current.hostKind !== original.hostKind || current.nativeWindowHandle !== original.nativeWindowHandle ||
      current.tabIds.length !== original.tabIds.length ||
      current.tabIds.some((tabId, index) => tabId !== original.tabIds[index]) ||
      currentSurfaces.length !== originalSurfaces.length ||
      currentSurfaces.some((surface, index) => surface !== originalSurfaces[index])) {
    throw new Error("Native resize lost the original window, tab, or surface owner");
  }
}

export async function resizeReadyTabWhileSiblingLoads(input: {
  platform: "macos" | "windows"; windowId: string; tabId: string;
}) {
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
  const before = inspection.surfaces.find(surface => surface.tabId === input.tabId)!.bounds;
  let resized = before;
  // A standalone AppKit Role has no Workspace corner grip. Use its native
  // right/bottom borders separately so both dimensions actually move.
  const drags = input.platform === "macos"
    ? [{ edge: "right" as const, x: -48, y: 0 }, { edge: "bottom" as const, x: 0, y: -32 }]
    : [{ edge: "bottomRight" as const, x: -48, y: -32 }];
  for (const drag of drags) {
    // End-live-resize commits a new Core revision for the next native gesture.
    const current = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
    requireOriginalResizeOwner(inspection, current);
    await resizeWorkspaceWindow({ inspection: current, edge: drag.edge, moves: [drag],
      whileHeld: async () => {
        await browser.waitUntil(async () => {
          const current = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
          resized = current.surfaces.find(surface => surface.tabId === input.tabId)!.bounds;
          return (drag.x === 0 || resized.width < before.width) &&
            (drag.y === 0 || resized.height < before.height);
        }, { timeout: 20_000, timeoutMsg: "Native resize did not update A while B was loading" });
      }
    });
  }
  expect(resized.width).toBeLessThan(before.width);
  expect(resized.height).toBeLessThan(before.height);
  return resized;
}

/** Observe the real screen before releasing B's navigation, without changing focus. */
export async function expectReadyTabAboveLoadingSibling(windowId: string, readyTabId: string,
  loadingTabId: string, loadingRoleId: string): Promise<void> {
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  const owner = await electronDesktopE2eApplicationShortcutRuntime(windowId);
  expect(owner.nativeWindow.activeTabId).toBe(readyTabId);
  expect(owner.coreWindow.activeTabId).toBe(readyTabId);
  const ready = inspection.surfaces.find(surface => surface.tabId === readyTabId)!;
  const { x, y, width, height } = ready.bounds;
  const evidence = await captureWorkspacePixels({ inspection, observeOnly: true, windowEdges: true,
    name: "ready-a-before-b-navigation-completes", reference: ready.bounds,
    region: ready.bounds, points: [{ x: x + 5, y: y + height / 2 }, { x: x + width - 5, y: y + height / 2 }] });
  for (const [r, g, b] of evidence.samples) {
    expect(g! > 175 && g! > r! + 60 && g! > b! + 60).toBe(true);
  }
  expect(ready.visible).toBe(true);
  const observations = JSON.parse(await readFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!,
    "electron-windows-role-attachment-observations.json"), "utf8")) as { roleId: string; visible?: boolean }[];
  expect(observations.filter(item => item.roleId === loadingRoleId).at(-1)?.visible).toBe(false);
  expect(inspection.surfaces.filter(surface => surface.tabId === loadingTabId))
    .toEqual([expect.objectContaining({ visible: false })]);
}

/** The selected B exposes its native loading presentation while completion is gated. */
export async function expectLoadingTabPresentation(windowId: string, tabId: string,
  platform: "macos" | "windows"): Promise<void> {
  await browser.waitUntil(async () => {
    const owner = await electronDesktopE2eApplicationShortcutRuntime(windowId);
    return owner.nativeWindow.activeTabId === tabId && owner.coreWindow.activeTabId === tabId;
  }, { timeout: 20_000, timeoutMsg: "The exact loading tab did not become the native/Core selection" });
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  const loading = inspection.surfaces.find(surface => surface.tabId === tabId)!;
  expect(loading.visible).toBe(true);
  expect(inspection.surfaces.filter(surface => surface.tabId !== tabId).every(surface => !surface.visible)).toBe(true);
  const reference = loading.bounds;
  const evidence = await captureWorkspacePixels({ inspection, observeOnly: true, windowEdges: true,
    name: "loading-b-before-navigation-completes", reference, region: reference,
    points: [{ x: reference.x + 5, y: reference.y + reference.height / 2 },
      { x: reference.x + reference.width - 5, y: reference.y + reference.height / 2 }] });
  if (platform === "macos") {
    expect((await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime?.appKitStatusPresentation).toBe("loading");
  }
  for (const [r, g, b] of evidence.samples) {
    if (platform === "macos") {
      // The AppKit status backdrop uses NSColor.windowBackgroundColor in both
      // light and dark appearances; the workspace underlay must not cover it.
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(40);
    } else if (inspection.native.workspaceBackground === "material") {
      // Mica follows Windows appearance; light Mica is not a white compositor
      // flash or the saturated green ready sibling behind this loading view.
      expect(Math.max(r!, g!, b!)).toBeLessThan(255);
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(40);
    } else expect(r! < 100 && g! < 100 && b! < 100).toBe(true);
  }
}
