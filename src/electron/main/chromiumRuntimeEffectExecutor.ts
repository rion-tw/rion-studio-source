import type {
  AppKitRuntimeProjectionEffectRecord,
  BrowserRuntimeRoleRecord,
  CoreEffectRequest,
  EmbeddedRoleSlotEffectRecord,
  EmbeddedRoleViewEffectRecord,
  EmbeddedTabEffectRecord,
  EmbeddedWebSurfaceLoadEffectRecord,
  MacroCoordinateContextRecord,
  RolePathsRecord,
  WindowsRuntimeWindowPlacementEventRecord,
  WindowsRuntimeWindowPlacementReceiptRecord
} from "../../shared/generated";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
export type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";
export type {
  ChromiumRuntimeEmptyHostIdentity,
  ChromiumRuntimeHostFactoryPort,
  ChromiumRuntimeHostPort,
  ChromiumRuntimeHostProjection,
  WindowsRuntimeWindowPlacementObservation
} from "./chromiumRuntimeHostPorts";
import type { ChromiumRoleOverlayFrameIdentity } from
  "./chromiumRoleSurfaceRegistry";
import {
  applyChromiumRuntimeAppKitProjection,
  type ChromiumRuntimeRoleRecord as RuntimeRoleRecord,
  type ChromiumRuntimeTabRecord as RuntimeTabRecord,
  type ChromiumRuntimeWebSurfaceRecord as RuntimeWebSurfaceRecord,
  type ChromiumRuntimeWindowRecord as RuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import { quarantineChromiumRuntimeWindows } from
  "./chromiumRuntimeWindowQuarantine";
import { followChromiumRuntimeOwnership } from
  "./chromiumRuntimeOwnershipFollower";
import { ChromiumRuntimeOwnershipTransitionCoordinator } from
  "./chromiumRuntimeOwnershipTransitionCoordinator";
import { drainEmptyChromiumRuntimeHosts } from "./chromiumRuntimeHostDrain";
import type { CoreEffectExecutionContext } from "./coreEffectContinuation";
import {
  applyChromiumRuntimeWindowSurfaceVisibility,
  applyChromiumRuntimeWindowVisibilityEffect
} from "./chromiumRuntimeWindowVisibility";
import {
  provisionChromiumRuntimeWindowForTabMove,
  retireChromiumRuntimeProvisionedWindow
} from "./chromiumRuntimeWindowProvision";
import {
  applyChromiumRuntimeWindowPresentationEffect,
  bindChromiumRuntimeWindowLayout,
  inspectChromiumRuntimeFullscreenToolbar,
  type ChromiumRuntimeFullscreenToolbarInspection
} from "./chromiumRuntimeFullscreenToolbar";
import type { ChromiumRuntimeEffectExecutorInput } from
  "./chromiumRuntimeEffectPorts";
import {
  projectChromiumRuntimeRolePlaceholderSlots,
  reconcileChromiumRuntimeRolePlaceholders
} from "./chromiumRuntimeRolePlaceholderProjection";
import {
  expectedEngineIsChromium,
  requireAppTarget,
  requireIdentifier,
  runtimeError,
  sameNormalizedRect,
  sortedSnapshot,
  targetMatchesCurrentHost
} from "./chromiumRuntimeEffectExecutorSupport";
import { commitChromiumRuntimeWindowsPlacementTarget } from
  "./chromiumRuntimePlacementTarget";
import {
  applyChromiumRuntimeWindowZoomEffect,
  effectiveChromiumRuntimeZoomFactor
} from "./chromiumRuntimeWindowZoomController";
import { executeChromiumRuntimeBrowserAction } from
  "./chromiumRuntimeBrowserActionExecutor";
import { executeChromiumRuntimeOverlayShellEffect } from
  "./chromiumRuntimeOverlayShellEffect";
import {
  executeChromiumRuntimeGlobalWebBrowserDataClear,
  executeChromiumRuntimeRoleBrowserDataClear
} from "./chromiumRuntimeBrowserDataEffectExecutor";
export type {
  ChromiumRuntimeBrowserDataClearPort,
  ChromiumRuntimeChromeProfileImportPort,
  ChromiumRuntimeEffectExecutorInput,
  ChromiumRuntimeGlobalWebBrowserDataClearPort,
  ChromiumRuntimeGlobalWebSurfacePort,
  ChromiumRuntimeLayoutPort,
  ChromiumRuntimeOverlayPort,
  ChromiumRuntimeResolvedWorkspaceLayout,
  ChromiumRuntimeRolePathsPort,
  ChromiumRuntimeRolePlaceholderPort,
  ChromiumRuntimeShellEffectsPort,
  ChromiumRuntimeSurfacePort,
  ChromiumRuntimeTrustedInputPort
} from "./chromiumRuntimeEffectPorts";

type ExecutorState = "open" | "draining" | "disposed";

/**
 * Applies Rust-issued Chromium runtime effects to Electron-owned native handles.
 *
 * The executor owns only non-serializable window/view generations. Logical
 * topology remains in Core and arrives through effect records. Every native
 * close is awaited from the exact Electron destruction event by the injected
 * host/surface ports.
 */
export class ChromiumRuntimeEffectExecutor {
  readonly #input: ChromiumRuntimeEffectExecutorInput;
  readonly #windows = new Map<string, RuntimeWindowRecord>();
  readonly #tabs = new Map<string, RuntimeTabRecord>();
  readonly #roles = new Map<string, RuntimeRoleRecord>();
  readonly #webSurfaces = new Map<string, RuntimeWebSurfaceRecord>();
  readonly #rolePaths = new Map<string, RolePathsRecord>();
  readonly #lastGenerationByRole = new Map<string, number>();
  readonly #lastGenerationByWebSurface = new Map<string, number>();
  readonly #ownershipTransitions: ChromiumRuntimeOwnershipTransitionCoordinator;
  #state: ExecutorState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(input: ChromiumRuntimeEffectExecutorInput) {
    this.#input = input;
    this.#ownershipTransitions = new ChromiumRuntimeOwnershipTransitionCoordinator({
      lifecycleEpoch: input.lifecycleEpoch,
      onError: input.onError
    });
    if (input.preloadPath.trim().length === 0) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_PRELOAD_INVALID",
        "A dedicated sandboxed role preload is required."
      );
    }
  }

  snapshot(): ChromiumRuntimeExecutorSnapshot {
    return Object.freeze({
      windows: Object.freeze(sortedSnapshot([...this.#windows.entries()].map(
        ([windowId, record]) => {
          const projection = record.host.readProjection();
          return Object.freeze({
            windowId,
            activeTabId: record.activeTabId,
            tabIds: Object.freeze([...record.tabIds]),
            displayId: projection.displayId,
            bounds: Object.freeze({ ...projection.bounds }),
            visible: projection.visible,
            focused: projection.focused,
            presentation: projection.presentation,
            windowGeneration: record.windowGeneration,
            topologyRevision: record.topologyRevision,
            windowZoomFactor: record.windowZoomFactor ?? 1,
            parentNativeHostId: record.host.id,
            ...(record.host.appKitIdentity
              ? { appKitIdentity: Object.freeze({ ...record.host.appKitIdentity }) }
              : {}),
            target: Object.freeze({
              ...record.hostTarget,
              displayId: projection.displayId,
              bounds: Object.freeze({ ...projection.bounds }),
              presentation: projection.presentation
            })
          });
        }
      ))),
      tabs: Object.freeze([...this.#tabs.entries()]
        .map(([tabId, record]) => Object.freeze({
          tabId,
          windowId: record.windowId,
          audioMuted: record.audioMuted,
          audible: [...this.#roles.values()]
            .filter((role) => role.tabId === tabId)
            .some((role) => this.#input.surfaces.isCurrentlyAudible(
              role.roleId, role.generation)) || [...this.#webSurfaces.values()]
            .filter((surface) => surface.tabId === tabId)
            .some((surface) => this.#input.webSurfaces.isCurrentlyAudible(
              surface.surfaceId, surface.generation)),
          attemptGeneration: requireIdentifier(
            record.specification.attemptGeneration ?? "",
            "tab attempt generation")
        }))
        .sort((left, right) => left.tabId.localeCompare(right.tabId))),
      roles: Object.freeze(sortedSnapshot([...this.#roles.values()].map((record) =>
        Object.freeze({
          roleId: record.roleId,
          tabId: record.tabId,
          windowId: record.windowId,
          generation: record.generation,
          ownerGeneration: record.ownerGeneration,
          zoomFactor: record.zoomFactor
        })
      ))),
      webSurfaces: Object.freeze(sortedSnapshot(
        [...this.#webSurfaces.values()].map((record) => Object.freeze({
          surfaceId: record.surfaceId,
          slotId: record.slotId,
          tabId: record.tabId,
          windowId: record.windowId,
          generation: record.generation,
          zoomFactor: record.zoomFactor
        }))
      ))
    });
  }

  desktopE2eStatusPresentation(windowId: string): number | undefined {
    return this.#windows.get(windowId)?.host.desktopE2eStatusPresentation?.(); }
  async commitTerminalRoleOwnership(
    projectedRoles: readonly BrowserRuntimeRoleRecord[]
  ): Promise<void> {
    if (this.#state !== "open") {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime is draining and rejects ownership projections."
      );
    }
    for (const projected of projectedRoles) {
      const native = this.#roles.get(projected.roleId);
      if (native && (
        native.tabId !== projected.owner.tabId ||
        native.ownerGeneration !== projected.owner.generation
      )) {
        throw runtimeError(
          "ELECTRON_CHROMIUM_ROLE_OWNERSHIP_DIVERGED",
          "The terminal Core owner does not match its exact Chromium surface."
        );
      }
    }
    projectChromiumRuntimeRolePlaceholderSlots(this.#tabs, projectedRoles);
    await this.#reconcileRolePlaceholders();
  }

  overlayCoordinateContext(
    identity: ChromiumRoleOverlayFrameIdentity
  ): MacroCoordinateContextRecord {
    const role = this.#roleForOverlay(identity);
    const window = this.#windows.get(role.windowId)!;
    return Object.freeze({
      appliedPageZoom: effectiveChromiumRuntimeZoomFactor(
        role.zoomFactor,
        window.windowZoomFactor ?? 1
      ),
      surfaceGeneration: role.generation,
      topologyRevision: window.topologyRevision
    });
  }

  overlayManagedShortcutIdentity(
    identity: ChromiumRoleOverlayFrameIdentity,
    phase: "replay" | "keyDown" | "keyUp"
  ): Readonly<{
    roleId: string;
    tabId: string;
    surfaceGeneration: number;
    documentInstanceId: string;
    ownerGeneration: number;
  }> {
    const role = this.#roleForOverlay(identity);
    const window = this.#windows.get(role.windowId)!;
    if (
      phase !== "keyUp" &&
      (window.activeTabId !== role.tabId || !window.host.isVisible())
    ) {
      throw runtimeError(
        "ELECTRON_MANAGED_SHORTCUT_SURFACE_INACTIVE",
        "Managed shortcuts require the visible role in the active native tab."
      );
    }
    return Object.freeze({
      roleId: role.roleId,
      tabId: role.tabId,
      surfaceGeneration: role.generation,
      documentInstanceId: identity.documentInstanceId,
      ownerGeneration: role.ownerGeneration
    });
  }

  overlayHeldKeyContinuityIdentity(
    identity: ChromiumRoleOverlayFrameIdentity
  ): Readonly<{
    roleId: string;
    tabId: string;
    surfaceGeneration: number;
    documentInstanceId: string;
    ownerGeneration: number;
  }> {
    const role = this.#roleForOverlay(identity);
    return Object.freeze({
      roleId: role.roleId,
      tabId: role.tabId,
      surfaceGeneration: role.generation,
      documentInstanceId: identity.documentInstanceId,
      ownerGeneration: role.ownerGeneration
    });
  }

  inspectFullscreenToolbar(
    windowId: string
  ): ChromiumRuntimeFullscreenToolbarInspection {
    return inspectChromiumRuntimeFullscreenToolbar({
      ports: this.#input,
      roles: this.#roles,
      webSurfaces: this.#webSurfaces,
      windows: this.#windows,
      windowId
    });
  }

  commitWindowsRuntimePlacementTarget(
    event: WindowsRuntimeWindowPlacementEventRecord,
    receipt: WindowsRuntimeWindowPlacementReceiptRecord
  ): void {
    commitChromiumRuntimeWindowsPlacementTarget({
      event,
      receipt,
      windows: this.#windows
    });
  }
  advanceLifecycle(lifecycleEpoch: number): void {
    this.#ownershipTransitions.advanceLifecycle(lifecycleEpoch);
  }
  observeExternalForeground(lifecycleEpoch: number): void {
    this.#ownershipTransitions.observeExternalForeground(lifecycleEpoch);
  }
  overlayActivate(identity: ChromiumRoleOverlayFrameIdentity): void {
    const role = this.#roleForOverlay(identity);
    const window = this.#windows.get(role.windowId)!;
    if (
      window.activeTabId !== role.tabId ||
      !window.host.isVisible() ||
      window.host.isDestroyed()
    ) {
      throw runtimeError(
        "ELECTRON_ROLE_OVERLAY_ACTIVATION_UNAUTHORIZED",
        "Only a visible role in the active native tab may request activation."
      );
    }
    window.host.focus();
  }

  async execute(effect: CoreEffectRequest, context?: CoreEffectExecutionContext):
  Promise<unknown> {
    if (this.#state !== "open") {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime is draining and rejects new effects."
      );
    }
    const action = effect.action;
    if (action.type === "browserAction") {
      return executeChromiumRuntimeBrowserAction({
        effect,
        request: action.request,
        roles: this.#roles,
        ...(this.#input.trustedInput
          ? { trustedInput: this.#input.trustedInput }
          : {})
      });
    }
    requireAppTarget(effect);
    return this.#executeApplicationEffect(effect, context);
  }

  async #executeApplicationEffect(
    effect: CoreEffectRequest,
    context?: CoreEffectExecutionContext
  ): Promise<unknown> {
    const action = effect.action;
    switch (action.type) {
      case "globalWebProfileClear":
        return executeChromiumRuntimeGlobalWebBrowserDataClear(
          this.#input,
          this.#webSurfaces.size > 0,
          effect,
          action.profile
        );
      case "roleBrowserDataClearSession":
        return executeChromiumRuntimeRoleBrowserDataClear(
          this.#input,
          this.#roles.has(action.roleId),
          effect,
          action,
          context?.signal
        );
      case "chromeProfileImportSnapshot":
      case "chromeProfileImportApply":
      case "chromeProfileImportVerify":
      case "chromeProfileImportRollback":
      case "chromeProfileImportCommit":
        return this.#input.chromeProfileImport.execute(effect, context?.signal);
      case "embeddedCreateTab":
        return this.#createTab(effect, action.tab);
      case "embeddedConfigureRoleSessions":
        return this.#configureRoleSessions(action.roleIds);
      case "embeddedLoadRoles":
        return this.#loadRoles(
          effect.target.handleId,
          action.roles,
          context?.signal
        );
      case "embeddedLoadWebSurfaces":
        return this.#loadWebSurfaces(effect, action, context?.signal);
      case "embeddedFocusRole":
        return this.#focusRole(action.roleId, action.zoomFactor ?? undefined);
      case "embeddedSetTabAudioMuted":
        return this.#setTabAudioMuted(effect, action);
      case "embeddedDestroyRole":
        return this.#destroyRole(action.roleId);
      case "embeddedClaimRoleSlot":
        return this.#claimRoleSlot(action.tabId, action.slot, action.role);
      case "embeddedDestroyTab":
        return this.#destroyTab(action.tabId, action.nextActiveTabId ?? undefined);
      case "embeddedFollowRoleOwnership":
        return this.#followRoleOwnership(effect, action, context?.signal);
      case "embeddedApplyAppKitProjection":
        return this.#applyAppKitProjection(effect, action.projection);
      case "embeddedProvisionWindowForTabMove":
        return provisionChromiumRuntimeWindowForTabMove({
          ports: this.#input,
          windows: this.#windows,
          tabs: this.#tabs
        }, effect, action);
      case "embeddedRetireProvisionedWindow":
        return retireChromiumRuntimeProvisionedWindow({
          ports: this.#input,
          windows: this.#windows,
          tabs: this.#tabs
        }, effect, action);
      case "embeddedSetRuntimeWindowVisibility":
        return this.#setRuntimeWindowVisibility(effect, action);
      case "embeddedSetRuntimeWindowPresentation":
        return applyChromiumRuntimeWindowPresentationEffect({
          effect,
          action,
          windows: this.#windows
        });
      case "embeddedSetRuntimeWindowZoom":
        return applyChromiumRuntimeWindowZoomEffect({
          effect,
          action,
          ports: this.#input,
          windows: this.#windows,
          roles: this.#roles,
          webSurfaces: this.#webSurfaces
        });
      case "embeddedPrepareTabRoleReload":
        return this.#input.roleReload?.prepare(effect, action) ??
          Promise.reject(runtimeError("ELECTRON_ROLE_RELOAD_NOT_READY",
            "The Chromium role reload coordinator is unavailable."));
      case "embeddedCommitTabRoleReload":
        return this.#input.roleReload?.commit(effect, action) ??
          Promise.reject(runtimeError("ELECTRON_ROLE_RELOAD_NOT_READY",
            "The Chromium role reload coordinator is unavailable."));
      case "embeddedSupersedeTabRoleReload":
        return this.#input.roleReload?.supersede(effect, action) ??
          Promise.reject(runtimeError("ELECTRON_ROLE_RELOAD_NOT_READY",
            "The Chromium role reload coordinator is unavailable."));
      case "embeddedInstallOverlays":
        return this.#installOverlays(effect.target.handleId, action.roleIds);
      case "overlayOpenMacroPage":
      case "overlayCopyCoordinate":
        return executeChromiumRuntimeOverlayShellEffect({
          effect,
          action,
          roles: this.#roles,
          windows: this.#windows,
          shellEffects: this.#input.shellEffects
        });
      default:
        throw runtimeError("ELECTRON_CHROMIUM_EFFECT_UNSUPPORTED",
          "The Chromium runtime does not implement this Core effect.");
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    this.#state = "draining";
    this.#ownershipTransitions.close("actorStop");
    const tabIds = [...this.#tabs.keys()];
    this.#disposePromise = Promise.allSettled(
      tabIds.map((tabId) => this.#destroyTab(tabId))
    ).then(async (results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) throw failure.reason;
      await drainEmptyChromiumRuntimeHosts(this.#windows);
      await this.#input.surfaces.dispose();
      await this.#input.webSurfaces.dispose();
      await this.#input.rolePlaceholders?.dispose();
      await this.#input.trustedInput?.dispose();
      this.#state = "disposed";
    }).catch((error: unknown) => {
      this.#disposePromise = null;
      throw error;
    });
    return this.#disposePromise;
  }

  async #createTab(
    effect: CoreEffectRequest,
    tab: EmbeddedTabEffectRecord
  ): Promise<void> {
    requireIdentifier(tab.tabId, "tab");
    requireIdentifier(tab.target.windowId, "window");
    if (effect.target.handleId !== tab.tabId) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_TARGET_MISMATCH",
        "The Core effect target does not match the tab being created."
      );
    }
    const existingTab = this.#tabs.get(tab.tabId);
    if (existingTab) {
      if (
        existingTab.windowId === tab.target.windowId &&
        existingTab.specification.attemptGeneration === tab.attemptGeneration
      ) {
        return;
      }
      throw runtimeError(
        "ELECTRON_CHROMIUM_TAB_OWNERSHIP_CONFLICT",
        "The logical tab is already bound to another launch attempt."
      );
    }

    let windowRecord = this.#windows.get(tab.target.windowId);
    const hostAlreadyOwnedWindow = windowRecord !== undefined;
    if (windowRecord) {
      if (!targetMatchesCurrentHost(tab.target, windowRecord.host)) {
        throw runtimeError(
          "ELECTRON_CHROMIUM_WINDOW_TARGET_CONFLICT",
          "The logical runtime window no longer matches the exact current native target."
        );
      }
      // Geometry and presentation are mutable native state. Retain the newest
      // Core-admitted target only after exact host readback; the window identity
      // and generation remain fenced separately.
      windowRecord.hostTarget = tab.target;
    } else {
      const host = await this.#input.hosts.create(tab.target, tab);
      if (
        host.logicalWindowId !== tab.target.windowId ||
        host.isDestroyed()
      ) {
        if (!host.isDestroyed()) await host.close();
        throw runtimeError(
          "ELECTRON_CHROMIUM_WINDOW_CREATE_INVALID",
          "Electron created a host with the wrong logical window identity."
        );
      }
      windowRecord = {
        host,
        hostTarget: tab.target,
        tabIds: [],
        hiddenTabIds: new Set(),
        activeTabId: tab.tabId,
        windowGeneration: tab.appkitWindowGeneration ?? 0,
        topologyRevision: tab.appkitTopologyRevision ?? 0,
        lastAdapterSequence: 0,
        windowZoomFactor: 1
      };
      this.#windows.set(tab.target.windowId, windowRecord);
      bindChromiumRuntimeWindowLayout({
        ports: this.#input,
        record: windowRecord,
        tabs: this.#tabs,
        roles: this.#roles,
        webSurfaces: this.#webSurfaces
      });
    }

    if (hostAlreadyOwnedWindow && windowRecord.host.initializeAppKitTab) {
      windowRecord.host.initializeAppKitTab(tab);
      windowRecord.windowGeneration = tab.appkitWindowGeneration!;
      windowRecord.topologyRevision = tab.appkitTopologyRevision!;
    }
    windowRecord.tabIds.push(tab.tabId);
    windowRecord.activeTabId = tab.tabId;
    this.#tabs.set(tab.tabId, {
      specification: tab,
      windowId: tab.target.windowId,
      roleViews: new Map(
        tab.roles
          .filter((role) => role.web === undefined)
          .map((role) => [role.role.id, role])
      ),
      webViews: new Map(
        tab.roles
          .filter((role) => role.web !== undefined)
          .map((role) => [role.role.id, role])
      ),
      audioMuted: tab.audioMuted
    });
    this.#applyWindowVisibility(windowRecord);
    await this.#reconcileRolePlaceholders();
  }

  async #configureRoleSessions(roleIds: string[]): Promise<void> {
    const unique = new Set(roleIds);
    if (unique.size !== roleIds.length) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_ROLE_SET_INVALID",
        "Core supplied duplicate role-session identities."
      );
    }
    await Promise.all(roleIds.map(async (roleId) => {
      requireIdentifier(roleId, "role");
      await this.#pathsFor(roleId);
    }));
  }

  #installOverlays(tabId: string, roleIds: string[]): Promise<void> {
    requireIdentifier(tabId, "tab");
    if (!this.#input.overlays) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_OVERLAY_NOT_READY",
        "The Chromium macro-overlay coordinator has not been enabled."
      );
    }
    if (!this.#tabs.has(tabId) || new Set(roleIds).size !== roleIds.length) {
      throw runtimeError(
        "ELECTRON_ROLE_OVERLAY_ROLE_SET_INVALID",
        "Core supplied an unavailable tab or duplicate overlay role identities."
      );
    }
    for (const roleId of roleIds) {
      requireIdentifier(roleId, "role");
      const role = this.#roles.get(roleId);
      if (!role || role.tabId !== tabId) {
        throw runtimeError(
          "ELECTRON_ROLE_OVERLAY_ROLE_SET_INVALID",
          "Every overlay role must own a live surface in the target tab."
        );
      }
    }
    return this.#input.overlays.install(roleIds, (roleId) => {
      const role = this.#roles.get(roleId);
      if (!role || role.tabId !== tabId) {
        throw runtimeError(
          "ELECTRON_ROLE_OVERLAY_ROLE_SET_INVALID",
          "The overlay role ownership changed before readiness admission."
        );
      }
      return role.generation;
    });
  }

  async #loadRoles(
    tabId: string,
    roles: ReadonlyArray<Readonly<{
      roleId: string;
      resolvedEngine: string;
      url: string;
      zoomFactor: number;
    }>>,
    signal?: AbortSignal
  ): Promise<void> {
    requireIdentifier(tabId, "tab");
    if (signal?.aborted) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_ROLE_LOAD_CANCELLED",
        "Core cancelled the Chromium Role load before native admission."
      );
    }
    const tab = this.#tabs.get(tabId);
    if (!tab) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_TAB_NOT_FOUND",
        "The role-load target tab is not attached."
      );
    }
    const windowRecord = this.#windowForTab(tab);
    const bounds = await this.#input.layout.resolveRoleBounds(
      tab.specification,
      windowRecord.host
    );
    const seen = new Set<string>();
    for (const role of roles) {
      requireIdentifier(role.roleId, "role");
      if (seen.has(role.roleId)) {
        throw runtimeError(
          "ELECTRON_CHROMIUM_ROLE_SET_INVALID",
          "Core supplied duplicate role-load identities."
        );
      }
      seen.add(role.roleId);
      if (!expectedEngineIsChromium(role.resolvedEngine)) {
        throw runtimeError(
          "ELECTRON_CHROMIUM_ENGINE_MISMATCH",
          "Electron refuses to present a non-Chromium role effect."
        );
      }
      const view = tab.roleViews.get(role.roleId);
      const slot = tab.specification.slots.find((candidate) =>
        candidate.role.id === role.roleId &&
        candidate.owner?.tabId === tabId
      );
      const roleBounds = bounds.get(role.roleId);
      if (
        !view ||
        !roleBounds ||
        !slot?.owner ||
        !Number.isSafeInteger(slot.owner.generation) ||
        slot.owner.generation < 1
      ) {
        throw runtimeError(
          "ELECTRON_CHROMIUM_ROLE_LAYOUT_MISSING",
          "The role-load effect is not represented by an owned tab slot."
        );
      }
      if (this.#roles.has(role.roleId)) {
        const existing = this.#roles.get(role.roleId)!;
        if (existing.tabId !== tabId) {
          throw runtimeError(
            "ELECTRON_CHROMIUM_ROLE_OWNERSHIP_CONFLICT",
            "The role already owns a Chromium surface in another tab."
          );
        }
        this.#input.surfaces.setBounds(role.roleId, existing.generation, roleBounds);
        this.#input.surfaces.setZoomFactor(
          role.roleId,
          existing.generation,
          effectiveChromiumRuntimeZoomFactor(
            role.zoomFactor,
            windowRecord.windowZoomFactor ?? 1
          )
        );
        existing.zoomFactor = role.zoomFactor;
      }
    }

    const attempts = roles
      .filter((role) => !this.#roles.has(role.roleId))
      .map(async (role) => {
        const roleBounds = bounds.get(role.roleId)!;
        const generation = this.#nextGeneration(role.roleId);
        const record: RuntimeRoleRecord = {
          roleId: role.roleId,
          tabId,
          windowId: tab.windowId,
          generation,
          ownerGeneration: tab.specification.slots.find((candidate) =>
            candidate.role.id === role.roleId && candidate.owner?.tabId === tabId
          )!.owner!.generation,
          zoomFactor: role.zoomFactor
        };
        const paths = await this.#pathsFor(role.roleId);
        if (signal?.aborted) {
          throw runtimeError(
            "ELECTRON_CHROMIUM_ROLE_LOAD_CANCELLED",
            "Core cancelled the Chromium Role load before surface creation."
          );
        }
        let cancellationClose: Promise<boolean> | null = null;
        const closeOpeningSurface = (): Promise<boolean> => {
          cancellationClose ??= this.#input.surfaces.closeRole(
            role.roleId,
            generation
          );
          // The create promise remains the authoritative load terminal. Observe
          // a concurrently requested close immediately so rejection cannot
          // become unhandled before the create path joins it below.
          void cancellationClose.catch(() => undefined);
          return cancellationClose;
        };
        const cancelOpeningSurface = (): void => {
          void closeOpeningSurface();
        };
        try {
          const creation = this.#input.surfaces.create({
            roleId: role.roleId,
            tabId,
            rolePaths: paths,
            generation,
            parent: windowRecord.host,
            url: role.url,
            preloadPath: this.#input.preloadPath,
            bounds: roleBounds,
            visible: windowRecord.activeTabId === tabId && windowRecord.host.isVisible(),
            zoomFactor: effectiveChromiumRuntimeZoomFactor(
              role.zoomFactor,
              windowRecord.windowZoomFactor ?? 1
            ),
            audioMuted: tab.audioMuted
          });
          signal?.addEventListener("abort", cancelOpeningSurface, { once: true });
          if (signal?.aborted) cancelOpeningSurface();
          await creation;
          if (signal?.aborted) {
            const closed = await closeOpeningSurface();
            if (!closed) {
              throw runtimeError(
                "ELECTRON_CHROMIUM_ROLE_LOAD_CANCEL_FAILED",
                "The cancelled Chromium Role load did not retire its exact surface."
              );
            }
            throw runtimeError(
              "ELECTRON_CHROMIUM_ROLE_LOAD_CANCELLED",
              "Core cancelled the Chromium Role load before readiness."
            );
          }
          this.#roles.set(role.roleId, record);
        } catch (error) {
          try {
            const closed = await closeOpeningSurface();
            if (closed) this.#input.overlays?.retire(role.roleId, generation);
          } catch {
            // Preserve the authoritative initial-load failure. The registry keeps
            // exact ownership when destruction or storage flush is still unknown.
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", cancelOpeningSurface);
        }
      });
    const results = await Promise.allSettled(attempts);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
    if (tab.webViews.size === 0) {
      this.#revealLoadedWindow(windowRecord);
      windowRecord.host.releaseAppKitSurfaceAttachment?.(tabId);
    } else {
      this.#applyWindowVisibility(windowRecord);
    }
    await this.#reconcileRolePlaceholders();
  }

  async #loadWebSurfaces(
    effect: CoreEffectRequest,
    action: Extract<
      CoreEffectRequest["action"],
      { type: "embeddedLoadWebSurfaces" }
    >,
    signal?: AbortSignal
  ): Promise<void> {
    const tabId = requireIdentifier(action.tabId, "global Web tab");
    requireIdentifier(action.attemptGeneration, "global Web attempt generation");
    if (signal?.aborted) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_LOAD_CANCELLED",
        "Core cancelled the global Web load before native admission."
      );
    }
    if (effect.target.handleId !== tabId) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_EFFECT_TARGET_MISMATCH",
        "The Core effect target does not match its global Web tab."
      );
    }
    const tab = this.#tabs.get(tabId);
    if (
      !tab ||
      tab.specification.attemptGeneration !== action.attemptGeneration
    ) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_TAB_STALE",
        "The global Web load no longer matches the exact tab launch attempt."
      );
    }
    if (
      action.profile?.profileKey !== "global-web" ||
      typeof action.profile.chromiumUserDataDir !== "string" ||
      action.profile.chromiumUserDataDir.length === 0 ||
      action.surfaces.length === 0
    ) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_EFFECT_INVALID",
        "Core supplied an invalid global Web profile or empty surface set."
      );
    }
    const windowRecord = this.#windowForTab(tab);
    const bounds = await this.#input.layout.resolveRoleBounds(
      tab.specification,
      windowRecord.host
    );
    const seenSurfaces = new Set<string>();
    const seenSlots = new Set<string>();
    for (const descriptor of action.surfaces) {
      this.#validateWebSurfaceDescriptor(
        tab,
        descriptor,
        seenSurfaces,
        seenSlots
      );
      if (!bounds.has(descriptor.surfaceId)) {
        throw runtimeError(
          "ELECTRON_GLOBAL_WEB_LAYOUT_MISSING",
          "Core did not resolve bounds for every global Web surface."
        );
      }
      if (this.#roles.has(descriptor.surfaceId)) {
        throw runtimeError(
          "ELECTRON_GLOBAL_WEB_MANAGED_ROLE_ALIAS",
          "A global Web surface identity aliases a managed role."
        );
      }
      const existing = this.#webSurfaces.get(descriptor.surfaceId);
      if (!existing) continue;
      if (
        existing.tabId !== tabId ||
        existing.slotId !== descriptor.slotId ||
        existing.url !== descriptor.url ||
        existing.profile.profileKey !== action.profile.profileKey ||
        existing.profile.chromiumUserDataDir !== action.profile.chromiumUserDataDir
      ) {
        throw runtimeError(
          "ELECTRON_GLOBAL_WEB_SURFACE_OWNERSHIP_CONFLICT",
          "The global Web identity already owns another native surface."
        );
      }
      this.#input.webSurfaces.setBounds(
        existing.surfaceId,
        existing.generation,
        bounds.get(existing.surfaceId)!
      );
      this.#input.webSurfaces.setZoomFactor(
        existing.surfaceId,
        existing.generation,
        effectiveChromiumRuntimeZoomFactor(
          descriptor.zoomFactor,
          windowRecord.windowZoomFactor ?? 1
        )
      );
      existing.zoomFactor = descriptor.zoomFactor;
    }

    const attempts = action.surfaces
      .filter((descriptor) => !this.#webSurfaces.has(descriptor.surfaceId))
      .map(async (descriptor) => {
        const generation = this.#nextWebSurfaceGeneration(descriptor.surfaceId);
        const record: RuntimeWebSurfaceRecord = {
          surfaceId: descriptor.surfaceId,
          slotId: descriptor.slotId,
          tabId,
          windowId: tab.windowId,
          generation,
          url: descriptor.url,
          profile: Object.freeze({ ...action.profile }),
          zoomFactor: descriptor.zoomFactor
        };
        if (signal?.aborted) {
          throw runtimeError(
            "ELECTRON_GLOBAL_WEB_LOAD_CANCELLED",
            "Core cancelled the global Web load before surface creation."
          );
        }
        let cancellationClose: Promise<boolean> | null = null;
        const closeOpeningSurface = (): Promise<boolean> => {
          cancellationClose ??= this.#input.webSurfaces.closeSurface(
            descriptor.surfaceId,
            generation
          );
          void cancellationClose.catch(() => undefined);
          return cancellationClose;
        };
        const cancelOpeningSurface = (): void => {
          void closeOpeningSurface();
        };
        try {
          const creation = this.#input.webSurfaces.create({
            attemptGeneration: requireIdentifier(
              tab.specification.attemptGeneration ?? "",
              "tab attempt generation"),
            surfaceId: descriptor.surfaceId,
            slotId: descriptor.slotId,
            generation,
            profile: action.profile,
            parent: windowRecord.host,
            tabId,
            windowGeneration: windowRecord.windowGeneration,
            windowId: tab.windowId,
            url: descriptor.url,
            bounds: bounds.get(descriptor.surfaceId)!,
            visible: windowRecord.activeTabId === tabId && windowRecord.host.isVisible(),
            zoomFactor: effectiveChromiumRuntimeZoomFactor(
              descriptor.zoomFactor, windowRecord.windowZoomFactor ?? 1),
            audioMuted: tab.audioMuted
          });
          signal?.addEventListener("abort", cancelOpeningSurface, { once: true });
          if (signal?.aborted) cancelOpeningSurface();
          await creation;
          if (signal?.aborted) {
            const closed = await closeOpeningSurface();
            if (!closed) {
              throw runtimeError(
                "ELECTRON_GLOBAL_WEB_LOAD_CANCEL_FAILED",
                "The cancelled global Web load did not retire its exact surface."
              );
            }
            throw runtimeError(
              "ELECTRON_GLOBAL_WEB_LOAD_CANCELLED",
              "Core cancelled the global Web load before readiness."
            );
          }
          this.#webSurfaces.set(descriptor.surfaceId, record);
        } catch (error) {
          try {
            await closeOpeningSurface();
          } catch {
            // Preserve the initial failure. Exact native/session ownership is
            // retained by the registry if destruction or flush is unknown.
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", cancelOpeningSurface);
        }
      });
    const results = await Promise.allSettled(attempts);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
    this.#revealLoadedWindow(windowRecord);
    windowRecord.host.releaseAppKitSurfaceAttachment?.(tabId);
  }

  #validateWebSurfaceDescriptor(
    tab: RuntimeTabRecord,
    descriptor: EmbeddedWebSurfaceLoadEffectRecord,
    seenSurfaces: Set<string>,
    seenSlots: Set<string>
  ): void {
    const surfaceId = requireIdentifier(descriptor.surfaceId, "global Web surface");
    const slotId = requireIdentifier(descriptor.slotId, "global Web slot");
    if (
      seenSurfaces.has(surfaceId) || seenSlots.has(slotId) ||
      !expectedEngineIsChromium(descriptor.resolvedEngine)
    ) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_EFFECT_INVALID",
        "Core supplied duplicate Web identities or a non-Chromium Web engine."
      );
    }
    seenSurfaces.add(surfaceId);
    seenSlots.add(slotId);
    const view = tab.webViews.get(surfaceId);
    const slot = tab.specification.slots.find((candidate) =>
      candidate.slotId === slotId && candidate.role.id === surfaceId
    );
    if (
      !view?.web || !slot?.web ||
      view.role.id !== surfaceId || slot.role.id !== surfaceId ||
      view.role.name !== view.web.name || slot.role.name !== slot.web.name ||
      view.web.name !== slot.web.name ||
      descriptor.url !== view.web.startUrl ||
      descriptor.url !== slot.web.startUrl ||
      view.role.launchUrl !== descriptor.url ||
      slot.role.launchUrl !== descriptor.url ||
      descriptor.zoomFactor !== view.zoomFactor ||
      descriptor.zoomFactor !== slot.zoomFactor ||
      view.zoomMode !== slot.zoomMode ||
      !sameNormalizedRect(view.rect, slot.rect) ||
      !Number.isFinite(descriptor.zoomFactor) ||
      descriptor.zoomFactor < 0.25 || descriptor.zoomFactor > 5 ||
      !expectedEngineIsChromium(view.resolvedEngine)
    ) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_EFFECT_INVALID",
        "The Web effect does not match its exact tab slot, view, URL, zoom, and engine."
      );
    }
  }

  #focusRole(roleId: string, zoomFactor?: number): void {
    requireIdentifier(roleId, "role");
    const role = this.#roles.get(roleId);
    if (!role) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_ROLE_NOT_FOUND",
        "The role does not own a Chromium surface."
      );
    }
    const windowRecord = this.#windows.get(role.windowId)!;
    windowRecord.activeTabId = role.tabId;
    if (zoomFactor !== undefined) {
      this.#input.surfaces.setZoomFactor(
        roleId,
        role.generation,
        effectiveChromiumRuntimeZoomFactor(
          zoomFactor,
          windowRecord.windowZoomFactor ?? 1
        )
      );
      role.zoomFactor = zoomFactor;
    }
    windowRecord.host.show();
    windowRecord.host.focus();
    this.#applyWindowVisibility(windowRecord);
  }

  #setTabAudioMuted(
    effect: CoreEffectRequest,
    action: Extract<CoreEffectRequest["action"], { type: "embeddedSetTabAudioMuted" }>
  ): Readonly<{
    tabId: string;
    windowId: string;
    attemptGeneration: string;
    muted: boolean;
    roles: ReadonlyArray<Readonly<{ roleId: string; ownerGeneration: number }>>;
    webSurfaces: ReadonlyArray<Readonly<{ surfaceId: string; slotId: string }>>;
  }> {
    requireIdentifier(action.tabId, "tab");
    requireIdentifier(action.windowId, "window");
    requireIdentifier(action.attemptGeneration, "attempt generation");
    if (effect.target.handleId !== action.tabId) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_TARGET_MISMATCH",
        "The Core effect target does not match the audio tab."
      );
    }
    const tab = this.#tabs.get(action.tabId);
    if (
      !tab ||
      tab.windowId !== action.windowId ||
      tab.specification.attemptGeneration !== action.attemptGeneration ||
      tab.audioMuted !== action.previousMuted
    ) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STALE",
        "The Chromium tab audio identity or prior state is stale."
      );
    }
    const expectedRoles = [...action.roles].sort((left, right) =>
      left.roleId.localeCompare(right.roleId)
    );
    const expectedWebSurfaces = [...action.webSurfaces].sort((left, right) =>
      left.surfaceId.localeCompare(right.surfaceId)
    );
    for (const role of expectedRoles) requireIdentifier(role.roleId, "audio role");
    for (const surface of expectedWebSurfaces) {
      requireIdentifier(surface.surfaceId, "audio Web surface");
      requireIdentifier(surface.slotId, "audio Web slot");
    }
    if (
      expectedRoles.length + expectedWebSurfaces.length === 0 ||
      new Set(expectedRoles.map((role) => role.roleId)).size !== expectedRoles.length ||
      new Set(expectedWebSurfaces.map((surface) => surface.surfaceId)).size !==
        expectedWebSurfaces.length ||
      new Set(expectedWebSurfaces.map((surface) => surface.slotId)).size !==
        expectedWebSurfaces.length
    ) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_SURFACE_SET_INVALID",
        "Core supplied an empty or duplicate tab audio surface set."
      );
    }
    const nativeRoles = [...this.#roles.values()]
      .filter((role) => role.tabId === action.tabId)
      .sort((left, right) => left.roleId.localeCompare(right.roleId));
    const identitiesMatch = nativeRoles.length === expectedRoles.length &&
      nativeRoles.every((role, index) =>
        role.roleId === expectedRoles[index]?.roleId &&
        role.ownerGeneration === expectedRoles[index]?.ownerGeneration
      );
    if (!identitiesMatch) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STALE",
        "The Chromium role ownership generation no longer matches Core."
      );
    }
    const nativeWebSurfaces = [...this.#webSurfaces.values()]
      .filter((surface) => surface.tabId === action.tabId)
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
    const webIdentitiesMatch =
      nativeWebSurfaces.length === expectedWebSurfaces.length &&
      nativeWebSurfaces.every((surface, index) =>
        surface.surfaceId === expectedWebSurfaces[index]?.surfaceId &&
        surface.slotId === expectedWebSurfaces[index]?.slotId
      );
    if (!webIdentitiesMatch) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STALE",
        "The global Web audio surface identity no longer matches Core."
      );
    }
    const previousStates = [
      ...nativeRoles.map((role) => ({
        id: role.roleId,
        generation: role.generation,
        muted: this.#input.surfaces.audioMuted(role.roleId, role.generation),
        set: (muted: boolean) => this.#input.surfaces.setAudioMuted(
          role.roleId,
          role.generation,
          muted
        )
      })),
      ...nativeWebSurfaces.map((surface) => ({
        id: surface.surfaceId,
        generation: surface.generation,
        muted: this.#input.webSurfaces.audioMuted(
          surface.surfaceId,
          surface.generation
        ),
        set: (muted: boolean) => this.#input.webSurfaces.setAudioMuted(
          surface.surfaceId,
          surface.generation,
          muted
        )
      }))
    ];
    if (previousStates.some((record) => record.muted !== action.previousMuted)) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_AUDIO_STATE_DIVERGED",
        "A Chromium role surface no longer matches the Core audio projection."
      );
    }

    const attempted: typeof previousStates = [];
    try {
      for (const record of previousStates) {
        attempted.push(record);
        record.set(action.muted);
      }
    } catch {
      let rollbackFailures = 0;
      for (const record of attempted.reverse()) {
        try {
          record.set(record.muted);
        } catch {
          rollbackFailures += 1;
        }
      }
      throw runtimeError(
        rollbackFailures === 0
          ? "ELECTRON_CHROMIUM_AUDIO_APPLY_FAILED"
          : "BROWSER_RUNTIME_AUDIO_ROLLBACK_FAILED",
        rollbackFailures === 0
          ? "Chromium rejected the tab audio mutation and the prior state was restored."
          : "Chromium tab audio rollback did not restore every exact role surface."
      );
    }
    tab.audioMuted = action.muted;
    return Object.freeze({
      tabId: action.tabId,
      windowId: action.windowId,
      attemptGeneration: action.attemptGeneration,
      muted: action.muted,
      roles: Object.freeze(expectedRoles.map((role) => Object.freeze({ ...role }))),
      webSurfaces: Object.freeze(
        expectedWebSurfaces.map((surface) => Object.freeze({ ...surface }))
      )
    });
  }

  async #destroyRole(roleId: string): Promise<boolean> {
    requireIdentifier(roleId, "role");
    const role = this.#roles.get(roleId);
    if (!role) return false;
    await this.#input.managedShortcutRetirement?.retireSurface(
      roleId,
      role.generation
    );
    await this.#input.trustedInput?.retireSurfaceForDestruction(
      roleId,
      role.generation
    );
    const closed = await this.#input.surfaces.closeRole(roleId, role.generation);
    if (closed) {
      this.#input.overlays?.retire(roleId, role.generation);
      if (this.#roles.get(roleId) === role) this.#roles.delete(roleId);
    }
    return closed;
  }

  async #claimRoleSlot(
    tabId: string,
    slot: EmbeddedRoleSlotEffectRecord,
    role: EmbeddedRoleViewEffectRecord
  ): Promise<void> {
    requireIdentifier(tabId, "tab");
    requireIdentifier(role.role.id, "role");
    if (role.web !== undefined) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_MANAGED_ROLE_ALIAS",
        "A synthetic Web slot cannot enter managed role ownership."
      );
    }
    if (this.#roles.has(role.role.id)) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_ROLE_OWNERSHIP_CONFLICT",
        "The claimed role still owns another Chromium surface."
      );
    }
    const tab = this.#tabs.get(tabId);
    if (!tab) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_TAB_NOT_FOUND",
        "The role-slot target tab is not attached."
      );
    }
    if (
      slot.slotId.length === 0 || slot.role.id !== role.role.id ||
      slot.owner?.tabId !== tabId || slot.owner.slotId !== slot.slotId ||
      !Number.isSafeInteger(slot.owner.generation) || slot.owner.generation < 1
    ) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_ROLE_CLAIM_FENCE_INVALID",
        "The claimed Role slot lost its exact Core owner generation."
      );
    }
    tab.specification = {
      ...tab.specification,
      slots: tab.specification.slots.map((candidateSlot) =>
        candidateSlot.slotId === slot.slotId ? { ...slot } : candidateSlot
      )
    };
    tab.roleViews.set(role.role.id, role);
  }

  async #destroyTab(tabId: string, nextActiveTabId?: string): Promise<boolean> {
    requireIdentifier(tabId, "tab");
    const tab = this.#tabs.get(tabId);
    if (!tab) return false;
    const windowRecord = this.#windowForTab(tab);
    if (
      nextActiveTabId !== undefined &&
      !windowRecord.tabIds.includes(nextActiveTabId)
    ) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_NEXT_TAB_INVALID",
        "Core selected a successor tab outside the closing tab's window."
      );
    }
    windowRecord.host.discardAppKitSurfaceAttachment?.(tabId);
    const ownedRoles = [...this.#roles.values()].filter((role) => role.tabId === tabId);
    const ownedWebSurfaces = [...this.#webSurfaces.values()]
      .filter((surface) => surface.tabId === tabId);
    const [roleCloses, webCloses] = await Promise.all([
      Promise.allSettled(ownedRoles.map((role) =>
        this.#retireInputAndCloseRole(role)
      )),
      Promise.allSettled(ownedWebSurfaces.map((surface) =>
        this.#input.webSurfaces.closeSurface(
          surface.surfaceId,
          surface.generation
        )
      ))
    ]);
    for (const [index, result] of roleCloses.entries()) {
      const role = ownedRoles[index]!;
      if (result.status !== "fulfilled" || result.value !== true) continue;
      this.#input.overlays?.retire(role.roleId, role.generation);
      if (this.#roles.get(role.roleId) === role) this.#roles.delete(role.roleId);
    }
    for (const [index, result] of webCloses.entries()) {
      const surface = ownedWebSurfaces[index]!;
      if (result.status !== "fulfilled" || result.value !== true) continue;
      if (this.#webSurfaces.get(surface.surfaceId) === surface) {
        this.#webSurfaces.delete(surface.surfaceId);
      }
    }
    const closeFailure = [...roleCloses, ...webCloses].find(
      (result) => result.status === "rejected" || result.value !== true
    );
    if (closeFailure) {
      if (closeFailure.status === "rejected") throw closeFailure.reason;
      throw runtimeError(
        "ELECTRON_CHROMIUM_SURFACE_CLOSE_NOT_OBSERVED",
        "A tab surface did not acknowledge its exact native close."
      );
    }
    const index = windowRecord.tabIds.indexOf(tabId);
    if (windowRecord.tabIds.length === 1) {
      this.#tabs.delete(tabId);
      if (index >= 0) windowRecord.tabIds.splice(index, 1);
      try {
        await this.#reconcileRolePlaceholders();
        await windowRecord.host.close();
      } catch (error) {
        if (!windowRecord.host.isDestroyed()) {
          this.#tabs.set(tabId, tab);
          windowRecord.tabIds.splice(Math.max(index, 0), 0, tabId);
          await this.#reconcileRolePlaceholders();
        }
        throw error;
      }
      if (this.#windows.get(tab.windowId) === windowRecord) this.#windows.delete(tab.windowId);
      return true;
    }
    this.#tabs.delete(tabId);
    if (index >= 0) windowRecord.tabIds.splice(index, 1);
    windowRecord.activeTabId = nextActiveTabId ?? windowRecord.tabIds[
      Math.min(Math.max(index, 0), windowRecord.tabIds.length - 1)
    ];
    if (this.#state === "open") this.#applyWindowVisibility(windowRecord);
    await this.#reconcileRolePlaceholders();
    return true;
  }

  async #retireInputAndCloseRole(role: RuntimeRoleRecord): Promise<boolean> {
    await this.#input.managedShortcutRetirement?.retireSurface(
      role.roleId,
      role.generation
    );
    await this.#input.trustedInput?.retireSurfaceForDestruction(
      role.roleId,
      role.generation
    );
    return this.#input.surfaces.closeRole(role.roleId, role.generation);
  }

  async #applyAppKitProjection(
    effect: CoreEffectRequest,
    projection: AppKitRuntimeProjectionEffectRecord
  ): Promise<Readonly<{ eventId: string; windowIds: readonly string[] }>> {
    const receipt = await applyChromiumRuntimeAppKitProjection({
      effect,
      projection,
      ports: this.#input,
      windows: this.#windows,
      tabs: this.#tabs,
      roles: this.#roles,
      webSurfaces: this.#webSurfaces,
      quarantineWindows: (windowIds) => quarantineChromiumRuntimeWindows({
        ports: this.#input, roles: this.#roles, tabs: this.#tabs,
        webSurfaces: this.#webSurfaces, windows: this.#windows, windowIds
      })
    });
    await this.#reconcileRolePlaceholders();
    try {
      this.#input.onNativeProjectionChanged?.();
    } catch {
      this.#input.onError({
        code: "ELECTRON_NATIVE_PROJECTION_NOTIFICATION_FAILED",
        message: "The committed native projection could not notify its renderer follower."
      });
    }
    return receipt;
  }

  async #followRoleOwnership(
    effect: CoreEffectRequest,
    action: Extract<
      CoreEffectRequest["action"],
      { type: "embeddedFollowRoleOwnership" }
    >,
    signal?: AbortSignal
  ): Promise<unknown> {
    const continuation = await followChromiumRuntimeOwnership({
      effect,
      lifecycleEpoch: action.lifecycleEpoch,
      projectedRoles: action.roles,
      projectedWindows: action.windows ?? [],
      ...(action.target === undefined ? {} : { target: action.target }),
      revealWindowIds: action.revealWindowIds,
      focusWindowIds: action.focusWindowIds,
      focusTabId: action.focusTabId,
      ownershipTransitions: this.#ownershipTransitions,
      ...(signal ? { signal } : {}),
      beforeNativeSubmission: async () => {
        projectChromiumRuntimeRolePlaceholderSlots(this.#tabs, action.roles);
        await this.#reconcileRolePlaceholders();
      },
      ports: this.#input,
      windows: this.#windows,
      tabs: this.#tabs,
      roles: this.#roles,
      webSurfaces: this.#webSurfaces
    });
    projectChromiumRuntimeRolePlaceholderSlots(this.#tabs, action.roles);
    await this.#reconcileRolePlaceholders();
    return continuation;
  }

  #setRuntimeWindowVisibility(
    effect: CoreEffectRequest,
    action: Extract<CoreEffectRequest["action"], {
      type: "embeddedSetRuntimeWindowVisibility";
    }>
  ): unknown {
    return applyChromiumRuntimeWindowVisibilityEffect({
      effect,
      action,
      ownershipTransitions: this.#ownershipTransitions,
      ports: this.#input,
      windows: this.#windows,
      roles: this.#roles,
      webSurfaces: this.#webSurfaces,
      reconcileProjection: () => this.#reconcileRolePlaceholders(),
      quarantineWindows: (windowIds) => quarantineChromiumRuntimeWindows({
        ports: this.#input,
        roles: this.#roles,
        tabs: this.#tabs,
        webSurfaces: this.#webSurfaces,
        windows: this.#windows,
        windowIds
      })
    });
  }

  async #reconcileRolePlaceholders(): Promise<void> {
    await reconcileChromiumRuntimeRolePlaceholders({
      ports: this.#input,
      tabs: this.#tabs,
      windows: this.#windows
    });
  }

  #roleForOverlay(identity: ChromiumRoleOverlayFrameIdentity): RuntimeRoleRecord {
    if (this.#state !== "open") {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime is draining and rejects overlay work."
      );
    }
    const role = this.#roles.get(identity.roleId);
    const window = role ? this.#windows.get(role.windowId) : undefined;
    if (
      !role ||
      role.generation !== identity.generation ||
      !window ||
      window.host.isDestroyed()
    ) {
      throw runtimeError(
        "ELECTRON_ROLE_OVERLAY_SURFACE_STALE",
        "The Chromium overlay document no longer owns its exact native role surface."
      );
    }
    return role;
  }

  #windowForTab(tab: RuntimeTabRecord): RuntimeWindowRecord {
    const windowRecord = this.#windows.get(tab.windowId);
    if (!windowRecord || windowRecord.host.isDestroyed()) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_WINDOW_NOT_FOUND",
        "The tab's native Chromium host window is unavailable."
      );
    }
    return windowRecord;
  }

  #applyWindowVisibility(windowRecord: RuntimeWindowRecord): void {
    applyChromiumRuntimeWindowSurfaceVisibility({
      ports: this.#input,
      windows: this.#windows,
      roles: this.#roles,
      webSurfaces: this.#webSurfaces
    }, windowRecord, windowRecord.host.isVisible());
  }

  #revealLoadedWindow(windowRecord: RuntimeWindowRecord): void {
    if (!windowRecord.host.isVisible()) windowRecord.host.show();
    if (!windowRecord.host.isVisible()) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_WINDOW_REVEAL_NOT_OBSERVED",
        "The loaded Chromium host did not acknowledge its exact native reveal."
      );
    }
    this.#applyWindowVisibility(windowRecord);
  }

  #pathsFor(roleId: string): Promise<RolePathsRecord> {
    const cached = this.#rolePaths.get(roleId);
    if (cached) return Promise.resolve(cached);
    return this.#input.rolePaths.resolve(roleId).then((paths) => {
      this.#rolePaths.set(roleId, paths);
      return paths;
    });
  }

  #nextGeneration(roleId: string): number {
    const generation = (this.#lastGenerationByRole.get(roleId) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_GENERATION_EXHAUSTED",
        "The native role-surface generation is exhausted."
      );
    }
    this.#lastGenerationByRole.set(roleId, generation);
    return generation;
  }

  #nextWebSurfaceGeneration(surfaceId: string): number {
    const generation = (this.#lastGenerationByWebSurface.get(surfaceId) ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw runtimeError(
        "ELECTRON_GLOBAL_WEB_GENERATION_EXHAUSTED",
        "The native global Web surface generation is exhausted."
      );
    }
    this.#lastGenerationByWebSurface.set(surfaceId, generation);
    return generation;
  }
}
