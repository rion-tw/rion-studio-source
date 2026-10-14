import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import { requireBounds } from "./windowsRuntimeHostGeometry";

function capturedBounds(bounds: ChromiumRoleSurfaceBounds): ChromiumRoleSurfaceBounds {
  requireBounds(bounds, "native restored window", 640, 480);
  return Object.freeze({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
}

function unwitnessedGeometry(): RionBridgeError {
  return new RionBridgeError({
    code: "ELECTRON_RUNTIME_HOST_FULLSCREEN_GEOMETRY_UNWITNESSED",
    message: "The fullscreen Windows host has no owned native restore-geometry capture."
  });
}

/**
 * Retains one host's native restore rectangle across its owned fullscreen call.
 * Electron applies the current frame insets to getNormalBounds(), so its
 * fullscreen readback can differ from the same host's normal restore geometry.
 * The factory owns the native identity and Core fences around these calls.
 */
export class WindowsRuntimeRestoredGeometry {
  #restoredBounds: ChromiumRoleSurfaceBounds;
  #fullscreenCaptured = false;

  constructor(initialNormalBounds: ChromiumRoleSurfaceBounds) {
    this.#restoredBounds = capturedBounds(initialNormalBounds);
  }

  captureBeforeFullscreen(rawNormalBounds: ChromiumRoleSurfaceBounds, fullscreen: boolean): void {
    if (fullscreen !== false) throw unwitnessedGeometry();
    const bounds = capturedBounds(rawNormalBounds);
    this.#restoredBounds = bounds;
    this.#fullscreenCaptured = true;
  }

  read(rawNormalBounds: ChromiumRoleSurfaceBounds, fullscreen: boolean): Readonly<ChromiumRoleSurfaceBounds> {
    if (typeof fullscreen !== "boolean") throw unwitnessedGeometry();
    requireBounds(rawNormalBounds, "native restored window", 640, 480);
    if (fullscreen) {
      if (!this.#fullscreenCaptured) throw unwitnessedGeometry();
      return this.#restoredBounds;
    }
    this.#restoredBounds = capturedBounds(rawNormalBounds);
    this.#fullscreenCaptured = false;
    return this.#restoredBounds;
  }
}
