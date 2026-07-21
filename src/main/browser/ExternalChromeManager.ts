import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import type { RoleStore } from "../roles/RoleStore";
import {
  CDN_COMPATIBILITY_EXTERNAL_NOTICE,
  CDN_COMPATIBILITY_UNAVAILABLE_NOTICE
} from "../game-browser/CdnCompatibilityManager";
import { findSystemChromeExecutable } from "../system-browser/SystemChromeLauncher";
import {
  BROWSER_BACKGROUND_FEATURES_TO_DISABLE,
  BROWSER_BASE_SWITCHES,
  EXTERNAL_CHROME_FOREGROUND_PRIORITY_SWITCHES,
  getGraphicsModeSwitches
} from "../../shared/browserGraphics";
import type {
  BrowserGraphicsMode,
  NormalizedRect,
  PixelBounds,
  Role,
  RoleStatus,
  WorkspaceBrowserZoomMode,
  WorkspaceSlotBrowserZoomPercent
} from "../../shared/types";
import {
  getAdaptiveWorkspaceBrowserZoomPercent,
  normalizeWorkspaceRectEdges
} from "../../shared/workspaceLayout";
import {
  connectExternalChromeAutomation,
  type ConnectExternalChromeAutomationOptions,
  type ExternalChromeDiagnosticEvent,
  type ExternalChromePageDiagnostics,
  type ExternalBrowserAutomationTarget
} from "./ExternalChromeAutomationTarget";
import type { ExternalChromeWindowBoundsAdapter } from "./WindowsExternalChromeWindowBoundsAdapter";
import type {
  BrowserWorkspaceRuntimeState,
  BrowserWorkspaceRuntimeStatus
} from "./BrowserManager";
import type { ExternalChromeProcessLike } from "../core/nativeCore";

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
  applyBrowserFonts?: (role: Role, browserUserDataDir: string) => Promise<void>;
  applyBrowserZoom?: (browserUserDataDir: string, zoomFactor: number) => Promise<void>;
  prepareCdnCompatibility?: (
    role: Role,
    browserUserDataDir: string
  ) => Promise<{ enabled: boolean; proxyServer?: string }>;
  prepareBrowserUserDataDir?: (browserUserDataDir: string) => Promise<void>;
  findExecutable?: () => string;
  getLaunchWorkArea: () => PixelBounds;
  graphicsMode?: BrowserGraphicsMode;
  onDiagnostic?: (event: ExternalChromeDiagnosticEvent & { roleId: string }) => void;
  now?: () => number;
  platform?: NodeJS.Platform;
  setInterval?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  windowBoundsAdapter?: ExternalChromeWindowBoundsAdapter;
  spawnChrome?: (executablePath: string, args: string[]) => ExternalChromeProcessLike;
  connectAutomation?: (
    browserUserDataDir: string,
    launchUrl: string,
    options?: Pick<
      ConnectExternalChromeAutomationOptions,
      "cdnCompatibilityEnabled" | "onDiagnostic" | "platform"
    >
  ) => Promise<ExternalBrowserAutomationTarget>;
}

export type ExternalMacroOverlayInstaller = (
  role: Role,
  target: ExternalBrowserAutomationTarget
) => Promise<void>;

interface ExternalChromeSession {
  automationTarget?: ExternalBrowserAutomationTarget;
  bounds: PixelBounds;
  cdpProbeInFlight?: boolean;
  cdnCompatibilityActive: boolean;
  child: ExternalChromeProcessLike;
  launchedAt?: string;
  lastHeartbeatAt?: number;
  lastCdpRoundTripAt?: number;
  lastCdpTimeoutAt?: number;
  notice?: string;
  pageHealth?: "healthy" | "unresponsive";
  pageHidden: boolean;
  physicalBounds?: PixelBounds;
  role: Role;
  state: RoleStatus["state"];
  workspaceId?: string;
  zoomFactor: number;
}

export class ExternalChromeRoleAlreadyRunningError extends Error {
  readonly code = "ROLE_ALREADY_RUNNING";

  constructor(roles: Role[]) {
    super(`Already running in another game window: ${roles.map((role) => role.name).join(", ")}.`);
    this.name = "ExternalChromeRoleAlreadyRunningError";
  }
}

export class ExternalChromeManager extends EventEmitter<ExternalChromeManagerEvents> {
  private readonly sessions = new Map<string, ExternalChromeSession>();
  private beforeRoleStop?: (roleId: string) => Promise<void>;
  private macroOverlayInstaller?: ExternalMacroOverlayInstaller;
  private readonly now: () => number;
  private suspended = false;

  constructor(
    private readonly roleStore: Pick<RoleStore, "ensureBrowserUserDataDir">,
    private readonly options: ExternalChromeManagerOptions
  ) {
    super();
    this.now = options.now ?? Date.now;
    const setIntervalFn = options.setInterval ?? setInterval;
    const healthTimer = setIntervalFn(() => this.checkPageHealth(), EXTERNAL_HEARTBEAT_INTERVAL_MS);
    if (typeof healthTimer !== "number") {
      healthTimer.unref?.();
    }
  }

  hasSession(roleId: string): boolean {
    return this.sessions.has(roleId);
  }

  setBeforeRoleStop(handler: (roleId: string) => Promise<void>): void {
    this.beforeRoleStop = handler;
  }

  setMacroOverlayInstaller(installer: ExternalMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  getAutomationSession(roleId: string): { role: Role; target: ExternalBrowserAutomationTarget } | undefined {
    const session = this.sessions.get(roleId);
    if (session?.state !== "running" || !session.automationTarget || session.pageHealth === "unresponsive") {
      return undefined;
    }
    return { role: session.role, target: session.automationTarget };
  }

  listStatuses(): RoleStatus[] {
    return [...this.sessions.entries()].map(([roleId, session]) => this.toStatus(roleId, session));
  }

  listDiagnostics(): ExternalChromeSessionDiagnostics[] {
    return [...this.sessions.entries()].map(([roleId, session]) => this.createDiagnostics(roleId, session));
  }

  async captureAllDiagnostics(): Promise<ExternalChromeSessionDiagnostics[]> {
    return Promise.all(
      [...this.sessions.keys()].map(async (roleId) => {
        try {
          return await this.captureDiagnostics(roleId);
        } catch {
          const session = this.sessions.get(roleId);
          if (!session) {
            throw new Error("External Chrome role stopped while diagnostics were captured.");
          }
          return this.createDiagnostics(roleId, session);
        }
      })
    );
  }

  handleSuspend(): void {
    this.suspended = true;
  }

  handleResume(): void {
    const resumedAt = this.now();
    this.suspended = false;
    this.sessions.forEach((session) => {
      session.lastHeartbeatAt = resumedAt;
    });
  }

  async captureDiagnostics(roleId: string): Promise<ExternalChromeSessionDiagnostics> {
    const session = this.sessions.get(roleId);
    if (!session) {
      throw new Error("External Chrome role is not running.");
    }
    let chrome: ExternalChromePageDiagnostics | undefined;
    if (session.automationTarget) {
      try {
        chrome = await withCdpRoundTripTimeout(
          session.automationTarget.collectDiagnostics(),
          EXTERNAL_CDP_ROUND_TRIP_TIMEOUT_MS
        );
      } catch {
        chrome = {
          capturedAt: new Date().toISOString(),
          cdp: { consecutiveEvaluateFailures: 0 },
          errors: ["Chrome diagnostics did not respond before the timeout."]
        };
      }
    }
    return this.createDiagnostics(roleId, session, chrome);
  }

  async recover(roleId: string): Promise<RoleStatus> {
    const session = this.sessions.get(roleId);
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
    let replacement: ExternalChromeSession;
    try {
      replacement = await this.launchSession(
        restored.role,
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
    await replacement.automationTarget?.focus().catch((error) => {
      console.warn("Failed to focus the recovered external Chrome role.", error);
    });
    return this.toStatus(roleId, replacement);
  }

  hasWorkspace(workspaceId: string): boolean {
    return [...this.sessions.values()].some((session) => session.workspaceId === workspaceId);
  }

  listWorkspaceRuntimeStatuses(): BrowserWorkspaceRuntimeStatus[] {
    const stateByWorkspaceId = new Map<string, BrowserWorkspaceRuntimeState>();
    this.sessions.forEach((session) => {
      if (!session.workspaceId) {
        return;
      }

      const current = stateByWorkspaceId.get(session.workspaceId);
      if (session.state === "stopping" || current === undefined) {
        stateByWorkspaceId.set(session.workspaceId, session.state);
      } else if (session.state === "launching" && current === "running") {
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
    const zoomFactor = resolveExternalChromeZoomFactor(
      options.zoomMode ?? "fixed",
      options.zoomFactor ?? 1,
      bounds.width
    );
    const existing = this.sessions.get(role.id);
    if (existing) {
      existing.role = role;
      existing.notice = options.notice ?? existing.notice;
      if (existing.zoomFactor !== zoomFactor) {
        existing.notice = appendNotice(existing.notice, EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
      }
      await existing.automationTarget?.focus().catch((error) => {
        console.warn("Failed to restore focus to the external Chrome role.", error);
      });
      return this.toStatus(role.id, existing);
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
    await session.automationTarget?.focus().catch((error) => {
      console.warn("Failed to focus the external Chrome role after launch.", error);
    });
    return this.toStatus(role.id, session);
  }

  async launchWorkspace(
    workspace: { id: string },
    items: ExternalChromeLaunchItem[],
    options: ExternalChromeLaunchOptions = {}
  ): Promise<RoleStatus[]> {
    const runningRoles = items.map((item) => item.role).filter((role) => this.sessions.has(role.id));
    if (runningRoles.length > 0) {
      throw new ExternalChromeRoleAlreadyRunningError(runningRoles);
    }

    const workArea = options.workArea ?? this.options.getLaunchWorkArea();
    const physicalWorkArea = this.toPhysicalBounds(workArea);
    // External Chrome always tiles the complete work area; appearance gaps apply only to embedded hosts.
    const normalizedRects = normalizeWorkspaceRectEdges(items.map((item) => item.rect));
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
    const sessions: Array<{ roleId: string; session: ExternalChromeSession }> = [];

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
              : resolveExternalChromeZoomFactor(
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
      await sessionByRoleId.get(initialFocusRoleId ?? "")?.automationTarget?.focus().catch((error) => {
        console.warn("Failed to restore initial focus to the first external Chrome role.", error);
      });
      return items.map(({ role }) => this.toStatus(role.id, sessionByRoleId.get(role.id)!));
    } catch (error) {
      await Promise.all(sessions.map(({ roleId }) => this.stop(roleId)));
      throw error;
    }
  }

  async stop(roleId: string): Promise<void> {
    const session = this.sessions.get(roleId);
    if (!session) {
      return;
    }

    session.state = "stopping";
    this.emitChange();
    await this.beforeRoleStop?.(roleId);
    this.sessions.delete(roleId);
    const target = session.automationTarget;
    session.automationTarget = undefined;
    target?.close();
    terminateChild(session.child);
    this.emitChange();
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const roleIds = [...this.sessions.entries()]
      .filter(([, session]) => session.workspaceId === workspaceId)
      .map(([roleId]) => roleId);
    await Promise.all(roleIds.map((roleId) => this.stop(roleId)));
  }

  private async stopForRecovery(roleId: string, session: ExternalChromeSession): Promise<void> {
    session.state = "stopping";
    this.emitChange();
    await this.beforeRoleStop?.(roleId);
    if (this.sessions.get(roleId) !== session) {
      throw new Error("External Chrome role stopped before recovery could begin.");
    }
    this.sessions.delete(roleId);
    const target = session.automationTarget;
    session.automationTarget = undefined;
    target?.close();
    terminateChild(session.child);
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
  ): Promise<ExternalChromeSession> {
    const executablePath = (this.options.findExecutable ?? findSystemChromeExecutable)();
    const browserUserDataDir = await this.roleStore.ensureBrowserUserDataDir(role.id);
    await (this.options.prepareBrowserUserDataDir ?? removeStaleDevToolsPort)(browserUserDataDir);
    await this.options.applyBrowserFonts?.(role, browserUserDataDir).catch((error) => {
      console.warn("Failed to apply browser font settings before opening external Chrome.", error);
    });
    let cdnCompatibilityRequested = false;
    let proxyServer: string | undefined;
    let sessionNotice = notice;
    await this.options.applyBrowserZoom?.(browserUserDataDir, zoomFactor).catch((error) => {
      console.warn("Failed to apply workspace zoom before opening external Chrome.", error);
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
    const child = (this.options.spawnChrome ?? spawnChrome)(
      executablePath,
      buildExternalChromeArgs(
        role,
        browserUserDataDir,
        bounds,
        proxyServer,
        this.options.graphicsMode,
        this.options.platform ?? process.platform
      )
    );
    const session: ExternalChromeSession = {
      cdnCompatibilityActive: false,
      child,
      bounds: { ...bounds },
      notice: sessionNotice,
      pageHidden: false,
      ...(physicalBounds ? { physicalBounds: { ...physicalBounds } } : {}),
      role,
      state: "launching",
      workspaceId,
      zoomFactor
    };
    this.sessions.set(role.id, session);
    this.emitChange();

    try {
      await waitForSpawn(child);
    } catch (error) {
      this.sessions.delete(role.id);
      this.emitChange();
      throw error;
    }

    child.once("close", () => this.deleteSession(role.id, session));
    child.once("error", () => this.deleteSession(role.id, session));

    try {
      const target = await (this.options.connectAutomation ?? connectExternalChromeAutomation)(
        browserUserDataDir,
        role.launchUrl,
        {
          cdnCompatibilityEnabled: cdnCompatibilityRequested,
          onDiagnostic: (event) => this.handleAutomationDiagnostic(role.id, session, event),
          platform: this.options.platform ?? process.platform
        }
      );
      if (this.sessions.get(role.id) !== session) {
        target.close();
        throw new Error("External Chrome closed before macro control connected.");
      }
      session.automationTarget = target;
      session.lastHeartbeatAt = this.now();
      session.lastCdpRoundTripAt = session.lastHeartbeatAt;
      session.pageHealth = "healthy";
      session.cdnCompatibilityActive = cdnCompatibilityRequested;
      if (session.cdnCompatibilityActive) {
        session.notice = appendNotice(session.notice, CDN_COMPATIBILITY_EXTERNAL_NOTICE);
      }
      try {
        await target.setWindowBounds(bounds);
      } catch (error) {
        console.warn("Failed to align external Chrome window bounds.", error);
      }
      await this.macroOverlayInstaller?.(role, target).catch((error) => {
        console.warn("Failed to install the macro overlay in external Chrome.", error);
      });
      // Register the manager listener after overlay installation so the overlay
      // scheduler removes this host before role-status listeners can request a refresh.
      target.onDisconnect(() => this.handleAutomationDisconnect(role.id, session, target));
    } catch (error) {
      if (this.sessions.get(role.id) !== session) {
        throw error;
      }
      console.warn("External Chrome macro automation is unavailable.", error);
      if (cdnCompatibilityRequested) {
        session.notice = appendNotice(session.notice, CDN_COMPATIBILITY_UNAVAILABLE_NOTICE);
      }
      session.notice = appendNotice(session.notice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
    }

    await this.alignVisibleWindow(child, physicalBounds);
    if (this.sessions.get(role.id) !== session) {
      throw new Error("External Chrome closed before window alignment completed.");
    }

    session.state = "running";
    session.launchedAt = new Date().toISOString();
    this.emitChange();
    return session;
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
    session: ExternalChromeSession,
    event: ExternalChromeDiagnosticEvent
  ): void {
    if (this.sessions.get(roleId) !== session) {
      return;
    }

    if (event.type === "page_heartbeat") {
      session.lastHeartbeatAt = this.now();
      if (typeof event.details.hidden === "boolean") {
        session.pageHidden = event.details.hidden;
      }
      if (session.pageHealth === "unresponsive") {
        session.pageHealth = "healthy";
        session.notice = removeNotice(session.notice, EXTERNAL_PAGE_UNRESPONSIVE_NOTICE);
        this.emit("health", roleId, "healthy");
        this.emitChange();
      }
    } else if (event.type === "page_lifecycle" && typeof event.details.hidden === "boolean") {
      session.pageHidden = event.details.hidden;
      // A page becoming visible again may report its next animation-frame
      // heartbeat just after this lifecycle event. Give that transition the
      // same grace period as a system resume.
      if (!event.details.hidden) {
        session.lastHeartbeatAt = this.now();
      }
    }

    this.options.onDiagnostic?.({ ...event, roleId });
  }

  private checkPageHealth(): void {
    if (this.suspended) {
      return;
    }
    const now = this.now();
    this.sessions.forEach((session, roleId) => {
      this.probeCdpRoundTrip(roleId, session, now);
      if (
        session.state !== "running" ||
        !session.automationTarget ||
        session.pageHealth === "unresponsive" ||
        session.pageHidden ||
        session.lastHeartbeatAt === undefined ||
        now - session.lastHeartbeatAt < EXTERNAL_HEARTBEAT_STALL_MS
      ) {
        return;
      }

      session.pageHealth = "unresponsive";
      session.notice = appendNotice(session.notice, EXTERNAL_PAGE_UNRESPONSIVE_NOTICE);
      this.emitChange();
      this.emit("health", roleId, "unresponsive");
      void this.captureDiagnostics(roleId)
        .then((diagnostics) => this.emit("diagnostics", roleId, diagnostics))
        .catch(() => undefined);
    });
  }

  private probeCdpRoundTrip(roleId: string, session: ExternalChromeSession, now: number): void {
    if (
      this.suspended ||
      session.state !== "running" ||
      !session.automationTarget ||
      session.cdpProbeInFlight ||
      (session.lastCdpRoundTripAt !== undefined && now - session.lastCdpRoundTripAt < EXTERNAL_CDP_ROUND_TRIP_INTERVAL_MS)
    ) {
      return;
    }

    const target = session.automationTarget;
    session.cdpProbeInFlight = true;
    void withCdpRoundTripTimeout(target.evaluate("void 0"), EXTERNAL_CDP_ROUND_TRIP_TIMEOUT_MS)
      .then(() => {
        if (this.sessions.get(roleId) !== session) return;
        session.lastCdpRoundTripAt = this.now();
      })
      .catch((error) => {
        if (this.sessions.get(roleId) !== session) return;
        session.lastCdpTimeoutAt = this.now();
        this.options.onDiagnostic?.({
          roleId,
          type: "cdp_round_trip_timeout",
          details: {
            message: error instanceof Error ? error.message.slice(0, 256) : "CDP round trip failed.",
            timeoutMs: EXTERNAL_CDP_ROUND_TRIP_TIMEOUT_MS
          }
        });
      })
      .finally(() => {
        if (this.sessions.get(roleId) === session) {
          session.cdpProbeInFlight = false;
        }
      });
  }

  private createDiagnostics(
    roleId: string,
    session: ExternalChromeSession,
    chrome?: ExternalChromePageDiagnostics
  ): ExternalChromeSessionDiagnostics {
    return {
      automationState: session.automationTarget ? "ready" : "unavailable",
      bounds: { ...session.bounds },
      capturedAt: new Date().toISOString(),
      ...(session.lastCdpRoundTripAt !== undefined || session.lastCdpTimeoutAt !== undefined
        ? {
            cdp: {
              ...(session.lastCdpRoundTripAt !== undefined
                ? { lastRoundTripAt: new Date(session.lastCdpRoundTripAt).toISOString() }
                : {}),
              ...(session.lastCdpTimeoutAt !== undefined
                ? { lastTimeoutAt: new Date(session.lastCdpTimeoutAt).toISOString() }
                : {})
            }
          }
        : {}),
      externalRoleCount: this.sessions.size,
      ...(session.pageHealth ? { pageHealth: session.pageHealth } : {}),
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
    session: ExternalChromeSession,
    target: ExternalBrowserAutomationTarget
  ): void {
    if (this.sessions.get(roleId) !== session || session.automationTarget !== target) {
      return;
    }
    session.automationTarget = undefined;
    if (session.cdnCompatibilityActive) {
      session.cdnCompatibilityActive = false;
      session.notice = replaceNotice(
        session.notice,
        CDN_COMPATIBILITY_EXTERNAL_NOTICE,
        CDN_COMPATIBILITY_UNAVAILABLE_NOTICE
      );
    }
    session.notice = appendNotice(session.notice, EXTERNAL_AUTOMATION_UNAVAILABLE_NOTICE);
    void this.beforeRoleStop?.(roleId);
    this.emitChange();
  }

  private deleteSession(roleId: string, session: ExternalChromeSession): void {
    if (this.sessions.get(roleId) !== session) {
      return;
    }

    this.sessions.delete(roleId);
    const target = session.automationTarget;
    session.automationTarget = undefined;
    target?.close();
    void this.beforeRoleStop?.(roleId);
    this.emitChange();
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }

  private toStatus(roleId: string, session: ExternalChromeSession): RoleStatus {
    return {
      roleId,
      state: session.state,
      launchedAt: session.launchedAt,
      notice: session.notice,
      runtimeMode: "external",
      ...(session.state === "running"
        ? {
            automationState: session.automationTarget ? "ready" as const : "unavailable" as const,
            ...(session.pageHealth ? { pageHealth: session.pageHealth } : {})
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
  graphicsMode: BrowserGraphicsMode = "automatic",
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
    ...getGraphicsModeSwitches(graphicsMode).map((name) => `--${name}`),
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
export const EXTERNAL_HEARTBEAT_INTERVAL_MS = 5_000;
export const EXTERNAL_HEARTBEAT_STALL_MS = 15_000;
export const EXTERNAL_CDP_ROUND_TRIP_INTERVAL_MS = 15_000;
export const EXTERNAL_CDP_ROUND_TRIP_TIMEOUT_MS = 4_000;

async function removeStaleDevToolsPort(browserUserDataDir: string): Promise<void> {
  await unlink(join(browserUserDataDir, "DevToolsActivePort")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

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

function withCdpRoundTripTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Chrome DevTools round trip timed out.")), timeoutMs);
    timeoutId.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function spawnChrome(executablePath: string, args: string[]): ExternalChromeProcessLike {
  return spawn(executablePath, args, { stdio: "ignore" });
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

function resolveExternalChromeZoomFactor(
  zoomMode: WorkspaceBrowserZoomMode,
  fixedZoomFactor: number,
  viewportWidth: number
): number {
  return zoomMode === "adaptive"
    ? getAdaptiveWorkspaceBrowserZoomPercent(viewportWidth) / 100
    : fixedZoomFactor;
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
