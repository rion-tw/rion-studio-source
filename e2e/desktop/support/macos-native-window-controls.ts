import { runCompiledMacosSwift } from "./compiled-macos-swift";
import { electronDesktopE2eProbe } from "./electron-driver";
import { focusVisibleMacosAppKitRuntime } from "./native-application-actions";

/** Native UI input/readback, fenced to the exact retained AppKit window. */
export async function macosNativeWindowControl(
  command: "drag" | "resize" | "minimize" | "minimized",
  windowId: string | undefined,
  dragDelta?: Readonly<{ x: number; y: number }>
): Promise<string> {
  if (process.platform !== "darwin" || !windowId?.trim()) {
    throw new Error("The native window control requires an exact macOS window ID");
  }
  const { processId } = await electronDesktopE2eProbe();
  if (command !== "minimized") {
    await focusVisibleMacosAppKitRuntime({ processId, windowId });
  }
  const stdout = await runCompiledMacosSwift("macos-native-window-controls", [
    String(processId), windowId, command,
    ...(dragDelta ? [String(dragDelta.x), String(dragDelta.y)] : [])
  ], command === "drag" || command === "resize" ? 30_000 : 10_000);
  return stdout.trim();
}

/** Read the exact focused AppKit frame without interpreting Swift on each call. */
export async function readMacosNativeWindowGeometry(
  processId: number,
  windowId: string,
  fullscreen = false
): Promise<{ x: number; y: number; width: number; height: number }> {
  return JSON.parse(await runCompiledMacosSwift("macos-native-window-controls", [
    String(processId), windowId, fullscreen ? "fullscreenGeometry" : "geometry"
  ], 15_000)) as { x: number; y: number; width: number; height: number };
}
