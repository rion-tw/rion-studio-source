import type { Buffer } from "node:buffer";

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions
} from "electron";

import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { ChromiumRuntimeHostPort } from "./chromiumRuntimeHostPorts";
import type { WindowsRuntimeHostProjection } from "../../shared/windowsRuntimeHost";

export interface RuntimeHostSessionPort {
  readonly storagePath: string | null;
  setBluetoothPairingHandler: (
    handler: (
      details: unknown,
      callback: (response: Readonly<{ confirmed: false }>) => void
    ) => void
  ) => void;
  setDevicePermissionHandler: (handler: () => false) => void;
  setDisplayMediaRequestHandler: (
    handler: (request: unknown, callback: (streams: object) => void) => void
  ) => void;
  setPermissionCheckHandler: (handler: () => false) => void;
  setPermissionRequestHandler: (
    handler: (
      contents: unknown,
      permission: string,
      callback: (granted: false) => void
    ) => void
  ) => void;
}

export interface RuntimeHostWebContentsEventMap {
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
  readonly "render-process-gone": (event: unknown, details: unknown) => void;
  readonly "ipc-message": (
    event: unknown,
    channel: string,
    ...args: unknown[]
  ) => void;
  readonly "will-attach-webview": (event: RuntimeHostPreventableEvent) => void;
  readonly "will-navigate": (event: RuntimeHostPreventableEvent, url: string) => void;
  readonly "will-redirect": (
    event: RuntimeHostPreventableEvent,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) => void;
}

export interface RuntimeHostWindowEventMap {
  readonly blur: () => void;
  readonly close: (event: RuntimeHostPreventableEvent) => void;
  readonly closed: () => void;
  readonly "enter-full-screen": () => void;
  readonly focus: () => void;
  readonly hide: () => void;
  readonly "leave-full-screen": () => void;
  readonly maximize: () => void;
  readonly minimize: () => void;
  readonly move: () => void;
  readonly "ready-to-show": () => void;
  readonly resize: () => void;
  readonly restore: () => void;
  readonly show: () => void;
  readonly unmaximize: () => void;
  readonly unresponsive: () => void;
}

export interface RuntimeHostPreventableEvent {
  preventDefault: () => void;
}

export interface WindowsRuntimeHostWebContentsPort {
  readonly session: RuntimeHostSessionPort;
  getURL: () => string;
  send: (channel: string, projection: WindowsRuntimeHostProjection) => void;
  on: <EventName extends keyof RuntimeHostWebContentsEventMap>(
    event: EventName,
    listener: RuntimeHostWebContentsEventMap[EventName]
  ) => unknown;
  removeListener: <EventName extends keyof RuntimeHostWebContentsEventMap>(
    event: EventName,
    listener: RuntimeHostWebContentsEventMap[EventName]
  ) => unknown;
  setWindowOpenHandler: (
    handler: (details: Readonly<{ url: string }>) => Readonly<{ action: "deny" }>
  ) => void;
}

export interface WindowsRuntimeHostWindowPort {
  readonly id: number;
  readonly contentView: ChromiumRuntimeHostPort["contentView"];
  readonly webContents: WindowsRuntimeHostWebContentsPort;
  close: () => void;
  focus: () => void;
  getBounds: () => ChromiumRoleSurfaceBounds;
  getContentBounds: () => ChromiumRoleSurfaceBounds;
  getNativeWindowHandle: () => Buffer;
  getNormalBounds: () => ChromiumRoleSurfaceBounds;
  hide: () => void;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isFullScreen: () => boolean;
  isMaximized: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  loadFile: (path: string) => Promise<void>;
  maximize: () => void;
  minimize: () => void;
  on: <EventName extends keyof RuntimeHostWindowEventMap>(
    event: EventName,
    listener: RuntimeHostWindowEventMap[EventName]
  ) => unknown;
  removeListener: <EventName extends keyof RuntimeHostWindowEventMap>(
    event: EventName,
    listener: RuntimeHostWindowEventMap[EventName]
  ) => unknown;
  setFullScreen: (fullscreen: boolean) => void;
  show: () => void;
  showInactive: () => void;
  unmaximize: () => void;
}

export interface WindowsRuntimeHostDisplayResolverPort {
  displayMatching: (bounds: ChromiumRoleSurfaceBounds) => Readonly<{
    id: number;
    workArea: ChromiumRoleSurfaceBounds;
  }>;
}

export interface WindowsBrowserWindowFactoryPort {
  create: (options: BrowserWindowConstructorOptions) => WindowsRuntimeHostWindowPort;
}

export type ElectronBrowserWindowConstructor = new (
  options: BrowserWindowConstructorOptions
) => BrowserWindow;
