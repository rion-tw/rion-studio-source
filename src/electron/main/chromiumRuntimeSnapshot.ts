import type {
  AppKitRuntimeHostIdentityRecord,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";

/** Exact, revision-fenced native ownership observed by Electron coordinators. */
export interface ChromiumRuntimeExecutorSnapshot {
  readonly windows: ReadonlyArray<Readonly<{
    windowId: string;
    activeTabId: string;
    tabIds: readonly string[];
    displayId: number;
    bounds: ChromiumRoleSurfaceBounds;
    visible: boolean;
    focused: boolean;
    presentation: EmbeddedLaunchTargetRecord["presentation"];
    /** Desired mode staged on an exact hidden Windows host; presentation remains native readback. */
    pendingInitialPresentation?: Readonly<{
      presentation: "maximized" | "fullscreen";
      nativeHostId: number;
      windowGeneration: number;
      topologyRevision: number;
    }>;
    windowGeneration: number;
    topologyRevision: number;
    windowZoomFactor?: number;
    parentNativeHostId?: number;
    appKitIdentity?: AppKitRuntimeHostIdentityRecord;
    target?: EmbeddedLaunchTargetRecord;
  }>>;
  readonly tabs: ReadonlyArray<Readonly<{
    tabId: string;
    windowId: string;
    audioMuted: boolean;
    audible: boolean;
    /** Native membership committed removal; exact resource release is still retained. */
    retiring?: true;
    attemptGeneration?: string;
  }>>;
  readonly roles: ReadonlyArray<Readonly<{
    roleId: string;
    tabId: string;
    workspaceId?: string;
    windowId: string;
    generation: number;
    ownerGeneration: number;
    zoomFactor?: number;
  }>>;
  readonly webSurfaces: ReadonlyArray<Readonly<{
    surfaceId: string;
    slotId: string;
    tabId: string;
    windowId: string;
    generation: number;
    zoomFactor?: number;
  }>>;
}

/** A staged mode cannot authorize a visible, replaced or unprojected host. */
export function pendingInitialPresentationMatches(
  window: ChromiumRuntimeExecutorSnapshot["windows"][number],
  windowGeneration = window.windowGeneration,
  topologyRevision = window.topologyRevision
): boolean {
  const pending = window.pendingInitialPresentation;
  return (pending?.presentation === "maximized" || pending?.presentation === "fullscreen") &&
    window.presentation === "normal" &&
    !window.visible && !window.focused && window.appKitIdentity === undefined &&
    Number.isSafeInteger(windowGeneration) && windowGeneration > 0 &&
    Number.isSafeInteger(topologyRevision) && topologyRevision > 0 &&
    pending.windowGeneration === windowGeneration && window.windowGeneration === windowGeneration &&
    pending.topologyRevision === topologyRevision && window.topologyRevision === topologyRevision &&
    Number.isSafeInteger(pending.nativeHostId) && pending.nativeHostId > 0 &&
    pending.nativeHostId === window.parentNativeHostId &&
    window.target?.windowId === window.windowId && window.target.presentation === pending.presentation;
}
