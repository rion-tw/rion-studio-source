import { projectWorkspaceSpecification } from "./chromiumRuntimeWorkspaceSpecification";
import { projectWorkspaceSlotLoads } from "./chromiumWorkspaceSlotLoading";
import {
  applyChromiumSurfaceProjection, captureChromiumSurfaceProjections,
  restoreChromiumSurfaceProjections, applyChromiumSurfaceReparent,
  restoreChromiumSurfaceReparents, type ChromiumSurfaceReparent
} from "./chromiumRuntimeSurfaceProjection";
import type {
  EmbeddedRuntimeWindowProjectionRecord
} from
  "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import { recordRuntimeTransition } from "./runtimeOperationJournal";
import type {
  ChromiumRuntimeEffectExecutorInput
} from "./chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
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
  /** Identity for journalling a refusal that quarantine would otherwise erase. */
  readonly effect?: Readonly<{ effectId: string; operationId: string }>;
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
    resizeIndicators?: import("../../shared/generated").WorkspaceResizeIndicatorRecord[];
    index: number;
  }>[];
  readonly specification: ChromiumRuntimeTabRecord["specification"];
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
    const specification = {
      ...projectWorkspaceSpecification(tab, workspaceProjection),
      // Layout and the committed tab must follow the same exact destination
      // host selected by Core's cross-window projection.
      target: input.windows.get(windowId)!.hostTarget
    };
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

  const roleSnapshots = captureChromiumSurfaceProjections(
    input.ports.surfaces,
    [...input.roles.values()].map((role) => [role.roleId, role.generation])
  );
  const webSnapshots = captureChromiumSurfaceProjections(
    input.ports.webSurfaces,
    [...input.webSurfaces.values()].map((surface) => [surface.surfaceId, surface.generation])
  );

  const completed: ChromiumSurfaceReparent[] = [];
  const compensate = async (primaryError: unknown): Promise<never> => {
    const failures: unknown[] = [];
    restoreChromiumSurfaceProjections(input.ports.surfaces, roleSnapshots, failures);
    restoreChromiumSurfaceProjections(input.ports.webSurfaces, webSnapshots, failures);
    await restoreChromiumSurfaceReparents(
      input.ports, input.windows, completed, failures, () => projectionError(
        "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_SOURCE_STALE",
        "A Windows topology rollback lost its exact source host."
      )
    );
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
        await applyChromiumSurfaceReparent(input.ports, {
          kind: "role",
          id: role.roleId,
          generation: role.generation,
          sourceWindowId: role.windowId
        }, input.windows.get(projected.windowId)!.host, completed);
      }
      applyChromiumSurfaceProjection(input.ports.surfaces, role.roleId, role.generation, {
        zoomFactor: effectiveChromiumRuntimeZoomFactor(
          role.zoomFactor,
          input.windows.get(projected.windowId)!.windowZoomFactor ?? 1
        ),
        bounds,
        visible: projected.active && !projected.hidden &&
          input.windows.get(projected.windowId)!.host.isVisible()
      });
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
        await applyChromiumSurfaceReparent(input.ports, {
          kind: "web",
          id: surface.surfaceId,
          generation: surface.generation,
          sourceWindowId: surface.windowId
        }, input.windows.get(projected.windowId)!.host, completed);
      }
      applyChromiumSurfaceProjection(input.ports.webSurfaces, surface.surfaceId, surface.generation, {
        zoomFactor: effectiveChromiumRuntimeZoomFactor(
          surface.zoomFactor,
          input.windows.get(projected.windowId)!.windowZoomFactor ?? 1
        ),
        bounds,
        visible: projected.active && !projected.hidden &&
          input.windows.get(projected.windowId)!.host.isVisible()
      });
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
      // The divider geometry below was resolved against the viewport this
      // transaction sampled. Re-reading the live window here would tear the
      // pair apart mid border drag and refuse geometry that was never stale.
      const contentBounds = projectedTabs.get(projection.activeTabId ?? "")?.contentBounds ??
        projection.tabIds.flatMap((tabId) => {
          const projected = projectedTabs.get(tabId);
          return projected ? [projected.contentBounds] : [];
        })[0] ?? host.getContentBounds();
      await host.applyWindowsChromeProjection({
        activeTabId: projection.activeTabId ?? null,
        contentBounds: Object.freeze({ ...contentBounds }),
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
            audioMuted: tab.audioMuted,
            hidden: projection.hiddenTabIds.includes(tabId),
            name: tab.specification.name,
            phase: projectedTabs.get(tabId)!.phase,
            tabId
          });
        }),
        topologyRevision: projection.topologyRevision,
        windowGeneration: projection.windowGeneration,
        windowId,
        workspaceBackground: projectedTabs.get(projection.activeTabId ?? "")?.specification.workspaceAppearance?.background ?? "material",
        workspaceDividers: Object.freeze(projection.tabIds.flatMap((tabId) => {
          const projected = projectedTabs.get(tabId)!;
          const attemptGeneration = projected.specification.attemptGeneration;
          if (!projected.specification.workspaceId || !attemptGeneration) return [];
          return projected.dividers.map((divider) => Object.freeze({
            attemptGeneration,
            axis: divider.axis,
            bounds: Object.freeze({ ...divider.bounds }),
            dividerIndex: divider.index,
            resizeIndicators: divider.resizeIndicators,
            tabId,
            visible: projected.active && !projected.hidden && host.isVisible()
          }));
        }))
      });
    }
  } catch (error) {
    // Quarantine retires the host, so the refusal that caused it is the only
    // evidence left of why. Journal its exact code before the host is gone.
    const cause = normalizeRionBridgeError(
      error,
      "ELECTRON_CHROMIUM_WINDOWS_CHROME_PROJECTION_FAILED"
    );
    if (input.effect) {
      recordRuntimeTransition({
        operationId: input.effect.operationId,
        effectId: input.effect.effectId,
        action: "windows-chrome-projection",
        targetKind: "window",
        targetId: [...projectionByWindow.keys()].sort().join(","),
        stage: "refused",
        errorCode: cause.code
      });
    }
    await input.quarantineWindows([...projectionByWindow.keys()]);
    throw projectionError(
      "ELECTRON_CHROMIUM_WINDOWS_CHROME_PROJECTION_FAILED",
      "The Windows runtime topology was quarantined after toolbar projection failed: " +
        `${cause.code}: ${cause.message}`
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
  for (const [tabId, projected] of projectedTabs) {
    const tab = input.tabs.get(tabId)!;
    projectWorkspaceSlotLoads(tab, input.windows.get(projected.windowId)!, projected.bounds);
  }
  return Object.freeze([...projectionByWindow.keys()].sort());
}
