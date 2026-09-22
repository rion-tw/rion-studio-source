import { randomUUID } from "node:crypto";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
import { RionBridgeError } from "../ipc/errors";

/** Native menu admission also works while the selected document is loading. */
export async function executeWindowsRuntimeTabShortcut(input: {
  core: ElectronCoreCommandPort;
  native: () => ChromiumRuntimeExecutorSnapshot;
  direction: "next" | "previous";
  focusedWindow?: { id: number; isDestroyed: () => boolean };
}): Promise<void> {
  const candidates = input.native().windows.filter(window => window.visible && window.focused &&
    (input.focusedWindow === undefined || window.parentNativeHostId === input.focusedWindow.id));
  if (input.focusedWindow?.isDestroyed() || candidates.length === 0) return;
  const stale = () => new RionBridgeError({ code: "ELECTRON_RUNTIME_TAB_SHORTCUT_STALE",
    message: "The native tab shortcut lost its exact focused Core/window fence." });
  if (candidates.length !== 1) throw stale();
  const source = candidates[0]!;
  const snapshot = await input.core.invoke({ type: "appSnapshot" });
  const logical = snapshot.logicalWindows.find(window => window.windowId === source.windowId);
  const current = input.native().windows.find(window => window.windowId === source.windowId);
  if (!logical || !current?.visible || !current.focused || input.focusedWindow?.isDestroyed() ||
      current.parentNativeHostId !== source.parentNativeHostId ||
      current.windowGeneration !== source.windowGeneration ||
      logical.windowGeneration !== source.windowGeneration ||
      current.topologyRevision !== source.topologyRevision ||
      logical.revision !== source.topologyRevision ||
      current.activeTabId !== source.activeTabId || logical.activeTabId !== source.activeTabId) throw stale();
  const tabs = logical.tabs.filter(tab => !tab.hidden);
  const index = tabs.findIndex(tab => tab.id === logical.activeTabId);
  if (index < 0) throw stale();
  if (tabs.length === 1) return;
  const next = tabs[(index + (input.direction === "next" ? 1 : -1) + tabs.length) % tabs.length]!;
  const result = await input.core.invoke({ type: "embeddedTabActivate", operationId: randomUUID(),
    tabId: next.id, windowId: logical.windowId, windowGeneration: logical.windowGeneration,
    topologyRevision: logical.revision });
  if (result.status !== "applied") throw new RionBridgeError({
    code: "ELECTRON_RUNTIME_TAB_SHORTCUT_NOT_APPLIED",
    message: "Core did not apply the native adjacent-tab selection."
  });
}
