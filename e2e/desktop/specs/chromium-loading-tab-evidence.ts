import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "@wdio/globals";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eApplicationShortcutRuntime } from "../support/electron-driver";
import { captureWorkspacePixels } from "../support/workspace-pixels";

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

/** The selected B has a dark native loading presentation while completion is gated. */
export async function expectLoadingTabPresentation(windowId: string): Promise<void> {
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  const reference = inspection.surfaces[0]!.bounds;
  const evidence = await captureWorkspacePixels({ inspection, observeOnly: true, windowEdges: true,
    name: "loading-b-before-navigation-completes", reference, region: reference,
    points: [{ x: reference.x + 5, y: reference.y + reference.height / 2 },
      { x: reference.x + reference.width - 5, y: reference.y + reference.height / 2 }] });
  for (const [r, g, b] of evidence.samples) {
    expect(r! < 100 && g! < 100 && b! < 100).toBe(true);
  }
}
