import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type {
  ChromiumRoleSurfaceBounds,
  ChromiumRoleSurfaceNativeWindowPort,
  ChromiumRoleSurfaceParentPort,
  ChromiumRoleSurfaceWebContentsPort
} from "./chromiumRoleSurfacePorts";
import type { SandboxedRemoteContentWebPreferences } from "./security";

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

export function hasChromiumWindowOpenPostBody(
  details: ChromiumWindowOpenDetails
): boolean {
  return details.postBody !== null && details.postBody !== undefined;
}

export type ChromiumPopupOwnerSource = Readonly<{
  ownerKind: "role" | "globalWeb";
  ownerId: string;
  slotId?: string;
  nativeGeneration: number;
  parent: ChromiumRoleSurfaceParentPort;
  session: ChromiumRoleSessionPort;
  openerFrame: object;
}>;

export interface ChromiumPopupBrowserWindowOptions {
  readonly alwaysOnTop: false;
  readonly autoHideMenuBar: true;
  readonly closable: true;
  readonly focusable: false;
  readonly frame: true;
  readonly fullscreen: false;
  readonly fullscreenable: false;
  readonly kiosk: false;
  readonly modal: false;
  readonly parent: ChromiumRoleSurfaceNativeWindowPort;
  readonly show: false;
  readonly title: string;
  readonly titleBarOverlay: false;
  readonly transparent: false;
  readonly useContentSize: false;
  readonly webPreferences: SandboxedRemoteContentWebPreferences & Readonly<{
    session: ChromiumRoleSessionPort;
  }>;
}

export interface ChromiumPopupWindowEventMap {
  readonly close: () => void;
  readonly closed: () => void;
  readonly move: () => void;
  readonly resize: () => void;
}

export interface ChromiumPopupWindowPort {
  readonly id: number;
  readonly webContents: ChromiumRoleSurfaceWebContentsPort;
  destroy: () => void;
  getBounds: () => ChromiumRoleSurfaceBounds;
  getContentBounds: () => ChromiumRoleSurfaceBounds;
  getParentWindow: () => ChromiumRoleSurfaceNativeWindowPort | null;
  getTitle: () => string;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isVisible: () => boolean;
  on: <EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    listener: ChromiumPopupWindowEventMap[EventName]
  ) => unknown;
  removeListener: <EventName extends keyof ChromiumPopupWindowEventMap>(
    event: EventName,
    listener: ChromiumPopupWindowEventMap[EventName]
  ) => unknown;
  setBounds: (bounds: ChromiumRoleSurfaceBounds) => void;
  setFocusable: (focusable: boolean) => void;
  setTitle: (title: string) => void;
  show: () => void;
}

export type ChromiumWindowOpenHandlerResponse =
  | Readonly<{ action: "deny" }>
  | Readonly<{
      action: "allow";
      outlivesOpener: false;
      overrideBrowserWindowOptions: ChromiumPopupBrowserWindowOptions;
    }>;

export interface ChromiumPopupOwnerLifecyclePort {
  handleWindowOpen: (
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails
  ) => ChromiumWindowOpenHandlerResponse;
  didCreateWindow: (
    source: ChromiumPopupOwnerSource,
    popupWindow: ChromiumPopupWindowPort,
    details: ChromiumWindowOpenDetails
  ) => void;
  retireOwner: (owner: Readonly<{
    ownerKind: "role" | "globalWeb";
    ownerId: string;
    nativeGeneration: number;
  }>) => Promise<void>;
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
