import { setChromiumRuntimeTabAudioMuted } from "./chromiumRuntimeTabAudioEffect";
import { ChromiumRuntimePlaceholderFollower } from "./chromiumRuntimePlaceholderFollower";
import { chromiumRuntimeEffectScopes } from "./chromiumRuntimeEffectScopes";
import { loadChromiumWorkspaceSlots } from "./chromiumWorkspaceSlotLoadExecutor";
import { captureChromiumRuntimeSnapshot } from "./chromiumRuntimeSnapshotCapture";
import { workspaceWebLaunchUrl } from "../../shared/workspaceStartPage";
import { observeAppKitWorkspaceAppearance } from
  "./appKitWorkspaceAppearanceObservation";
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
import {
  coreEffectEventContinuation,
  type CoreEffectEventContinuation,
  type CoreEffectExecutionContext
} from "./coreEffectContinuation";
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
  projectFencedRolePlaceholderSlots,
  reconcileChromiumRuntimeRolePlaceholders
} from "./chromiumRuntimeRolePlaceholderProjection";
import {
  expectedEngineIsChromium,
  requireAppTarget,
  requireIdentifier,
  runtimeError,
  sameNormalizedRect,
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

/** Executes Core effects against exact native handles. */
export class ChromiumRuntimeEffectExecutor {
  readonly #input: ChromiumRuntimeEffectExecutorInput;
  readonly #windows = new Map<string, RuntimeWindowRecord>();
  readonly #tabs = new Map<string, RuntimeTabRecord>();
  readonly #retiredSlotLoads = new Set<string>();
  readonly #roles = new Map<string, RuntimeRoleRecord>();
  readonly #openingRoles = new Map<string, RuntimeRoleRecord>();
  readonly #webSurfaces = new Map<string, RuntimeWebSurfaceRecord>();
  readonly #attachedWebSurfaces = new Map<string, RuntimeWebSurfaceRecord>();
  readonly #openingWebSurfaces = new Map<string, RuntimeWebSurfaceRecord>();
  readonly #closingRoleGenerations = new Map<string, number>();
  readonly #closingWebSurfaceGenerations = new Map<string, number>();
  readonly #rolePaths = new Map<string, RolePathsRecord>();
  readonly #lastGenerationByRole = new Map<string, number>();
  readonly #lastGenerationByWebSurface = new Map<string, number>();
  readonly #savedWindowRestorePresentations = new Map<string, boolean>();
  readonly #admittedTabWindows = new Map<string, string>();
  readonly #retiringWindows = new Set<string>();
  readonly #closedTabAttempts = new Map<string, string>();
  readonly #ownershipTransitions: ChromiumRuntimeOwnershipTransitionCoordinator;
  readonly #placeholderFollower: ChromiumRuntimePlaceholderFollower;
  #state: ExecutorState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(input: ChromiumRuntimeEffectExecutorInput) {
    this.#input = input;
    this.#placeholderFollower = new ChromiumRuntimePlaceholderFollower(input, this.#tabs, this.#windows, () => this.#state === "open");
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

  mutationScopes(effect: CoreEffectRequest): readonly string[] {
    return chromiumRuntimeEffectScopes(effect, this.#tabs, this.#admittedTabWindows);
  }

  attachedWebSurfaceObservations(windowId: string): import("../../shared/generated").AppKitAttachedWebSurfaceRecord[] {
    return [...this.#projectableWebSurfaces().values()]
      .filter((surface) => surface.windowId === windowId &&
        !this.#closingWebSurfaceGenerations.has(surface.surfaceId))
      .map((surface) => ({ surfaceId: surface.surfaceId, slotId: surface.slotId,
        tabId: surface.tabId, surfaceGeneration: surface.generation,
        attemptGeneration: this.#tabs.get(surface.tabId)!.specification.attemptGeneration! }));
  }

  #projectableWebSurfaces(): Map<string, RuntimeWebSurfaceRecord> {
    return new Map([...this.#attachedWebSurfaces, ...this.#webSurfaces].filter(
      ([id, surface]) => this.#closingWebSurfaceGenerations.get(id) !== surface.generation));
  }

  #projectableRoles(): Map<string, RuntimeRoleRecord> {
    return new Map([...this.#roles].filter(
      ([id, role]) => this.#closingRoleGenerations.get(id) !== role.generation));
  }

  snapshot(): ChromiumRuntimeExecutorSnapshot {
    return captureChromiumRuntimeSnapshot({ windows: this.#windows, tabs: this.#tabs,
      roles: this.#roles, webSurfaces: this.#webSurfaces, ports: this.#input,
      closingRoleGenerations: this.#closingRoleGenerations,
      closingWebSurfaceGenerations: this.#closingWebSurfaceGenerations });
  }

  desktopE2eStatusPresentation(windowId: string): number | undefined {
    return this.#windows.get(windowId)?.host.desktopE2eStatusPresentation?.(); }

  beginSavedWindowRestore(windowId: string, foreground = false): void {
    requireIdentifier(windowId, "saved-window restore");
    if (this.#state !== "open") {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime cannot begin a saved-window restore while draining."
      );
    }
    this.#savedWindowRestorePresentations.set(windowId, foreground);
  }

  finishSavedWindowRestore(windowId: string): void {
    requireIdentifier(windowId, "saved-window restore");
    if (
      this.#state !== "open" ||
      !this.#savedWindowRestorePresentations.has(windowId)
    ) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RESTORE_PRESENTATION_STALE",
        "The saved-window restore presentation is no longer current."
      );
    }
    const windowRecord = this.#windows.get(windowId);
    if (!windowRecord || windowRecord.host.isDestroyed()) {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RESTORE_PRESENTATION_STALE",
        "The restored Game Window has no exact native host to reveal."
      );
    }
    const foreground = this.#savedWindowRestorePresentations.get(windowId)!;
    this.#savedWindowRestorePresentations.delete(windowId);
    try {
      // Explicit Show already revealed this host before hydration. Preserve a
      // subsequent user hide/minimize instead of revealing it again at completion.
      if (foreground) this.#applyWindowVisibility(windowRecord);
      else this.#revealRestoredWindow(windowRecord);
    } catch (error) {
      this.#savedWindowRestorePresentations.set(windowId, foreground);
      throw error;
    }
  }
  async commitTerminalRoleOwnership(
    projectedRoles: readonly BrowserRuntimeRoleRecord[],
    roleId?: string
  ): Promise<void> {
    if (this.#state !== "open") {
      throw runtimeError(
        "ELECTRON_CHROMIUM_RUNTIME_DRAINING",
        "The Chromium runtime is draining and rejects ownership projections."
      );
    }
    for (const projected of projectedRoles.filter(role => roleId === undefined || role.roleId === roleId)) {
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
    projectChromiumRuntimeRolePlaceholderSlots(this.#tabs, projectedRoles, roleId);
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
    phase: "keyDown" | "keyUp"
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
      case "roleSessionRecoveryImport":
        if (!this.#input.sessionRecovery || this.#roles.has(action.roleId)) {
          throw runtimeError("RECOVERY_RUNTIME_CONFLICT", "The recovery target is unavailable or in use.");
        }
        return this.#input.sessionRecovery.execute(effect, context?.signal);
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
      case "embeddedLoadWorkspaceSlots":
        return this.#loadWorkspaceSlots(effect, action, context?.signal);
      case "embeddedRetryWorkspaceSlot": {
        const tab = this.#tabs.get(action.record.tabId);
        if (!tab?.workspaceLoadPlan) throw runtimeError("WORKSPACE_SLOT_RETRY_STALE", "The workspace retired before retry.");
        return this.#loadWorkspaceSlots(effect, tab.workspaceLoadPlan, context?.signal, action.record);
      }
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
        return setChromiumRuntimeTabAudioMuted({ ports: this.#input, tabs: this.#tabs, roles: this.#roles, webSurfaces: this.#webSurfaces }, effect, action);
      case "embeddedDestroyRole":
        return coreEffectEventContinuation(this.#destroyRole(action.roleId), () => { /* Exact destruction must finish after cancellation. */ });
      case "embeddedClaimRoleSlot":
        return this.#claimRoleSlot(action.tabId, action.slot, action.role);
      case "embeddedDestroyTab":
        if (action.attemptGeneration !== undefined && this.#tabs.get(action.tabId)?.specification.attemptGeneration !== action.attemptGeneration) {
          return false;
        }
        return coreEffectEventContinuation(this.#destroyTab(action.tabId, action.nextActiveTabId ?? undefined), () => { /* Retain exact native release evidence. */ });
      case "embeddedFollowRoleOwnership":
        return this.#followRoleOwnership(effect, action, context?.signal);
      case "embeddedObserveAppKitWorkspaceAppearance":
        return observeAppKitWorkspaceAppearance(
          this.#input.appKitWorkspaceAppearance,
          action.windowIds,
          (windowId) => this.#windows.has(windowId)
        );
      case "embeddedApplyAppKitProjection":
        return this.#applyAppKitProjection(effect, action.projection, context?.signal);
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
          webSurfaces: this.#projectableWebSurfaces()
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
    for (const tab of this.#tabs.values()) tab.pendingContentFocus?.cancel();
    this.#state = "draining";
    this.#savedWindowRestorePresentations.clear();
    this.#ownershipTransitions.close("actorStop");
    const windowTabCohorts = [...this.#windows.values()].map(
      (window) => [...window.tabIds]
    );
    this.#disposePromise = Promise.allSettled(
      windowTabCohorts.map(async (tabIds) => {
        // Tabs sharing one native host must drain in order. Parallel destruction
        // can resume a placeholder-layout projection after a sibling has closed
        // the AppKit/Win32 host and invalidate its exact generation fence.
        for (const tabId of tabIds) await this.#destroyTab(tabId);
      })
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
    if (this.#retiringWindows.has(tab.target.windowId) ||
      (tab.attemptGeneration !== undefined && this.#closedTabAttempts.get(tab.tabId) === tab.attemptGeneration)) {
      throw runtimeError("ELECTRON_CHROMIUM_TAB_RETIRED", "The tab attempt or its exact host has already retired.");
    }
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
        webSurfaces: this.#attachedWebSurfaces
      });
    }

    if (hostAlreadyOwnedWindow && windowRecord.host.initializeAppKitTab) {
      windowRecord.host.initializeAppKitTab(tab);
      windowRecord.windowGeneration = tab.appkitWindowGeneration!;
      windowRecord.topologyRevision = tab.appkitTopologyRevision!;
    }
    for (const current of this.#tabs.values()) {
      if (current.windowId === tab.target.windowId) current.pendingContentFocus?.cancel();
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
    // Core's ownership/window projection supplies the first Windows generation
    // fence. Reconcile blocked slots from that event before revealing the host.
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

  async #loadWorkspaceSlots(
    effect: CoreEffectRequest,
    plan: Extract<CoreEffectRequest["action"], { type: "embeddedLoadWorkspaceSlots" }>,
    signal?: AbortSignal,
    retry?: import("../../shared/generated").WorkspaceSlotLoadRecord
  ): Promise<CoreEffectEventContinuation<void>> {
    return loadChromiumWorkspaceSlots({
      ports: this.#input, tabs: this.#tabs,
      windowForTab: (tab) => this.#windowForTab(tab),
      roleGenerations: this.#lastGenerationByRole, webGenerations: this.#lastGenerationByWebSurface,
      retiredLoads: this.#retiredSlotLoads,
      loadRoles: (tabId, roles, signal) => this.#loadRoles(tabId, roles, signal, true),
      loadWebSurfaces: (effect, action, signal) => this.#loadWebSurfaces(effect, action, signal, true)
    }, effect, plan, signal, retry);
  }

  async #loadRoles(
    tabId: string,
    roles: ReadonlyArray<Readonly<{
      roleId: string;
      resolvedEngine: string;
      url: string;
      zoomFactor: number;
    }>>,
    signal?: AbortSignal,
    slotLoad = false
  ): Promise<CoreEffectEventContinuation<void>> {
    const cancellation = new AbortController();
    signal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
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
      if (this.#openingRoles.has(role.roleId)) {
        throw runtimeError("ELECTRON_CHROMIUM_ROLE_LOAD_PENDING",
          "The Role already has an exact pending native navigation.");
      }
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

    const pathsByRole = new Map(await Promise.all(roles.map(async (role) =>
      [role.roleId, await this.#pathsFor(role.roleId)] as const
    )));
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
        const paths = pathsByRole.get(role.roleId)!;
        if (signal?.aborted) {
          throw runtimeError(
            "ELECTRON_CHROMIUM_ROLE_LOAD_CANCELLED",
            "Core cancelled the Chromium Role load before surface creation."
          );
        }
        let cancellationClose: Promise<boolean> | null = null;
        let releaseConfirmed = false;
        const closeOpeningSurface = (): Promise<boolean> => {
          cancellationClose ??= this.#input.surfaces.closeRole(
            role.roleId,
            generation
          ).then(closed => { releaseConfirmed = closed; return closed; });
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
            visible: !slotLoad && windowRecord.activeTabId === tabId && windowRecord.host.isVisible(),
            zoomFactor: effectiveChromiumRuntimeZoomFactor(
              role.zoomFactor,
              windowRecord.windowZoomFactor ?? 1
            ),
            audioMuted: tab.audioMuted
          });
          signal?.addEventListener("abort", cancelOpeningSurface, { once: true });
          if (signal?.aborted) cancelOpeningSurface();
          this.#openingRoles.set(role.roleId, record);
          await creation;
          if (this.#tabs.get(tabId) !== tab ||
              this.#openingRoles.get(role.roleId) !== record ||
              this.#closingRoleGenerations.get(role.roleId) === generation ||
              this.#windows.get(tab.windowId) !== windowRecord) {
            throw runtimeError("ELECTRON_CHROMIUM_ROLE_LOAD_STALE",
              "The loading Role lost its exact native topology before readiness.");
          }
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
            if (closed || this.#input.surfaces.wasRetired?.(role.roleId, generation)) {
              this.#retiredSlotLoads.add(`role:${role.roleId}:${generation}`);
              this.#input.overlays?.retire(role.roleId, generation);
              if (this.#roles.get(role.roleId) === record) this.#roles.delete(role.roleId);
            }
          } catch {
            // Preserve the authoritative initial-load failure. The registry keeps
            // exact ownership when destruction or storage flush is still unknown.
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", cancelOpeningSurface);
          if (this.#openingRoles.get(role.roleId) === record &&
              (releaseConfirmed || this.#roles.get(role.roleId) === record || this.#input.surfaces.wasRetired?.(role.roleId, generation))) {
            this.#openingRoles.delete(role.roleId);
          }
        }
      });
    const completion = Promise.allSettled(attempts).then(async (results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) throw failure.reason;
      if (this.#tabs.get(tabId) !== tab ||
          this.#windows.get(tab.windowId) !== windowRecord) {
        throw runtimeError("ELECTRON_CHROMIUM_ROLE_LOAD_STALE",
          "The loading tab retired before native readiness.");
      }
      if (slotLoad) return;
      if (tab.webViews.size === 0) {
        this.#applyWindowVisibility(windowRecord);
        windowRecord.host.releaseAppKitSurfaceAttachment?.(tabId);
      } else {
        this.#applyWindowVisibility(windowRecord);
      }
      await this.#reconcileRolePlaceholders();
    });
    return coreEffectEventContinuation(completion, () => cancellation.abort());
  }

  async #loadWebSurfaces(
    effect: CoreEffectRequest,
    action: Extract<
      CoreEffectRequest["action"],
      { type: "embeddedLoadWebSurfaces" }
    >,
    signal?: AbortSignal,
    slotLoad = false
  ): Promise<CoreEffectEventContinuation<void>> {
    const cancellation = new AbortController();
    signal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
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
      if (this.#roles.has(descriptor.surfaceId) || this.#openingRoles.has(descriptor.surfaceId)) {
        throw runtimeError(
          "ELECTRON_GLOBAL_WEB_MANAGED_ROLE_ALIAS",
          "A global Web surface identity aliases a managed role."
        );
      }
      if (this.#openingWebSurfaces.has(descriptor.surfaceId)) {
        throw runtimeError("ELECTRON_GLOBAL_WEB_LOAD_PENDING",
          "The Web surface already has an exact pending native navigation.");
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
        let releaseConfirmed = false;
        let cancellationClose: Promise<boolean> | null = null;
        const closeOpeningSurface = (): Promise<boolean> => {
          cancellationClose ??= this.#input.webSurfaces.closeSurface(
            descriptor.surfaceId,
            generation
          ).then(closed => { releaseConfirmed = closed; return closed; });
          void cancellationClose.catch(() => undefined);
          return cancellationClose;
        };
        const cancelOpeningSurface = (): void => {
          if (this.#attachedWebSurfaces.get(descriptor.surfaceId) === record) {
            this.#attachedWebSurfaces.delete(descriptor.surfaceId);
          }
          void closeOpeningSurface();
        };
        try {
          this.#openingWebSurfaces.set(descriptor.surfaceId, record);
          const creation = this.#input.webSurfaces.create({
            onAttached: () => {
              if (signal?.aborted || this.#openingWebSurfaces.get(descriptor.surfaceId) !== record ||
                  this.#tabs.get(tabId) !== tab) return;
              this.#attachedWebSurfaces.set(descriptor.surfaceId, record);
              windowRecord.host.notifySurfaceAttachment?.();
            },
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
            visible: !slotLoad && windowRecord.activeTabId === tabId && windowRecord.host.isVisible(),
            zoomFactor: effectiveChromiumRuntimeZoomFactor(
              descriptor.zoomFactor, windowRecord.windowZoomFactor ?? 1),
            audioMuted: tab.audioMuted
          });
          signal?.addEventListener("abort", cancelOpeningSurface, { once: true });
          if (signal?.aborted) cancelOpeningSurface();
          await creation;
          if (this.#tabs.get(tabId) !== tab ||
              this.#openingWebSurfaces.get(descriptor.surfaceId) !== record ||
              this.#windows.get(tab.windowId) !== windowRecord) {
            throw runtimeError("ELECTRON_GLOBAL_WEB_LOAD_STALE",
              "The loading Web surface lost its exact topology before readiness.");
          }
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
          this.#attachedWebSurfaces.set(descriptor.surfaceId, record);
        } catch (error) {
          try {
            if (await closeOpeningSurface() || this.#input.webSurfaces.wasRetired?.(descriptor.surfaceId, generation)) this.#retiredSlotLoads.add(`web:${descriptor.surfaceId}:${generation}`);
          } catch {
            // Preserve the initial failure. Exact native/session ownership is
            // retained by the registry if destruction or flush is unknown.
          }
          throw error;
        } finally {
          if (this.#webSurfaces.get(descriptor.surfaceId) !== record &&
              this.#attachedWebSurfaces.get(descriptor.surfaceId) === record) {
            this.#attachedWebSurfaces.delete(descriptor.surfaceId);
          }
          signal?.removeEventListener("abort", cancelOpeningSurface);
          if (this.#openingWebSurfaces.get(descriptor.surfaceId) === record &&
              (releaseConfirmed || this.#webSurfaces.get(descriptor.surfaceId) === record ||
                this.#input.webSurfaces.wasRetired?.(descriptor.surfaceId, generation))) {
            this.#openingWebSurfaces.delete(descriptor.surfaceId);
          }
        }
      });
    const completion = Promise.allSettled(attempts).then((results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failure) throw failure.reason;
      if (this.#tabs.get(tabId) !== tab ||
          this.#windows.get(tab.windowId) !== windowRecord) {
        throw runtimeError("ELECTRON_GLOBAL_WEB_LOAD_STALE",
          "The loading Web tab retired before native readiness.");
      }
      if (slotLoad) return;
      this.#applyWindowVisibility(windowRecord);
      windowRecord.host.releaseAppKitSurfaceAttachment?.(tabId);
    });
    return coreEffectEventContinuation(completion, () => cancellation.abort());
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
      descriptor.url !== workspaceWebLaunchUrl(view.web.lastUrl) ||
      descriptor.url !== workspaceWebLaunchUrl(slot.web.lastUrl) ||
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


  async #destroyRole(roleId: string): Promise<boolean> {
    requireIdentifier(roleId, "role");
    const role = this.#roles.get(roleId) ?? this.#openingRoles.get(roleId);
    if (!role) return false;
    this.#closingRoleGenerations.set(role.roleId, role.generation);
    const closed = await this.#retireInputAndCloseRole(role);
    if (closed) {
      this.#input.overlays?.retire(roleId, role.generation);
      if (this.#roles.get(roleId) === role) this.#roles.delete(roleId);
      if (this.#openingRoles.get(roleId) === role) this.#openingRoles.delete(roleId);
      if (this.#closingRoleGenerations.get(roleId) === role.generation) {
        this.#closingRoleGenerations.delete(roleId);
      }
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
    if (this.#roles.has(role.role.id) || this.#openingRoles.has(role.role.id)) {
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
    tab.pendingContentFocus?.cancel();
    if (tab.specification.attemptGeneration) {
      this.#closedTabAttempts.set(tabId, tab.specification.attemptGeneration);
      if (this.#closedTabAttempts.size > 4096) this.#closedTabAttempts.delete(this.#closedTabAttempts.keys().next().value!);
    }
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
    // A committed close projection may already have removed native membership.
    // The retained exact tab record still owns background resource retirement.
    if (windowRecord.tabIds.includes(tabId)) windowRecord.host.discardAppKitSurfaceAttachment?.(tabId);
    const ownedRoles = [...this.#roles.values(), ...this.#openingRoles.values()]
      .filter((role) => role.tabId === tabId);
    const ownedWebSurfaces = [...this.#webSurfaces.values(), ...this.#openingWebSurfaces.values()]
      .filter((surface) => surface.tabId === tabId);
    for (const role of ownedRoles) {
      this.#closingRoleGenerations.set(role.roleId, role.generation);
    }
    for (const surface of ownedWebSurfaces) {
      this.#closingWebSurfaceGenerations.set(
        surface.surfaceId,
        surface.generation
      );
    }
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
      if (this.#openingRoles.get(role.roleId) === role) this.#openingRoles.delete(role.roleId);
      if (this.#closingRoleGenerations.get(role.roleId) === role.generation) {
        this.#closingRoleGenerations.delete(role.roleId);
      }
    }
    for (const [index, result] of webCloses.entries()) {
      const surface = ownedWebSurfaces[index]!;
      if (result.status !== "fulfilled" || result.value !== true) continue;
      if (this.#webSurfaces.get(surface.surfaceId) === surface) {
        this.#webSurfaces.delete(surface.surfaceId);
      }
      this.#attachedWebSurfaces.delete(surface.surfaceId);
      if (this.#openingWebSurfaces.get(surface.surfaceId) === surface) {
        this.#openingWebSurfaces.delete(surface.surfaceId);
      }
      if (this.#closingWebSurfaceGenerations.get(surface.surfaceId) ===
          surface.generation) {
        this.#closingWebSurfaceGenerations.delete(surface.surfaceId);
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
    if (windowRecord.tabIds.every(id => id === tabId)) {
      this.#retiringWindows.add(tab.windowId);
      this.#tabs.delete(tabId);
      this.#admittedTabWindows.delete(tabId);
      if (index >= 0) windowRecord.tabIds.splice(index, 1);
      this.#scheduleRolePlaceholders();
      // Logical membership is terminal even if the native host cannot prove release.
      // Keep the exact host record quarantined; never restore the closed tab.
      await windowRecord.host.close();
      if (this.#windows.get(tab.windowId) === windowRecord) this.#windows.delete(tab.windowId);
      this.#retiringWindows.delete(tab.windowId);
      return true;
    }
    this.#tabs.delete(tabId);
    this.#admittedTabWindows.delete(tabId);
    if (index >= 0) windowRecord.tabIds.splice(index, 1);
    // Closing a background tab must preserve the surviving Core-selected tab.
    // An explicit successor remains authoritative for an active-tab close.
    if (windowRecord.activeTabId === tabId) {
      windowRecord.activeTabId = nextActiveTabId ??
        windowRecord.tabIds[Math.min(Math.max(index, 0), windowRecord.tabIds.length - 1)] ?? "";
    }
    if (this.#state === "open") this.#applyWindowVisibility(windowRecord);
    this.#scheduleRolePlaceholders();
    return true;
  }

  async #retireInputAndCloseRole(role: RuntimeRoleRecord): Promise<boolean> {
    if (this.#openingRoles.get(role.roleId) === role) {
      return this.#input.surfaces.closeRole(role.roleId, role.generation);
    }
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
    projection: AppKitRuntimeProjectionEffectRecord,
    signal?: AbortSignal
  ): Promise<Readonly<{ eventId: string; windowIds: readonly string[] }>> {
    const receipt = await applyChromiumRuntimeAppKitProjection({
      signal,
      effect,
      projection,
      ports: this.#input,
      windows: this.#windows,
      tabs: this.#tabs,
      roles: this.#projectableRoles(),
      webSurfaces: this.#projectableWebSurfaces(),
      quarantineWindows: (windowIds) => quarantineChromiumRuntimeWindows({
        ports: this.#input, roles: this.#roles, tabs: this.#tabs,
        webSurfaces: this.#projectableWebSurfaces(), windows: this.#windows, windowIds
      })
    });
    this.#scheduleRolePlaceholders();
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
        projectFencedRolePlaceholderSlots(this.#tabs, action.roles, this.#windows, action.windows);
        this.#scheduleRolePlaceholders();
      },
      ports: this.#input,
      windows: this.#windows,
      tabs: this.#tabs,
      roles: this.#projectableRoles(),
      webSurfaces: this.#projectableWebSurfaces()
    });
    projectFencedRolePlaceholderSlots(this.#tabs, action.roles, this.#windows, action.windows);
    this.#scheduleRolePlaceholders();
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
      roles: this.#projectableRoles(),
      webSurfaces: this.#projectableWebSurfaces(),
      reconcileProjection: () => this.#reconcileRolePlaceholders(),
      quarantineWindows: (windowIds) => quarantineChromiumRuntimeWindows({
        ports: this.#input,
        roles: this.#roles,
        tabs: this.#tabs,
        webSurfaces: this.#projectableWebSurfaces(),
        windows: this.#windows,
        windowIds
      })
    });
  }

  #scheduleRolePlaceholders(): void {
    this.#placeholderFollower.schedule();
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
      roles: this.#projectableRoles(),
      webSurfaces: this.#projectableWebSurfaces()
    }, windowRecord, windowRecord.host.isVisible());
  }

  #revealRestoredWindow(windowRecord: RuntimeWindowRecord): void {
    if (!windowRecord.host.isVisible()) windowRecord.host.showInactive!();
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
