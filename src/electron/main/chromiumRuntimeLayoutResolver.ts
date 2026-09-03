import type {
  CoreCommand,
  CoreCommandResult,
  EmbeddedTabEffectRecord,
  LayoutBounds,
  WorkspaceDividerDescriptor,
  WorkspaceLayoutOutput
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type {
  ChromiumRuntimeHostPort,
  ChromiumRuntimeLayoutPort,
  ChromiumRuntimeResolvedWorkspaceLayout
} from "./chromiumRuntimeEffectExecutor";

export interface ChromiumRuntimeLayoutCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

function layoutError(code: string, message: string): never {
  throw new RionBridgeError({ code, message });
}

function validateContentBounds(bounds: ChromiumRoleSurfaceBounds): LayoutBounds {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
    bounds.width < 1 ||
    bounds.height < 1
  ) {
    layoutError(
      "ELECTRON_CHROMIUM_CONTENT_BOUNDS_INVALID",
      "The native runtime host returned invalid content bounds."
    );
  }
  return { ...bounds };
}

function validateRoleIds(tab: EmbeddedTabEffectRecord): string[] {
  const roleIds = tab.slots.map((slot) => slot.role.id);
  if (
    roleIds.some((roleId) => roleId.length === 0) ||
    new Set(roleIds).size !== roleIds.length
  ) {
    layoutError(
      "ELECTRON_CHROMIUM_ROLE_LAYOUT_INVALID",
      "The tab layout must contain one unique identity for every role surface."
    );
  }
  return roleIds;
}

function containsBounds(parent: LayoutBounds, child: LayoutBounds): boolean {
  return child.x >= parent.x &&
    child.y >= parent.y &&
    child.width >= 1 &&
    child.height >= 1 &&
    child.x + child.width <= parent.x + parent.width &&
    child.y + child.height <= parent.y + parent.height;
}

function validateOutput(
  output: WorkspaceLayoutOutput,
  roleIds: string[],
  contentBounds: LayoutBounds,
  descriptors: readonly WorkspaceDividerDescriptor[]
): ChromiumRuntimeResolvedWorkspaceLayout {
  if (!output || typeof output.visible !== "boolean" ||
      !Array.isArray(output.roles) || !Array.isArray(output.dividers)) {
    layoutError(
      "ELECTRON_CHROMIUM_LAYOUT_RESULT_INVALID",
      "Core returned an invalid Chromium role layout."
    );
  }
  const expected = new Set(roleIds);
  const resolved = new Map<string, ChromiumRoleSurfaceBounds>();
  for (const role of output.roles) {
    if (
      !expected.has(role.roleId) ||
      resolved.has(role.roleId) ||
      !role.bounds ||
      ![
        role.bounds.x,
        role.bounds.y,
        role.bounds.width,
        role.bounds.height
      ].every(Number.isSafeInteger) ||
      !containsBounds(contentBounds, role.bounds)
    ) {
      layoutError(
        "ELECTRON_CHROMIUM_LAYOUT_RESULT_INVALID",
        "Core returned a missing, duplicate, or out-of-range Chromium role layout."
      );
    }
    resolved.set(role.roleId, Object.freeze({ ...role.bounds }));
  }
  if (resolved.size !== expected.size) {
    layoutError(
      "ELECTRON_CHROMIUM_LAYOUT_RESULT_INVALID",
      "Core did not resolve every Chromium role surface."
    );
  }
  const dividerIndexes = new Set<number>();
  const dividers = output.dividers.map((divider) => {
    const descriptor = descriptors[divider.index];
    if (!descriptor || dividerIndexes.has(divider.index) ||
        !Number.isSafeInteger(divider.index) || divider.index < 0 ||
        !divider.bounds || ![
          divider.bounds.x,
          divider.bounds.y,
          divider.bounds.width,
          divider.bounds.height
        ].every(Number.isSafeInteger) || !containsBounds(contentBounds, divider.bounds) ||
        !(["horizontal", "vertical"] as const).includes(descriptor.axis)) {
      layoutError(
        "ELECTRON_CHROMIUM_LAYOUT_DIVIDER_INVALID",
        "Core returned a missing, duplicate, or out-of-range workspace divider."
      );
    }
    dividerIndexes.add(divider.index);
    return Object.freeze({
      axis: descriptor.axis,
      bounds: Object.freeze({ ...divider.bounds }),
      index: divider.index
    });
  });
  if (dividers.length !== descriptors.length) {
    layoutError(
      "ELECTRON_CHROMIUM_LAYOUT_DIVIDER_INCOMPLETE",
      "Core did not resolve every authoritative workspace divider."
    );
  }
  return Object.freeze({
    contentBounds: Object.freeze({ ...contentBounds }),
    dividers: Object.freeze(dividers),
    roles: resolved,
    visible: output.visible
  });
}

function dividerInputs(dividers: WorkspaceDividerDescriptor[]) {
  return dividers.map(({ axis, beforeRoleIds, afterRoleIds }) => ({
    axis,
    beforeRoleIds,
    afterRoleIds
  }));
}

/** Keeps layout authority in Rust while Electron supplies live native bounds. */
export class ChromiumRuntimeLayoutResolver implements ChromiumRuntimeLayoutPort {
  readonly #core: ChromiumRuntimeLayoutCorePort;

  constructor(core: ChromiumRuntimeLayoutCorePort) {
    this.#core = core;
  }

  async resolveRoleBounds(
    tab: EmbeddedTabEffectRecord,
    host: ChromiumRuntimeHostPort
  ): Promise<ReadonlyMap<string, ChromiumRoleSurfaceBounds>> {
    return (await this.resolveWorkspaceLayout(tab, host)).roles;
  }

  async resolveWorkspaceLayout(
    tab: EmbeddedTabEffectRecord,
    host: ChromiumRuntimeHostPort
  ): Promise<ChromiumRuntimeResolvedWorkspaceLayout> {
    if (
      host.logicalWindowId !== tab.target.windowId ||
      host.isDestroyed()
    ) {
      layoutError(
        "ELECTRON_CHROMIUM_LAYOUT_HOST_INVALID",
        "The tab layout target no longer owns its native Chromium host."
      );
    }
    const contentBounds = validateContentBounds(host.getContentBounds());
    const roleIds = validateRoleIds(tab);
    // Every authoritative slot participates in geometry, including a blocked
    // shared-Role slot whose remote Role surface remains in another window.
    const roles = tab.slots.map((slot) => ({
      roleId: slot.role.id,
      rect: slot.rect
    }));
    const dividers = await this.#core.invoke({
      type: "layoutCreateDividers",
      roles
    });
    const output = await this.#core.invoke({
      type: "layoutResolve",
      input: {
        active: true,
        hidden: false,
        windowVisible: host.isVisible(),
        contentBounds,
        gap: tab.workspaceAppearance.gap,
        roles,
        dividers: dividerInputs(dividers)
      }
    });
    return validateOutput(output, roleIds, contentBounds, dividers);
  }
}
