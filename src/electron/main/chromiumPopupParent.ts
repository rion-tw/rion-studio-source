import type {
  AppKitRuntimeHostIdentityRecord,
  ChromiumPopupParentFenceRecord,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import type { ChromiumPopupOwnerSource } from "./chromiumPopupPorts";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeEffectExecutor";

export interface ChromiumPopupParentResolution {
  readonly parent: ChromiumPopupParentFenceRecord;
  readonly parentTarget: EmbeddedLaunchTargetRecord;
}

export function exactChromiumPopupOpenerFrameEqual(
  left: object,
  right: object | null | undefined
): boolean {
  if (left === right) return true;
  if (!right) return false;
  const leftFrame = left as Readonly<{
    frameToken?: unknown;
    processId?: unknown;
    routingId?: unknown;
  }>;
  const rightFrame = right as Readonly<{
    frameToken?: unknown;
    processId?: unknown;
    routingId?: unknown;
  }>;
  if (
    typeof leftFrame.frameToken !== "string" || leftFrame.frameToken.length === 0 ||
    leftFrame.frameToken !== rightFrame.frameToken
  ) return false;
  const routed = leftFrame.processId !== undefined || rightFrame.processId !== undefined ||
    leftFrame.routingId !== undefined || rightFrame.routingId !== undefined;
  return !routed || (
    Number.isSafeInteger(leftFrame.processId) &&
    leftFrame.processId === rightFrame.processId &&
    Number.isSafeInteger(leftFrame.routingId) &&
    leftFrame.routingId === rightFrame.routingId
  );
}

export function exactChromiumPopupParentResolutionEqual(
  left: ChromiumPopupParentResolution,
  right: ChromiumPopupParentResolution
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appKitIdentityMatches(
  identity: AppKitRuntimeHostIdentityRecord,
  windowId: string
): boolean {
  return identity.logicalWindowId === windowId &&
    identity.launchGeneration.length > 0 &&
    Number.isSafeInteger(identity.nativeGeneration) &&
    identity.nativeGeneration > 0;
}

export function resolveChromiumPopupParent(
  snapshot: ChromiumRuntimeExecutorSnapshot,
  source: ChromiumPopupOwnerSource,
  platform: "darwin" | "win32"
): ChromiumPopupParentResolution | null {
  if (
    source.parent.isDestroyed() || !source.parent.nativeWindow ||
    source.parent.nativeWindow.isDestroyed() ||
    source.parent.nativeWindow.id !== source.parent.id ||
    !Number.isSafeInteger(source.parent.id) || source.parent.id < 1 ||
    !Number.isSafeInteger(source.nativeGeneration) || source.nativeGeneration < 1
  ) return null;
  const owner = source.ownerKind === "role"
    ? snapshot.roles.find((candidate) => candidate.roleId === source.ownerId &&
        candidate.generation === source.nativeGeneration)
    : snapshot.webSurfaces.find((candidate) => candidate.surfaceId === source.ownerId &&
        candidate.slotId === source.slotId &&
        candidate.generation === source.nativeGeneration);
  if (!owner) return null;
  const tab = snapshot.tabs.find((candidate) => candidate.tabId === owner.tabId);
  const window = snapshot.windows.find((candidate) =>
    candidate.windowId === owner.windowId &&
    candidate.parentNativeHostId === source.parent.id &&
    candidate.tabIds.includes(owner.tabId));
  if (
    !tab || !window || tab.windowId !== window.windowId ||
    !tab.attemptGeneration || !window.target ||
    !Number.isSafeInteger(window.parentNativeHostId) ||
    (window.parentNativeHostId ?? 0) < 1
  ) return null;
  if (
    platform === "darwin" &&
    (!window.appKitIdentity || !appKitIdentityMatches(window.appKitIdentity, window.windowId))
  ) return null;
  if (platform === "win32" && window.appKitIdentity) return null;
  const role = source.ownerKind === "role"
    ? snapshot.roles.find((candidate) => candidate.roleId === source.ownerId &&
        candidate.generation === source.nativeGeneration)
    : undefined;
  return Object.freeze({
    parent: Object.freeze({
      ownerKind: source.ownerKind,
      ownerId: source.ownerId,
      ...(source.ownerKind === "globalWeb" ? { slotId: source.slotId! } : {}),
      ownerNativeGeneration: source.nativeGeneration,
      ...(role ? { roleOwnerGeneration: role.ownerGeneration } : {}),
      parentWindowId: window.windowId,
      parentWindowGeneration: window.windowGeneration,
      parentTopologyRevision: window.topologyRevision,
      parentTabId: owner.tabId,
      parentAttemptGeneration: tab.attemptGeneration,
      parentNativeHostId: window.parentNativeHostId!,
      ...(window.appKitIdentity
        ? { parentAppkitIdentity: Object.freeze({ ...window.appKitIdentity }) }
        : {})
    }),
    parentTarget: Object.freeze({
      ...window.target,
      bounds: Object.freeze({ ...window.target.bounds }),
      workArea: Object.freeze({ ...window.target.workArea })
    })
  });
}
