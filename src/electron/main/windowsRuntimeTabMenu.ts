import type { MenuItemConstructorOptions } from "electron";
import { runtimeTabMenuLabels } from "../../shared/runtimeTabMenuLabels";
import type { AppLanguage } from "../../shared/types";
import type { WindowsRuntimeHostCommand, WindowsRuntimeHostProjection } from "../../shared/windowsRuntimeHost";

/** Native menu items capture one published projection; selection re-enters the
 * same fenced controller as renderer commands. No native view is hidden or resized. */
export function windowsRuntimeTabMenu(
  projection: WindowsRuntimeHostProjection,
  tabId: string,
  language: AppLanguage,
  submit: (command: WindowsRuntimeHostCommand) => void
): MenuItemConstructorOptions[] {
  const tab = projection.tabs.find(candidate => candidate.tabId === tabId && !candidate.hidden);
  if (!tab) return [];
  const labels = runtimeTabMenuLabels[language];
  const base = { projectionRevision: projection.projectionRevision, tabId, windowId: projection.windowId };
  return [
    { id: "reloadTab", label: labels.reload, click: () => submit({ ...base, type: "reloadTab",
      lifecycleEpoch: projection.lifecycleEpoch, topologyRevision: projection.topologyRevision,
      windowGeneration: projection.windowGeneration }) },
    { id: "setTabMuted", label: tab.audioMuted ? labels.unmute : labels.mute, type: "checkbox",
      checked: tab.audioMuted, click: () => submit({ ...base, type: "setTabMuted", muted: !tab.audioMuted }) },
    { type: "separator" },
    { id: "hideTab", label: labels.hide, enabled: projection.tabs.filter(candidate => !candidate.hidden).length > 1,
      click: () => submit({ ...base, type: "hideTab" }) },
    { id: "moveTab", label: labels.moveToWindow, enabled: projection.moveTargets.length > 0,
      submenu: projection.moveTargets.map(target => ({ id: target.windowId, label: target.name,
        click: () => submit({ ...base, type: "moveTab", targetWindowId: target.windowId,
          targetWindowGeneration: target.windowGeneration }) })) },
    { id: "moveTabToNewWindow", label: labels.moveToNewWindow,
      click: () => submit({ ...base, type: "moveTabToNewWindow" }) },
    { type: "separator" },
    { id: "closeTab", label: labels.stop, click: () => submit({ ...base, type: "closeTab" }) }
  ];
}
