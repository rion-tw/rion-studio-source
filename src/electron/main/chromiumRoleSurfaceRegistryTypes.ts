import type { RolePathsRecord } from "../../shared/generated";
import type { ChromiumRoleSessionHandle } from "./chromiumRoleSessionRegistry";
import type {
  ChromiumRoleNavigationLifecycleOwner
} from "./chromiumRoleNavigationLifecycle";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceEvent,
  ChromiumRoleSurfaceEventMap,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort,
  ChromiumRoleWebContentsViewPort
} from "./chromiumRoleSurfacePorts";

export type ChromiumRoleSurfaceRegistryState =
  | "open"
  | "draining"
  | "disposed";
export interface CreateChromiumRoleSurfaceInput {
  readonly roleId: string;
  readonly tabId: string;
  readonly rolePaths: RolePathsRecord;
  readonly generation: number;
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly url: string;
  readonly preloadPath: string;
  readonly bounds: ChromiumRoleSurfaceBounds;
  readonly visible: boolean;
  readonly zoomFactor: number;
  readonly audioMuted: boolean;
}

export interface ChromiumRoleSurfaceHandle {
  readonly roleId: string;
  readonly generation: number;
  readonly parentId: number;
  readonly url: string;
}

export interface ChromiumRoleOverlayFrameIdentity {
  readonly roleId: string;
  readonly generation: number;
  readonly frame: object;
  readonly frameToken: string;
  readonly documentInstanceId: string;
}

export type ChromiumRoleOverlayLifecycleReason =
  | "document-superseded"
  | "surface-retired";

export interface ChromiumRoleOverlayLifecycleEvent {
  readonly roleId: string;
  readonly generation: number;
  readonly reason: ChromiumRoleOverlayLifecycleReason;
}

export interface ChromiumRoleOverlayRefreshSubmissionReceipt {
  readonly roleId: string;
  readonly generation: number;
  readonly frameToken: string;
  readonly refreshId: string;
  readonly status: "submitted";
  readonly worldId: 1004;
}

export interface ChromiumRoleSurfaceDeferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
}

export interface ChromiumRoleSurfaceListeners {
  readonly beforeInputEvent: ChromiumRoleSurfaceEventMap["before-input-event"];
  readonly didStartNavigation: ChromiumRoleSurfaceEventMap[
    "did-start-navigation"
  ];
  readonly didFinishLoad: () => void;
  readonly didFailLoad: (
    event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => void;
  readonly destroyed: () => void;
  readonly willAttachWebview: (event: ChromiumRoleSurfaceEvent) => void;
  readonly willNavigate: (
    event: ChromiumRoleSurfaceEvent,
    url: string
  ) => void;
  readonly willRedirect: (
    event: ChromiumRoleSurfaceEvent,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => void;
}

export interface ChromiumRoleSurfaceRecord {
  readonly roleId: string;
  readonly tabId: string;
  readonly generation: number;
  readonly sessionHandle: ChromiumRoleSessionHandle;
  parent: ChromiumRoleSurfaceParentPort;
  physicalParent: ChromiumRoleSurfaceParentPort | null;
  readonly view: ChromiumRoleWebContentsViewPort;
  readonly contents: ChromiumRoleSurfaceWebContentsPort;
  readonly creation: ChromiumRoleSurfaceDeferred<ChromiumRoleSurfaceHandle>;
  readonly webContentsDestroyed: ChromiumRoleSurfaceDeferred<void>;
  readonly destruction: ChromiumRoleSurfaceDeferred<void>;
  listeners: ChromiumRoleSurfaceListeners;
  state: "opening" | "active" | "load-failed" | "closing" | "quarantined";
  attached: boolean;
  destroyed: boolean;
  loadSettled: boolean;
  activeMainFrameFailureReported: boolean;
  closePromise: Promise<boolean> | null;
  releasePromise: Promise<boolean> | null;
  terminalObservation: Promise<void> | null;
  terminalFailure: unknown | null;
  overlayRetired: boolean;
  nativeAttachmentRetired: boolean;
  nativeAttachmentRetirement: Promise<void> | null;
  networkFailureSession: ChromiumRoleNetworkFailureSessionPort | null;
  readonly navigation: ChromiumRoleNavigationLifecycleOwner;
}

export interface ChromiumRoleNetworkFailureSessionPort {
  readonly webRequest: Readonly<{
    onErrorOccurred: (
      listener: ((details: Readonly<{
        resourceType: string;
        url: string;
        webContents?: object;
        webContentsId?: number;
      }>) => void) | null
    ) => void;
  }>;
}

export interface ChromiumRoleSurfaceParentOwner {
  readonly parent: ChromiumRoleSurfaceParentPort;
  count: number;
}
