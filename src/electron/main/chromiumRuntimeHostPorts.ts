import type {
  AppKitRuntimeHostIdentityRecord,
  EmbeddedLaunchTargetRecord,
  EmbeddedTabEffectRecord
} from "../../shared/generated";
import type { ChromiumPopupHostLifecycleObserver } from "./chromiumPopupPorts";
import type { CreateChromiumRoleSurfaceInput } from "./chromiumRoleSurfaceRegistry";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { ChromiumRuntimeAppKitProjectionTransaction } from
  "./chromiumRuntimeProjectionTransaction";
import type {
  ChromiumRuntimeFullscreenToolbarObservation,
  ChromiumRuntimeWindowChromeLayoutProjection,
  ChromiumRuntimeWindowChromeProjection,
  ChromiumRuntimeWindowPresentationRequest
} from "./chromiumRuntimeFullscreenToolbar";

export interface ChromiumRuntimeHostPort {
  readonly id: number;
  readonly logicalWindowId: string;
  readonly contentView: CreateChromiumRoleSurfaceInput["parent"]["contentView"];
  close: () => Promise<void>;
  focus: () => void;
  hide: () => void;
  getContentBounds: () => ChromiumRoleSurfaceBounds;
  readProjection: () => ChromiumRuntimeHostProjection;
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  show: () => void;
  /** Shows a runtime host without claiming the process-global focus lease. */
  showInactive?: () => void;
  /**
   * Exact native state stream used by EventBound window transitions. The
   * platform adapter must publish only after identity validation and must
   * return an unsubscribe function for exact host retirement.
   */
  bindRuntimeWindowState?: (
    observer: ChromiumRuntimeWindowStateObserver
  ) => () => void;
  readRuntimeWindowState?: () => ChromiumRuntimeWindowStateObservation;
  bindPopupLifecycle?: (observer: ChromiumPopupHostLifecycleObserver) => void;
  readonly appKitIdentity?: AppKitRuntimeHostIdentityRecord;
  initializeAppKitTab?: (tab: EmbeddedTabEffectRecord) => void;
  releaseAppKitSurfaceAttachment?: (tabId: string) => void;
  discardAppKitSurfaceAttachment?: (tabId: string) => void;
  prepareAppKitProjection?: (projection: import(
    "../../shared/generated"
  ).AppKitRuntimeWindowProjectionRecord) => ChromiumRuntimeAppKitProjectionTransaction;
  applyAppKitPhaseProjection?: (projection: import(
    "../../shared/generated"
  ).EmbeddedRuntimeWindowProjectionRecord) => void;
  prepareWorkspaceDividerProjection?: (projection: import(
    "../../shared/generated"
  ).AppKitRuntimeWindowProjectionRecord) => ChromiumRuntimeAppKitProjectionTransaction;
  applyWindowsChromeProjection?: (
    projection: ChromiumRuntimeWindowChromeProjection
  ) => Promise<void>;
  applyWindowsChromeLayoutProjection?: (
    projection: ChromiumRuntimeWindowChromeLayoutProjection
  ) => Promise<void>;
  bindRuntimeWindowLayout?: (observer: () => Promise<void>) => void;
  bindRuntimeWindowPlacement?: (observer: () => Promise<void>) => void;
  readRuntimeWindowPlacement?: () => WindowsRuntimeWindowPlacementObservation;
  readFullscreenToolbar?: () => ChromiumRuntimeFullscreenToolbarObservation;
  setRuntimeWindowPresentation?: (
    request: ChromiumRuntimeWindowPresentationRequest
  ) => Promise<ChromiumRuntimeHostProjection>;
  desktopE2eShowAppKitTabMenu?: (tabId: string) => boolean;
  desktopE2eStatusPresentation?: () => number;
}

export type ChromiumRuntimeWindowStateSource =
  | "blur"
  | "closed"
  | "failed"
  | "focus"
  | "hide"
  | "initial"
  | "minimize"
  | "restore"
  | "show";

export interface ChromiumRuntimeWindowStateObservation {
  readonly platform: "macos" | "windows";
  readonly source: ChromiumRuntimeWindowStateSource;
  readonly sequence: number;
  readonly lifecycleEpoch: number;
  readonly logicalWindowId: string;
  readonly nativeHostId: number;
  readonly nativeGeneration: number;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly focused: boolean;
  /** Exact key-window/foreground-HWND ownership, not Electron isFocused alone. */
  readonly foreground: boolean;
  readonly appKitIdentity?: AppKitRuntimeHostIdentityRecord;
  readonly failureCode?: string;
}

export type ChromiumRuntimeWindowStateObserver = (
  observation: ChromiumRuntimeWindowStateObservation
) => void;

/** Exact synchronous BrowserWindow/Core fence captured from the current host. */
export interface WindowsRuntimeWindowPlacementObservation {
  readonly nativeHostId: number;
  readonly nativeGeneration: number;
  readonly windowId: string;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
  readonly displayId: number;
  readonly normalBounds: ChromiumRoleSurfaceBounds;
  readonly savedWorkArea: ChromiumRoleSurfaceBounds;
  readonly presentation: EmbeddedLaunchTargetRecord["presentation"];
}

export interface ChromiumRuntimeHostProjection {
  readonly displayId: number;
  readonly bounds: ChromiumRoleSurfaceBounds;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly presentation: EmbeddedLaunchTargetRecord["presentation"];
}

export interface ChromiumRuntimeHostFactoryPort {
  create: (
    target: EmbeddedLaunchTargetRecord,
    initialTab: EmbeddedTabEffectRecord
  ) => Promise<ChromiumRuntimeHostPort>;
  createEmpty: (
    target: EmbeddedLaunchTargetRecord,
    identity: ChromiumRuntimeEmptyHostIdentity
  ) => Promise<ChromiumRuntimeHostPort>;
}

export interface ChromiumRuntimeEmptyHostIdentity {
  readonly attemptGeneration: string;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
}
