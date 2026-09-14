import type { BrowserRuntimeRoleRecord, EmbeddedRuntimeWindowProjectionRecord } from "../../shared/generated";
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
  projectedRoles: readonly BrowserRuntimeRoleRecord[],
  roleId?: string
): void {
  const projectedByRole = new Map(projectedRoles.map((role) => [role.roleId, role]));
  for (const tab of tabs.values()) {
    tab.specification = {
      ...tab.specification,
      slots: tab.specification.slots.map((slot) => {
        if (slot.web !== undefined || (roleId !== undefined && slot.role.id !== roleId)) return slot;
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

/** A phase-only reply cannot overwrite another window or a newer committed phase. */
export function projectFencedRolePlaceholderSlots(
  tabs: Map<string, ChromiumRuntimeTabRecord>,
  roles: readonly BrowserRuntimeRoleRecord[],
  windows: ReadonlyMap<string, ChromiumRuntimeWindowRecord>,
  projections: readonly EmbeddedRuntimeWindowProjectionRecord[] | undefined
): void {
  if (!projections) { projectChromiumRuntimeRolePlaceholderSlots(tabs, roles); return; }
  const scope = new Set(projections.filter(projection => {
    const current = windows.get(projection.windowId);
    return current?.windowGeneration === projection.windowGeneration &&
      current.topologyRevision === projection.topologyRevision;
  }).map(projection => projection.windowId));
  projectChromiumRuntimeRolePlaceholderSlots(
    new Map([...tabs].filter(([, tab]) => scope.has(tab.windowId))), roles
  );
}

export async function reconcileChromiumRuntimeRolePlaceholders(input: Readonly<{
  ports: ChromiumRuntimeEffectExecutorInput;
  tabs: Map<string, ChromiumRuntimeTabRecord>;
  windows: Map<string, ChromiumRuntimeWindowRecord>;
  isCurrent?: () => boolean;
}>): Promise<void> {
  const placeholders = input.ports.rolePlaceholders;
  if (!placeholders) return;
  const descriptors = [];
  for (const tab of input.tabs.values()) {
    if (input.isCurrent?.() === false) return;
    const liveWindow = input.windows.get(tab.windowId);
    // A tombstoned tab retains resources until exact release, but owns no presentation.
    if (liveWindow && !liveWindow.tabIds.includes(tab.specification.tabId)) continue;
    const placeholdersSlots = tab.specification.slots.filter((slot) =>
      slot.web === undefined && (slot.state === "blocked" || slot.state === "available")
    );
    if (placeholdersSlots.length === 0) continue;
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
    if (input.isCurrent?.() === false) return;
    for (const slot of placeholdersSlots) {
      const owner = slot.owner;
      const ownerTab = owner ? input.tabs.get(owner.tabId) : undefined;
      const slotBounds = bounds.get(slot.role.id);
      if (
        !slotBounds ||
        (slot.state === "blocked" && !owner) ||
        (slot.state === "available" && owner !== undefined) ||
        (owner && (owner.slotId.length === 0 || owner.generation < 1))
      ) {
        throw projectionError(
          "ELECTRON_ROLE_PLACEHOLDER_OWNER_STALE",
          "The blocked Role slot lost its exact Core owner or layout."
        );
      }
      descriptors.push(Object.freeze({
        bounds: Object.freeze({ ...slotBounds }),
        ownerGeneration: owner?.generation ?? null,
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
  if (input.isCurrent?.() === false) return;
  await placeholders.reconcile(descriptors);
}
