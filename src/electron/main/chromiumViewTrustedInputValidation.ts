import type { ChromiumViewInputIdentity, ChromiumViewInputObservation } from "./chromiumViewInputSubmission";

const token = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export function sameChromiumViewInputIdentity(left: ChromiumViewInputIdentity, right: ChromiumViewInputIdentity): boolean {
  return left.roleId === right.roleId && left.surfaceGeneration === right.surfaceGeneration &&
    left.nativeGeneration === right.nativeGeneration && left.bindingRevision === right.bindingRevision &&
    left.parentIdentity === right.parentIdentity && left.webContentsId === right.webContentsId;
}

export function validChromiumViewInputIdentity(value: ChromiumViewInputIdentity): boolean {
  return typeof value.roleId === "string" && value.roleId.length > 0 && value.roleId.length <= 256 &&
    value.roleId === value.roleId.trim() && !/[\\/]/u.test(value.roleId) &&
    [value.surfaceGeneration, value.nativeGeneration, value.webContentsId]
      .every(number => Number.isSafeInteger(number) && number > 0) &&
    typeof value.bindingRevision === "string" && /^[1-9][0-9]*$/u.test(value.bindingRevision) &&
    BigInt(value.bindingRevision) <= 18_446_744_073_709_551_615n && token(value.parentIdentity);
}

export function validChromiumViewInputObservation(
  value: ChromiumViewInputObservation, expected: ChromiumViewInputIdentity,
  mode: "foreground" | "background"
): boolean {
  if ((mode !== "foreground" && mode !== "background") || !value || !value.identity || !value.bounds) return false;
  return validChromiumViewInputIdentity(value.identity) && sameChromiumViewInputIdentity(value.identity, expected) &&
    token(value.focusIdentity) && value.parentForeground === true && value.parentVisible === true &&
    value.parentMinimized === false && value.viewAttached === true && value.contentsDestroyed === false &&
    value.viewVisible === (mode === "foreground") && value.contentsFocused === (mode === "foreground") &&
    (value.focusedWebContentsId === null || (Number.isSafeInteger(value.focusedWebContentsId) && value.focusedWebContentsId > 0)) &&
    (mode === "foreground" ? value.focusedWebContentsId === expected.webContentsId
      : value.focusedWebContentsId !== expected.webContentsId) &&
    [value.bounds.x, value.bounds.y, value.bounds.width, value.bounds.height].every(Number.isSafeInteger) &&
    value.bounds.width > 0 && value.bounds.height > 0 &&
    Number.isFinite(value.zoomFactor) && value.zoomFactor >= 0.25 && value.zoomFactor <= 5;
}

/** Canonical equality for the exact facts; property order is not an ownership fence. */
export function chromiumViewInputObservationKey(value: ChromiumViewInputObservation): string {
  const identity = value.identity;
  return JSON.stringify([identity.roleId, identity.surfaceGeneration, identity.nativeGeneration,
    identity.bindingRevision, identity.parentIdentity, identity.webContentsId,
    value.focusIdentity, value.parentForeground, value.parentVisible, value.parentMinimized,
    value.viewAttached, value.viewVisible, value.contentsDestroyed, value.contentsFocused,
    value.focusedWebContentsId, value.bounds.x, value.bounds.y, value.bounds.width, value.bounds.height,
    value.zoomFactor]);
}
