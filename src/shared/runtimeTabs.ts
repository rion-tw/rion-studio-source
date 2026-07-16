import type {
  AppLanguage,
  EmbeddedRuntimeState,
  WorkspaceDisplayInfo
} from "./types";

export const RUNTIME_TABS_STATE_CHANNEL = "runtime-tabs:state";
export const RUNTIME_TABS_ACTION_CHANNEL = "runtime-tabs:action";

export type RuntimeTabAction =
  | { type: "activate"; tabId: string }
  | { type: "hide"; tabId: string }
  | { type: "stop"; tabId: string }
  | { type: "move"; tabId: string; displayId: number }
  | { type: "reorder"; tabId: string; beforeTabId?: string }
  | { type: "openLauncher" }
  | { type: "openTabMenu"; tabId: string }
  | { type: "fullscreenToolbarEnter" }
  | { type: "fullscreenToolbarLeave" }
  | {
      type: "windowControl";
      control: "close" | "minimize" | "toggleFullscreen" | "zoom";
    };

export interface RuntimeTabChromeState extends EmbeddedRuntimeState {
  alwaysShowToolbarInFullScreen: boolean;
  displayId: number;
  displays: WorkspaceDisplayInfo[];
  fullscreen: boolean;
  language: AppLanguage;
  tabIconDataUrls: Record<string, string>;
  toolbarVisible: boolean;
  windowFullscreen: boolean;
}

export function isRuntimeTabAction(value: unknown): value is RuntimeTabAction {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.type !== "string") return false;

  if (["activate", "hide", "stop", "openTabMenu"].includes(action.type)) {
    return typeof action.tabId === "string" && action.tabId.length > 0;
  }
  if (action.type === "move") {
    return typeof action.tabId === "string" && Number.isInteger(action.displayId);
  }
  if (action.type === "reorder") {
    return typeof action.tabId === "string" &&
      (action.beforeTabId === undefined || typeof action.beforeTabId === "string");
  }
  if (action.type === "windowControl") {
    return ["close", "minimize", "toggleFullscreen", "zoom"].includes(
      action.control as string
    ) && Object.keys(action).length === 2;
  }
  if (["openLauncher", "fullscreenToolbarEnter", "fullscreenToolbarLeave"].includes(action.type)) {
    return Object.keys(action).length === 1;
  }
  return false;
}
