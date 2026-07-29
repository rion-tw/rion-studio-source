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
  | { type: "tabDragStart"; sessionId: string; tabId: string; screenX: number; screenY: number }
  | { type: "tabDragMove"; sessionId: string; screenX: number; screenY: number }
  | { type: "tabDragDrop"; sessionId: string; windowId: string; beforeTabId?: string }
  | { type: "tabDragEnd"; sessionId: string; cancelled: boolean }
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
      Object.keys(action).length === 5;
  }
  if (action.type === "tabDragMove") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      typeof action.screenX === "number" && Number.isFinite(action.screenX) &&
      typeof action.screenY === "number" && Number.isFinite(action.screenY) &&
      Object.keys(action).length === 4;
  }
  if (action.type === "tabDragDrop") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      typeof action.windowId === "string" && action.windowId.length > 0 &&
      (action.beforeTabId === undefined ||
        (typeof action.beforeTabId === "string" && action.beforeTabId.length > 0)) &&
      Object.keys(action).every((key) =>
        ["type", "sessionId", "windowId", "beforeTabId"].includes(key)
      );
  }
  if (action.type === "tabDragEnd") {
    return typeof action.sessionId === "string" && action.sessionId.length > 0 &&
      typeof action.cancelled === "boolean" && Object.keys(action).length === 3;
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
