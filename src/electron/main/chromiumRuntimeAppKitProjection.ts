import type {
  AppKitRuntimeProjectionEffectRecord,
  AppKitRuntimeWindowProjectionRecord,
  CoreEffectRequest,
  EmbeddedLaunchTargetRecord,
  EmbeddedRoleViewEffectRecord,
  EmbeddedTabEffectRecord,
  GlobalWebProfilePathsRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type {
  ChromiumRuntimeEffectExecutorInput,
  ChromiumRuntimeHostPort
} from "./chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeAppKitProjectionTransaction,
  ChromiumRuntimeSurfaceProjection
} from "./chromiumRuntimeProjectionTransaction";
import { effectiveChromiumRuntimeZoomFactor } from
  "./chromiumRuntimeWindowZoomController";

export interface ChromiumRuntimeWindowRecord {
  readonly host: ChromiumRuntimeHostPort;
  hostTarget: EmbeddedLaunchTargetRecord;
  readonly tabIds: string[];
  readonly hiddenTabIds: Set<string>;
  activeTabId: string;
  windowGeneration: number;
  topologyRevision: number;
  lastAdapterSequence: number;
  /** Electron mirror of the Rust Kernel window multiplier. */
  windowZoomFactor?: number;
}

export interface ChromiumRuntimeTabRecord {
  specification: EmbeddedTabEffectRecord;
  windowId: string;
  readonly roleViews: Map<string, EmbeddedRoleViewEffectRecord>;
  readonly webViews: Map<string, EmbeddedRoleViewEffectRecord>;
  audioMuted: boolean;
}

export interface ChromiumRuntimeRoleRecord {
  readonly generation: number;
  readonly ownerGeneration: number;
  readonly roleId: string;
  readonly tabId: string;
  windowId: string;
  zoomFactor: number;
}

export interface ChromiumRuntimeWebSurfaceRecord {
  readonly generation: number;
  readonly surfaceId: string;
  readonly slotId: string;
  readonly tabId: string;
  readonly url: string;
  readonly profile: GlobalWebProfilePathsRecord;
  windowId: string;
  zoomFactor: number;
}

export interface ApplyChromiumRuntimeAppKitProjectionInput {
  readonly effect: CoreEffectRequest;
  readonly projection: AppKitRuntimeProjectionEffectRecord;
  readonly ports: ChromiumRuntimeEffectExecutorInput;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly tabs: Map<string, ChromiumRuntimeTabRecord>;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
  readonly quarantineWindows: (windowIds: readonly string[]) => Promise<void>;
}

function runtimeError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function requireIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw runtimeError(
      "ELECTRON_CHROMIUM_RUNTIME_ID_INVALID",
      `Core supplied an invalid ${field} identity.`
    );
  }
  return value;
}

export async function applyChromiumRuntimeAppKitProjection(
  input: ApplyChromiumRuntimeAppKitProjectionInput
): Promise<Readonly<{ eventId: string; windowIds: readonly string[] }>> {
  const { effect, projection, ports, windows, tabs, roles, webSurfaces } = input;
  requireIdentifier(projection.eventId, "AppKit event");
  if (projection.windows.length < 1 || projection.windows.length > 2) {
    throw runtimeError(
      "ELECTRON_MACOS_APPKIT_PROJECTION_SCOPE_INVALID",
      "Core supplied an invalid AppKit projection window scope."
    );
  }
  const projectionsByWindow = new Map<
    string,
    AppKitRuntimeWindowProjectionRecord
  >();
  const projectedWindowByTab = new Map<string, string>();
  const projectedLayoutsByRole = new Map<string, {
    windowId: string;
    tabId: string;
    ownerGeneration: number;
    bounds: ChromiumRoleSurfaceBounds;
    visible: boolean;
  }>();
  const projectedLayoutsByWebSurface = new Map<string, {
    windowId: string;
    tabId: string;
    slotId: string;
    bounds: ChromiumRoleSurfaceBounds;
    visible: boolean;
  }>();
  for (const windowProjection of projection.windows) {
    const windowId = requireIdentifier(
      windowProjection.identity.logicalWindowId,
      "AppKit window"
    );
    if (projectionsByWindow.has(windowId)) {
      throw runtimeError(
        "ELECTRON_MACOS_APPKIT_PROJECTION_SCOPE_INVALID",
        "Core supplied a duplicate AppKit projection window."
      );
    }
    const window = windows.get(windowId);
    if (
      !window || window.host.isDestroyed() || !window.host.appKitIdentity ||
      !window.host.prepareAppKitProjection ||
      !window.host.prepareWorkspaceDividerProjection ||
      window.host.appKitIdentity.logicalWindowId !==
        windowProjection.identity.logicalWindowId ||
      window.host.appKitIdentity.launchGeneration !==
        windowProjection.identity.launchGeneration ||
      window.host.appKitIdentity.nativeGeneration !==
        windowProjection.identity.nativeGeneration ||
      windowProjection.windowGeneration !== window.windowGeneration ||
      windowProjection.topologyRevision < window.topologyRevision ||
      windowProjection.adapterSequence <= window.lastAdapterSequence
    ) {
      throw runtimeError(
        "ELECTRON_MACOS_APPKIT_PROJECTION_STALE",
        "Core supplied a stale AppKit host, window generation, topology revision, or adapter sequence."
      );
    }
    const logicalTabIds = windowProjection.logicalTabIds.map((tabId) =>
      requireIdentifier(tabId, "logical AppKit tab")
    );
    const logicalTabIdSet = new Set(logicalTabIds);
    const hiddenTabIds = windowProjection.hiddenTabIds.map((tabId) =>
      requireIdentifier(tabId, "hidden AppKit tab")
    );
    const hiddenTabIdSet = new Set(hiddenTabIds);
    if (
      logicalTabIdSet.size !== logicalTabIds.length ||
      hiddenTabIdSet.size !== hiddenTabIds.length ||
      hiddenTabIds.some((tabId) => !logicalTabIdSet.has(tabId)) ||
      logicalTabIds.some((tabId) => !tabs.has(tabId) || projectedWindowByTab.has(tabId))
    ) {
      throw runtimeError(
        "ELECTRON_MACOS_APPKIT_PROJECTION_TAB_INVALID",
        "Core supplied a duplicate, hidden, or unavailable logical AppKit tab projection."
      );
    }
    for (const tabId of logicalTabIds) projectedWindowByTab.set(tabId, windowId);
    const tabIds = new Set<string>();
    for (const tabProjection of windowProjection.tabs) {
      const tabId = requireIdentifier(tabProjection.tabId, "AppKit tab");
      if (tabIds.has(tabId) || !logicalTabIdSet.has(tabId) || hiddenTabIdSet.has(tabId)) {
        throw runtimeError(
          "ELECTRON_MACOS_APPKIT_PROJECTION_TAB_INVALID",
          "Core supplied a duplicate or unavailable AppKit tab projection."
        );
      }
      tabIds.add(tabId);
    }
    const visibleLogicalTabIds = logicalTabIds.filter(
      (tabId) => !hiddenTabIdSet.has(tabId)
    );
    if (
      JSON.stringify([...tabIds]) !== JSON.stringify(visibleLogicalTabIds) ||
      (windowProjection.activeTabId !== undefined &&
        !tabIds.has(windowProjection.activeTabId)) ||
      (windowProjection.activeTabId === undefined && tabIds.size > 0)
    ) {
      throw runtimeError(
        "ELECTRON_MACOS_APPKIT_PROJECTION_ACTIVE_INVALID",
        "Core supplied an active AppKit tab outside the exact projected order."
      );
    }
    for (const roleLayout of windowProjection.roles) {
      const roleId = requireIdentifier(roleLayout.roleId, "AppKit role");
      const role = roles.get(roleId);
      if (
        projectedLayoutsByRole.has(roleId) || !role ||
        role.tabId !== roleLayout.tabId ||
        role.ownerGeneration !== roleLayout.ownerGeneration ||
        projectedWindowByTab.get(role.tabId) !== windowId
      ) {
        throw runtimeError(
          "ELECTRON_MACOS_APPKIT_LAYOUT_OWNER_STALE",
          "Core supplied a stale AppKit role owner or layout generation."
        );
      }
      if (role.windowId !== windowId && !ports.surfaces.reparentRole) {
        throw runtimeError(
          "ELECTRON_MACOS_APPKIT_REPARENT_UNAVAILABLE",
          "The Chromium surface registry cannot consume an AppKit cross-window move."
        );
      }
      projectedLayoutsByRole.set(roleId, {
        windowId,
        tabId: roleLayout.tabId,
        ownerGeneration: roleLayout.ownerGeneration,
        bounds: roleLayout.bounds,
        visible: windowProjection.windowVisible &&
          windowProjection.activeTabId === roleLayout.tabId
      });
    }
    for (const webLayout of windowProjection.webSurfaces) {
      const surfaceId = requireIdentifier(webLayout.surfaceId, "AppKit Web surface");
      const slotId = requireIdentifier(webLayout.slotId, "AppKit Web slot");
      const surface = webSurfaces.get(surfaceId);
      const tab = tabs.get(webLayout.tabId);
      if (
        projectedLayoutsByWebSurface.has(surfaceId) || !surface || !tab ||
        surface.tabId !== webLayout.tabId || surface.slotId !== slotId ||
        tab.specification.attemptGeneration !== webLayout.attemptGeneration ||
        projectedWindowByTab.get(surface.tabId) !== windowId ||
        (webLayout.visible && (
          !windowProjection.windowVisible ||
          windowProjection.activeTabId !== webLayout.tabId
        ))
      ) {
        throw runtimeError(
          "ELECTRON_MACOS_APPKIT_WEB_LAYOUT_OWNER_STALE",
          "Core supplied a stale global Web surface, slot, tab, or launch fence."
        );
      }
      if (surface.windowId !== windowId && !ports.webSurfaces.reparentSurface) {
        throw runtimeError(
          "ELECTRON_MACOS_APPKIT_WEB_REPARENT_UNAVAILABLE",
          "The global Web surface registry cannot consume an AppKit cross-window move."
        );
      }
      projectedLayoutsByWebSurface.set(surfaceId, {
        windowId,
        tabId: webLayout.tabId,
        slotId,
        bounds: webLayout.bounds,
        visible: webLayout.visible && windowProjection.windowVisible
      });
    }
    const dividerKeys = new Set<string>();
    for (const divider of windowProjection.workspaceDividers) {
      const tabId = requireIdentifier(divider.tabId, "AppKit divider tab");
      const attemptGeneration = requireIdentifier(
        divider.attemptGeneration,
        "AppKit divider attempt generation"
      );
      const tab = tabs.get(tabId);
      const key = `${tabId.length}:${tabId}:${divider.dividerIndex}`;
      if (
        !tab || projectedWindowByTab.get(tabId) !== windowId ||
        windowProjection.activeTabId !== tabId ||
        tab.specification.attemptGeneration !== attemptGeneration ||
        !Number.isSafeInteger(divider.dividerIndex) ||
        divider.dividerIndex < 0 ||
        (divider.axis !== "horizontal" && divider.axis !== "vertical") ||
        divider.visible !== windowProjection.windowVisible ||
        divider.bounds.width < 1 || divider.bounds.height < 1 ||
        dividerKeys.has(key)
      ) {
        throw runtimeError(
          "ELECTRON_MACOS_APPKIT_DIVIDER_OWNER_STALE",
          "Core supplied a stale workspace-divider tab, attempt, axis, or geometry fence."
        );
      }
      dividerKeys.add(key);
    }
    projectionsByWindow.set(windowId, windowProjection);
  }
  if (!projectionsByWindow.has(effect.target.handleId)) {
    throw runtimeError(
      "ELECTRON_MACOS_APPKIT_PROJECTION_TARGET_MISMATCH",
      "The Core effect target is outside its AppKit projection scope."
    );
  }

  const touchedWindowIds = new Set(projectionsByWindow.keys());
  const hostTransactions = new Map<
    string,
    ChromiumRuntimeAppKitProjectionTransaction
  >();
  const dividerTransactions = new Map<
    string,
    ChromiumRuntimeAppKitProjectionTransaction
  >();
  for (const [windowId, windowProjection] of projectionsByWindow) {
    const window = windows.get(windowId)!;
    hostTransactions.set(
      windowId,
      window.host.prepareAppKitProjection!(windowProjection)
    );
    dividerTransactions.set(
      windowId,
      window.host.prepareWorkspaceDividerProjection!(windowProjection)
    );
  }

  const roleSurfaceSnapshots = new Map<string, ChromiumRuntimeSurfaceProjection>();
  for (const role of roles.values()) {
    if (
      touchedWindowIds.has(role.windowId) ||
      projectedLayoutsByRole.has(role.roleId)
    ) {
      roleSurfaceSnapshots.set(
        role.roleId,
        ports.surfaces.readProjection(role.roleId, role.generation)
      );
    }
  }
  const webSurfaceSnapshots = new Map<string, ChromiumRuntimeSurfaceProjection>();
  for (const surface of webSurfaces.values()) {
    if (
      touchedWindowIds.has(surface.windowId) ||
      projectedLayoutsByWebSurface.has(surface.surfaceId)
    ) {
      webSurfaceSnapshots.set(
        surface.surfaceId,
        ports.webSurfaces.readProjection(surface.surfaceId, surface.generation)
      );
    }
  }

  const completedReparents: Array<Readonly<{
    kind: "role" | "web";
    id: string;
    generation: number;
    sourceWindowId: string;
  }>> = [];
  const committedHosts: Array<Readonly<{
    windowId: string;
    transaction: ChromiumRuntimeAppKitProjectionTransaction;
  }>> = [];
  const committedDividers: Array<Readonly<{
    windowId: string;
    transaction: ChromiumRuntimeAppKitProjectionTransaction;
  }>> = [];
  let surfaceProjectionStarted = false;

  const compensate = async (
    primaryError: unknown,
    quarantineForUnverifiedHostMutation: boolean
  ): Promise<never> => {
    const compensationFailures: unknown[] = [];
    if (surfaceProjectionStarted) {
      for (const [roleId, snapshot] of roleSurfaceSnapshots) {
        const role = roles.get(roleId)!;
        try {
          if (snapshot.zoomFactor !== undefined) {
            ports.surfaces.setZoomFactor(
              roleId,
              role.generation,
              snapshot.zoomFactor
            );
          }
          ports.surfaces.setBounds(roleId, role.generation, snapshot.bounds);
        } catch (error) {
          compensationFailures.push(error);
        }
        try {
          ports.surfaces.setVisible(roleId, role.generation, snapshot.visible);
        } catch (error) {
          compensationFailures.push(error);
        }
      }
      for (const [surfaceId, snapshot] of webSurfaceSnapshots) {
        const surface = webSurfaces.get(surfaceId)!;
        try {
          if (snapshot.zoomFactor !== undefined) {
            ports.webSurfaces.setZoomFactor(
              surfaceId,
              surface.generation,
              snapshot.zoomFactor
            );
          }
          ports.webSurfaces.setBounds(
            surfaceId,
            surface.generation,
            snapshot.bounds
          );
        } catch (error) {
          compensationFailures.push(error);
        }
        try {
          ports.webSurfaces.setVisible(
            surfaceId,
            surface.generation,
            snapshot.visible
          );
        } catch (error) {
          compensationFailures.push(error);
        }
      }
    }
    for (const completed of [...completedReparents].reverse()) {
      const source = windows.get(completed.sourceWindowId);
      if (!source || source.host.isDestroyed()) {
        compensationFailures.push(runtimeError(
          "ELECTRON_MACOS_APPKIT_PROJECTION_REPARENT_SOURCE_STALE",
          "An AppKit projection rollback lost its exact source host."
        ));
        continue;
      }
      try {
        if (completed.kind === "role") {
          await ports.surfaces.reparentRole!(
            completed.id,
            completed.generation,
            source.host
          );
        } else {
          await ports.webSurfaces.reparentSurface!(
            completed.id,
            completed.generation,
            source.host
          );
        }
      } catch (error) {
        compensationFailures.push(error);
      }
    }
    for (const completed of [...committedDividers].reverse()) {
      try {
        completed.transaction.rollback();
      } catch (error) {
        compensationFailures.push(error);
      }
    }
    for (const completed of [...committedHosts].reverse()) {
      try {
        completed.transaction.rollback();
      } catch (error) {
        compensationFailures.push(error);
      }
    }
    if (quarantineForUnverifiedHostMutation || compensationFailures.length > 0) {
      try {
        await input.quarantineWindows([...projectionsByWindow.keys()]);
      } catch (error) {
        compensationFailures.push(error);
      }
    }
    if (compensationFailures.length > 0) {
      throw runtimeError(
        "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED",
        "The AppKit projection was quarantined after exact rollback or teardown failed."
      );
    }
    if (quarantineForUnverifiedHostMutation) {
      throw runtimeError(
        "MACOS_APPKIT_CHROMIUM_PROJECTION_HOST_QUARANTINED",
        "The AppKit projection failed and every affected native host was closed exactly."
      );
    }
    throw primaryError;
  };

  try {
    for (const [roleId, layout] of projectedLayoutsByRole) {
      const role = roles.get(roleId)!;
      if (role.windowId === layout.windowId) continue;
      const target = windows.get(layout.windowId)!;
      await ports.surfaces.reparentRole!(roleId, role.generation, target.host);
      completedReparents.push({
        kind: "role",
        id: roleId,
        generation: role.generation,
        sourceWindowId: role.windowId
      });
    }
    for (const [surfaceId, layout] of projectedLayoutsByWebSurface) {
      const surface = webSurfaces.get(surfaceId)!;
      if (surface.windowId === layout.windowId) continue;
      const target = windows.get(layout.windowId)!;
      await ports.webSurfaces.reparentSurface!(
        surfaceId,
        surface.generation,
        target.host
      );
      completedReparents.push({
        kind: "web",
        id: surfaceId,
        generation: surface.generation,
        sourceWindowId: surface.windowId
      });
    }
  } catch (error) {
    return compensate(error, false);
  }

  try {
    for (const [windowId, transaction] of hostTransactions) {
      transaction.commit();
      committedHosts.push({ windowId, transaction });
    }
  } catch (error) {
    return compensate(
      error,
      [...hostTransactions.values()].some(
        (transaction) => transaction.requiresQuarantine()
      )
    );
  }

  try {
    surfaceProjectionStarted = true;
    for (const [roleId, layout] of projectedLayoutsByRole) {
      const role = roles.get(roleId)!;
      const current = roleSurfaceSnapshots.get(roleId)!;
      const zoomFactor = effectiveChromiumRuntimeZoomFactor(
        role.zoomFactor,
        windows.get(layout.windowId)!.windowZoomFactor ?? 1
      );
      if (current.zoomFactor !== zoomFactor) {
        ports.surfaces.setZoomFactor(roleId, role.generation, zoomFactor);
      }
      if (!sameBounds(current.bounds, layout.bounds)) {
        ports.surfaces.setBounds(roleId, role.generation, layout.bounds);
      }
      if (current.visible !== layout.visible) {
        ports.surfaces.setVisible(roleId, role.generation, layout.visible);
      }
    }
    for (const [surfaceId, layout] of projectedLayoutsByWebSurface) {
      const surface = webSurfaces.get(surfaceId)!;
      const current = webSurfaceSnapshots.get(surfaceId)!;
      const zoomFactor = effectiveChromiumRuntimeZoomFactor(
        surface.zoomFactor,
        windows.get(layout.windowId)!.windowZoomFactor ?? 1
      );
      if (current.zoomFactor !== zoomFactor) {
        ports.webSurfaces.setZoomFactor(surfaceId, surface.generation, zoomFactor);
      }
      if (!sameBounds(current.bounds, layout.bounds)) {
        ports.webSurfaces.setBounds(surfaceId, surface.generation, layout.bounds);
      }
      if (current.visible !== layout.visible) {
        ports.webSurfaces.setVisible(surfaceId, surface.generation, layout.visible);
      }
    }
    for (const role of roles.values()) {
      if (
        touchedWindowIds.has(role.windowId) &&
        !projectedLayoutsByRole.has(role.roleId) &&
        roleSurfaceSnapshots.get(role.roleId)?.visible === true
      ) {
        ports.surfaces.setVisible(role.roleId, role.generation, false);
      }
    }
    for (const surface of webSurfaces.values()) {
      if (
        touchedWindowIds.has(surface.windowId) &&
        !projectedLayoutsByWebSurface.has(surface.surfaceId) &&
        webSurfaceSnapshots.get(surface.surfaceId)?.visible === true
      ) {
        ports.webSurfaces.setVisible(surface.surfaceId, surface.generation, false);
      }
    }
  } catch (error) {
    return compensate(error, false);
  }

  try {
    for (const [windowId, transaction] of dividerTransactions) {
      transaction.commit();
      committedDividers.push({ windowId, transaction });
    }
  } catch (error) {
    return compensate(
      error,
      [...dividerTransactions.values()].some(
        (transaction) => transaction.requiresQuarantine()
      )
    );
  }

  for (const [tabId, windowId] of projectedWindowByTab) {
    tabs.get(tabId)!.windowId = windowId;
  }
  for (const [roleId, layout] of projectedLayoutsByRole) {
    roles.get(roleId)!.windowId = layout.windowId;
  }
  for (const [surfaceId, layout] of projectedLayoutsByWebSurface) {
    webSurfaces.get(surfaceId)!.windowId = layout.windowId;
  }
  for (const [windowId, windowProjection] of projectionsByWindow) {
    const window = windows.get(windowId)!;
    window.tabIds.splice(
      0,
      window.tabIds.length,
      ...windowProjection.logicalTabIds
    );
    window.hiddenTabIds.clear();
    for (const tabId of windowProjection.hiddenTabIds) window.hiddenTabIds.add(tabId);
    window.activeTabId = windowProjection.activeTabId ?? "";
    window.topologyRevision = windowProjection.topologyRevision;
    window.lastAdapterSequence = windowProjection.adapterSequence;
  }
  for (const { transaction } of committedHosts) transaction.finalize?.();
  return Object.freeze({
    eventId: projection.eventId,
    windowIds: Object.freeze([...projectionsByWindow.keys()].sort())
  });
}
