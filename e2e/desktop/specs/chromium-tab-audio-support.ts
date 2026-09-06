import { browser, expect } from "@wdio/globals";

import { electronDesktopE2eRuntimeTabReload } from "../support/electron-driver";
import { selectMacosVisibleRuntimeTabMenuAction } from "../support/macos-appkit-ui";
import { selectVisibleWindowsRuntimeTabMenuAction } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";

/** Primary actions use visible menus; inspection only reads Core/native evidence. */
export async function verifyVisibleChromiumTabAudio(input: Readonly<{
  muted: boolean;
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tabId: string;
  tabName: string;
  windowId: string;
}>): Promise<void> {
  const before = await electronDesktopE2eRuntimeTabReload(input.windowId);
  expect(before.roles.length).toBeGreaterThan(0);
  expect(before.roles.every((role) => role.audioMuted !== input.muted)).toBe(true);
  {
    const { muted } = input;
    const action = muted ? "mute" : "unmute";
    if (input.platform === "macos") {
      await selectMacosVisibleRuntimeTabMenuAction({ ...input, action });
    } else {
      await selectVisibleWindowsRuntimeTabMenuAction({ ...input, action });
    }
    await browser.waitUntil(async () => {
      const core = await rendererCall("getEmbeddedRuntimeState");
      const native = await electronDesktopE2eRuntimeTabReload(input.windowId);
      return core.tabs.some((tab) => tab.id === input.tabId && tab.audioMuted === muted) &&
        native.roles.length === before.roles.length &&
        native.roles.every((role) => role.tabId === input.tabId && role.audioMuted === muted);
    }, { timeout: 15_000, interval: 100, timeoutMsg: "Tab mute did not reach Core and Chromium" });
    const after = await electronDesktopE2eRuntimeTabReload(input.windowId);
    expect(after.roles.map(({ audioMuted: _muted, ...role }) => role)).toEqual(
      before.roles.map(({ audioMuted: _muted, ...role }) => role)
    );
  }
}
