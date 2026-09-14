import { $ } from "@wdio/globals";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { electronDesktopE2eProbe } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";
import { withWindowsRuntimeHost } from "./native-runtime-tabs";

const executeFile = promisify(execFile);
export async function workspaceSlotUi(input: {
  platform: "macos" | "windows"; windowId: string; tabId: string;
  slotId: string; mainWindowHandle: string; action?: "read" | "retry";
}): Promise<{ phase: string; width?: number; height?: number }> {
  if (input.platform === "macos") {
    const processId = (await electronDesktopE2eProbe()).processId;
    if (input.action === "retry") await focusVisibleMacosAppKitRuntime({ processId, windowId: input.windowId });
    const output = await executeFile("/usr/bin/xcrun", ["swift",
      resolve(import.meta.dirname, "workspace-slot-ui.swift"),
      JSON.stringify({ ...input, processId, action: input.action ?? "read" })
    ], { encoding: "utf8", timeout: 15_000 });
    return JSON.parse(output.stdout);
  }
  return withWindowsRuntimeHost(input.mainWindowHandle, input.tabId, async () => {
    const slot = await $(`[data-workspace-slot-status='${input.slotId}']`);
    if (!await slot.isExisting()) return { phase: "ready" };
    const phase = await slot.getAttribute("data-phase");
    const size = await slot.getSize();
    if (input.action === "retry") {
      const retry = await slot.$("button");
      await retry.waitForClickable({ timeout: 10_000 });
      await retry.click();
    }
    return { phase: phase!, width: size.width, height: size.height };
  }, input.windowId);
}
