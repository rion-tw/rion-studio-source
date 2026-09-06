import type { ChromiumRoleSurfaceBounds, ChromiumRoleSurfaceParentPort,
  ChromiumRoleWebContentsViewPort } from "./chromiumRoleSurfacePorts";

interface WindowsInputSurfaceContentPort {
  readonly children: readonly unknown[];
  addChildView: (view: ChromiumRoleWebContentsViewPort) => void;
  removeChildView: (view: ChromiumRoleWebContentsViewPort) => void;
}

type WindowsInputHostEvent = "move" | "resize" | "show" | "hide" | "minimize" | "restore" | "focus" | "blur" | "closed";

export interface WindowsChromiumInputBaseWindowPort
  extends ChromiumRoleSurfaceParentPort {
  readonly contentView: WindowsInputSurfaceContentPort;
  destroy: () => void;
  focus: () => void;
  getBounds: () => ChromiumRoleSurfaceBounds;
  getContentBounds: () => ChromiumRoleSurfaceBounds;
  getNativeWindowHandle: () => Buffer;
  hide: () => void;
  isFocused: () => boolean;
  isVisible: () => boolean;
  on: (event: WindowsInputHostEvent, listener: () => void) => unknown;
  removeListener: (event: WindowsInputHostEvent, listener: () => void) => unknown;
  setBounds: (bounds: ChromiumRoleSurfaceBounds) => void;
  show: () => void;
  showInactive: () => void;
}

export interface WindowsChromiumInputRuntimeParentIdentity {
  readonly nativeGeneration: number;
  readonly ownerRevision: string;
}

export interface WindowsChromiumInputRuntimeParentBinding {
  readonly identity: WindowsChromiumInputRuntimeParentIdentity;
  readonly logicalParent: ChromiumRoleSurfaceParentPort;
  readonly window: WindowsChromiumInputBaseWindowPort;
}

export interface WindowsChromiumInputRuntimeParentResolverPort {
  resolve: (
    parent: ChromiumRoleSurfaceParentPort
  ) => WindowsChromiumInputRuntimeParentBinding | null;
}

export interface WindowsChromiumInputPresentationEvent {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly visible: boolean;
  readonly previousVisible: boolean;
}

export interface WindowsChromiumInputPresentationPort {
  subscribePresentation: (listener: (event: WindowsChromiumInputPresentationEvent) => void) => () => void;
}
