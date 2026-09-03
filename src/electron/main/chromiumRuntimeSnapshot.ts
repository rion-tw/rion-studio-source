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
    attemptGeneration?: string;
  }>>;
  readonly roles: ReadonlyArray<Readonly<{
    roleId: string;
    tabId: string;
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
