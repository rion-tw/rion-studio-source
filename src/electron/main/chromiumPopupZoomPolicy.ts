import type { ChromiumPopupAdmissionRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";

export function finiteChromiumPopupZoom(
  value: unknown,
  fallback?: number
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number" || !Number.isFinite(candidate) ||
    candidate < 0.25 || candidate > 5
  ) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_POPUP_ZOOM_FENCE_INVALID",
      message: "The controlled popup lost its exact runtime-window zoom fence."
    });
  }
  return candidate;
}

export function effectiveChromiumPopupZoom(
  base: number,
  windowFactor: number
): number {
  return Math.min(5, Math.max(0.25, base * windowFactor));
}

export function chromiumPopupZoomContext(
  snapshot: ChromiumRuntimeExecutorSnapshot,
  admission: ChromiumPopupAdmissionRecord
): Readonly<{ base: number; windowFactor: number }> {
  const parent = admission.parent;
  const window = snapshot.windows.find((candidate) =>
    candidate.windowId === parent.parentWindowId &&
    candidate.windowGeneration === parent.parentWindowGeneration);
  const owner = parent.ownerKind === "role"
    ? snapshot.roles.find((candidate) =>
        candidate.roleId === parent.ownerId &&
        candidate.generation === parent.ownerNativeGeneration &&
        candidate.windowId === parent.parentWindowId)
    : snapshot.webSurfaces.find((candidate) =>
        candidate.surfaceId === parent.ownerId &&
        candidate.generation === parent.ownerNativeGeneration &&
        candidate.windowId === parent.parentWindowId);
  if (!window || !owner) {
    throw new RionBridgeError({
      code: "ELECTRON_CHROMIUM_POPUP_ZOOM_OWNER_STALE",
      message: "The controlled popup no longer has its exact live window owner."
    });
  }
  return Object.freeze({
    base: finiteChromiumPopupZoom(owner.zoomFactor, 1),
    windowFactor: finiteChromiumPopupZoom(window.windowZoomFactor, 1)
  });
}
