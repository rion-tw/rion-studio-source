export type RendererPlatform = "linux" | "mac" | "windows";
export type WindowGestureMode = "native-non-client" | "unavailable";

/**
 * Electron exposes native draggable regions on both supported platforms.
 */
export function windowGestureMode(
  platform: RendererPlatform
): WindowGestureMode {
  return platform === "linux" ? "unavailable" : "native-non-client";
}
