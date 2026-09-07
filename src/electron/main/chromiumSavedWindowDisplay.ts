import type {
  DisplayInfoRecord,
  DisplayTopologySnapshotRecord,
  StateGameWindowRecord
} from "../../shared/generated";
import { sameBounds } from "./chromiumRuntimeLaunchGeometry";

export function displayFingerprintMatches(
  saved: NonNullable<StateGameWindowRecord["targetDisplay"]["fingerprint"]>,
  display: DisplayInfoRecord
): boolean {
  return saved.label === display.label &&
    sameBounds(saved.bounds, display.bounds) &&
    saved.resolution.width === display.resolution.width &&
    saved.resolution.height === display.resolution.height &&
    saved.scaleFactor === display.scaleFactor &&
    saved.isPrimary === display.isPrimary &&
    saved.isInternal === display.isInternal;
}

/** Resolve consumed legacy metadata against one authoritative screen snapshot. */
export function resolveSavedWindowDisplay(
  saved: StateGameWindowRecord,
  topology: DisplayTopologySnapshotRecord
): DisplayInfoRecord | undefined {
  const fingerprint = saved.targetDisplay.fingerprint;
  const exact = topology.displays.find(display => display.id === saved.targetDisplay.id);
  if (exact && fingerprint && displayFingerprintMatches(fingerprint, exact)) return exact;

  // The retired shell used different monitor IDs, placeholder names and physical
  // resolution. Electron reports DIP size. Never reinterpret a modern fingerprint
  // or choose an arbitrary display when legacy evidence is absent or ambiguous.
  if (fingerprint && !/^Monitor #\d+$/u.test(fingerprint.label)) return undefined;
  const candidates = topology.displays.filter(display => {
    if (!fingerprint) return sameBounds(saved.placement.savedWorkArea, display.workArea);
    return sameBounds(fingerprint.bounds, display.bounds) &&
      fingerprint.resolution.width === Math.round(display.bounds.width * display.scaleFactor) &&
      fingerprint.resolution.height === Math.round(display.bounds.height * display.scaleFactor) &&
      fingerprint.scaleFactor === display.scaleFactor &&
      fingerprint.isPrimary === display.isPrimary &&
      fingerprint.isInternal === display.isInternal;
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}
