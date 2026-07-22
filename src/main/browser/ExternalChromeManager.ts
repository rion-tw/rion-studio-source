import { EventEmitter } from "node:events";

import type { RoleStore } from "../roles/RoleStore";
import {
  CDN_COMPATIBILITY_EXTERNAL_NOTICE,
  CDN_COMPATIBILITY_UNAVAILABLE_NOTICE
} from "../game-browser/CdnCompatibilityManager";
import {
  BROWSER_BACKGROUND_FEATURES_TO_DISABLE,
  BROWSER_BASE_SWITCHES,
  EXTERNAL_CHROME_FOREGROUND_PRIORITY_SWITCHES,
  formatChromiumSwitch,
  getGraphicsSwitches
} from "../../shared/browserGraphics";
import { DEFAULT_BROWSER_GRAPHICS_SETTINGS } from "../../shared/browserFonts";
import type {
  BrowserGraphicsSettings,
  NormalizedRect,
  PixelBounds,
  Role,
  RoleStatus,
  WorkspaceBrowserZoomMode,
  WorkspaceBrowserZoomPercent,
  WorkspaceSlotBrowserZoomPercent
} from "../../shared/types";
import type {
  ConnectExternalChromeAutomationOptions,
  ExternalChromeDiagnosticEvent,
  ExternalChromePageDiagnostics,
  ExternalBrowserAutomationTarget
} from "./ExternalChromeAutomationTarget";
import type { ExternalChromeWindowBoundsAdapter } from "./WindowsExternalChromeWindowBoundsAdapter";
import type {
  BrowserWorkspaceRuntimeState,
  BrowserWorkspaceRuntimeStatus
} from "./BrowserManager";
import type { ExternalChromeProcessLike } from "../core/nativeCore";
import type { ExternalChromeHealthMonitor } from "./RustExternalChromeHealthMonitor";
import type {
  ExternalSessionCommand,
  ExternalSessionRecord,
  ExternalSessionResult
} from "../../shared/generated";

export interface ExternalChromeManagerEvents {
  change: [RoleStatus[]];
  diagnostics: [roleId: string, diagnostics: ExternalChromeSessionDiagnostics];
  health: [roleId: string, health: "healthy" | "unresponsive", diagnostics?: ExternalChromeSessionDiagnostics];
}

export interface ExternalChromeSessionDiagnostics {
  automationState: "ready" | "unavailable";
  bounds: PixelBounds;
  capturedAt: string;
  cdp?: {
    lastRoundTripAt?: string;
    lastTimeoutAt?: string;
  };
  externalRoleCount: number;
  pageHealth?: "healthy" | "unresponsive";
  physicalBounds?: PixelBounds;
  roleId: string;
  runtimeMode: "external";
  workspaceId?: string;
  zoomFactor: number;
  chrome?: ExternalChromePageDiagnostics;
}

export interface ExternalChromeLaunchItem {
  browserZoomPercent?: WorkspaceSlotBrowserZoomPercent;
  rect: NormalizedRect;
  role: Role;
}

export interface ExternalChromeLaunchOptions {
  notice?: string;
  workArea?: PixelBounds;
  zoomMode?: WorkspaceBrowserZoomMode;
  zoomFactor?: number;
}

export interface ExternalChromeManagerOptions {
  adaptiveZoomResolver: (
    viewportWidth: number,
    currentPercent?: WorkspaceBrowserZoomPercent
  ) => WorkspaceBrowserZoomPercent;
  applyBrowserPreferences?: (
    role: Role,
    browserUserDataDir: string,
    zoomFactor: number
  ) => Promise<void>;
  externalSessionState: {
    invokeExternalSession: (command: ExternalSessionCommand) => ExternalSessionResult;
  };
  captureAutomationDiagnostics: (roleId: string) => Promise<ExternalChromePageDiagnostics>;
  evaluateAutomation: <T = unknown>(roleId: string, source: string) => Promise<T>;
  focusAutomation: (roleId: string) => Promise<void>;
  prepareCdnCompatibility?: (
    role: Role,
    browserUserDataDir: string
  ) => Promise<{ enabled: boolean; proxyServer?: string }>;
  prepareBrowserUserDataDir: (browserUserDataDir: string) => Promise<void>;
  findExecutable: () => string;
  getLaunchWorkArea: () => PixelBounds;
  graphicsSettings?: BrowserGraphicsSettings;
  healthMonitor: ExternalChromeHealthMonitor;
  normalizeWorkspaceRects: (rects: NormalizedRect[]) => NormalizedRect[];
  onDiagnostic?: (event: ExternalChromeDiagnosticEvent & { roleId: string }) => void;
  now?: () => number;
  platform?: NodeJS.Platform;
  setAutomationWindowBounds: (roleId: string, bounds: PixelBounds) => Promise<void>;
  windowBoundsAdapter?: ExternalChromeWindowBoundsAdapter;
  spawnChrome: (roleId: string, executablePath: string, args: string[]) => ExternalChromeProcessLike;
  connectAutomation: (
    browserUserDataDir: string,
    launchUrl: string,
    options?: Pick<
      ConnectExternalChromeAutomationOptions,
      "cdnCompatibilityEnabled" | "onDiagnostic" | "roleId"
    >
  ) => Promise<ExternalBrowserAutomationTarget>;
  unregisterAutomation: (roleId: string) => void;
}

export type ExternalMacroOverlayInstaller = (
  role: Role,
  target: ExternalBrowserAutomationTarget
) => Promise<void>;

interface ExternalChromeHandles {
  automationTarget?: ExternalBrowserAutomationTarget;
  child: ExternalChromeProcessLike;
}

export class ExternalChromeRoleAlreadyRunningError extends Error {
  readonly code = "ROLE_ALREADY_RUNNING";

  constructor(roles: Role[]) {
    super(`Already running in another game window: ${roles.map((role) => role.name).join(", ")}.`);
    this.name = "ExternalChromeRoleAlreadyRunningError";
  }
}

export class ExternalChromeManager extends EventEmitter<ExternalChromeManagerEvents> {
  private readonly handles = new Map<string, ExternalChromeHandles>();
  private beforeRoleStop?: (roleId: string) => Promise<void>;
  private macroOverlayInstaller?: ExternalMacroOverlayInstaller;
  private readonly now: () => number;

  constructor(
    private readonly roleStore: Pick<RoleStore, "ensureBrowserUserDataDir">,
    private readonly options: ExternalChromeManagerOptions
  ) {
    super();
    this.now = options.now ?? Date.now;
    options.healthMonitor.onHealth((roleId, health) => this.handleHealthChange(roleId, health));
    options.healthMonitor.onProbeFailure(({ errorMessage, roleId }) => {
      const session = this.getSession(roleId);
      if (!session) return;
      this.invokeSession({ type: "recordCdpTimeout", roleId, atMs: this.now() });
      this.options.onDiagnostic?.({
        roleId,
        type: "cdp_round_trip_timeout",
        details: { message: errorMessage.slice(0, 256), timeoutMs: EXTERNAL_CDP_ROUND_TRIP_TIMEOUT_MS }
      });
    });
  }

  hasSession(roleId: string): boolean {
    return Boolean(this.getSession(roleId));
  }

  setBeforeRoleStop(handler: (roleId: string) => Promise<void>): void {
    this.beforeRoleStop = handler;
  }

  setMacroOverlayInstaller(installer: ExternalMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  getAutomationSession(roleId: string): { role: Role; target: ExternalBrowserAutomationTarget } | undefined {
    const session = this.getSession(roleId);
    const target = this.handles.get(roleId)?.automationTarget;
    if (session?.state !== "running" || !target || session.pageHealth === "unresponsive") {
      return undefined;
    }
    return { role: session.role as Role, target };
  }

  listStatuses(): RoleStatus[] {
    return this.listSessions().map((session) => this.toStatus(session));
  }

  listDiagnostics(): ExternalChromeSessionDiagnostics[] {
    return this.listSessions().map((session) => this.createDiagnostics(session));
  }

  async captureAllDiagnostics(): Promise<ExternalChromeSessionDiagnostics[]> {
    return Promise.all(
      this.listSessions().map(async (record) => {
        const roleId = record.role.id;
        try {
          return await this.captureDiagnostics(roleId);
        } catch {
          const session = this.getSession(roleId);
          if (!session) {
            throw new Error("External Chrome role stopped while diagnostics were captured.");
          }
          return this.createDiagnostics(session);
        }
      })
    );
  }

  handleSuspend(): void {
    this.options.healthMonitor.setSuspended(true);
  }

  handleResume(): void {
    this.options.healthMonitor.setSuspended(false);
  }

  async captureDiagnostics(roleId: string): Promise<ExternalChromeSessionDiagnostics> {
    const session = this.getSession(roleId);
    if (!session) {
      throw new Error("External Chrome role is not running.");
    }
    let chrome: ExternalChromePageDiagnostics | undefined;
    if (this.handles.get(roleId)?.automationTarget) {
      try {
        chrome = await this.options.captureAutomationDiagnostics(roleId);
      } catch {
        chrome = {
          capturedAt: new Date().toISOString(),
          cdp: { consecutiveEvaluateFailures: 0 },
          errors: ["Chrome diagnostics did not respond before the timeout."]
        };
      }
    }
    return this.createDiagnostics(session, chrome);
  }

  evaluate<T = unknown>(roleId: string, source: string): Promise<T> {
    if (!this.getSession(roleId)?.automationAvailable) {
      return Promise.reject(new Error("External Chrome automation is unavailable."));
    }
    return this.options.evaluateAutomation<T>(roleId, source);
  }

  async recover(roleId: string): Promise<RoleStatus> {
    const session = this.getSession(roleId);
    if (!session || session.state !== "running") {
      throw new Error("External Chrome role is not running.");
    }
    if (session.pageHealth !== "unresponsive") {
      throw new Error("External Chrome role does not need recovery.");
    }

    const restored = {
      bounds: { ...session.bounds },
      notice: removeNotice(session.notice, EXTERNAL_PAGE_UNRESPONSIVE_NOTICE),
      physicalBounds: session.physicalBounds ? { ...session.physicalBounds } : undefined,
      role: session.role,
      workspaceId: session.workspaceId,
      zoomFactor: session.zoomFactor
    };
    await this.stopForRecovery(roleId, session);
    let replacement: ExternalSessionRecord;
    try {
      replacement = await this.launchSession(
        restored.role as Role,
        restored.bounds,
        restored.physicalBounds,
        restored.workspaceId,
        restored.notice,
        restored.zoomFactor
      );
    } catch (error) {
      // The workspace reservation may now be released because recovery did
      // not manage to create a replacement session.
      this.emitChange();
      throw error;
    }
    await this.focusAutomation(roleId).catch((error) => {
      console.warn("Failed to focus the recovered external Chrome role.", error);
    });
    return this.toStatus(replacement);
  }

  hasWorkspace(workspaceId: string): boolean {
    return this.listSessions().some((session) => session.workspaceId === workspaceId);
  }

  listWorkspaceRuntimeStatuses(): BrowserWorkspaceRuntimeStatus[] {
    const stateByWorkspaceId = new Map<string, BrowserWorkspaceRuntimeState>();
    this.listSessions().forEach((session) => {
      if (!session.workspaceId) {
        return;
      }

      const current = stateByWorkspaceId.get(session.workspaceId);
      const state = session.state === "stopping" || session.state === "launching"
        ? session.state
        : "running";
      if (state === "stopping" || current === undefined) {
        stateByWorkspaceId.set(session.workspaceId, state);
      } else if (state === "launching" && current === "running") {
        stateByWorkspaceId.set(session.workspaceId, "launching");
      }
    });

    return [...stateByWorkspaceId].map(([workspaceId, state]) => ({ workspaceId, state }));
  }

  async launch(role: Role, options: ExternalChromeLaunchOptions = {}): Promise<RoleStatus> {
    const workArea = options.workArea ?? this.options.getLaunchWorkArea();
    const bounds = {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height
    };
    const zoomFactor = this.resolveZoomFactor(
      options.zoomMode ?? "fixed",
      options.zoomFactor ?? 1,
      bounds.width
    );
    const existing = this.getSession(role.id);
    if (existing) {
      this.invokeSession({ type: "updateRole", role });
      let notice = options.notice ?? existing.notice;
      if (existing.zoomFactor !== zoomFactor) {
        notice = appendNotice(notice, EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
      }
      this.invokeSession({ type: "setNotice", roleId: role.id, ...(notice ? { notice } : {}) });
      await this.focusAutomation(role.id).catch((error) => {
        console.warn("Failed to restore focus to the external Chrome role.", error);
      });
      return this.toStatus(this.getSession(role.id)!);
    }

    const physicalBounds = this.toPhysicalBounds(bounds);
    const session = await this.launchSession(
      role,
      bounds,
      physicalBounds,
      undefined,
      options.notice,
      zoomFactor
    );
    await this.focusAutomation(role.id).catch((error) => {
      console.warn("Failed to focus the external Chrome role after launch.", error);
    });
    return this.toStatus(session);
  }

  async launchWorkspace(
    workspace: { id: string },
    items: ExternalChromeLaunchItem[],
    options: ExternalChromeLaunchOptions = {}
  ): Promise<RoleStatus[]> {
    const runningRoles = items.map((item) => item.role).filter((role) => this.hasSession(role.id));
    if (runningRoles.length > 0) {
      throw new ExternalChromeRoleAlreadyRunningError(runningRoles);
    }

    const workArea = options.workArea ?? this.options.getLaunchWorkArea();
    const physicalWorkArea = this.toPhysicalBounds(workArea);
    // External Chrome always tiles the complete work area; appearance gaps apply only to embedded hosts.
    const normalizedRects = this.options.normalizeWorkspaceRects(items.map((item) => item.rect));
    const dipBounds = createSeamlessWorkspaceBounds(
      normalizedRects.map((rect) => normalizedRectToPixelBounds(rect, workArea)),
      externalChromeSeamOverlap(this.options.platform ?? process.platform)
    );
    const physicalBounds = physicalWorkArea
      ? createSeamlessWorkspaceBounds(
          normalizedRects.map((rect) => normalizedRectToPixelBounds(rect, physicalWorkArea)),
          WINDOWS_PHYSICAL_SEAM_OVERLAP
        )
      : undefined;
    const sessions: Array<{ roleId: string; session: ExternalSessionRecord }> = [];

    try {
      const initialFocusRoleId = items[0]?.role.id;
      const launchResults = await Promise.allSettled(
        items.map((item, index) =>
          this.launchSession(
            item.role,
            dipBounds[index],
            physicalBounds?.[index],
            workspace.id,
            options.notice,
            item.browserZoomPercent !== undefined
              ? item.browserZoomPercent / 100
              : this.resolveZoomFactor(
                  options.zoomMode ?? "fixed",
                  options.zoomFactor ?? 1,
                  dipBounds[index].width
                )
          ).then((session) => ({ roleId: item.role.id, session }))
        )
      );
      launchResults.forEach((result) => {
        if (result.status === "fulfilled") sessions.push(result.value);
      });
      const failedLaunch = launchResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (failedLaunch) throw failedLaunch.reason;

      const sessionByRoleId = new Map(sessions.map(({ roleId, session }) => [roleId, session]));
      await this.focusAutomation(initialFocusRoleId ?? "").catch((error) => {
        console.warn("Failed to restore initial focus to the first external Chrome role.", error);
      });
      return items.map(({ role }) => this.toStatus(sessionByRoleId.get(role.id)!));
    } catch (error) {
      await Promise.all(sessions.map(({ roleId }) => this.stop(roleId)));
      throw error;
    }
  }

  private resolveZoomFactor(
    zoomMode: WorkspaceBrowserZoomMode,
    fixedZoomFactor: number,
    viewportWidth: number
  ): number {
    return zoomMode === "adaptive"
      ? this.options.adaptiveZoomResolver(viewportWidth) / 100
      : fixedZoomFactor;
  }

  async stop(roleId: string): Promise<void> {
    const session = this.getSession(roleId);
    if (!session) {
      return;
    }

    this.invokeSession({ type: "setStopping", roleId });
    this.emitChange();
    await this.beforeRoleStop?.(roleId);
    this.invokeSession({ type: "remove", roleId, preserveWorkspace: false });
    await this.options.healthMonitor.remove(roleId).catch(() => undefined);
    const handles = this.handles.get(roleId);
    this.handles.delete(roleId);
    const target = handles?.automationTarget;
    target?.close();
    this.options.unregisterAutomation(roleId);
    if (handles) terminateChild(handles.child);
    this.emitChange();
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const roleIds = this.listSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.role.id);
    await Promise.all(roleIds.map((roleId) => this.stop(roleId)));
  }

  private async stopForRecovery(roleId: string, session: ExternalSessionRecord): Promise<void> {
    this.invokeSession({ type: "setStopping", roleId });
    this.emitChange();
    await this.beforeRoleStop?.(roleId);
    if (this.getSession(roleId)?.launchedAt !== session.launchedAt) {
      throw new Error("External Chrome role stopped before recovery could begin.");
    }
    this.invokeSession({ type: "remove", roleId, preserveWorkspace: true });
    await this.options.healthMonitor.remove(roleId).catch(() => undefined);
    const handles = this.handles.get(roleId);
    this.handles.delete(roleId);
    const target = handles?.automationTarget;
    target?.close();
    this.options.unregisterAutomation(roleId);
    if (handles) terminateChild(handles.child);
    // Do not emit an empty workspace state here. launchSession emits the next
    // state as soon as it owns the preserved workspace again.
  }

  private async launchSession(
    role: Role,
    bounds: PixelBounds,
    physicalBounds: PixelBounds | undefined,
    workspaceId: string | undefined,
    notice: string | undefined,
    zoomFactor: number
  ): Promise<ExternalSessionRecord> {
    const executablePath = this.options.findExecutable();
    const browserUserDataDir = await this.roleStore.ensureBrowserUserDataDir(role.id);
    await this.options.prepareBrowserUserDataDir(browserUserDataDir);
    let cdnCompatibilityRequested = false;
    let proxyServer: string | undefined;
    let sessionNotice = notice;
    await this.options.applyBrowserPreferences?.(role, browserUserDataDir, zoomFactor).catch((error) => {
      console.warn("Failed to apply browser preferences before opening external Chrome.", error);
      sessionNotice = appendNotice(sessionNotice, EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
    });
    try {
      const compatibility = await this.options.prepareCdnCompatibility?.(role, browserUserDataDir);
      cdnCompatibilityRequested = compatibility?.enabled ?? false;
      proxyServer = compatibility?.proxyServer;
    } catch (error) {
      console.warn("Failed to prepare CDN compatibility mode for external Chrome.", error);
      sessionNotice = appendNotice(sessionNotice, CDN_COMPATIBILITY_UNAVAILABLE_NOTICE);
    }
    const child = this.options.spawnChrome(
      role.id,
      executablePath,
      buildExternalChromeArgs(
        role,
        browserUserDataDir,
        bounds,
        proxyServer,
        this.options.graphicsSettings,
        this.options.platform ?? process.platform
      )
    );
    const handles: ExternalChromeHandles = { child };
    this.invokeSession({
      type: "begin",
      role,
      bounds: { ...bounds },
      ...(physicalBounds ? { physicalBounds: { ...physicalBounds } } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(sessionNotice ? { notice: sessionNotice } : {}),
      zoomFactor
    });
    this.handles.set(role.id, handles);
    this.emitChange();

    try {
      await waitForSpawn(child);
    } catch (error) {
      if (this.handles.get(role.id) === handles) {
        this.handles.delete(role.id);
        this.invokeSession({ type: "remove", roleId: role.id, preserveWorkspace: false });
      }
      this.emitChange();
      throw error;
    }

    child.once("close", () => this.deleteSession(role.id, handles));
    child.once("error", () => this.deleteSession(role.id, handles));

    try {
      const target = await this.options.connectAutomation(
        browserUserDataDir,
        role.launchUrl,
        {
          cdnCompatibilityEnabled: cdnCompatibilityRequested,
          onDiagnostic: (event) => this.handleAutomationDiagnostic(role.id, handles, event),
          roleId: role.id
        }
      );
      if (this.handles.get(role.id) !== handles) {
        target.close();
        throw new Error("External Chrome closed before macro control connected.");
      }
      handles.automationTarget = target;
      this.invokeSession({
        type: "setAutomation",
        roleId: role.id,
        available: true,
        cdnActive: cdnCompatibilityRequested
      });
      this.invokeSession({ type: "setHealth", roleId: role.id, health: "healthy", pageHidden: false });
      await this.options.healthMonitor.register(role.id);
      if (cdnCompatibilityRequested) {
        sessionNotice = appendNotice(sessionNotice, CDN_COMPATIBILITY_EXTERNAL_NOTICE);
        this.invokeSession({ type: "setNotice", roleId: role.id, notice: sessionNotice });
      }
      try {
        await this.options.setAutomationWindowBounds(role.id, bounds);
      } catch (error) {
        console.warn("Failed to align external Chrome window bounds.", error);
      }
      await this.macroOverlayInstaller?.(role, target).catch((error) => {
        console.warn("Failed to install the macro overlay in external Chrome.", error);
      });
      // Register the manager listener after overlay installation so the overlay
      // scheduler removes this host before role-status listeners can request a refresh.
      target.onDisconnect(() => this.handleAutomationDisconnect(role.id, handles, target));
    } catch (error) {
      this.options.unregisterAutomation(role.id);
      if (this.handles.get(role.id) !== handles) {
        throw error;
      }
      console.warn("External Chrome macro automation is unavailable.", error);
      if (cdnCompatibilityRequested) {
        sessionNotice = appendNotice(sessionNotice, CDN_COMPATIBILITY_UNAVAILABLE_NOTICE);
      }
      sessionNotice = appendNotice(sessionNotice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
      this.invokeSession({ type: "setNotice", roleId: role.id, notice: sessionNotice });
      this.invokeSession({
        type: "setAutomation",
        roleId: role.id,
        available: false,
        cdnActive: false
      });
    }

    await this.alignVisibleWindow(child, physicalBounds);
    if (this.handles.get(role.id) !== handles) {
      throw new Error("External Chrome closed before window alignment completed.");
    }

    this.invokeSession({
      type: "setRunning",
      roleId: role.id,
      launchedAt: new Date().toISOString()
    });
    this.emitChange();
    return this.getSession(role.id)!;
  }

  private toPhysicalBounds(bounds: PixelBounds): PixelBounds | undefined {
    const adapter = this.options.windowBoundsAdapter;
    if (!adapter) {
      return undefined;
    }

    try {
      return adapter.dipToPhysicalBounds(bounds);
    } catch (error) {
      console.warn("Failed to convert external Chrome bounds to physical pixels.", error);
      return undefined;
    }
  }

  private async alignVisibleWindow(
    child: ExternalChromeProcessLike,
    physicalBounds: PixelBounds | undefined
  ): Promise<void> {
    const adapter = this.options.windowBoundsAdapter;
    if (!adapter || !physicalBounds) {
      return;
    }

    const browserProcessId = child.pid;
    if (!Number.isInteger(browserProcessId) || (browserProcessId ?? 0) <= 0) {
      console.warn("Failed to align external Chrome visible bounds because its process ID is unavailable.");
      return;
    }

    try {
      await adapter.alignVisibleBounds({
        browserProcessId: browserProcessId as number,
        physicalBounds
      });
    } catch (error) {
      console.warn("Failed to align external Chrome visible bounds.", error);
    }
  }

  private handleAutomationDiagnostic(
    roleId: string,
    handles: ExternalChromeHandles,
    event: ExternalChromeDiagnosticEvent
  ): void {
    const session = this.getSession(roleId);
    if (!session || this.handles.get(roleId) !== handles) {
      return;
    }

    if (event.type === "page_heartbeat") {
      if (typeof event.details.hidden === "boolean") {
        this.invokeSession({
          type: "setHealth",
          roleId,
          ...(session.pageHealth ? { health: session.pageHealth } : {}),
          pageHidden: event.details.hidden
        });
      }
      this.options.healthMonitor.heartbeat(
        roleId,
        typeof event.details.hidden === "boolean" ? event.details.hidden : session.pageHidden
      );
    } else if (event.type === "page_lifecycle" && typeof event.details.hidden === "boolean") {
      this.invokeSession({
        type: "setHealth",
        roleId,
        ...(session.pageHealth ? { health: session.pageHealth } : {}),
        pageHidden: event.details.hidden
      });
      this.options.healthMonitor.heartbeat(roleId, event.details.hidden);
    }

    this.options.onDiagnostic?.({ ...event, roleId });
  }

  private handleHealthChange(roleId: string, health: "healthy" | "unresponsive"): void {
    const session = this.getSession(roleId);
    if (!session || session.pageHealth === health) return;
    this.invokeSession({ type: "setHealth", roleId, health, pageHidden: session.pageHidden });
    if (health === "healthy") {
      const notice = removeNotice(session.notice, EXTERNAL_PAGE_UNRESPONSIVE_NOTICE);
      this.invokeSession({ type: "setNotice", roleId, ...(notice ? { notice } : {}) });
      this.emit("health", roleId, health);
      this.emitChange();
      return;
    }
    this.invokeSession({
      type: "setNotice",
      roleId,
      notice: appendNotice(session.notice, EXTERNAL_PAGE_UNRESPONSIVE_NOTICE)
    });
    this.emitChange();
    this.emit("health", roleId, health);
    void this.captureDiagnostics(roleId)
      .then((diagnostics) => this.emit("diagnostics", roleId, diagnostics))
      .catch(() => undefined);
  }

  private createDiagnostics(
    session: ExternalSessionRecord,
    chrome?: ExternalChromePageDiagnostics
  ): ExternalChromeSessionDiagnostics {
    const roleId = session.role.id;
    return {
      automationState: session.automationAvailable ? "ready" : "unavailable",
      bounds: { ...session.bounds },
      capturedAt: new Date().toISOString(),
      ...(session.lastCdpTimeoutAtMs !== undefined
        ? {
            cdp: {
              lastTimeoutAt: new Date(session.lastCdpTimeoutAtMs).toISOString()
            }
          }
        : {}),
      externalRoleCount: this.listSessions().length,
      ...(session.pageHealth === "healthy" || session.pageHealth === "unresponsive"
        ? { pageHealth: session.pageHealth }
        : {}),
      ...(session.physicalBounds ? { physicalBounds: { ...session.physicalBounds } } : {}),
      roleId,
      runtimeMode: "external",
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      zoomFactor: session.zoomFactor,
      ...(chrome ? { chrome } : {})
    };
  }

  private handleAutomationDisconnect(
    roleId: string,
    handles: ExternalChromeHandles,
    target: ExternalBrowserAutomationTarget
  ): void {
    const session = this.getSession(roleId);
    if (!session || this.handles.get(roleId) !== handles || handles.automationTarget !== target) {
      return;
    }
    handles.automationTarget = undefined;
    this.options.unregisterAutomation(roleId);
    void this.options.healthMonitor.remove(roleId).catch(() => undefined);
    let notice = session.notice;
    if (session.cdnActive) {
      notice = replaceNotice(
        notice,
        CDN_COMPATIBILITY_EXTERNAL_NOTICE,
        CDN_COMPATIBILITY_UNAVAILABLE_NOTICE
      );
    }
    notice = appendNotice(notice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
    this.invokeSession({ type: "setNotice", roleId, notice });
    this.invokeSession({
      type: "setAutomation",
      roleId,
      available: false,
      cdnActive: false
    });
    void this.beforeRoleStop?.(roleId);
    this.emitChange();
  }

  private deleteSession(roleId: string, handles: ExternalChromeHandles): void {
    if (!this.getSession(roleId) || this.handles.get(roleId) !== handles) {
      return;
    }

    this.handles.delete(roleId);
    this.invokeSession({ type: "remove", roleId, preserveWorkspace: false });
    void this.options.healthMonitor.remove(roleId).catch(() => undefined);
    const target = handles.automationTarget;
    handles.automationTarget = undefined;
    target?.close();
    this.options.unregisterAutomation(roleId);
    void this.beforeRoleStop?.(roleId);
    this.emitChange();
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }

  private listSessions(): ExternalSessionRecord[] {
    return this.invokeSession({ type: "snapshot" }).sessions;
  }

  private getSession(roleId: string): ExternalSessionRecord | undefined {
    return this.listSessions().find((session) => session.role.id === roleId);
  }

  private invokeSession(command: ExternalSessionCommand): ExternalSessionResult {
    return this.options.externalSessionState.invokeExternalSession(command);
  }

  private async focusAutomation(roleId: string): Promise<void> {
    if (!roleId) return;
    await this.options.focusAutomation(roleId);
  }

  private toStatus(session: ExternalSessionRecord): RoleStatus {
    return {
      roleId: session.role.id,
      state: session.state as RoleStatus["state"],
      launchedAt: session.launchedAt,
      notice: session.notice,
      runtimeMode: "external",
      ...(session.state === "running"
        ? {
            automationState: session.automationAvailable ? "ready" as const : "unavailable" as const,
            ...(session.pageHealth === "healthy" || session.pageHealth === "unresponsive"
              ? { pageHealth: session.pageHealth }
              : {})
          }
        : {})
    };
  }
}

export function buildExternalChromeArgs(
  role: Role,
  browserUserDataDir: string,
  bounds: PixelBounds,
  proxyServer?: string,
  graphicsSettings: BrowserGraphicsSettings = DEFAULT_BROWSER_GRAPHICS_SETTINGS,
  platform: NodeJS.Platform = process.platform
): string[] {
  return [
    `--user-data-dir=${browserUserDataDir}`,
    "--profile-directory=Default",
    `--app=${role.launchUrl}`,
    `--window-position=${bounds.x},${bounds.y}`,
    `--window-size=${bounds.width},${bounds.height}`,
    ...BROWSER_BASE_SWITCHES.map((name) => `--${name}`),
    ...getExternalChromeBackgroundSwitches(platform).map((name) => `--${name}`),
    `--disable-features=${BROWSER_BACKGROUND_FEATURES_TO_DISABLE.join(",")}`,
    ...getGraphicsSwitches(graphicsSettings, platform).map(formatChromiumSwitch),
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    ...(proxyServer ? [`--proxy-server=${proxyServer}`] : [])
  ];
}

export function getExternalChromeBackgroundSwitches(platform: NodeJS.Platform): string[] {
  // Keep the platform argument so callers and platform-table tests retain the
  // same contract. Foreground priority intentionally relies on Chrome's native
  // background handling on both supported desktop platforms.
  void platform;
  return [...EXTERNAL_CHROME_FOREGROUND_PRIORITY_SWITCHES];
}

const EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE =
  "Macro control could not connect to compatibility mode. Restart this role to try again.";
export const EXTERNAL_PAGE_UNRESPONSIVE_NOTICE =
  "The external Chrome game page stopped responding. Capture diagnostics or restart this role.";
export const EXTERNAL_ZOOM_UNAVAILABLE_NOTICE =
  "Workspace zoom could not be applied in external Chrome. Restart this role to try again.";

// Native Chrome windows retain OS-drawn corners and frame pixels even when their
// rectangles touch. A small internal overlap keeps the desktop from showing
// through those decorations. macOS needs enough overlap to cover its rounded
// window corners; Windows additionally squares and removes the DWM border in the
// native frame helper, so one physical pixel is sufficient as a fallback.
const MACOS_SEAM_OVERLAP = 12;
const WINDOWS_DIP_SEAM_OVERLAP = 1;
const WINDOWS_PHYSICAL_SEAM_OVERLAP = 1;
export const EXTERNAL_CDP_ROUND_TRIP_TIMEOUT_MS = 4_000;

function appendNotice(current: string | undefined, next: string): string {
  if (!current) return next;
  if (current.includes(next)) return current;
  return `${current} ${next}`;
}

function removeNotice(current: string | undefined, notice: string): string | undefined {
  const remaining = current?.replace(notice, "").replace(/\s{2,}/g, " ").trim();
  return remaining || undefined;
}

function replaceNotice(current: string | undefined, previous: string, next: string): string {
  const remaining = current?.replace(previous, "").trim();
  return appendNotice(remaining || undefined, next);
}

function waitForSpawn(child: ExternalChromeProcessLike): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function terminateChild(child: ExternalChromeProcessLike): void {
  if (child.killed || child.exitCode !== null) {
    return;
  }

  child.kill();
}

function normalizedRectToPixelBounds(rect: NormalizedRect, contentBounds: PixelBounds): PixelBounds {
  const left = Math.round(rect.x * contentBounds.width);
  const top = Math.round(rect.y * contentBounds.height);
  const right = Math.round((rect.x + rect.width) * contentBounds.width);
  const bottom = Math.round((rect.y + rect.height) * contentBounds.height);

  return {
    x: contentBounds.x + left,
    y: contentBounds.y + top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

function externalChromeSeamOverlap(platform: NodeJS.Platform): number {
  if (platform === "darwin") {
    return MACOS_SEAM_OVERLAP;
  }
  return platform === "win32" ? WINDOWS_DIP_SEAM_OVERLAP : 0;
}

export function createSeamlessWorkspaceBounds(
  bounds: PixelBounds[],
  seamOverlap: number
): PixelBounds[] {
  if (seamOverlap <= 0 || bounds.length < 2) {
    return bounds.map((item) => ({ ...item }));
  }

  const result = bounds.map((item) => ({ ...item }));

  for (let leftIndex = 0; leftIndex < bounds.length; leftIndex += 1) {
    const left = bounds[leftIndex];
    const leftRight = left.x + left.width;
    const leftBottom = left.y + left.height;

    for (let rightIndex = leftIndex + 1; rightIndex < bounds.length; rightIndex += 1) {
      const right = bounds[rightIndex];
      const rightRight = right.x + right.width;
      const rightBottom = right.y + right.height;
      const verticalOverlap = Math.min(leftBottom, rightBottom) - Math.max(left.y, right.y);
      const horizontalOverlap = Math.min(leftRight, rightRight) - Math.max(left.x, right.x);

      // Expand only the earlier window across each seam. The resulting overlap
      // fills either window's transparent corner regardless of which one is in
      // front, while avoiding a double-width overlap.
      if (verticalOverlap > 0) {
        if (leftRight === right.x) {
          result[leftIndex].width += seamOverlap;
        } else if (rightRight === left.x) {
          result[leftIndex].x -= seamOverlap;
          result[leftIndex].width += seamOverlap;
        }
      }

      if (horizontalOverlap > 0) {
        if (leftBottom === right.y) {
          result[leftIndex].height += seamOverlap;
        } else if (rightBottom === left.y) {
          result[leftIndex].y -= seamOverlap;
          result[leftIndex].height += seamOverlap;
        }
      }
    }
  }

  return result;
}
