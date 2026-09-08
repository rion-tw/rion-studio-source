import type { EmbeddedLaunchTargetRecord } from "../../shared/generated";

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
