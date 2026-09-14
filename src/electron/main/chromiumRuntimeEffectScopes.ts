import type { CoreEffectRequest } from "../../shared/generated";
import type { ChromiumRuntimeTabRecord } from "./chromiumRuntimeAppKitProjection";

export function chromiumRuntimeEffectScopes(effect: CoreEffectRequest,
  tabs: ReadonlyMap<string, ChromiumRuntimeTabRecord>, admittedTabWindows: Map<string, string>): readonly string[] {
    const action = effect.action;
    if (effect.target.kind !== "app") return [`${effect.target.kind}:${effect.target.handleId}`];
    if (action.type === "embeddedCreateTab") {
      admittedTabWindows.set(action.tab.tabId, action.tab.target.windowId);
      return [`window:${action.tab.target.windowId}`];
    }
    if (action.type === "embeddedProvisionWindowForTabMove") {
      return [`window:${action.sourceWindowId}`, `window:${action.target.windowId}`];
    }
    if (action.type === "embeddedObserveAppKitWorkspaceAppearance") {
      return action.windowIds.map(id => `window:${id}`);
    }
    if (action.type === "embeddedApplyAppKitProjection") {
      return action.projection.windows.map(window => `window:${window.identity.logicalWindowId}`);
    }
    if (action.type === "embeddedFollowRoleOwnership" && action.windows?.length) {
      return action.windows.map(window => `window:${window.windowId}`);
    }
    const tabId = "tabId" in action && typeof action.tabId === "string" ? action.tabId : effect.target.handleId;
    const tab = tabs.get(tabId);
    if (tab) return [`window:${tab.windowId}`];
    const admittedWindow = admittedTabWindows.get(tabId);
    if (admittedWindow) return [`window:${admittedWindow}`];
    if ("windowId" in action && typeof action.windowId === "string") return [`window:${action.windowId}`];
    if ("roleId" in action && typeof action.roleId === "string") return [`role:${action.roleId}`];
    return ["app"];
  }

