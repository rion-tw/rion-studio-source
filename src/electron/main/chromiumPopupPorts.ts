import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type { ChromiumRoleSurfaceParentPort } from "./chromiumRoleSurfacePorts";

export interface ChromiumWindowOpenDetails {
  readonly url: string;
  readonly disposition?: string;
  readonly frameName?: string;
  readonly features?: string;
  readonly referrer?: Readonly<{
    url: string;
    policy: string;
  }>;
  readonly postBody?: unknown;
}

export type ChromiumPopupOwnerSource = Readonly<{
  ownerKind: "role" | "globalWeb";
  ownerId: string;
  slotId?: string;
  nativeGeneration: number;
  parent: ChromiumRoleSurfaceParentPort;
  session: ChromiumRoleSessionPort;
}>;

export interface ChromiumPopupOwnerLifecyclePort {
  requestOpen: (
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails
  ) => void;
  retireOwner: (owner: Readonly<{
    ownerKind: "role" | "globalWeb";
    ownerId: string;
    nativeGeneration: number;
  }>) => Promise<void>;
  /** Close the owner's current popups while temporarily fencing new admission. */
  retireOwnerPopupsForMove: (owner: Readonly<{
    ownerKind: "role" | "globalWeb";
    ownerId: string;
    nativeGeneration: number;
  }>) => Promise<void>;
  prepareOwnerReload?: (owner: Readonly<{
    ownerKind: "role";
    ownerId: string;
    nativeGeneration: number;
  }>, operationId: string) => Promise<void>;
  releaseOwnerReload?: (owner: Readonly<{
    ownerKind: "role";
    ownerId: string;
    nativeGeneration: number;
  }>, operationId: string) => boolean;
}

export interface ChromiumPopupHostLifecycleObserver {
  readonly closeRequested: () => void;
  readonly closed: () => void;
  readonly layoutChanged: (bounds: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>) => void;
}
