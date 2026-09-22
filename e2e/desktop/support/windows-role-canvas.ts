import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eProbe } from "./electron-driver";
import { readVisibleElectronCanvasPoint } from "./electron-role-surface";
import { fixtureCursor, waitFixtureEvent } from "./fixture";
import { focusWindowsRuntimeNativeWindow } from "./windows-runtime-foreground";

/** Click the actual Canvas after returning WebDriver to its launcher evidence target. */
export async function focusWindowsRoleCanvas(input: Readonly<{
  launchUrl: string; mainWindowHandle: string; windowId: string; roleId: string; fixtureId: string;
}>): Promise<void> {
  const { processId } = await electronDesktopE2eProbe();
  const point = await readVisibleElectronCanvasPoint(input.launchUrl, input.mainWindowHandle);
  const host = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
  const surfaces = host.surfaces.filter(surface => surface.kind === "role" && surface.id === input.roleId && surface.visible);
  if (!host.nativeWindowHandle || surfaces.length !== 1 || point.viewport.width <= 0 || point.viewport.height <= 0) {
    throw new Error("The exact visible Windows Role Canvas has no native geometry");
  }
  const bounds = surfaces[0]!.bounds;
  const afterSequence = await fixtureCursor();
  await focusWindowsRuntimeNativeWindow({
    processId, nativeWindowHandle: host.nativeWindowHandle, pointerTarget: "content-click",
    contentPoint: { x: bounds.x + point.x * bounds.width / point.viewport.width,
      y: bounds.y + point.y * bounds.height / point.viewport.height }
  });
  const click = await waitFixtureEvent({ afterSequence, kind: "game-click", roleId: input.fixtureId });
  if (!click.isTrusted || click.targetId !== "game-input-canvas") {
    throw new Error("The native click did not reach the exact Windows Role Canvas");
  }
}
