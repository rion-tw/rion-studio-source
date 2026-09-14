import type { DisplayInfoRecord, DisplayTopologySnapshotRecord, EmbeddedLaunchTargetRecord } from "../../shared/generated";

export function sameBounds(
  left: EmbeddedLaunchTargetRecord["bounds"],
  right: EmbeddedLaunchTargetRecord["bounds"]
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

export function sameNormalBounds(
  left: EmbeddedLaunchTargetRecord["bounds"],
  right: EmbeddedLaunchTargetRecord["bounds"]
): boolean {
  return Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1 &&
    Math.abs(left.width - right.width) <= 1 &&
    Math.abs(left.height - right.height) <= 1;
}

export function validBounds(
  bounds: EmbeddedLaunchTargetRecord["bounds"],
  minimumWidth = 1,
  minimumHeight = 1
): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) &&
    bounds.width >= minimumWidth && bounds.height >= minimumHeight &&
    Number.isSafeInteger(bounds.x + bounds.width) &&
    Number.isSafeInteger(bounds.y + bounds.height);
}

export function cloneTarget(target: EmbeddedLaunchTargetRecord): EmbeddedLaunchTargetRecord {
  return {
    ...target,
    bounds: { ...target.bounds },
    workArea: { ...target.workArea }
  };
}

export function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(
    (value, index) => value === right[index]
  );
}

export function displayById(
  topology: DisplayTopologySnapshotRecord,
  displayId: number
): DisplayInfoRecord | undefined {
  return topology.displays.find((display) => display.id === displayId);
}

export function targetMatchesDisplay(
  target: EmbeddedLaunchTargetRecord,
  topology: DisplayTopologySnapshotRecord
): boolean {
  const display = displayById(topology, target.displayId);
  return display !== undefined &&
    display.scaleFactor === target.scaleFactor &&
    sameBounds(display.workArea, target.workArea) &&
    validBounds(target.bounds, 640, 480) &&
    target.bounds.x >= target.workArea.x &&
    target.bounds.y >= target.workArea.y &&
    target.bounds.x + target.bounds.width <= target.workArea.x + target.workArea.width &&
    target.bounds.y + target.bounds.height <= target.workArea.y + target.workArea.height;
}
