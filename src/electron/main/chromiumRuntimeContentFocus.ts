import type {
  BrowserRuntimeRoleRecord, EmbeddedRuntimeWindowProjectionRecord
} from "../../shared/generated";
import type {
  ChromiumRuntimeRoleRecord, ChromiumRuntimeTabRecord, ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeEffectExecutorInput } from "./chromiumRuntimeEffectExecutor";
import { recordRuntimeTransition } from "./runtimeOperationJournal";

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
  readonly nativeGeneration: number;
  readonly attemptGeneration: string | undefined;
  readonly role: ChromiumRuntimeRoleRecord | undefined;
  readonly roleId: string;
  readonly ownerGeneration: number;
  readonly cancel: () => void;
}

/** The first failed foreground gate, or null when the exact host may take content focus. */
function foregroundBlocker(window: ChromiumRuntimeWindowRecord, epoch?: number,
  nativeGeneration?: number): string | null {
  if (window.host.isDestroyed()) return "host-destroyed";
  const native = window.host.readRuntimeWindowState?.();
  if (!native) return "state-unavailable";
  if (!native.focused) return "not-focused";
  if (!native.foreground) return "not-foreground";
  if (!native.visible) return "not-visible";
  if (native.minimized) return "minimized";
  if (native.source === "closed" || native.source === "failed" || native.failureCode !== undefined) {
    return "stream-terminal";
  }
  if (native.platform !== (window.host.appKitIdentity ? "macos" : "windows") ||
      native.logicalWindowId !== window.host.logicalWindowId || native.nativeHostId !== window.host.id) {
    return "host-identity";
  }
  if (nativeGeneration !== undefined && native.nativeGeneration !== nativeGeneration) return "native-generation";
  if (native.windowGeneration !== window.windowGeneration) return "window-generation";
  if (native.topologyRevision !== window.topologyRevision) return "topology-revision";
  if (epoch !== undefined && native.lifecycleEpoch !== epoch) return "lifecycle-epoch";
  if (!window.host.readProjection().focused) return "projection-not-focused";
  return null;
}

/** The Role slot that receives content focus: the first non-web slot in layout order. */
function contentFocusSlot(tab: ChromiumRuntimeTabRecord) {
  return tab.specification.slots.find(slot => !slot.web);
}

/**
 * Diagnostics only: each standalone content-focus decision is bounded
 * identity evidence in the runtime journal and never affects admission.
 */
function recordContentFocus(tabId: string, stage: string, window?: ChromiumRuntimeWindowRecord,
  detail?: string): void {
  try {
    recordRuntimeTransition({
      operationId: `content-focus:${tabId}`, action: "contentFocus", targetKind: "tab", targetId: tabId,
      stage: detail ? `${stage}:${detail}` : stage,
      ...(window ? { fences: { windowId: window.host.logicalWindowId,
        windowGeneration: window.windowGeneration, topologyRevision: window.topologyRevision } } : {})
    });
  } catch {
    // Evidence capture must never change focus admission.
  }
}

/** EventBound, content only: a user admission grants one responder handoff. */
export function requestChromiumContentFocus(input: ContentFocusState, tabId: string,
  projections: readonly EmbeddedRuntimeWindowProjectionRecord[] = []): void {
  const tab = input.tabs.get(tabId);
  if (!tab) { recordContentFocus(tabId, "request-skipped", undefined, "tab-unknown"); return; }
  tab.pendingContentFocus?.cancel();
  const window = input.windows.get(tab.windowId);
  if (!window || input.signal?.aborted) {
    recordContentFocus(tabId, "request-skipped", window, window ? "aborted" : "window-unknown");
    return;
  }
  const blocker = foregroundBlocker(window, input.lifecycleEpoch);
  if (blocker) { recordContentFocus(tabId, "request-skipped", window, blocker); return; }
  if (window.activeTabId !== tabId || window.hiddenTabIds.has(tabId)) {
    recordContentFocus(tabId, "request-skipped", window, "not-selected");
    return;
  }
  const projected = projections.find(item => item.windowId === tab.windowId &&
    item.windowGeneration === window.windowGeneration && item.topologyRevision === window.topologyRevision);
  const phase = projected?.tabPhases.find(item => item.tabId === tabId)?.phase;
  if (!window.host.appKitIdentity && (phase === "loading" || phase === "attaching" || phase === "activating")) {
    // Hiding the previous Role can leave the focused HWND without a Chromium
    // responder. One explicit selection hands input to local chrome until ready.
    window.host.focusLocalChrome?.();
    recordContentFocus(tabId, "request-local-chrome", window, phase);
  }
  if (!window.host.bindRuntimeWindowState) {
    recordContentFocus(tabId, "request-skipped", window, "state-stream-unavailable");
    return;
  }
  // A standalone tab hands input to its only Role; a workspace hands it to its
  // first Role slot in layout order. Web slots never take the game responder.
  const slot = contentFocusSlot(tab);
  if (!slot?.owner) {
    recordContentFocus(tabId, "request-skipped", window, slot ? "slot-unowned" : "no-role-slot");
    return;
  }
  const { lifecycleEpoch, nativeGeneration } = window.host.readRuntimeWindowState!();
  const subscription: { dispose?: () => void } = {};
  const role = [...input.roles.values()].find(role => role.tabId === tabId && role.roleId === slot.role.id);
  const claim: ChromiumContentFocusClaim = {
    window, windowGeneration: window.windowGeneration, topologyRevision: window.topologyRevision,
    lifecycleEpoch, nativeGeneration, attemptGeneration: tab.specification.attemptGeneration,
    role,
    roleId: slot.role.id, ownerGeneration: role?.ownerGeneration ?? slot.owner.generation,
    cancel: () => {
      if (tab.pendingContentFocus === claim) {
        delete tab.pendingContentFocus;
        recordContentFocus(tabId, "claim-released", window);
      }
      subscription.dispose?.();
      input.signal?.removeEventListener("abort", claim.cancel);
    }
  };
  tab.pendingContentFocus = claim;
  try {
    subscription.dispose = window.host.bindRuntimeWindowState(observation => {
      if (!observation.focused || !observation.foreground || !observation.visible ||
          observation.minimized || observation.source === "closed" || observation.source === "failed" ||
          observation.failureCode !== undefined || observation.nativeHostId !== window.host.id ||
          observation.logicalWindowId !== window.host.logicalWindowId ||
          observation.nativeGeneration !== nativeGeneration ||
          observation.windowGeneration !== claim.windowGeneration ||
          observation.lifecycleEpoch !== lifecycleEpoch) {
        recordContentFocus(tabId, "claim-revoked", window, `native-${observation.source}`);
        claim.cancel();
      }
    });
  } catch (error) { claim.cancel(); throw error; }
  // Native subscriptions can synchronously deliver retirement.
  if (tab.pendingContentFocus !== claim) { subscription.dispose(); return; }
  input.signal?.addEventListener("abort", claim.cancel, { once: true });
  if (input.signal?.aborted) claim.cancel();
  else recordContentFocus(tabId, "request-claimed", window, phase ?? "unprojected");
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
    const current = input.windows.get(tab.windowId);
    const projected = projections.find(item => item.windowId === tab.windowId);
    const window = claim.window;
    const revoked = input.signal?.aborted ? "aborted"
      : input.lifecycleEpoch !== undefined && input.lifecycleEpoch !== claim.lifecycleEpoch ? "lifecycle-epoch"
        : current !== window ? "window-replaced"
          : window.windowGeneration !== claim.windowGeneration ? "window-generation"
            : window.topologyRevision < claim.topologyRevision ? "topology-regressed"
              : tab.specification.attemptGeneration !== claim.attemptGeneration ? "attempt-generation"
                : window.activeTabId !== tabId || window.hiddenTabIds.has(tabId) ? "deselected"
                  : foregroundBlocker(window, claim.lifecycleEpoch, claim.nativeGeneration);
    if (revoked) {
      recordContentFocus(tabId, "claim-revoked", window, revoked);
      claim.cancel();
      continue;
    }
    if (!projected || projected.topologyRevision !== window.topologyRevision ||
        projected.windowGeneration !== window.windowGeneration) continue;
    const phase = projected.tabPhases.find(item => item.tabId === tabId)?.phase;
    const roles = [...input.roles.values()].filter(role => role.windowId === tab.windowId && role.tabId === tabId);
    if (claim.role && !roles.includes(claim.role)) {
      recordContentFocus(tabId, "claim-revoked", window, "role-replaced");
      claim.cancel();
      continue;
    }
    if (phase === "loading" || phase === "activating" || phase === "attaching") {
      // A workspace keeps sibling Role slots interactive while others load, so
      // a deferred handoff could take focus back from a slot the user already
      // clicked. Only an already-ready workspace receives the selection handoff.
      if (tab.specification.workspaceId) {
        recordContentFocus(tabId, "claim-revoked", window, `workspace-${phase}`);
        claim.cancel();
      }
      continue;
    }
    claim.cancel();
    const role = roles.find(item => item.roleId === claim.roleId);
    if (phase !== "ready" || !role) {
      recordContentFocus(tabId, "handoff-skipped", window, phase !== "ready" ? `phase-${phase ?? "unprojected"}`
        : "role-missing");
      continue;
    }
    const owner = owners.find(item => item.roleId === role.roleId);
    if (role.roleId !== claim.roleId || role.ownerGeneration !== claim.ownerGeneration ||
        owner?.state !== "running" || owner.owner.tabId !== tabId ||
        owner.owner.generation !== role.ownerGeneration) {
      recordContentFocus(tabId, "handoff-skipped", window, owner?.state !== "running"
        ? `owner-${owner?.state ?? "missing"}` : "owner-changed");
      continue;
    }
    if (!input.ports.surfaces.readProjection(role.roleId, role.generation).visible) {
      recordContentFocus(tabId, "handoff-skipped", window, "surface-hidden");
      continue;
    }
    input.ports.surfaces.focusVisible(role.roleId, role.generation);
    recordContentFocus(tabId, "handoff-focused", window);
  }
}
