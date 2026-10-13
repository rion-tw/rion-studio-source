import type { ChromiumRoleSurfaceInputEvent } from "./chromiumRoleSurfacePorts";

/** Preserve trusted function-key delivery; application menus also omit Fn accelerators. */
export function preserveChromiumFunctionKeyInput(
  contents: { setIgnoreMenuShortcuts: (ignore: boolean) => void },
  input: Pick<ChromiumRoleSurfaceInputEvent, "code" | "key">
): void {
  const functionKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/u;
  // Unlike preventDefault(), this retains trusted DOM keydown/keyup. Reset for
  // every other event so Ctrl+Tab, Quick Access and visible menus still work.
  // This mutable preference is not a per-event ACK fence: queued ordinary keys
  // can reset it before an earlier unhandled key returns from the renderer.
  // Removing function-key menu accelerators is therefore mandatory as well.
  contents.setIgnoreMenuShortcuts(functionKey.test(input.code) || functionKey.test(input.key));
}
