import type { KeyboardInputEvent, MouseInputEvent } from "electron";
import type { RolePathsRecord } from "../../shared/generated";
import type {
  ChromiumRoleSessionHandle,
  ChromiumRoleSessionPort
} from "./chromiumRoleSessionRegistry";
import type { SandboxedRemoteContentWebPreferences } from "./security";
import type { ChromiumWindowOpenDetails } from "./chromiumPopupPorts";

export interface ChromiumRoleSurfaceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ChromiumRoleSurfaceEvent {
  preventDefault: () => void;
}

export interface ChromiumRoleSurfaceInputEvent {
  readonly alt: boolean;
  readonly code: string;
  readonly control: boolean;
  readonly isAutoRepeat: boolean;
  readonly key: string;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly type: "keyDown" | "keyUp" | string;
}

export interface ChromiumRoleSurfaceEventMap {
  readonly focus: () => void;
  readonly blur: () => void;
  readonly "before-input-event": (
    event: ChromiumRoleSurfaceEvent,
    input: ChromiumRoleSurfaceInputEvent
  ) => void;
  readonly "did-start-navigation": (
    details: Readonly<{
      isMainFrame: boolean;
      isSameDocument: boolean;
    }>
  ) => void;
  readonly "did-finish-load": () => void;
  readonly "did-fail-load": (
    event: unknown,
    errorCode: number,
    errorDescription: string,
    validatedUrl: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => void;
  readonly "enter-html-full-screen": () => void;
  readonly "leave-html-full-screen": () => void;
  readonly destroyed: () => void;
  readonly "will-attach-webview": (event: ChromiumRoleSurfaceEvent) => void;
  readonly "will-navigate": (
    event: ChromiumRoleSurfaceEvent,
    url: string
  ) => void;
  readonly "will-redirect": (
    event: ChromiumRoleSurfaceEvent,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => void;
}

export interface ChromiumRoleSurfaceWebContentsPort {
  focus?: () => void;
  isFocused?: () => boolean;
  sendInputEvent?: (event: KeyboardInputEvent | MouseInputEvent) => void;
  readonly id?: number;
  readonly mainFrame?: Readonly<{ readonly frameToken: string }>;
  readonly session: ChromiumRoleSessionPort;
  close: (options?: { readonly waitForBeforeUnload?: boolean }) => void;
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    scripts: Array<Readonly<{ code: string; url?: string }>>,
    userGesture?: boolean
  ) => Promise<unknown>;
  getURL: () => string;
  getZoomFactor: () => number;
  isAudioMuted: () => boolean;
  isCurrentlyAudible: () => boolean;
  isDestroyed: () => boolean;
  loadURL: (url: string, options?: Readonly<{
    httpReferrer?: Readonly<{ url: string; policy: string }>;
  }>) => Promise<void>;
  reload: () => void;
  on: <EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    listener: ChromiumRoleSurfaceEventMap[EventName]
  ) => unknown;
  removeListener: <EventName extends keyof ChromiumRoleSurfaceEventMap>(
    event: EventName,
    listener: ChromiumRoleSurfaceEventMap[EventName]
  ) => unknown;
  send: (channel: string, ...arguments_: unknown[]) => void;
  setWindowOpenHandler: (
    handler: (details: ChromiumWindowOpenDetails) => Readonly<{ action: "deny" }>
  ) => void;
  setAudioMuted: (muted: boolean) => void;
  setZoomFactor: (factor: number) => void;
}

export interface ChromiumRoleWebContentsViewPort {
  readonly webContents: ChromiumRoleSurfaceWebContentsPort;
  getBounds: () => ChromiumRoleSurfaceBounds;
  getVisible: () => boolean;
  setBounds: (bounds: ChromiumRoleSurfaceBounds) => void;
  setVisible: (visible: boolean) => void;
}

interface ChromiumRoleSurfaceParentContentPort {
  addChildView: (view: ChromiumRoleWebContentsViewPort) => void;
  removeChildView: (view: ChromiumRoleWebContentsViewPort) => void;
}

export interface ChromiumRoleSurfaceParentPort {
  readonly id: number;
  readonly contentView: ChromiumRoleSurfaceParentContentPort;
  isDestroyed: () => boolean;
}

export interface ChromiumWebContentsViewFactoryPort {
  create: (options: Readonly<{
    webPreferences: SandboxedRemoteContentWebPreferences & Readonly<{
      session: ChromiumRoleSessionPort;
    }>;
  }>) => ChromiumRoleWebContentsViewPort;
}

export interface ChromiumRoleSessionOwnerPort {
  ensure: (
    roleId: string,
    rolePaths: RolePathsRecord
  ) => ChromiumRoleSessionHandle;
  releaseRole: (
    roleId: string,
    chromiumUserDataDir: string
  ) => Promise<boolean>;
  dispose: () => Promise<void>;
}

export interface ChromiumRoleSurfaceNativeAttachmentInput {
  readonly roleId: string;
  readonly generation: number;
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly isCancelled: () => boolean;
  readonly attach: () => void;
  readonly detach: () => void;
  /** Optional exact physical host lane used by the Windows child HWND owner. */
  readonly view?: ChromiumRoleWebContentsViewPort;
  readonly attachTo?: (physicalParent: ChromiumRoleSurfaceParentPort) => void;
}

export interface ChromiumRoleSurfaceNativeReparentInput {
  readonly roleId: string;
  readonly generation: number;
  readonly sourceParent: ChromiumRoleSurfaceParentPort;
  readonly targetParent: ChromiumRoleSurfaceParentPort;
  readonly isCancelled: () => boolean;
  readonly detachSource: () => void;
  readonly attachTarget: () => void;
  readonly detachTarget: () => void;
  readonly restoreSource: () => void;
  readonly view?: ChromiumRoleWebContentsViewPort;
  readonly attachTargetTo?: (
    physicalParent: ChromiumRoleSurfaceParentPort
  ) => void;
  readonly restoreSourceTo?: (
    physicalParent: ChromiumRoleSurfaceParentPort
  ) => void;
}

export interface ChromiumRoleSurfaceNativePresentationInput {
  readonly roleId: string;
  readonly generation: number;
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly physicalParent: ChromiumRoleSurfaceParentPort;
  readonly view: ChromiumRoleWebContentsViewPort;
}

export interface ChromiumRoleSurfaceNativeRetirementInput
  extends ChromiumRoleSurfaceNativePresentationInput {
  readonly detach: () => void;
}

export interface ChromiumRoleSurfaceNativeAttachmentPort {
  attach: (input: ChromiumRoleSurfaceNativeAttachmentInput) => Promise<void>;
  initialLoadCommitted?: (
    roleId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ) => void;
  reparent: (input: ChromiumRoleSurfaceNativeReparentInput) => Promise<void>;
  retire: (
    roleId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort,
    physical?: ChromiumRoleSurfaceNativeRetirementInput
  ) => Promise<void>;
  syncPresentation?: (
    input: ChromiumRoleSurfaceNativePresentationInput
  ) => void;
}
