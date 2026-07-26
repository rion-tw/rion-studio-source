import type {
  EmbeddedRuntimeTabSummary,
  EmbeddedRuntimeState,
  LaunchWorkspace,
  NormalizedRect,
  PixelBounds,
  Role,
  RoleStatus,
  WorkspaceSlotBrowserZoomPercent
} from "../../../shared/types";

export interface RuntimeHostLaunchTarget {
  displayId: number;
  workArea: PixelBounds;
}

export interface RuntimeHostWorkspaceItem {
  browserZoomPercent?: WorkspaceSlotBrowserZoomPercent;
  rect: NormalizedRect;
  role: Role;
}

export interface RuntimeHostRestoreTabInput {
  type: "role" | "workspace";
  sourceId: string;
  hidden: boolean;
  audioMuted: boolean;
}

export interface RuntimeHostWorkspaceStatus {
  workspaceId: string;
  state: "launching" | "running" | "stopping";
}

/**
 * Shell-neutral orchestration boundary used by launch coordinators and menus.
 *
 * The transitional Electron shell and the Tauri-native WebView2/WKWebView host
 * implement the same user-visible lifecycle without leaking platform handles to
 * callers.
 */
export interface RuntimeHostPort {
  acquireRuntimeToolbarRevealLock: (displayId: number) => () => void;
  finishRestoredWindow: (displayId: number) => void;
  hideRuntimeTab: (tabId: string) => Promise<void>;
  launch: (
    role: Role,
    options?: { zoomFactor?: number; target?: RuntimeHostLaunchTarget }
  ) => Promise<RoleStatus | null>;
  launchWorkspace: (
    workspace: Pick<
      LaunchWorkspace,
      "browserZoomMode" | "browserZoomPercent" | "id" | "name" | "template"
    >,
    items: RuntimeHostWorkspaceItem[],
    target?: RuntimeHostLaunchTarget
  ) => Promise<RoleStatus[]>;
  launchEmbeddedRestoreTab: (
    tab: RuntimeHostRestoreTabInput,
    target: RuntimeHostLaunchTarget
  ) => Promise<EmbeddedRuntimeTabSummary | undefined>;
  listEmbeddedRuntimeState: () => EmbeddedRuntimeState;
  listStatuses: () => RoleStatus[];
  listWorkspaceDisplayReservations: () => Array<{
    workspaceId: string;
    workspaceName: string;
    displayId: number;
  }>;
  listWorkspaceRuntimeStatuses: () => RuntimeHostWorkspaceStatus[];
  moveRuntimeTab: (tabId: string, displayId: number) => Promise<void>;
  on: {
    (event: "change", listener: (statuses: RoleStatus[]) => void): RuntimeHostPort;
    (event: "runtimeChange", listener: (state: EmbeddedRuntimeState) => void): RuntimeHostPort;
  };
  prepareRestoredWindow: (displayId: number, windowId: string) => void;
  publishRuntimeSessionChange: () => void;
  setRuntimeSessionProjectionProvider: (
    provider: () => Pick<EmbeddedRuntimeState, "savedWindows" | "recovery">
  ) => void;
  setRuntimeTabAudioMuted: (tabId: string, muted: boolean) => void;
  showEmbeddedRuntimeWindows: (displayId?: number) => Promise<void>;
  showRuntimeTab: (tabId: string) => Promise<void>;
  stop: (roleId: string) => Promise<void>;
  stopAll: () => Promise<void>;
  stopRuntimeTab: (tabId: string) => Promise<void>;
  stopRuntimeWindow: (displayId: number) => Promise<void>;
  stopWorkspace: (workspaceId: string) => Promise<void>;
}
