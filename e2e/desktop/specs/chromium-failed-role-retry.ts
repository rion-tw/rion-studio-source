import { $, browser, expect } from "@wdio/globals";
import type { Role } from "../../../src/shared/types";
import { electronDesktopE2eRoleSessionRuntime } from "../support/electron-driver";
import { switchTrackedWindow } from "../support/electron-role-surface";
import { runtimeTabShellErrors, visibleRuntimeTabPhase } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";

/** Retries the retained failed tab by clicking its real local placeholder. */
export async function retryFailedRolePlaceholder(input: {
  mainWindowHandle: string;
  platform: "macos" | "windows";
  role: Role;
  tabId: string;
  windowId: string;
}): Promise<void> {
  let target: string | undefined;
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === input.mainWindowHandle) continue;
      try {
        await switchTrackedWindow(handle);
        const url = new URL(await browser.getUrl());
        if (url.protocol !== "file:" || !url.pathname.endsWith("/runtime-role-placeholder-electron.html")) continue;
        if (!await $("#claim").isDisplayed() || !await $("#claim").isEnabled()) continue;
        if (!(await $("body").getText()).includes(input.role.name)) continue;
        target = handle;
        return true;
      } catch { /* A retired document is not a current placeholder. */ }
    }
    await switchTrackedWindow(input.mainWindowHandle);
    return false;
  }, { timeout: 20_000, timeoutMsg: "Failed Role did not expose its visible retry placeholder" });
  if (!target) throw new Error("The failed Role placeholder is missing");
  try { await $("#claim").click(); }
  finally { await switchTrackedWindow(input.mainWindowHandle); }
  await browser.waitUntil(async () => (await rendererCall("listRoleStatuses"))
    .some(role => role.roleId === input.role.id && role.state === "running"), {
    timeout: 45_000, timeoutMsg: "Failed Role could not retry from its retained tab"
  });
  expect((await electronDesktopE2eRoleSessionRuntime(input.role.id)).currentRuntime)
    .toEqual(expect.objectContaining({ tabId: input.tabId, windowId: input.windowId }));
  expect(await visibleRuntimeTabPhase({ ...input, tabName: input.role.name })).toBe("ready");
  expect(await runtimeTabShellErrors()).toEqual([]);
}
