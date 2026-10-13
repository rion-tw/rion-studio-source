import type { ChromiumRoleSurfaceInputEvent } from "./chromiumRoleSurfacePorts";

/** Function keys reach the game/managed shortcut owner, never an app menu action. */
export function preserveChromiumFunctionKeyInput(
  contents: { setIgnoreMenuShortcuts: (ignore: boolean) => void },
  input: Pick<ChromiumRoleSurfaceInputEvent, "code" | "key">
): void {
  const functionKey = /^F(?:[1-9]|1[0-9]|2[0-4])$/u;
  // Unlike preventDefault(), this retains trusted DOM keydown/keyup. Reset for
  // every other event so Ctrl+Tab, Quick Access and visible menus still work.
  contents.setIgnoreMenuShortcuts(functionKey.test(input.code) || functionKey.test(input.key));
}
