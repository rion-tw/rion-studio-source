import type { CoreAppSnapshotRecord } from "../../shared/generated";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
import { canonicalWebSurfaceIdentities, reconcileNativeWebSurfaces } from "./chromiumRuntimeLaunchWebIdentity";

export interface LaunchWindowRevision {
  windowGeneration: number;
  topologyRevision: number;
}

/** Current Core/native identities authorize reuse; admission metadata is not a lease. */
export function inspectLaunchWindowFence(
  core: CoreAppSnapshotRecord,
  native: ChromiumRuntimeExecutorSnapshot,
  windowId: string,
  previous?: LaunchWindowRevision,
  quarantined = false
): { reason: string | null; fences: Record<string, string | number> } {
  const logical = core.logicalWindows.filter(window => window.windowId === windowId);
  const runtime = core.browserRuntime.windows.filter(window => window.windowId === windowId);
  const hosts = native.windows.filter(window => window.windowId === windowId);
  const window = logical[0], host = hosts[0];
  const ids = window?.tabs.map(tab => tab.id) ?? [];
  const tabs = native.tabs.filter(tab => tab.windowId === windowId && !tab.retiring);
  const coreTabs = core.browserRuntime.tabs.filter(tab => tab.windowId === windowId);
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, index) => id === b[index]);
  let reason: string | null = null;
  if (quarantined) reason = "registration-compensation-indeterminate";
  else if (logical.length !== 1 || runtime.length !== 1 || hosts.length !== 1) reason = "window-identity";
  else if (!window || !host || window.windowGeneration < 1 || window.revision < 1 ||
    host.windowGeneration !== window.windowGeneration) reason = "window-generation";
  else if (previous && previous.windowGeneration !== window.windowGeneration) reason = "generation-changed";
  else if (previous?.windowGeneration === window.windowGeneration && window.revision < previous.topologyRevision) reason = "revision-regressed";
  else if (host.topologyRevision !== window.revision) reason = "topology-revision";
  else if (!same(runtime[0]!.tabIds, ids) || !same(host.tabIds, ids)) reason = "ordered-tabs";
  else if (host.activeTabId !== (window.activeTabId ?? "") ||
    runtime[0]!.activeTabId !== window.activeTabId) reason = "active-tab";
  else if (tabs.length !== ids.length || coreTabs.length !== ids.length || new Set(ids).size !== ids.length ||
    ids.some(id => tabs.filter(tab => tab.tabId === id).length !== 1 ||
      coreTabs.filter(tab => tab.id === id).length !== 1 ||
      native.tabs.filter(tab => tab.tabId === id && !tab.retiring).length !== 1)) reason = "tab-identities";
  else {
    for (const tab of coreTabs) {
      const physical = tabs.find(candidate => candidate.tabId === tab.id)!;
      if (physical.attemptGeneration !== undefined && physical.attemptGeneration !== tab.attemptGeneration) {
        reason = "tab-attempt"; break;
      }
      const web = canonicalWebSurfaceIdentities(tab, tab.tabType);
      const relevant = native.webSurfaces.filter(surface => surface.windowId === windowId ||
        web?.some(expected => expected.surfaceId === surface.surfaceId));
      if (!web || reconcileNativeWebSurfaces(web, tab.id, windowId, { ...native, webSurfaces: relevant }) === "invalid") {
        reason = "web-surface-identity"; break;
      }
    }
  }
  return { reason, fences: {
    windowId, reason: reason ?? "exact", coreGeneration: window?.windowGeneration ?? -1,
    coreRevision: window?.revision ?? -1, nativeGeneration: host?.windowGeneration ?? -1,
    nativeRevision: host?.topologyRevision ?? -1,
    observedGeneration: previous?.windowGeneration ?? -1, observedRevision: previous?.topologyRevision ?? -1,
    coreTabAttempts: coreTabs.map(tab => `${tab.id}:${tab.attemptGeneration ?? "absent"}`).join(","),
    nativeTabAttempts: tabs.map(tab => `${tab.tabId}:${tab.attemptGeneration ?? "absent"}`).join(","),
    coreTabIds: ids.join(","),
    nativeTabIds: host?.tabIds.join(",") ?? "", liveNativeTabIds: tabs.map(tab => tab.tabId).join(","),
    coreActiveTabId: window?.activeTabId ?? "", nativeActiveTabId: host?.activeTabId ?? ""
  } };
}
