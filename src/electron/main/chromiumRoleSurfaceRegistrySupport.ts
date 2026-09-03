import { RionBridgeError } from "../ipc/errors";
import type { BrowserAction } from "../../shared/generated";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { ChromiumRoleOverlayFrameIdentity } from
  "./chromiumRoleSurfaceRegistry";

export function surfaceError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export function fail(code: string, message: string): never {
  throw surfaceError(code, message);
}

export function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    fail(
      "ELECTRON_ROLE_SURFACE_GENERATION_INVALID",
      "A positive Rust-owned role-surface generation is required."
    );
  }
}

export function validateTabId(tabId: string): void {
  if (
    typeof tabId !== "string" || tabId.length === 0 || tabId.length > 256 ||
    tabId !== tabId.trim() || tabId.includes("/") || tabId.includes("\\") ||
    [...tabId].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    fail(
      "ELECTRON_ROLE_SURFACE_TAB_INVALID",
      "The role surface lost its exact runtime-tab identity."
    );
  }
}

export function validateOverlayRefreshId(refreshId: string): void {
  if (
    typeof refreshId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(refreshId)
  ) {
    fail(
      "ELECTRON_ROLE_OVERLAY_REFRESH_ID_INVALID",
      "A canonical Chromium overlay refresh identity is required."
    );
  }
}

export function sameOverlayFrame(
  left: ChromiumRoleOverlayFrameIdentity,
  right: ChromiumRoleOverlayFrameIdentity
): boolean {
  return left.roleId === right.roleId &&
    left.generation === right.generation &&
    left.frame === right.frame &&
    left.frameToken === right.frameToken &&
    left.documentInstanceId === right.documentInstanceId;
}

export function overlayRefreshSource(
  refreshId: string,
  frameToken: string
): string {
  return `(() => {
    const refreshId = ${JSON.stringify(refreshId)};
    const frameToken = ${JSON.stringify(frameToken)};
    const controller = globalThis.__rionStudioMacroOverlay;
    if (
      globalThis.__rionStudioDocumentInstanceId !== frameToken ||
      typeof controller?.refreshFromNative !== "function"
    ) {
      return Object.freeze({ frameToken, refreshId, status: "rejected" });
    }
    void controller.refreshFromNative(refreshId);
    return Object.freeze({ frameToken, refreshId, status: "submitted" });
  })()`;
}

export function validateBounds(bounds: ChromiumRoleSurfaceBounds): void {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.width < 0 ||
    bounds.height < 0
  ) {
    fail(
      "ELECTRON_ROLE_SURFACE_BOUNDS_INVALID",
      "Role-surface bounds must contain finite integer coordinates and sizes."
    );
  }
}

export function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

export function validateZoomFactor(zoomFactor: number): void {
  if (!Number.isFinite(zoomFactor) || zoomFactor < 0.25 || zoomFactor > 5) {
    fail(
      "ELECTRON_ROLE_SURFACE_ZOOM_INVALID",
      "The role-surface zoom factor must be between 0.25 and 5."
    );
  }
}

export function resolveTrustedInputClickPoint(
  action: Extract<BrowserAction, { type: "click" }>,
  bounds: ChromiumRoleSurfaceBounds,
  zoomFactor: number
): Readonly<{ clientX: number; clientY: number; zoomFactor: number }> {
  const viewportWidth = bounds.width / zoomFactor;
  const viewportHeight = bounds.height / zoomFactor;
  if (
    viewportWidth < 1 || viewportHeight < 1 ||
    !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
  ) {
    fail(
      "ELECTRON_ROLE_TRUSTED_INPUT_VIEWPORT_INVALID",
      "The live Chromium role surface has no usable click viewport."
    );
  }
  const anchors = {
    "top-left": [0, 0],
    "top-center": [50, 0],
    "top-right": [100, 0],
    "center-left": [0, 50],
    center: [50, 50],
    "center-right": [100, 50],
    "bottom-left": [0, 100],
    "bottom-center": [50, 100],
    "bottom-right": [100, 100]
  } as const;
  const [anchorX, anchorY] = action.anchor === null
    ? anchors["top-left"]
    : anchors[action.anchor];
  const anchoredX = viewportWidth * anchorX / 100;
  const anchoredY = viewportHeight * anchorY / 100;
  const rawX = action.unit === "percent"
    ? viewportWidth * (anchorX + action.x) / 100
    : anchoredX + action.x / (action.unit === "reference-px" ? zoomFactor : 1);
  const rawY = action.unit === "percent"
    ? viewportHeight * (anchorY + action.y) / 100
    : anchoredY + action.y / (action.unit === "reference-px" ? zoomFactor : 1);
  return Object.freeze({
    clientX: Math.min(
      Math.max(Math.round(rawX), 0),
      Math.max(Math.floor(viewportWidth) - 1, 0)
    ),
    clientY: Math.min(
      Math.max(Math.round(rawY), 0),
      Math.max(Math.floor(viewportHeight) - 1, 0)
    ),
    zoomFactor
  });
}
