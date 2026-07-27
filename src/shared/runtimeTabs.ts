import type {
  AppLanguage,
  DisplayInfo,
  EmbeddedRuntimeState,
  EmbeddedRuntimeTabSummary,
  WorkspaceLayoutTemplate
} from "./types";

export function formatRuntimeTabTooltip(
  tab: Pick<EmbeddedRuntimeTabSummary, "name" | "type" | "roleNames">,
  language: AppLanguage
): string {
  if (tab.type !== "workspace" || !tab.roleNames?.length) return tab.name;
  const separator = language === "zh-TW" || language === "zh-CN" ? "：" : ":";
  return `${tab.name}${separator}${tab.roleNames.join(", ")}`;
}

export type RuntimeTabAction =
  | { type: "activate"; tabId: string }
  | { type: "hide"; tabId: string }
  | { type: "stop"; tabId: string }
  | { type: "move"; tabId: string; windowId: string }
  | { type: "tearOut"; tabId: string; screenX: number; screenY: number }
  | { type: "reorder"; tabId: string; beforeTabId?: string }
  | { type: "openLauncher" }
  | { type: "openTabMenu"; tabId: string }
  | { type: "activateAdjacent"; direction: "next" | "previous" }
  | { type: "fullscreenToolbarEnter" }
  | { type: "fullscreenToolbarLeave" }
  | {
      type: "windowControl";
      control: "close" | "minimize" | "toggleFullscreen" | "zoom";
    };

export interface RuntimeTabStripState extends EmbeddedRuntimeState {
  alwaysShowToolbarInFullScreen: boolean;
  displayId: number;
  windowId: string;
  displays: DisplayInfo[];
  fullscreen: boolean;
  language: AppLanguage;
  tabIconDataUrls: Record<string, string>;
  tabWorkspaceTemplates: Record<string, WorkspaceLayoutTemplate>;
  toolbarVisible: boolean;
  windowFullscreen: boolean;
}

export function isRuntimeTabAction(value: unknown): value is RuntimeTabAction {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.type !== "string") return false;

  if (["activate", "hide", "stop", "openTabMenu"].includes(action.type)) {
    return typeof action.tabId === "string" && action.tabId.length > 0 &&
      Object.keys(action).length === 2;
  }
  if (action.type === "move") {
    return typeof action.tabId === "string" && action.tabId.length > 0 &&
      typeof action.windowId === "string" && action.windowId.length > 0 &&
      Object.keys(action).length === 3;
  }
  if (action.type === "tearOut") {
    return typeof action.tabId === "string" && action.tabId.length > 0 &&
      typeof action.screenX === "number" && Number.isFinite(action.screenX) &&
      typeof action.screenY === "number" && Number.isFinite(action.screenY) &&
      Object.keys(action).length === 4;
  }
  if (action.type === "reorder") {
    return typeof action.tabId === "string" && action.tabId.length > 0 &&
      (action.beforeTabId === undefined ||
        (typeof action.beforeTabId === "string" && action.beforeTabId.length > 0)) &&
      Object.keys(action).every((key) => ["type", "tabId", "beforeTabId"].includes(key));
  }
  if (action.type === "windowControl") {
    return ["close", "minimize", "toggleFullscreen", "zoom"].includes(
      action.control as string
    ) && Object.keys(action).length === 2;
  }
  if (action.type === "activateAdjacent") {
    return ["next", "previous"].includes(action.direction as string) &&
      Object.keys(action).length === 2;
  }
  if (["openLauncher", "fullscreenToolbarEnter", "fullscreenToolbarLeave"].includes(action.type)) {
    return Object.keys(action).length === 1;
  }
  return false;
}
