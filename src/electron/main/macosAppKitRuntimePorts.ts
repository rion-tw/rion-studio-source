import type { BaseWindow, BaseWindowConstructorOptions } from "electron";

import type {
  AppKitRuntimeHostObservationRecord,
  AppKitRuntimeWorkspaceDividerLayoutRecord
} from "../../shared/generated";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { ChromiumRuntimeHostPort } from "./chromiumRuntimeHostPorts";
import type { RawAppKitFullscreenToolbarState } from
  "./macosAppKitFullscreenToolbarObservation";
import type { RawAppKitRuntimeContentLayout } from
  "./macosAppKitRuntimeHostValidation";

export type MacosAppKitNativeEventListener = (...arguments_: unknown[]) => void;

export interface AppKitRuntimeHostIdentity {
  readonly logicalWindowId: string;
  readonly launchGeneration: string;
  readonly nativeGeneration: number;
}

export interface RawAppKitDesktopE2ETitlebarGeometry {
  readonly rootMinX: number;
  readonly rootWidth: number;
  readonly tabMinX: number;
  readonly tabMinY: number;
  readonly tabMaxX: number;
  readonly tabMaxY: number;
  readonly windowNameMaxX: number;
  readonly trafficLightsMaxX: number;
  readonly fullscreenControlMinX: number;
  readonly fullscreenControlMinY: number;
  readonly fullscreenControlWidth: number;
  readonly fullscreenControlHeight: number;
  readonly titleHidden: boolean;
  readonly valid: boolean;
}

export interface RawAppKitDesktopE2ETabAnchor {
  readonly x: number;
  readonly y: number;
}

export interface RawNativeAppKitRuntimeHost {
  readonly logicalWindowId: string;
  readonly launchGeneration: string;
  readonly nativeGeneration: number;
  destroy: (expected: AppKitRuntimeHostIdentity) => boolean;
  focusWindow: (expected: AppKitRuntimeHostIdentity) => void;
  snapshotContentLayout: (
    expected: AppKitRuntimeHostIdentity
  ) => RawAppKitRuntimeContentLayout;
  applyTabProjection: (
    expected: AppKitRuntimeHostIdentity,
    projectionRevision: string,
    tabs: ReadonlyArray<Readonly<{
      tabId: string;
      name: string;
      phase: "dormant" | "activating" | "attaching" | "loading" | "ready" | "degraded" | "failed";
      tabType: "role" | "workspace" | "popup";
      workspaceTemplate?: string;
    }>>,
    activeTabId?: string
  ) => Readonly<{
    projectionRevision: string;
    tabCount: number;
    activeTabId?: string;
  }>;
  restoreLastVerifiedTabProjection?: (
    expected: AppKitRuntimeHostIdentity
  ) => Readonly<{
    projectionRevision: string;
    tabCount: number;
    activeTabId?: string;
  }>;
  applyWorkspaceDividerProjection: (
    expected: AppKitRuntimeHostIdentity,
    projectionRevision: string,
    contentBounds: ChromiumRoleSurfaceBounds,
    dividers: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[]
  ) => Readonly<{
    projectionRevision: string;
    dividerCount: number;
    contentBounds: ChromiumRoleSurfaceBounds;
  }>;
  restoreLastVerifiedWorkspaceDividerProjection: (
    expected: AppKitRuntimeHostIdentity
  ) => Readonly<{
    projectionRevision: string;
    dividerCount: number;
    contentBounds: ChromiumRoleSurfaceBounds;
  }>;
  prepareFullscreen: (
    expected: AppKitRuntimeHostIdentity,
    fullscreen: boolean
  ) => void;
  setFullscreenPolicy: (
    expected: AppKitRuntimeHostIdentity,
    alwaysShow: boolean
  ) => void;
  setTabCloseButtonsHidden: (
    expected: AppKitRuntimeHostIdentity,
    alwaysHide: boolean
  ) => void;
  setRevealLocked: (
    expected: AppKitRuntimeHostIdentity,
    locked: boolean
  ) => void;
  setWindowName: (
    expected: AppKitRuntimeHostIdentity,
    windowName?: string
  ) => void;
  desktopE2eFullscreenToolbarState?: (
    expected: AppKitRuntimeHostIdentity
  ) => RawAppKitFullscreenToolbarState;
  desktopE2eTitlebarGeometry?: (
    expected: AppKitRuntimeHostIdentity
  ) => RawAppKitDesktopE2ETitlebarGeometry;
  desktopE2eTabAnchor?: (
    expected: AppKitRuntimeHostIdentity,
    tabId: string,
    grabRatioX: number,
    grabRatioY: number
  ) => RawAppKitDesktopE2ETabAnchor;
  desktopE2eAccessibilityShowMenu?: (
    expected: AppKitRuntimeHostIdentity,
    tabId: string
  ) => boolean;
  desktopE2eStatusPresentation?: (
    expected: AppKitRuntimeHostIdentity
  ) => number;
}

export interface RawAppKitRuntimeAddon {
  appKitRuntimeAbiVersion: () => number;
  attachAppKitRuntimeHost: (
    nativeViewHandle: Buffer,
    identity: AppKitRuntimeHostIdentity,
    callback: (eventJson: string) => void
  ) => RawNativeAppKitRuntimeHost;
}

export interface MacosAppKitPreventableWindowEvent {
  preventDefault: () => void;
}

export interface MacosAppKitBaseWindowPort {
  readonly id: number;
  readonly contentView: ChromiumRuntimeHostPort["contentView"];
  close: () => void;
  destroy: () => void;
  focus: () => void;
  hide: () => void;
  getContentBounds: () => ChromiumRoleSurfaceBounds;
  getNormalBounds: () => ChromiumRoleSurfaceBounds;
  getNativeWindowHandle: () => Buffer;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  isFullScreen: () => boolean;
  isMaximized: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  maximize: () => void;
  on: (event: string, listener: MacosAppKitNativeEventListener) => unknown;
  removeListener: (event: string, listener: MacosAppKitNativeEventListener) => unknown;
  setFullScreen: (fullscreen: boolean) => void;
  show: () => void;
  showInactive: () => void;
}

export interface MacosAppKitDisplayPort {
  readonly id: number;
  readonly workArea: ChromiumRoleSurfaceBounds;
}

export interface MacosAppKitDisplayResolverPort {
  displayMatching: (bounds: ChromiumRoleSurfaceBounds) => MacosAppKitDisplayPort;
}

export interface MacosAppKitBaseWindowFactoryPort {
  create: (options: BaseWindowConstructorOptions) => MacosAppKitBaseWindowPort;
}

export type ElectronBaseWindowConstructor = new (
  options: BaseWindowConstructorOptions
) => BaseWindow;

export interface AppKitRuntimeActionEvent {
  readonly identity: AppKitRuntimeHostIdentity;
  readonly action: Readonly<Record<string, unknown>>;
  readonly hosts: readonly AppKitRuntimeHostObservationRecord[];
}

export interface AppKitRuntimeLayoutEvent {
  readonly identity: AppKitRuntimeHostIdentity;
  readonly hosts: readonly AppKitRuntimeHostObservationRecord[];
}
