import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";

export interface ChromiumRuntimeAppKitProjectionTransaction {
  commit: () => void;
  finalize?: () => void;
  requiresQuarantine: () => boolean;
  rollback: () => void;
}

export interface ChromiumRuntimeSurfaceProjection {
  readonly bounds: ChromiumRoleSurfaceBounds;
  readonly visible: boolean;
  /** Exact Electron WebContents zoom readback when the surface is live. */
  readonly zoomFactor?: number;
}
