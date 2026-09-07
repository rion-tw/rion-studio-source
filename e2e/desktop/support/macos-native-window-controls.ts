import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { electronDesktopE2eProbe } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";

const executeFile = promisify(execFile);
const script = fileURLToPath(new URL("./macos-native-window-controls.swift", import.meta.url));

/** Native UI input/readback, fenced to the exact retained AppKit window. */
export async function macosNativeWindowControl(
  command: "drag" | "resize" | "minimize" | "minimized",
  windowId: string | undefined
): Promise<string> {
  if (process.platform !== "darwin" || !windowId?.trim()) {
    throw new Error("The native window control requires an exact macOS window ID");
  }
  const { processId } = await electronDesktopE2eProbe();
  if (command !== "minimized") {
    await focusVisibleMacosAppKitRuntime({ processId, windowId });
  }
  const result = await executeFile("/usr/bin/xcrun", [
    "swift", script, String(processId), windowId, command
  ], { encoding: "utf8", timeout: command === "drag" || command === "resize" ? 30_000 : 10_000 });
  return result.stdout.trim();
}
