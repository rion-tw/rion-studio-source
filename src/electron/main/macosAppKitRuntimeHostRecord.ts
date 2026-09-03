import type {
  AppKitRuntimeTabProjectionRecord,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import type { ChromiumRuntimeHostPort } from "./chromiumRuntimeHostPorts";
import type { ChromiumPopupHostLifecycleObserver } from "./chromiumPopupPorts";
import type { MacosAppKitInputHostBinding } from
  "./macosAppKitInputSurfaceAttachmentCoordinator";
import type { MacosAppKitRuntimeHostPresentationGate } from
  "./macosAppKitRuntimeHostPresentationGate";
import type { MacosAppKitRuntimePresentationController } from
  "./macosAppKitRuntimePresentationController";
import type {
  RawAppKitRuntimeContentLayout
} from "./macosAppKitRuntimeHostValidation";
import type {
  RawNativeAppKitRuntimeHost
} from "./macosAppKitRuntimePorts";
import type { Deferred } from "./macosAppKitRuntimeHostSupport";
import type { MacosAppKitWorkspaceDividerProjectionState } from
  "./macosAppKitWorkspaceDividerProjection";
import type {
  MacosAppKitRuntimeWindowListeners,
  MacosAppKitRuntimeWindowStateRecord
} from "./macosAppKitRuntimeWindowState";

export type MacosAppKitRuntimeHostState =
  | "opening"
  | "active"
  | "closing"
  | "closed"
  | "poisoned";

export interface MacosAppKitRuntimeHostRecord
  extends MacosAppKitRuntimeWindowStateRecord {
  readonly target: EmbeddedLaunchTargetRecord;
  readonly closed: Deferred<void>;
  readonly presentationReady: Deferred<void>;
  readonly host: ChromiumRuntimeHostPort;
  readonly listeners: Readonly<MacosAppKitRuntimeWindowListeners>;
  controller: RawNativeAppKitRuntimeHost | null;
  inputBinding: MacosAppKitInputHostBinding | null;
  layout: RawAppKitRuntimeContentLayout | null;
  state: MacosAppKitRuntimeHostState;
  closePromise: Promise<void> | null;
  controllerDetached: boolean;
  controllerIdentityValidated: boolean;
  nativeProjectionRevision: number;
  readonly projectedTabs: Map<string, AppKitRuntimeTabProjectionRecord>;
  readonly workspaceDividerProjection: MacosAppKitWorkspaceDividerProjectionState;
  readonly presentationGate: MacosAppKitRuntimeHostPresentationGate;
  readonly presentation: MacosAppKitRuntimePresentationController;
  projectedActiveTabId: string | undefined;
  lastAdapterSequence: number;
  windowName: string;
  readonly popupId: string | null;
  popupObserver: ChromiumPopupHostLifecycleObserver | null;
}
