import type { BrowserRuntimeRoleRecord } from "../../shared/generated";
import type { ChromiumRuntimeEffectExecutorInput } from
  "./chromiumRuntimeEffectPorts";
import type {
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import { RionBridgeError } from "../ipc/errors";

function projectionError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export function projectChromiumRuntimeRolePlaceholderSlots(
  tabs: Map<string, ChromiumRuntimeTabRecord>,
  projectedRoles: readonly BrowserRuntimeRoleRecord[]
): void {
  const projectedByRole = new Map(projectedRoles.map((role) => [role.roleId, role]));
  for (const tab of tabs.values()) {
    tab.specification = {
      ...tab.specification,
      slots: tab.specification.slots.map((slot) => {
        if (slot.web !== undefined) return slot;
        const projected = projectedByRole.get(slot.role.id);
        if (!projected) {
          return { ...slot, state: "available" as const, owner: undefined };
        }
        const owns = projected.owner.tabId === tab.specification.tabId &&
          projected.owner.slotId === slot.slotId;
        return {
          ...slot,
          state: owns ? projected.state : "blocked" as const,
          owner: { ...projected.owner }
        };
      })
    };
  }
}

export async function reconcileChromiumRuntimeRolePlaceholders(input: Readonly<{
  ports: ChromiumRuntimeEffectExecutorInput;
  tabs: Map<string, ChromiumRuntimeTabRecord>;
  windows: Map<string, ChromiumRuntimeWindowRecord>;
}>): Promise<void> {
  const placeholders = input.ports.rolePlaceholders;
  if (!placeholders) return;
  const descriptors = [];
  for (const tab of input.tabs.values()) {
    const blocked = tab.specification.slots.filter((slot) =>
      slot.web === undefined && slot.state === "blocked"
    );
    if (blocked.length === 0) continue;
    const window = input.windows.get(tab.windowId);
    if (
      !window || window.windowGeneration < 1 || window.topologyRevision < 1 ||
      window.host.isDestroyed()
    ) {
      throw projectionError(
        "ELECTRON_ROLE_PLACEHOLDER_WINDOW_FENCE_STALE",
        "The blocked Role slot has no positive native window revision fence."
      );
    }
    const bounds = await input.ports.layout.resolveRoleBounds(
      tab.specification,
      window.host
    );
    for (const slot of blocked) {
      const owner = slot.owner;
      const ownerTab = owner ? input.tabs.get(owner.tabId) : undefined;
      const slotBounds = bounds.get(slot.role.id);
      if (
        !owner || !slotBounds ||
        owner.slotId.length === 0 || owner.generation < 1
      ) {
        throw projectionError(
          "ELECTRON_ROLE_PLACEHOLDER_OWNER_STALE",
          "The blocked Role slot lost its exact Core owner or layout."
        );
      }
      descriptors.push(Object.freeze({
        bounds: Object.freeze({ ...slotBounds }),
        ownerGeneration: owner.generation,
        // EventBound: detaching the previous owner tab can precede Core's
        // terminal ownership projection. Preserve the exact owner fence and
        // blocked slot during that handoff; only its presentation name is
        // unavailable until embeddedFollowRoleOwnership commits the successor.
        ownerTabName: ownerTab?.specification.name ?? null,
        parent: window.host,
        placeholderId: `role-placeholder:${tab.specification.tabId}:${slot.slotId}`,
        roleId: slot.role.id,
        roleName: slot.role.name,
        slotId: slot.slotId,
        tabId: tab.specification.tabId,
        topologyRevision: window.topologyRevision,
        visible: window.host.isVisible() &&
          window.activeTabId === tab.specification.tabId &&
          !window.hiddenTabIds.has(tab.specification.tabId),
        windowGeneration: window.windowGeneration,
        windowId: tab.windowId
      }));
    }
  }
  await placeholders.reconcile(descriptors);
}
