import type {
  AppLanguage,
  EmbeddedRuntimeState,
  LaunchWorkspace,
  Role,
  WorkspaceDisplayInfo
} from "./types";

export const RUNTIME_TABS_STATE_CHANNEL = "runtime-tabs:state";
export const RUNTIME_TABS_ACTION_CHANNEL = "runtime-tabs:action";
export const RUNTIME_TABS_LAUNCH_ITEMS_CHANNEL = "runtime-tabs:launch-items";

export type RuntimeTabAction =
  | { type: "activate"; tabId: string }
  | { type: "hide"; tabId: string }
  | { type: "stop"; tabId: string }
  | { type: "move"; tabId: string; displayId: number }
  | { type: "reorder"; tabId: string; beforeTabId?: string }
  | { type: "setOverlay"; open: boolean }
  | { type: "launch"; itemType: "role" | "workspace"; itemId: string };

export interface RuntimeTabChromeState extends EmbeddedRuntimeState {
  displayId: number;
  displays: WorkspaceDisplayInfo[];
  language: AppLanguage;
}

export interface RuntimeTabLaunchItem {
  id: string;
  name: string;
  type: "role" | "workspace";
  running: boolean;
  hidden: boolean;
  targetDisplayId?: number;
}

export function createRuntimeTabLaunchItems(
  roles: Role[],
  workspaces: LaunchWorkspace[],
  state: EmbeddedRuntimeState
): RuntimeTabLaunchItem[] {
  const visibleByDisplayId = new Map(state.windows.map((window) => [window.displayId, window.visible]));
  const tabByRoleId = new Map(
    state.tabs.flatMap((tab) => tab.roleIds.map((roleId) => [roleId, tab] as const))
  );
  const tabByWorkspaceId = new Map(
    state.tabs.flatMap((tab) => tab.type === "workspace" && tab.sourceId
      ? [[tab.sourceId, tab] as const]
      : [])
  );

  return [
    ...roles.map((role) => {
      const tab = tabByRoleId.get(role.id);
      return {
        id: role.id,
        name: role.name,
        type: "role" as const,
        running: Boolean(tab),
        hidden: tab ? tab.hidden || visibleByDisplayId.get(tab.displayId) === false : false
      };
    }),
    ...workspaces.map((workspace) => {
      const tab = tabByWorkspaceId.get(workspace.id);
      return {
        id: workspace.id,
        name: workspace.name,
        type: "workspace" as const,
        running: Boolean(tab),
        hidden: tab ? tab.hidden || visibleByDisplayId.get(tab.displayId) === false : false,
        ...(workspace.targetDisplayId === undefined ? {} : { targetDisplayId: workspace.targetDisplayId })
      };
    })
  ];
}

export function isRuntimeTabAction(value: unknown): value is RuntimeTabAction {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const action = value as Record<string, unknown>;
  if (typeof action.type !== "string") return false;

  if (["activate", "hide", "stop"].includes(action.type)) {
    return typeof action.tabId === "string" && action.tabId.length > 0;
  }
  if (action.type === "move") {
    return typeof action.tabId === "string" && Number.isInteger(action.displayId);
  }
  if (action.type === "reorder") {
    return typeof action.tabId === "string" &&
      (action.beforeTabId === undefined || typeof action.beforeTabId === "string");
  }
  if (action.type === "setOverlay") {
    return typeof action.open === "boolean";
  }
  if (action.type === "launch") {
    return (action.itemType === "role" || action.itemType === "workspace") &&
      typeof action.itemId === "string" && action.itemId.length > 0;
  }
  return false;
}
