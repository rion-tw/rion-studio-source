import type { StatePixelBoundsRecord } from "../../shared/generated";

export type DipToScreenRect = (
  window: null,
  bounds: StatePixelBoundsRecord
) => StatePixelBoundsRecord;

export function resolveExternalPhysicalBounds(
  platform: NodeJS.Platform,
  bounds: StatePixelBoundsRecord,
  dipToScreenRect: DipToScreenRect
): StatePixelBoundsRecord {
  return platform === "win32" ? dipToScreenRect(null, bounds) : bounds;
}
