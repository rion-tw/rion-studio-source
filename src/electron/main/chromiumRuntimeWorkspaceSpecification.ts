import type { EmbeddedRuntimeWorkspaceTabProjectionRecord } from "../../shared/generated";
import type { ChromiumRuntimeTabRecord } from "./chromiumRuntimeAppKitProjection";
import { RionBridgeError } from "../ipc/errors";

// Retain existing diagnostic codes while sharing the exact slot-owner checks.
function projectionError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export function projectWorkspaceSpecification(
  tab: ChromiumRuntimeTabRecord,
  projection: EmbeddedRuntimeWorkspaceTabProjectionRecord | undefined
): ChromiumRuntimeTabRecord["specification"] {
  if (!projection) return tab.specification;
  if (
    projection.tabId !== tab.specification.tabId ||
    tab.specification.workspaceId === undefined ||
    projection.workspaceSlots.length < 1 ||
    !["material", "black"].includes(projection.workspaceAppearance.background) ||
    ![1, 2, 4, 6, 8, 12, 16].includes(projection.workspaceAppearance.gap) ||
    new Set(projection.workspaceSlots.map((slot) => slot.id)).size !==
      projection.workspaceSlots.length
  ) {
    throw projectionError(
      "ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_PROJECTION_INVALID",
      "Core supplied an invalid authoritative workspace-slot projection."
    );
  }
  const workspaceSlots = projection.workspaceSlots.map((slot) => ({
    ...slot,
    rect: { ...slot.rect },
    ...(slot.web === undefined ? {} : { web: { ...slot.web } })
  }));
  const rectByRole = new Map<string, typeof workspaceSlots[number]["rect"]>();
  const slots = tab.specification.slots.map((slot) => {
    const workspaceSlot = workspaceSlots.find(
      (candidate) => candidate.id === slot.slotId
    );
    if (!workspaceSlot) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_PROJECTION_INCOMPLETE",
        "Core omitted a live Chromium workspace slot from its projection."
      );
    }
    const roleMatches = workspaceSlot.roleId === slot.role.id &&
      workspaceSlot.web === undefined && slot.web === undefined;
    const webMatches = workspaceSlot.roleId === undefined &&
      workspaceSlot.web !== undefined && slot.web !== undefined;
    if (!roleMatches && !webMatches) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_PROJECTION_OWNER_STALE",
        "The authoritative workspace slot no longer matches its native surface owner."
      );
    }
    rectByRole.set(slot.role.id, workspaceSlot.rect);
    return { ...slot, rect: { ...workspaceSlot.rect } };
  });
  if (slots.length !== workspaceSlots.length) {
    throw projectionError(
      "ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_PROJECTION_INCOMPLETE",
      "Core supplied a workspace slot outside the live Chromium tab."
    );
  }
  const roles = tab.specification.roles.map((role) => {
    const rect = rectByRole.get(role.role.id);
    if (!rect) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_PROJECTION_INCOMPLETE",
        "Core omitted a live Chromium role view from its workspace projection."
      );
    }
    return { ...role, rect: { ...rect } };
  });
  return {
    ...tab.specification,
    workspaceAppearance: { ...projection.workspaceAppearance },
    workspaceSlots,
    slots,
    roles
  };
}

