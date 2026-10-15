import { browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Role } from "../../../src/shared/types";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eApplicationShortcutRuntime, electronDesktopE2eProbe } from "../support/electron-driver";
import { clickVisibleElectronCanvasWithPointer, clickVisibleElectronPageElementWithPointer } from "../support/electron-role-surface";
import { fixtureCursor, fixtureEvents, fixtureState, waitFixtureEvent } from "../support/fixture";
import { focusVisibleMacosAppKitRuntime, pressVisibleMacosApplicationShortcut, withVisibleMacosRoleKeyReceipt, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";

import { focusWindowsRuntimeNativeWindow } from "../support/windows-runtime-foreground";

/** Native keys only after switching: selecting a ChromeDriver page can hide a missing responder handoff. */
export async function exerciseTabContentFocus(input: {
  platform: "macos" | "windows"; windowId: string; mainWindowHandle: string; roles: readonly Role[]; tabIds: readonly string[];
}): Promise<void> {
  const processId = (await electronDesktopE2eProbe()).processId;
  const first = input.roles[0]!;
  const last = input.roles.at(-1)!;
  const nativeWindowHandle = (await electronDesktopE2eFullscreenToolbarRuntime(input.windowId)).nativeWindowHandle;
  const focusHost = () => input.platform === "macos"
    ? focusVisibleMacosAppKitRuntime({ processId, windowId: input.windowId })
    : focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle: nativeWindowHandle! });
  const shortcut = (command: "toggleFullscreen" | "nextTab" | "previousTab" | "escape") =>
    input.platform === "macos"
      ? pressVisibleMacosApplicationShortcut({ command, processId, runtimeWindowId: input.windowId,
        targetMode: "focused-runtime" })
      : pressVisibleWindowsApplicationShortcut({ command, processId, nativeWindowHandle,
        targetMode: "focused-runtime" });
  const select = async (tabId: string) => {
    await focusHost();
    if ((await electronDesktopE2eApplicationShortcutRuntime(input.windowId)).nativeWindow.activeTabId !== tabId) {
      await shortcut("nextTab");
    }
    await browser.waitUntil(async () =>
      (await electronDesktopE2eApplicationShortcutRuntime(input.windowId)).nativeWindow.activeTabId === tabId,
    { timeout: 20_000 });
  };
  // Establish real, different DOM focus targets before the regression sequence.
  await select(input.tabIds[0]!);
  await clickVisibleElectronPageElementWithPointer(first.launchUrl, input.mainWindowHandle, "#tab-focus-input");
  await select(input.tabIds.at(-1)!);
  await clickVisibleElectronCanvasWithPointer(last.launchUrl, input.mainWindowHandle);
  const waitPresentation = (presentation: "normal" | "fullscreen") => browser.waitUntil(async () =>
    (await electronDesktopE2eFullscreenToolbarRuntime(input.windowId)).presentation === presentation,
  { timeout: 20_000, timeoutMsg: `Native window did not enter ${presentation}` });
  await focusHost();
  await shortcut("toggleFullscreen");
  await waitPresentation("fullscreen");
  const evidence: unknown[] = [];
  for (const step of [
    { command: "nextTab" as const, role: first, tabId: input.tabIds[0]!, element: "tab-focus-input" },
    { command: "previousTab" as const, role: last, tabId: input.tabIds.at(-1)!, element: "game-input-canvas" }
  ]) {
    const switchCursor = await fixtureCursor();
    await shortcut(step.command);
    await browser.waitUntil(async () => {
      const inspection = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
      return (await electronDesktopE2eApplicationShortcutRuntime(input.windowId)).nativeWindow.activeTabId === step.tabId && inspection.surfaces.some(surface =>
        surface.tabId === step.tabId && surface.visible);
    }, { timeout: 20_000, timeoutMsg: "Native tab switch did not project its visible surface" });
    const cursor = await fixtureCursor();
    await shortcut("escape");
    const fixtureId = new URL(step.role.launchUrl).pathname.split("/").at(-1)!;
    await waitFixtureEvent({ afterSequence: cursor, kind: "keyup", roleId: fixtureId });
    const events = await fixtureEvents({ afterSequence: cursor });
    if (input.platform === "windows") {
      const switchEvents = await fixtureEvents({ afterSequence: switchCursor });
      expect(switchEvents.filter(event => event.code === "Tab" &&
        ["keydown", "keyup"].includes(event.kind))).toEqual([]);
    }
    const escape = events.filter(event => event.code === "Escape" && ["keydown", "keyup"].includes(event.kind));
    expect(escape.map(event => event.kind)).toEqual(["keydown", "keyup"]);
    for (const event of escape) expect(event).toMatchObject({ roleId: fixtureId, isTrusted: true,
      targetId: step.element, activeElementId: step.element,
      modifiers: { alt: false, control: false, meta: false, shift: false } });
    const inspection = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
    expect(inspection.presentation).toBe("fullscreen");
    const selection = await electronDesktopE2eApplicationShortcutRuntime(input.windowId);
    expect(selection.nativeWindow.activeTabId).toBe(step.tabId);
    expect(selection.coreWindow.activeTabId).toBe(step.tabId);
    const keyCursor = await fixtureCursor();
    const receiveKey = async (signal?: AbortSignal) => {
      const key = await waitFixtureEvent({ afterSequence: keyCursor, kind: "keydown", roleId: fixtureId,
        ...(signal ? { signal } : {}) });
      expect(key).toMatchObject({ code: input.platform === "macos" ? "KeyY" : "Digit3", isTrusted: true, activeElementId: step.element,
        modifiers: { alt: false, control: false, meta: false, shift: false } });
      const keyup = await waitFixtureEvent({ afterSequence: keyCursor, kind: "keyup", roleId: fixtureId,
        ...(signal ? { signal } : {}) });
      if (input.platform === "macos") expect(keyup).toMatchObject({ code: "KeyY", isTrusted: true,
        activeElementId: step.element, modifiers: { alt: false, control: false, meta: false, shift: false } });
      const state = signal ? await fixtureState(signal) : await fixtureState();
      for (const role of input.roles) {
        const id = new URL(role.launchUrl).pathname.split("/").at(-1)!;
        // Windows focus cleanup releases the old page through the established
        // compatible endpoint. Its DOM key state must clear; new input above must
        // still be trusted. AppKit additionally proves its native release path.
        const pressed = input.platform === "windows" ? state[id]?.pressedCodes : state[id]?.trustedPressedCodes;
        expect((pressed ?? []).filter(code =>
          /^(Control|Shift)/.test(code))).toEqual([]);
      }
      return key;
    };
    let key: Awaited<ReturnType<typeof receiveKey>>;
    if (input.platform === "macos") key = await withVisibleMacosRoleKeyReceipt({ code: "KeyY", processId,
      runtimeWindowId: input.windowId, runtimeTabName: step.role.name }, receiveKey);
    else {
      await pressVisibleWindowsApplicationShortcut({ command: "digit3Tap", processId,
        nativeWindowHandle, targetMode: "focused-runtime" });
      key = await receiveKey();
    }
    evidence.push({ command: step.command, escape, key, activeTabId: selection.nativeWindow.activeTabId,
      presentation: inspection.presentation });
  }
  await writeFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "chromium-tab-content-focus.json"),
    JSON.stringify(evidence, null, 2));
  await shortcut("toggleFullscreen");
  await waitPresentation("normal");
}
