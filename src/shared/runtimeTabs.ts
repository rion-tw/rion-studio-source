import type {
  ApplicationShortcutCommand,
  AppLanguage,
  DisplayInfo,
  EmbeddedRuntimeState,
  EmbeddedRuntimeTabSummary,
  ResolvedTheme,
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
  | {
      type: "tabDragStart";
      sessionId: string;
      tabId: string;
      screenX: number;
      screenY: number;
      grabRatioX: number;
      grabRatioY: number;
      tabWidth: number;
      tabHeight: number;
    }
  | { type: "tabDragMove"; sessionId: string; screenX: number; screenY: number }
  | {
      type: "tabDragHover";
      sessionId: string;
      windowId: string;
      screenX: number;
      screenY: number;
      tabWidth: number;
      tabHeight: number;
      beforeTabId?: string;
    }
  | {
      type: "tabDragDrop";
      sessionId: string;
      windowId: string;
      screenX: number;
      screenY: number;
      beforeTabId?: string;
    }
  | {
      type: "tabDragEnd";
      sessionId: string;
      cancelled: boolean;
      screenX: number;
      screenY: number;
    }
  | { type: "tabDragCancel"; sessionId: string }
  | { type: "reorder"; tabId: string; beforeTabId?: string }
  | { type: "openLauncher" }
  | { type: "openTabMenu"; tabId: string }
  | { type: "applicationShortcut"; command: ApplicationShortcutCommand }
  | { type: "activateAdjacent"; direction: "next" | "previous" }
  | { type: "fullscreenToolbarEnter" }
  | { type: "fullscreenToolbarLeave" }
  | {
      type: "windowControl";
      control: "close" | "minimize" | "toggleFullscreen" | "zoom";
    };

export interface RuntimeTabStripState extends EmbeddedRuntimeState {
  alwaysHideTabCloseButton: boolean;
  alwaysShowToolbarInFullScreen: boolean;
  displayId: number;
  windowId: string;
  displays: DisplayInfo[];
  fullscreen: boolean;
  language: AppLanguage;
  resolvedTheme: ResolvedTheme;
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
  if (action.type === "tabDragStart") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      typeof action.tabId === "string" && action.tabId.length > 0 &&
      typeof action.screenX === "number" && Number.isFinite(action.screenX) &&
      typeof action.screenY === "number" && Number.isFinite(action.screenY) &&
      typeof action.grabRatioX === "number" && Number.isFinite(action.grabRatioX) &&
      action.grabRatioX >= 0 && action.grabRatioX <= 1 &&
      typeof action.grabRatioY === "number" && Number.isFinite(action.grabRatioY) &&
      action.grabRatioY >= 0 && action.grabRatioY <= 1 &&
      typeof action.tabWidth === "number" && Number.isFinite(action.tabWidth) &&
      action.tabWidth > 0 &&
      typeof action.tabHeight === "number" && Number.isFinite(action.tabHeight) &&
      action.tabHeight > 0 &&
      Object.keys(action).length === 9;
  }
  if (action.type === "tabDragMove") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      typeof action.screenX === "number" && Number.isFinite(action.screenX) &&
      typeof action.screenY === "number" && Number.isFinite(action.screenY) &&
      Object.keys(action).length === 4;
  }
  if (action.type === "tabDragHover" || action.type === "tabDragDrop") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      typeof action.windowId === "string" && action.windowId.length > 0 &&
      typeof action.screenX === "number" && Number.isFinite(action.screenX) &&
      typeof action.screenY === "number" && Number.isFinite(action.screenY) &&
      (action.type !== "tabDragHover" || (
        typeof action.tabWidth === "number" && Number.isFinite(action.tabWidth) &&
        action.tabWidth > 0 &&
        typeof action.tabHeight === "number" && Number.isFinite(action.tabHeight) &&
        action.tabHeight > 0
      )) &&
      (action.beforeTabId === undefined ||
        (typeof action.beforeTabId === "string" && action.beforeTabId.length > 0)) &&
      Object.keys(action).every((key) =>
        ["type", "sessionId", "windowId", "screenX", "screenY", "tabWidth", "tabHeight", "beforeTabId"].includes(key)
      );
  }
  if (action.type === "tabDragEnd") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      typeof action.cancelled === "boolean" &&
      typeof action.screenX === "number" && Number.isFinite(action.screenX) &&
      typeof action.screenY === "number" && Number.isFinite(action.screenY) &&
      Object.keys(action).length === 5;
  }
  if (action.type === "tabDragCancel") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      Object.keys(action).length === 2;
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
  if (action.type === "applicationShortcut") {
    return ["newGameWindow", "toggleFullscreen", "zoomReset", "zoomIn", "zoomOut"].includes(
      action.command as string
    ) && Object.keys(action).length === 2;
  }
  if (["openLauncher", "fullscreenToolbarEnter", "fullscreenToolbarLeave"].includes(action.type)) {
    return Object.keys(action).length === 1;
  }
  return false;
}
