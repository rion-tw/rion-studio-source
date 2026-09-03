export type DesktopShellKind = "electron" | "tauri";
export type RendererPlatform = "linux" | "mac" | "windows";
export type WindowGestureMode =
  | "appkit-bridge"
  | "native-non-client"
  | "unavailable";

/**
 * Electron exposes native draggable regions on both supported platforms. The
 * v22 Tauri macOS compatibility shell still owns its exact AppKit drag bridge.
 */
export function windowGestureMode(
  platform: RendererPlatform,
  shell: DesktopShellKind
): WindowGestureMode {
  if (platform === "windows" || shell === "electron") {
    return platform === "linux" ? "unavailable" : "native-non-client";
  }
  return platform === "mac" ? "appkit-bridge" : "unavailable";
}
