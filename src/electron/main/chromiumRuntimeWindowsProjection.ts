import type {
  EmbeddedRuntimeWindowProjectionRecord,
  EmbeddedRuntimeWorkspaceTabProjectionRecord
} from
  "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeEffectExecutorInput
} from "./chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeSurfaceProjection } from
  "./chromiumRuntimeProjectionTransaction";
import { bindChromiumRuntimeWindowLayout } from
  "./chromiumRuntimeFullscreenToolbar";
import { effectiveChromiumRuntimeZoomFactor } from
  "./chromiumRuntimeWindowZoomController";

interface ApplyRuntimeWindowsProjectionInput {
  readonly projections: readonly EmbeddedRuntimeWindowProjectionRecord[];
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly tabs: Map<string, ChromiumRuntimeTabRecord>;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
  readonly quarantineWindows: (windowIds: readonly string[]) => Promise<void>;
}

interface ProjectedTab {
  readonly windowId: string;
  readonly active: boolean;
  readonly hidden: boolean;
  readonly phase: import("../../shared/generated").RuntimeTabActivationPhaseRecord;
  readonly bounds: ReadonlyMap<string, Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>>;
  readonly contentBounds: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly dividers: readonly Readonly<{
    axis: "horizontal" | "vertical";
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
    index: number;
  }>[];
  readonly specification: ChromiumRuntimeTabRecord["specification"];
}

interface CompletedReparent {
  readonly kind: "role" | "web";
  readonly id: string;
  readonly generation: number;
  readonly sourceWindowId: string;
}

function projectionError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function exactIds(values: readonly string[]): boolean {
  return values.every(validIdentifier) && new Set(values).size === values.length;
}

function projectWorkspaceSpecification(
  tab: ChromiumRuntimeTabRecord,
  projection: EmbeddedRuntimeWorkspaceTabProjectionRecord | undefined
): ChromiumRuntimeTabRecord["specification"] {
  if (!projection) return tab.specification;
  if (
    projection.tabId !== tab.specification.tabId ||
    tab.specification.workspaceId === undefined ||
    projection.workspaceSlots.length < 2 ||
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
    workspaceSlots,
    slots,
    roles
  };
}

/**
 * Applies a Rust-owned logical window projection to existing Windows Chromium
 * hosts. AppKit hosts are deliberately excluded: macOS consumes the exact
 * AppKit projection transaction instead.
 */
export async function applyChromiumRuntimeWindowsProjection(
  input: ApplyRuntimeWindowsProjectionInput
): Promise<readonly string[]> {
  if (input.projections.length === 0) return Object.freeze([]);
  const attached = input.projections.filter((projection) =>
    input.windows.has(projection.windowId)
  );
  if (attached.some((projection) =>
    input.windows.get(projection.windowId)?.host.appKitIdentity !== undefined
  )) {
    return Object.freeze([]);
  }

  const projectionByWindow = new Map<string, EmbeddedRuntimeWindowProjectionRecord>();
  const ownerByTab = new Map<string, string>();
  const phaseByTab = new Map<string, import(
    "../../shared/generated"
  ).RuntimeTabActivationPhaseRecord>();
  for (const projection of attached) {
    if (
      !validIdentifier(projection.windowId) ||
      !Number.isSafeInteger(projection.windowGeneration) ||
      projection.windowGeneration < 1 ||
      !Number.isSafeInteger(projection.topologyRevision) ||
      projection.topologyRevision < 1 ||
      projectionByWindow.has(projection.windowId) ||
      !exactIds(projection.tabIds) || !exactIds(projection.hiddenTabIds)
    ) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_INVALID",
        "Core supplied malformed or duplicated Windows runtime topology."
      );
    }
    const tabIds = new Set(projection.tabIds);
    const tabPhaseIds = projection.tabPhases.map((tab) => tab.tabId);
    const workspaceTabIds = (projection.workspaceTabs ?? []).map(
      (tab) => tab.tabId
    );
    if (
      projection.hiddenTabIds.some((tabId) => !tabIds.has(tabId)) ||
      (projection.activeTabId !== undefined && (
        !tabIds.has(projection.activeTabId) ||
        projection.hiddenTabIds.includes(projection.activeTabId)
      )) || !exactIds(workspaceTabIds) || !exactIds(tabPhaseIds) ||
      tabPhaseIds.length !== projection.tabIds.length ||
      tabPhaseIds.some((tabId) => !tabIds.has(tabId)) ||
      projection.tabPhases.some((tab) => !new Set([
        "dormant",
        "activating",
        "attaching",
        "loading",
        "ready",
        "degraded",
        "failed"
      ]).has(tab.phase)) ||
      workspaceTabIds.some((tabId) => !tabIds.has(tabId))
    ) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_SELECTION_INVALID",
        "Core supplied an active or hidden tab outside its exact window membership."
      );
    }
    const current = input.windows.get(projection.windowId)!;
    if (
      current.host.isDestroyed() ||
      (current.windowGeneration !== 0 &&
        current.windowGeneration !== projection.windowGeneration) ||
      projection.topologyRevision < current.topologyRevision
    ) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_STALE",
        "Core supplied a stale Windows runtime host generation or topology revision."
      );
    }
    for (const tabId of projection.tabIds) {
      if (!input.tabs.has(tabId) || ownerByTab.has(tabId)) {
        throw projectionError(
          "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_TAB_INVALID",
          "Core supplied a duplicated or unavailable Windows runtime tab."
        );
      }
      ownerByTab.set(tabId, projection.windowId);
    }
    for (const tab of projection.tabPhases) phaseByTab.set(tab.tabId, tab.phase);
    projectionByWindow.set(projection.windowId, projection);
  }
  for (const tabId of input.tabs.keys()) {
    if (!ownerByTab.has(tabId)) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_INCOMPLETE",
        "Core omitted an attached Chromium tab from the Windows topology projection."
      );
    }
  }

  const projectedTabs = new Map<string, ProjectedTab>();
  for (const projection of projectionByWindow.values()) {
    const record = input.windows.get(projection.windowId)!;
    bindChromiumRuntimeWindowLayout({
      ports: input.ports,
      record,
      tabs: input.tabs,
      roles: input.roles,
      webSurfaces: input.webSurfaces
    });
  }
  for (const [tabId, windowId] of ownerByTab) {
    const tab = input.tabs.get(tabId)!;
    const projection = projectionByWindow.get(windowId)!;
    const host = input.windows.get(windowId)!.host;
    const workspaceProjection = (projection.workspaceTabs ?? []).find(
      (candidate) => candidate.tabId === tabId
    );
    const specification = projectWorkspaceSpecification(tab, workspaceProjection);
    if (!input.ports.layout.resolveWorkspaceLayout) {
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_WORKSPACE_LAYOUT_UNAVAILABLE",
        "The Windows runtime requires authoritative Core divider geometry."
      );
    }
    const layout = await input.ports.layout.resolveWorkspaceLayout(
      specification,
      host
    );
    projectedTabs.set(tabId, {
      windowId,
      active: projection.activeTabId === tabId,
      hidden: projection.hiddenTabIds.includes(tabId),
      phase: phaseByTab.get(tabId)!,
      bounds: layout.roles,
      contentBounds: layout.contentBounds,
      dividers: layout.dividers,
      specification
    });
  }

  const roleSnapshots = new Map<string, ChromiumRuntimeSurfaceProjection>();
  const webSnapshots = new Map<string, ChromiumRuntimeSurfaceProjection>();
  for (const role of input.roles.values()) {
    roleSnapshots.set(
      role.roleId,
      input.ports.surfaces.readProjection(role.roleId, role.generation)
    );
  }
  for (const surface of input.webSurfaces.values()) {
    webSnapshots.set(
      surface.surfaceId,
      input.ports.webSurfaces.readProjection(surface.surfaceId, surface.generation)
    );
  }

  const completed: CompletedReparent[] = [];
  const compensate = async (primaryError: unknown): Promise<never> => {
    const failures: unknown[] = [];
    for (const [roleId, snapshot] of roleSnapshots) {
      const role = input.roles.get(roleId)!;
      try {
        if (snapshot.zoomFactor !== undefined) {
          input.ports.surfaces.setZoomFactor(
            roleId,
            role.generation,
            snapshot.zoomFactor
          );
        }
        input.ports.surfaces.setBounds(roleId, role.generation, snapshot.bounds);
        input.ports.surfaces.setVisible(roleId, role.generation, snapshot.visible);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [surfaceId, snapshot] of webSnapshots) {
      const surface = input.webSurfaces.get(surfaceId)!;
      try {
        if (snapshot.zoomFactor !== undefined) {
          input.ports.webSurfaces.setZoomFactor(
            surfaceId,
            surface.generation,
            snapshot.zoomFactor
          );
        }
        input.ports.webSurfaces.setBounds(surfaceId, surface.generation, snapshot.bounds);
        input.ports.webSurfaces.setVisible(
          surfaceId,
          surface.generation,
          snapshot.visible
        );
      } catch (error) {
        failures.push(error);
      }
    }
    for (const item of [...completed].reverse()) {
      const source = input.windows.get(item.sourceWindowId);
      try {
        if (!source || source.host.isDestroyed()) {
          throw projectionError(
            "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_SOURCE_STALE",
            "A Windows topology rollback lost its exact source host."
          );
        }
        if (item.kind === "role") {
          await input.ports.surfaces.reparentRole!(
            item.id,
            item.generation,
            source.host
          );
        } else {
          await input.ports.webSurfaces.reparentSurface!(
            item.id,
            item.generation,
            source.host
          );
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      try {
        await input.quarantineWindows([...projectionByWindow.keys()]);
      } catch (error) {
        failures.push(error);
      }
      throw projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_COMPENSATION_FAILED",
        "The Windows runtime topology was quarantined after compensation failed."
      );
    }
    throw primaryError;
  };

  try {
    for (const role of input.roles.values()) {
      const projected = projectedTabs.get(role.tabId);
      if (!projected) continue;
      const bounds = projected.bounds.get(role.roleId);
      if (!bounds) {
        throw projectionError(
          "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_LAYOUT_MISSING",
          "The Windows runtime projection omitted an owned Role layout."
        );
      }
      if (role.windowId !== projected.windowId) {
        if (!input.ports.surfaces.reparentRole) {
          throw projectionError(
            "ELECTRON_CHROMIUM_WINDOWS_REPARENT_UNAVAILABLE",
            "The Chromium Role surface registry cannot apply a cross-window move."
          );
        }
        await input.ports.surfaces.reparentRole(
          role.roleId,
          role.generation,
          input.windows.get(projected.windowId)!.host
        );
        completed.push({
          kind: "role",
          id: role.roleId,
          generation: role.generation,
          sourceWindowId: role.windowId
        });
      }
      input.ports.surfaces.setZoomFactor(
        role.roleId,
        role.generation,
        effectiveChromiumRuntimeZoomFactor(
          role.zoomFactor,
          input.windows.get(projected.windowId)!.windowZoomFactor ?? 1
        )
      );
      input.ports.surfaces.setBounds(role.roleId, role.generation, bounds);
      input.ports.surfaces.setVisible(
        role.roleId,
        role.generation,
        projected.active && !projected.hidden &&
          input.windows.get(projected.windowId)!.host.isVisible()
      );
    }
    for (const surface of input.webSurfaces.values()) {
      const projected = projectedTabs.get(surface.tabId);
      if (!projected) continue;
      const bounds = projected.bounds.get(surface.surfaceId);
      if (!bounds) {
        throw projectionError(
          "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_LAYOUT_MISSING",
          "The Windows runtime projection omitted an owned Web surface layout."
        );
      }
      if (surface.windowId !== projected.windowId) {
        if (!input.ports.webSurfaces.reparentSurface) {
          throw projectionError(
            "ELECTRON_CHROMIUM_WINDOWS_WEB_REPARENT_UNAVAILABLE",
            "The global Web surface registry cannot apply a cross-window move."
          );
        }
        await input.ports.webSurfaces.reparentSurface(
          surface.surfaceId,
          surface.generation,
          input.windows.get(projected.windowId)!.host
        );
        completed.push({
          kind: "web",
          id: surface.surfaceId,
          generation: surface.generation,
          sourceWindowId: surface.windowId
        });
      }
      input.ports.webSurfaces.setZoomFactor(
        surface.surfaceId,
        surface.generation,
        effectiveChromiumRuntimeZoomFactor(
          surface.zoomFactor,
          input.windows.get(projected.windowId)!.windowZoomFactor ?? 1
        )
      );
      input.ports.webSurfaces.setBounds(surface.surfaceId, surface.generation, bounds);
      input.ports.webSurfaces.setVisible(
        surface.surfaceId,
        surface.generation,
        projected.active && !projected.hidden &&
          input.windows.get(projected.windowId)!.host.isVisible()
      );
    }
  } catch (error) {
    return compensate(error);
  }

  try {
    for (const [windowId, projection] of projectionByWindow) {
      const host = input.windows.get(windowId)!.host;
      if (!host.applyWindowsChromeProjection) {
        throw projectionError(
          "ELECTRON_CHROMIUM_WINDOWS_CHROME_PROJECTION_UNAVAILABLE",
          "The Windows runtime host cannot apply its native toolbar projection."
        );
      }
      await host.applyWindowsChromeProjection({
        activeTabId: projection.activeTabId ?? null,
        contentBounds: Object.freeze({ ...host.getContentBounds() }),
        moveTargets: Object.freeze([...projectionByWindow.values()]
          .filter((target) => target.windowId !== windowId)
          .map((target) => {
            const targetRecord = input.windows.get(target.windowId)!;
            return Object.freeze({
              name: targetRecord.hostTarget.persistedName ?? "Game Window",
              windowGeneration: target.windowGeneration,
              windowId: target.windowId
            });
          })),
        tabs: projection.tabIds.map((tabId) => {
          const tab = input.tabs.get(tabId)!;
          return Object.freeze({
            active: projection.activeTabId === tabId,
            hidden: projection.hiddenTabIds.includes(tabId),
            name: tab.specification.name,
            phase: projectedTabs.get(tabId)!.phase,
            tabId
          });
        }),
        topologyRevision: projection.topologyRevision,
        windowGeneration: projection.windowGeneration,
        windowId,
        workspaceDividers: Object.freeze(projection.tabIds.flatMap((tabId) => {
          const projected = projectedTabs.get(tabId)!;
          const attemptGeneration = projected.specification.attemptGeneration;
          if (!projected.specification.workspaceId || !attemptGeneration) return [];
          return projected.dividers.map((divider) => Object.freeze({
            attemptGeneration,
            axis: divider.axis,
            bounds: Object.freeze({ ...divider.bounds }),
            dividerIndex: divider.index,
            tabId,
            visible: projected.active && !projected.hidden && host.isVisible()
          }));
        }))
      });
    }
  } catch {
    await input.quarantineWindows([...projectionByWindow.keys()]);
    throw projectionError(
      "ELECTRON_CHROMIUM_WINDOWS_CHROME_PROJECTION_FAILED",
      "The Windows runtime topology was quarantined after toolbar projection failed."
    );
  }

  for (const [tabId, projected] of projectedTabs) {
    const tab = input.tabs.get(tabId)!;
    tab.windowId = projected.windowId;
    tab.specification = projected.specification;
  }
  for (const role of input.roles.values()) {
    role.windowId = projectedTabs.get(role.tabId)?.windowId ?? role.windowId;
  }
  for (const surface of input.webSurfaces.values()) {
    surface.windowId = projectedTabs.get(surface.tabId)?.windowId ?? surface.windowId;
  }
  for (const [windowId, projection] of projectionByWindow) {
    const window = input.windows.get(windowId)!;
    window.tabIds.splice(0, window.tabIds.length, ...projection.tabIds);
    window.hiddenTabIds.clear();
    for (const tabId of projection.hiddenTabIds) window.hiddenTabIds.add(tabId);
    window.activeTabId = projection.activeTabId ?? "";
    window.windowGeneration = projection.windowGeneration;
    window.topologyRevision = projection.topologyRevision;
  }
  return Object.freeze([...projectionByWindow.keys()].sort());
}
