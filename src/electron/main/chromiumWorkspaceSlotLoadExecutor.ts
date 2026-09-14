import type { CoreEffectRequest, EmbeddedRoleLoadEffectRecord, WorkspaceSlotLoadRecord } from "../../shared/generated";
import type { ChromiumRuntimeTabRecord, ChromiumRuntimeWindowRecord } from "./chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeEffectExecutorInput } from "./chromiumRuntimeEffectPorts";
import { coreEffectEventContinuation, type CoreEffectEventContinuation } from "./coreEffectContinuation";
import { runtimeError } from "./chromiumRuntimeEffectExecutorSupport";
import { projectWorkspaceSlotLoads } from "./chromiumWorkspaceSlotLoading";

interface WorkspaceSlotExecutorInput {
  ports: ChromiumRuntimeEffectExecutorInput;
  tabs: Map<string, ChromiumRuntimeTabRecord>;
  windowForTab: (tab: ChromiumRuntimeTabRecord) => ChromiumRuntimeWindowRecord;
  roleGenerations: Map<string, number>;
  webGenerations: Map<string, number>;
  retiredLoads: Set<string>;
  loadRoles: (tabId: string, roles: EmbeddedRoleLoadEffectRecord[], signal: AbortSignal) => Promise<CoreEffectEventContinuation<void>>;
  loadWebSurfaces: (effect: CoreEffectRequest, action: Extract<CoreEffectRequest["action"], { type: "embeddedLoadWebSurfaces" }>, signal: AbortSignal) => Promise<CoreEffectEventContinuation<void>>;
}

export async function loadChromiumWorkspaceSlots(
  input: WorkspaceSlotExecutorInput, effect: CoreEffectRequest,
  plan: Extract<CoreEffectRequest["action"], { type: "embeddedLoadWorkspaceSlots" }>,
  signal?: AbortSignal, retry?: WorkspaceSlotLoadRecord
): Promise<CoreEffectEventContinuation<void>> {
    const tabId = retry?.tabId ?? effect.target.handleId;
    const tab = input.tabs.get(tabId);
    const port = input.ports.workspaceSlotLoading;
    if (!tab || !port || plan.tabId !== tabId || plan.attemptGeneration !== tab.specification.attemptGeneration) {
      throw runtimeError("WORKSPACE_SLOT_LOAD_UNAVAILABLE", "The exact workspace slot load channel is unavailable.");
    }
    tab.workspaceLoadPlan = plan;
    tab.slotRetry = port.retry;
    tab.slotLoads ??= new Map();
    const window = input.windowForTab(tab);
    window.host.bindWorkspaceSlotRetry?.((record) => port.retry(record));
    const cancellation = new AbortController();
    const loadSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
    const bounds = await input.ports.layout.resolveRoleBounds(tab.specification, window.host);
    const descriptors = [
      ...plan.roles.map((role) => ({ id: role.roleId, kind: "role" as const, role })),
      ...plan.surfaces.map((web) => ({ id: web.surfaceId, kind: "web" as const, web }))
    ].filter((descriptor) => !retry || descriptor.id === retry.surfaceId);
    if (retry && descriptors.length !== 1) throw runtimeError("WORKSPACE_SLOT_RETRY_STALE", "The slot descriptor changed before retry.");
    // Admission returns a continuation before any native completion reports to Core.
    const completion = Promise.resolve().then(async () => {
      const runs = descriptors.map(async (descriptor) => {
        const slot = tab.specification.slots.find((item) => item.role.id === descriptor.id);
        if (!slot) throw runtimeError("WORKSPACE_SLOT_LOAD_STALE", "The slot no longer belongs to this workspace.");
        let record = retry ?? await port.report({
          tabId, slotId: slot.slotId, surfaceId: descriptor.id,
          windowId: tab.windowId, windowGeneration: window.windowGeneration,
          attemptGeneration: tab.specification.attemptGeneration!,
          loadId: tab.specification.attemptGeneration!, ownerGeneration: slot.owner?.generation ?? 0,
          surfaceGeneration: 0, revision: 0, phase: "loading", retryable: false
        });
        if (!record || loadSignal.aborted || input.tabs.get(tabId) !== tab) return;
        tab.slotLoads!.set(slot.slotId, record);
        projectWorkspaceSlotLoads(tab, window, bounds);
        let phase: "ready" | "failed" = "ready";
        let retryable = false;
        const generations = descriptor.kind === "role" ? input.roleGenerations : input.webGenerations;
        const before = generations.get(descriptor.id) ?? 0;
        try {
          const continuation = descriptor.kind === "role"
            ? await input.loadRoles(tabId, [descriptor.role], loadSignal)
            : await input.loadWebSurfaces(effect, {
              type: "embeddedLoadWebSurfaces", tabId,
              attemptGeneration: tab.specification.attemptGeneration!,
              profile: plan.profile!, surfaces: [descriptor.web]
            }, loadSignal);
          await continuation.completion;
        } catch (error) {
          if (loadSignal.aborted) throw error;
          phase = "failed";
          const generation = generations.get(descriptor.id) ?? 0;
          retryable = generation === before || input.retiredLoads.delete(`${descriptor.kind}:${descriptor.id}:${generation}`);
        }
        if (loadSignal.aborted || input.tabs.get(tabId) !== tab) return;
        const ownerWindow = input.windowForTab(tab);
        record = await port.report({ ...record, phase, retryable,
          windowId: tab.windowId, windowGeneration: ownerWindow.windowGeneration,
          surfaceGeneration: generations.get(descriptor.id) ?? 0 });
        if (!record || loadSignal.aborted || input.tabs.get(tabId) !== tab) return;
        tab.slotLoads!.set(slot.slotId, record);
        const currentWindow = input.windowForTab(tab);
        const currentBounds = await input.ports.layout.resolveRoleBounds(tab.specification, currentWindow.host);
        projectWorkspaceSlotLoads(tab, currentWindow, currentBounds);
        if (record.phase === "ready") {
          const visible = currentWindow.activeTabId === tabId && currentWindow.host.isVisible();
          if (descriptor.kind === "role") input.ports.surfaces.setVisible(descriptor.id, record.surfaceGeneration, visible);
          else input.ports.webSurfaces.setVisible(descriptor.id, record.surfaceGeneration, visible);
          currentWindow.host.releaseAppKitSurfaceAttachment?.(tabId);
        }
      });
      const outcomes = await Promise.allSettled(runs);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (loadSignal.aborted) throw runtimeError("WORKSPACE_SLOT_LOAD_CANCELLED", "Workspace loading was cancelled.");
    });
    return coreEffectEventContinuation(completion, () => cancellation.abort());
}
