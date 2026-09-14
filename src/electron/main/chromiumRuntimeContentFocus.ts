import type {
  BrowserRuntimeRoleRecord, EmbeddedRuntimeWindowProjectionRecord
} from "../../shared/generated";
import type {
  ChromiumRuntimeRoleRecord, ChromiumRuntimeTabRecord, ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeEffectExecutorInput } from "./chromiumRuntimeEffectExecutor";

interface ContentFocusState {
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly tabs: Map<string, ChromiumRuntimeTabRecord>;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly ports: Pick<ChromiumRuntimeEffectExecutorInput, "surfaces">;
  readonly signal?: AbortSignal;
  readonly lifecycleEpoch?: number;
}

type ContentFocusOwner = Pick<BrowserRuntimeRoleRecord, "roleId" | "state"> & {
  readonly owner: Pick<BrowserRuntimeRoleRecord["owner"], "tabId" | "generation">;
};

export interface ChromiumContentFocusClaim {
  readonly window: ChromiumRuntimeWindowRecord;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
  readonly lifecycleEpoch: number;
  readonly attemptGeneration: string | undefined;
  readonly role: ChromiumRuntimeRoleRecord | undefined;
  readonly roleId: string;
  readonly ownerGeneration: number;
  readonly cancel: () => void;
}

function foreground(window: ChromiumRuntimeWindowRecord, epoch?: number): boolean {
  const native = window.host.readRuntimeWindowState?.();
  return !window.host.isDestroyed() && !!window.host.appKitIdentity &&
    !!native?.focused && native.foreground && native.visible && !native.minimized &&
    native.windowGeneration === window.windowGeneration &&
    native.topologyRevision === window.topologyRevision &&
    (epoch === undefined || native.lifecycleEpoch === epoch) &&
    window.host.readProjection().focused;
}

/** EventBound, content only: a user admission grants one responder handoff. */
export function requestChromiumContentFocus(input: ContentFocusState, tabId: string): void {
  const tab = input.tabs.get(tabId);
  if (!tab) return;
  tab.pendingContentFocus?.cancel();
  const window = input.windows.get(tab.windowId);
  if (!window || input.signal?.aborted || !foreground(window, input.lifecycleEpoch) ||
      window.activeTabId !== tabId || window.hiddenTabIds.has(tabId) ||
      tab.specification.workspaceId || tab.webViews.size !== 0 || tab.roleViews.size !== 1 ||
      !window.host.bindRuntimeWindowState) return;
  const slot = tab.specification.slots[0];
  if (!slot?.owner || tab.specification.slots.length !== 1) return;
  const lifecycleEpoch = window.host.readRuntimeWindowState!().lifecycleEpoch;
  const subscription: { dispose?: () => void } = {};
  const role = [...input.roles.values()].find(role => role.tabId === tabId);
  const claim: ChromiumContentFocusClaim = {
    window, windowGeneration: window.windowGeneration, topologyRevision: window.topologyRevision,
    lifecycleEpoch, attemptGeneration: tab.specification.attemptGeneration,
    role,
    roleId: slot.role.id, ownerGeneration: role?.ownerGeneration ?? slot.owner.generation,
    cancel: () => {
      if (tab.pendingContentFocus === claim) delete tab.pendingContentFocus;
      subscription.dispose?.();
      input.signal?.removeEventListener("abort", claim.cancel);
    }
  };
  tab.pendingContentFocus = claim;
  try {
    subscription.dispose = window.host.bindRuntimeWindowState(observation => {
      if (!observation.focused || !observation.foreground || !observation.visible ||
          observation.minimized || observation.source === "closed" || observation.source === "failed" ||
          observation.windowGeneration !== claim.windowGeneration ||
          observation.lifecycleEpoch !== lifecycleEpoch) claim.cancel();
    });
  } catch (error) { claim.cancel(); throw error; }
  // Native subscriptions can synchronously deliver retirement.
  if (tab.pendingContentFocus !== claim) { subscription.dispose(); return; }
  input.signal?.addEventListener("abort", claim.cancel, { once: true });
  if (input.signal?.aborted) claim.cancel();
}

/** Recheck on every authoritative topology/readiness projection, including loading. */
export function handoffChromiumContentFocus(
  input: ContentFocusState,
  projections: readonly EmbeddedRuntimeWindowProjectionRecord[],
  owners: readonly ContentFocusOwner[]
): void {
  for (const [tabId, tab] of input.tabs) {
    const claim = tab.pendingContentFocus;
    if (!claim) continue;
    const window = input.windows.get(tab.windowId);
    const projected = projections.find(item => item.windowId === tab.windowId);
    if (input.signal?.aborted ||
        (input.lifecycleEpoch !== undefined && input.lifecycleEpoch !== claim.lifecycleEpoch) ||
        window !== claim.window ||
        window.windowGeneration !== claim.windowGeneration ||
        window.topologyRevision < claim.topologyRevision ||
        tab.specification.attemptGeneration !== claim.attemptGeneration ||
        window.activeTabId !== tabId || window.hiddenTabIds.has(tabId) ||
        !foreground(window, claim.lifecycleEpoch)) { claim.cancel(); continue; }
    if (!projected || projected.topologyRevision !== window.topologyRevision ||
        projected.windowGeneration !== window.windowGeneration) continue;
    const phase = projected.tabPhases.find(item => item.tabId === tabId)?.phase;
    const roles = [...input.roles.values()].filter(role => role.windowId === tab.windowId && role.tabId === tabId);
    if (claim.role && !roles.includes(claim.role)) { claim.cancel(); continue; }
    if (phase === "loading" || phase === "activating" || phase === "attaching") continue;
    claim.cancel();
    if (phase !== "ready" || roles.length !== 1 || tab.specification.workspaceId ||
        tab.webViews.size !== 0) continue;
    const role = roles[0]!;
    const owner = owners.find(item => item.roleId === role.roleId);
    if (role.roleId !== claim.roleId || role.ownerGeneration !== claim.ownerGeneration ||
        owner?.state !== "running" || owner.owner.tabId !== tabId ||
        owner.owner.generation !== role.ownerGeneration ||
        !input.ports.surfaces.readProjection(role.roleId, role.generation).visible) continue;
    input.ports.surfaces.focusVisible(role.roleId, role.generation);
  }
}
