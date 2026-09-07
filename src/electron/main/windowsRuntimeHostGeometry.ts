import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
export function requireBounds(
  bounds: ChromiumRoleSurfaceBounds,
  field: string,
  minimumWidth = 1,
  minimumHeight = 1
): void {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.width < minimumWidth ||
    bounds.height < minimumHeight ||
    !Number.isSafeInteger(bounds.x + bounds.width) ||
    !Number.isSafeInteger(bounds.y + bounds.height)
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_RUNTIME_HOST_BOUNDS_INVALID",
      message: `Core supplied invalid ${field} bounds for the runtime host.`
    });
  }
}

/** One native host's last usable viewport; minimize is not a resize. */
export class WindowsRuntimeContentGeometry {
  #lastUnminimized: ChromiumRoleSurfaceBounds | null = null;

  read(native: Readonly<{
    getContentBounds: () => ChromiumRoleSurfaceBounds;
    isMinimized: () => boolean;
  }>, inset: number): ChromiumRoleSurfaceBounds {
    const minimized = native.isMinimized();
    const bounds = minimized ? this.#lastUnminimized : native.getContentBounds();
    if (!bounds) {
      throw new RionBridgeError({
        code: "ELECTRON_RUNTIME_HOST_CONTENT_BOUNDS_UNOBSERVED",
        message: "The minimized Windows host has no previously observed content bounds."
      });
    }
    requireBounds(bounds, "native content");
    if (bounds.height <= inset) {
      throw new RionBridgeError({
        code: "ELECTRON_RUNTIME_HOST_CONTENT_BOUNDS_INVALID",
        message: "The Windows runtime host has no content area below its chrome."
      });
    }
    if (!minimized) this.#lastUnminimized = Object.freeze({ ...bounds });
    return Object.freeze({ x: 0, y: inset, width: bounds.width, height: bounds.height - inset });
  }
}
