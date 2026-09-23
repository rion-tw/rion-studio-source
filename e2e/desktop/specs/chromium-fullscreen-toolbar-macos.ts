import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browser, expect } from "@wdio/globals";
import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eProbe,
  type ElectronDesktopE2eFullscreenToolbarRuntimeInspection
} from "../support/electron-driver";
import {
  movePointerToMacosFullscreenRevealEdge,
  movePointerToMacosRuntimeContent
} from "../support/macos-appkit-ui";
import { focusVisibleMacosAppKitRuntime } from "../support/native-application-actions";

const executeFile = promisify(execFile);
type Inspection = ElectronDesktopE2eFullscreenToolbarRuntimeInspection;

export function expectMacosRevealSynchronized(inspection: Inspection): void {
  const appKit = inspection.native.appKit!;
  const lifecycle = appKit.nativeLifecycle!;
  expect(lifecycle).toBeDefined();
  expect(lifecycle.sequence).toBeGreaterThan(0);
  expect(appKit.presentationAutoHideToolbar).toBe(true);
  expect(lifecycle.toolbarReveal).toBeCloseTo(lifecycle.menuBarReveal, 3);
  if (lifecycle.menuBarReveal === 0) {
    expect(appKit.accessoryVisibleHeight).toBe(0);
    expect(appKit.visibleTrafficLightCount).toBe(0);
  }
}

async function waitForNativeMenu(
  windowId: string,
  revealed: boolean,
  afterSequence: number,
  pinned: boolean
): Promise<Inspection> {
  let last: Inspection | undefined;
  let failure: unknown;
  await browser.waitUntil(async () => {
    last = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    const native = last.native.appKit!;
    const lifecycle = native.nativeLifecycle!;
    expect(lifecycle).toBeDefined();
    try {
      if (pinned && lifecycle.onActiveSpace) {
        expect(last.native.nativeWindowControlCount).toBe(3);
        expect(native.visibleTrafficLightCount).toBe(3);
      }
    } catch (error) {
      failure = error;
      return true;
    }
    return lifecycle.sequence > afterSequence && lifecycle.onActiveSpace &&
      (revealed ? lifecycle.menuBarReveal >= 0.999 : lifecycle.menuBarReveal <= 0.001);
  }, { interval: 30, timeout: 20_000,
    timeoutMsg: `Native menu bar did not ${revealed ? "reveal" : "retract"}` });
  if (failure) throw failure;
  return last!;
}

export async function proveMacosPinnedHoverCycles(windowId: string): Promise<void> {
  await movePointerToMacosRuntimeContent(windowId);
  for (let cycle = 0; cycle < 2; cycle++) {
    const before = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    const baseline = before.surfaces.map((surface) => surface.bounds);
    const sequence = before.native.appKit!.nativeLifecycle!.sequence;
    await movePointerToMacosFullscreenRevealEdge(windowId);
    const shown = await waitForNativeMenu(windowId, true, sequence, true);
    await movePointerToMacosRuntimeContent(windowId);
    const hidden = await waitForNativeMenu(
      windowId, false, shown.native.appKit!.nativeLifecycle!.sequence, true);
    expect(hidden.surfaces.map((surface) => surface.bounds)).toEqual(baseline);
    expect(hidden.native.toolbarVisible).toBe(true);
    expect(hidden.native.appKit!.nativeLifecycle!.toolbarReveal).toBe(1);
  }
}

export async function proveMacosFullscreenSpaceReturn(
  windowId: string, pinned: boolean
): Promise<void> {
  const probe = await electronDesktopE2eProbe();
  const before = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  // Switch the runtime display itself: activating Finder can merely focus
  // another display and leave this fullscreen Space active.
  await executeFile("/usr/bin/osascript", ["-e",
    'tell application "System Events" to key code 123 using control down']);
  await browser.waitUntil(async () => {
    const current = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    return current.native.appKit?.nativeLifecycle?.onActiveSpace === false;
  }, { timeout: 15_000, timeoutMsg: "The native fullscreen Space was not left" });
  await executeFile("/usr/bin/osascript", ["-e",
    'tell application "System Events" to key code 124 using control down']);
  await browser.waitUntil(async () => {
    const current = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    return current.native.appKit?.nativeLifecycle?.onActiveSpace === true;
  }, { timeout: 15_000, timeoutMsg: "The native fullscreen Space was not returned to" });
  await focusVisibleMacosAppKitRuntime({ processId: probe.processId, windowId });
  await movePointerToMacosRuntimeContent(windowId);
  await browser.waitUntil(async () => {
    const current = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    const native = current.native.appKit!;
    if (!native.nativeLifecycle?.onActiveSpace) return false;
    expect(current.surfaces.map((surface) => surface.bounds))
      .toEqual(before.surfaces.map((surface) => surface.bounds));
    return native.nativeLifecycle.menuBarReveal <= 0.001 &&
      native.visibleTrafficLightCount === (pinned ? 3 : 0) &&
      current.native.toolbarVisible === pinned;
  }, { timeout: 20_000, timeoutMsg: "Toolbar policy did not survive native Space return" });
}
