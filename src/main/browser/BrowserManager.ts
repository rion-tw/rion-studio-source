import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  BaseWindow,
  BaseWindowConstructorOptions,
  BrowserWindowConstructorOptions,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions
} from "electron";

import {
  classifyAuthSession,
  NO_PERSISTED_LOGIN_SESSION_MESSAGE,
  type AuthSessionCheckResult
} from "../auth/authSessionClassification";
import {
  createLoginStorageSnapshot,
  isPersistedLoginStorageReady,
  LOGIN_STORAGE_EXPRESSION
} from "../auth/loginEvidence";
import type { RoleStore } from "../roles/RoleStore";
import { DEFAULT_WORKSPACE_APPEARANCE_SETTINGS } from "../../shared/browserFonts";
import type {
  BrowserLaunchMode,
  LaunchWorkspace,
  NormalizedRect,
  PixelBounds,
  Role,
  RoleStatus,
  WorkspaceAppearanceSettings
} from "../../shared/types";
import { WORKSPACE_RESIZE_INDICATOR_CHANNEL } from "../../shared/internalIpc";
import {
  MIN_WORKSPACE_SLOT_SIZE,
  normalizeWorkspaceRectEdges
} from "../../shared/workspaceLayout";
import {
  formatWorkspaceResizeRatio,
  snapWorkspaceResizePosition,
  type WorkspaceResizeIndicatorPayload
} from "../../shared/workspaceResize";
import type { ExternalChromeLaunchItem, ExternalChromeManager } from "./ExternalChromeManager";
import { ElectronAutomationTarget, type BrowserAutomationTarget } from "./ElectronAutomationTarget";
import { ElectronWorkspaceResourceTarget } from "./ElectronWorkspaceResourceTarget";
import type { SystemPressureSource } from "./SystemPressureMonitor";
import {
  WorkspaceResourceCoordinator,
  type WorkspaceResourceTarget
} from "./WorkspaceResourceCoordinator";

export interface BrowserManagerEvents {
  change: [RoleStatus[]];
}

export interface BrowserLaunchOptions {
  zoomFactor?: number;
}

export interface BrowserWorkspaceLaunchItem {
  rect: NormalizedRect;
  role: Role;
}

export interface BrowserWorkspaceLaunchTarget {
  displayId: number;
  workArea: PixelBounds;
}

export type BrowserWorkspaceRuntimeState = "launching" | "running" | "stopping";

export interface BrowserWorkspaceRuntimeStatus {
  workspaceId: string;
  state: BrowserWorkspaceRuntimeState;
}

export interface BrowserAutomationSession {
  role: Role;
  target: BrowserAutomationTarget;
}

export type BrowserMacroOverlayInstaller = (role: Role, webContents: WebContents) => Promise<void>;
export type BrowserProxyApplier = (role: Role, partition: string, session: Session) => Promise<void>;
export type BrowserCdnCompatibilityApplier = (role: Role, partition: string, session: Session) => Promise<void>;
export type BeforeRolesStop = (roleIds: string[]) => Promise<void>;

export interface BrowserManagerOptions {
  applyBrowserFonts?: (role: Role, partition: string) => Promise<void>;
  applyBrowserProxy?: BrowserProxyApplier;
  applyCdnCompatibility?: BrowserCdnCompatibilityApplier;
  createHostWindow: (options: BaseWindowConstructorOptions) => BaseWindow;
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  dividerPreloadPath: string;
  embeddedPreloadPath: string;
  externalChromeManager?: ExternalChromeManager;
  getBrowserLaunchMode?: (role?: Role) => BrowserLaunchMode | Promise<BrowserLaunchMode>;
  getLoginUrl?: (role: Role) => string | Promise<string>;
  getLaunchWorkArea: () => PixelBounds;
  getWorkspaceAppearanceSettings?: () =>
    | WorkspaceAppearanceSettings
    | Promise<WorkspaceAppearanceSettings>;
  platform?: NodeJS.Platform;
  prefersReducedTransparency?: () => boolean;
  loginPollIntervalMs?: number;
  resourcePressureMonitor?: SystemPressureSource;
}

export class BrowserLaunchAuthError extends Error {
  readonly code = "LOGIN_REQUIRED_AFTER_LAUNCH";

  constructor(message = NO_PERSISTED_LOGIN_SESSION_MESSAGE) {
    super(message);
    this.name = "BrowserLaunchAuthError";
  }
}

export class BrowserGameLoadError extends Error {
  readonly code = "GAME_PAGE_LOAD_FAILED";

  constructor() {
    super(
      "Unable to load the game page. If you use a game accelerator, enable global, TUN, or system proxy mode, or set a local proxy in Game settings."
    );
    this.name = "BrowserGameLoadError";
  }
}

export class BrowserLoginCancelledError extends Error {
  constructor() {
    super("Login flow was cancelled.");
    this.name = "BrowserLoginCancelledError";
  }
}

export class BrowserRoleAlreadyRunningError extends Error {
  readonly code = "ROLE_ALREADY_RUNNING";
  readonly roleNames: string[];

  constructor(roles: Role[]) {
    const roleNames = roles.map((role) => role.name);
    super(`Already running in another game window: ${roleNames.join(", ")}.`);
    this.name = "BrowserRoleAlreadyRunningError";
    this.roleNames = roleNames;
  }
}

export class BrowserWorkspaceDisplayOccupiedError extends Error {
  readonly code = "WORKSPACE_DISPLAY_OCCUPIED";

  constructor(
    readonly displayId: number,
    readonly occupiedByWorkspaceId: string
  ) {
    super("Launch workspace target display is already occupied.");
    this.name = "BrowserWorkspaceDisplayOccupiedError";
  }
}

interface GameHostWindow {
  activeDividerResize?: ActiveGameDividerResize;
  closing: boolean;
  dividers: GameDivider[];
  id: string;
  roleIds: Set<string>;
  workspaceAppearance: WorkspaceAppearanceSettings;
  window: BaseWindow;
  workspaceId?: string;
}

type DividerAxis = "horizontal" | "vertical";

interface GameDivider {
  afterRoleIds: string[];
  axis: DividerAxis;
  beforeRoleIds: string[];
  defaultPosition: number;
  view: WebContentsView;
}

interface ActiveGameDividerResize {
  divider: GameDivider;
  roleIds: string[];
  snappedPosition: number;
}

interface GameDividerResizeResult {
  changed: boolean;
  position: number;
  roleIds: string[];
}

export type GameDividerPointerPayload =
  | { phase: "move" | "start"; screenPosition: number }
  | { phase: "end" }
  | { phase: "reset" };

export const GAME_DIVIDER_POINTER_CHANNEL = "game-divider:pointer";

interface BrowserSession {
  hostId: string;
  launchedAt?: string;
  popupViews: Set<WebContentsView>;
  rect: NormalizedRect;
  role: Role;
  state: RoleStatus["state"];
  target: BrowserAutomationTarget;
  view: WebContentsView;
  zoomFactor: number;
}

const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
export const EXTERNAL_COMPAT_NOTICE =
  "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.";
const FULL_WINDOW_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };
const WORKSPACE_LAUNCH_CONCURRENCY = 2;

function getWorkspaceWindowMaterialOptions(
  platform: NodeJS.Platform,
  prefersReducedTransparency: boolean
): Partial<BaseWindowConstructorOptions> {
  if (prefersReducedTransparency) {
    return { backgroundColor: "#52525B" };
  }

  if (platform === "darwin") {
    return {
      backgroundColor: "#000000",
      vibrancy: "under-window",
      visualEffectState: "followWindow"
    };
  }

  if (platform === "win32") {
    return {
      backgroundColor: "#202024",
      backgroundMaterial: "acrylic"
    };
  }

  return { backgroundColor: "#000000" };
}

export class BrowserManager extends EventEmitter<BrowserManagerEvents> {
  private readonly blockedRoleIds = new Set<string>();
  private readonly dividerByWebContentsId = new Map<number, { divider: GameDivider; hostId: string }>();
  private readonly hosts = new Map<string, GameHostWindow>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly pendingWorkspaceLaunchIds = new Set<string>();
  private readonly roleOperationTails = new Map<string, Promise<void>>();
  private readonly workspaceDisplayReservations = new Map<string, { displayId: number; name: string }>();
  private readonly workspaceHostIds = new Map<string, string>();
  private readonly resourceCoordinator: WorkspaceResourceCoordinator;
  private beforeRolesStop?: BeforeRolesStop;
  private macroOverlayInstaller?: BrowserMacroOverlayInstaller;

  constructor(
    private readonly roleStore: Pick<RoleStore, "updateAuthState">,
    private readonly options: BrowserManagerOptions
  ) {
    super();
    this.resourceCoordinator = new WorkspaceResourceCoordinator(options.resourcePressureMonitor);
    this.options.externalChromeManager?.on("change", () => {
      this.cleanupWorkspaceDisplayReservations();
      void this.resourceCoordinator.reconcileRuntimeRoleIds(
        "external",
        this.options.externalChromeManager?.listStatuses().map((status) => status.roleId) ?? []
      );
      this.emitChange();
    });
    this.resourceCoordinator.on("change", () => this.emitChange());
  }

  setBeforeRolesStop(handler: BeforeRolesStop): void {
    this.beforeRolesStop = handler;
    this.options.externalChromeManager?.setBeforeRoleStop((roleId) => handler([roleId]));
  }

  setWorkspaceAppearanceSettings(settings: WorkspaceAppearanceSettings): void {
    this.hosts.forEach((host) => {
      if (!host.workspaceId) {
        return;
      }

      host.workspaceAppearance = { ...settings };
      host.dividers.forEach((divider) => this.applyWorkspaceBackground(divider, settings));
      this.layoutHost(host);
    });
  }

  setMacroOverlayInstaller(installer: BrowserMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  setExternalMacroOverlayInstaller(
    installer: Parameters<ExternalChromeManager["setMacroOverlayInstaller"]>[0]
  ): void {
    this.options.externalChromeManager?.setMacroOverlayInstaller(installer);
  }

  setMacroActiveRoleIds(roleIds: Iterable<string>): Promise<void> {
    return this.resourceCoordinator.setMacroActiveRoleIds(roleIds);
  }

  listStatuses(): RoleStatus[] {
    return [
      ...[...this.sessions.entries()].map(([roleId, session]) => this.toStatus(roleId, session)),
      ...(this.options.externalChromeManager?.listStatuses() ?? [])
    ].map((status) => this.withResourceStatus(status));
  }

  listWorkspaceDisplayReservations(): Array<{ workspaceId: string; workspaceName: string; displayId: number }> {
    return [...this.workspaceDisplayReservations].map(([workspaceId, reservation]) => ({
      workspaceId,
      workspaceName: reservation.name,
      displayId: reservation.displayId
    }));
  }

  listWorkspaceRuntimeStatuses(): BrowserWorkspaceRuntimeStatus[] {
    const states = new Map<string, BrowserWorkspaceRuntimeState>();
    const setState = (workspaceId: string, state: BrowserWorkspaceRuntimeState): void => {
      const current = states.get(workspaceId);
      if (!current || getWorkspaceRuntimeStatePriority(state) > getWorkspaceRuntimeStatePriority(current)) {
        states.set(workspaceId, state);
      }
    };

    this.pendingWorkspaceLaunchIds.forEach((workspaceId) => setState(workspaceId, "launching"));
    this.workspaceHostIds.forEach((hostId, workspaceId) => {
      const host = this.hosts.get(hostId);
      if (!host) {
        return;
      }
      if (host.closing) {
        setState(workspaceId, "stopping");
        return;
      }

      const sessionStates = [...host.roleIds]
        .map((roleId) => this.sessions.get(roleId)?.state)
        .filter((state): state is RoleStatus["state"] => state !== undefined);
      if (sessionStates.includes("stopping")) {
        setState(workspaceId, "stopping");
      } else if (sessionStates.includes("launching")) {
        setState(workspaceId, "launching");
      } else {
        setState(workspaceId, "running");
      }
    });
    this.options.externalChromeManager?.listWorkspaceRuntimeStatuses?.().forEach((status) => {
      setState(status.workspaceId, status.state);
    });

    return [...states].map(([workspaceId, state]) => ({ workspaceId, state }));
  }

  getRoleIdForWebContents(webContentsId: number): string | undefined {
    return [...this.sessions.entries()].find(([, session]) => session.view.webContents.id === webContentsId)?.[0];
  }

  getAutomationSession(roleId: string): BrowserAutomationSession | undefined {
    const session = this.sessions.get(roleId);

    if (session?.state !== "running" || session.view.webContents.isDestroyed()) {
      return this.options.externalChromeManager?.getAutomationSession(roleId);
    }

    return { role: session.role, target: session.target };
  }

  launch(role: Role, options: BrowserLaunchOptions = {}): Promise<RoleStatus> {
    return this.runRoleOperation([role.id], () => this.launchUnlocked(role, options));
  }

  private async launchUnlocked(role: Role, options: BrowserLaunchOptions): Promise<RoleStatus> {
    const zoomFactor = options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR;
    const launchMode = await this.getBrowserLaunchMode(role);
    if (launchMode === "external") {
      return this.launchExternal(role, undefined, zoomFactor);
    }

    const existing = this.sessions.get(role.id);
    if (existing) {
      existing.role = role;
      await this.applyZoom(existing, zoomFactor);
      await this.ensureSessionAuthenticated(role, existing);
      await this.installMacroOverlay(role, existing.view.webContents);
      await this.focusSession(existing);
      return this.toStatus(role.id, existing);
    }

    if (this.options.externalChromeManager?.hasSession(role.id)) {
      return this.launchExternal(role, undefined, zoomFactor);
    }

    const host = this.createHost(role.name);
    await this.applyBrowserFonts(role);
    const session = this.createSession(role, host, FULL_WINDOW_RECT, zoomFactor);

    try {
      host.window.show();
      await this.finishLaunch(session, zoomFactor);
      host.window.focus();
      await session.target.focus();
      return this.toStatus(role.id, session);
    } catch (error) {
      await this.stopHost(host.id);
      if (launchMode === "auto" && error instanceof BrowserGameLoadError) {
        return this.launchExternal(role, EXTERNAL_COMPAT_NOTICE, zoomFactor);
      }
      throw error;
    }
  }

  launchWorkspace(
    workspace: Pick<LaunchWorkspace, "browserZoomPercent" | "id" | "name" | "resourcePolicy">,
    items: BrowserWorkspaceLaunchItem[],
    target?: BrowserWorkspaceLaunchTarget,
    launchMode?: BrowserLaunchMode
  ): Promise<RoleStatus[]> {
    return this.runRoleOperation(
      items.map((item) => item.role.id),
      () => this.launchWorkspaceUnlocked(workspace, items, target, launchMode)
    );
  }

  private async launchWorkspaceUnlocked(
    workspace: Pick<LaunchWorkspace, "browserZoomPercent" | "id" | "name" | "resourcePolicy">,
    items: BrowserWorkspaceLaunchItem[],
    target?: BrowserWorkspaceLaunchTarget,
    requestedLaunchMode?: BrowserLaunchMode
  ): Promise<RoleStatus[]> {
    const runningRoles = items
      .map((item) => item.role)
      .filter((role) => this.sessions.has(role.id) || this.options.externalChromeManager?.hasSession(role.id));
    if (runningRoles.length > 0) {
      throw new BrowserRoleAlreadyRunningError(runningRoles);
    }

    if (target) {
      this.reserveWorkspaceDisplay(workspace.id, workspace.name, target.displayId);
      this.pendingWorkspaceLaunchIds.add(workspace.id);
      this.emitChange();
    }

    try {
      const launchMode = requestedLaunchMode ?? await this.getBrowserLaunchMode();
      if (launchMode === "external") {
        return this.launchExternalWorkspace(workspace, items, undefined, target);
      }

      const roleNames = items.map((item) => item.role.name).join(", ");
      const workspaceAppearance = await this.getWorkspaceAppearanceSettings();
      const host = this.createHost(
        `${workspace.name} - ${roleNames}`,
        workspace.id,
        target?.workArea,
        workspaceAppearance
      );
      try {
        await Promise.all(items.map((item) => this.applyBrowserFonts(item.role)));
        const normalizedRects = normalizeWorkspaceRectEdges(items.map((item) => item.rect));
        const zoomFactor = workspace.browserZoomPercent / 100;
        const sessions = items.map((item, index) =>
          this.createSession(item.role, host, normalizedRects[index], zoomFactor)
        );
        await this.createHostDividers(host);
        host.window.show();
        const primaryRoleId = workspace.resourcePolicy.primaryRoleId ?? sessions[0]?.role.id;
        const primarySession = sessions.find((session) => session.role.id === primaryRoleId) ?? sessions[0];
        if (primarySession) {
          await this.finishLaunch(primarySession, zoomFactor);
        }
        const backgroundSessions = sessions.filter((session) => session !== primarySession);
        const launchConcurrency = workspace.resourcePolicy.mode === "adaptive" &&
          this.options.resourcePressureMonitor?.getSnapshot().level === "constrained"
          ? 1
          : WORKSPACE_LAUNCH_CONCURRENCY;
        await runInBatches(
          backgroundSessions,
          launchConcurrency,
          (session) => this.finishLaunch(session, zoomFactor)
        );
        if (host.closing || host.window.isDestroyed()) {
          return [];
        }
        host.window.focus();
        await this.resourceCoordinator.activateWorkspace(
          workspace.id,
          workspace.resourcePolicy,
          sessions.map((session) =>
            new ElectronWorkspaceResourceTarget(session.role.id, session.view.webContents)
          )
        );
        return sessions.map((session) =>
          this.withResourceStatus(this.toStatus(session.role.id, session))
        );
      } catch (error) {
        const launchWasCancelled = host.closing || host.window.isDestroyed();
        await this.stopHost(host.id);
        if (launchWasCancelled) {
          return [];
        }
        if (launchMode === "auto" && error instanceof BrowserGameLoadError) {
          return this.launchExternalWorkspace(workspace, items, EXTERNAL_COMPAT_NOTICE, target);
        }
        throw error;
      }
    } finally {
      if (target) {
        this.pendingWorkspaceLaunchIds.delete(workspace.id);
        this.cleanupWorkspaceDisplayReservation(workspace.id);
        this.emitChange();
      }
    }
  }

  startLogin(role: Role): Promise<void> {
    return this.runRoleOperation([role.id], () => this.startLoginUnlocked(role));
  }

  private async startLoginUnlocked(role: Role): Promise<void> {
    let session = this.sessions.get(role.id);

    if (!session) {
      const host = this.createHost(role.name);
      await this.applyBrowserFonts(role);
      session = this.createSession(role, host, FULL_WINDOW_RECT, DEFAULT_BROWSER_ZOOM_FACTOR);
    } else {
      session.role = role;
      session.state = "launching";
      session.launchedAt = undefined;
      this.emitChange();
    }

    await this.applyZoom(session, DEFAULT_BROWSER_ZOOM_FACTOR);
    const currentUrl = session.view.webContents.getURL();
    if (!currentUrl || currentUrl === "about:blank") {
      await this.applyBrowserProxy(session);
      await this.applyCdnCompatibility(session);
      await session.view.webContents.loadURL(await this.getLoginUrl(role));
    }
    await this.focusSession(session);
  }

  async waitForAuthentication(roleId: string): Promise<AuthSessionCheckResult> {
    while (true) {
      const session = this.sessions.get(roleId);
      if (!session || session.view.webContents.isDestroyed()) {
        throw new BrowserLoginCancelledError();
      }

      const result = await this.checkSessionAuthentication(session.role, session);
      if (result.authState === "authenticated") {
        session.state = "running";
        session.launchedAt = new Date().toISOString();
        await this.installMacroOverlay(session.role, session.view.webContents);
        this.emitChange();
        return result;
      }

      if (result.authState === "auth_failed") {
        return result;
      }

      await delay(this.options.loginPollIntervalMs ?? 1_500);
    }
  }

  stop(roleId: string): Promise<void> {
    return this.withRoleOperationLocks([roleId], () => this.stopUnlocked(roleId));
  }

  private async stopUnlocked(roleId: string): Promise<void> {
    const session = this.sessions.get(roleId);
    if (!session) {
      await this.options.externalChromeManager?.stop(roleId);
      return;
    }

    session.state = "stopping";
    this.emitChange();
    await this.runBeforeRolesStop([roleId]);
    this.destroySession(roleId, session);

    const host = this.hosts.get(session.hostId);
    if (host && host.roleIds.size === 0) {
      this.closeHostWindow(host);
    }
  }

  runRoleOperation<T>(roleIds: string[], operation: () => Promise<T>): Promise<T> {
    return this.withRoleOperationLocks(roleIds, async () => {
      this.assertRolesAvailable(roleIds);
      return operation();
    });
  }

  stopRoleAndRunMutation<T>(roleId: string, operation: () => Promise<T>): Promise<T> {
    return this.withRoleOperationLocks([roleId], async () => {
      this.assertRolesAvailable([roleId]);
      this.blockedRoleIds.add(roleId);
      await this.stopUnlocked(roleId);
      return operation();
    });
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    await this.resourceCoordinator.deactivateWorkspace(workspaceId);
    const hostId = this.workspaceHostIds.get(workspaceId);
    if (hostId) {
      await this.stopHost(hostId);
    }
    await this.options.externalChromeManager?.stopWorkspace(workspaceId);
    this.cleanupWorkspaceDisplayReservation(workspaceId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.hosts.keys()].map((hostId) => this.stopHost(hostId)));
    await Promise.all(this.options.externalChromeManager?.listStatuses().map((status) => this.stop(status.roleId)) ?? []);
  }

  handleDividerPointer(webContentsId: number, payload: unknown): void {
    const target = this.dividerByWebContentsId.get(webContentsId);
    if (!target || !isGameDividerPointerPayload(payload)) {
      return;
    }

    const host = this.hosts.get(target.hostId);
    if (!host || host.window.isDestroyed()) {
      return;
    }

    if (payload.phase === "end") {
      this.finishDividerResize(host, target.divider);
      return;
    }

    if (payload.phase === "reset") {
      this.finishDividerResize(host);
      this.resizeDivider(host, target.divider, target.divider.defaultPosition);
      return;
    }

    const contentBounds = host.window.getContentBounds();
    const size = target.divider.axis === "vertical" ? contentBounds.width : contentBounds.height;
    const origin = target.divider.axis === "vertical" ? contentBounds.x : contentBounds.y;
    if (size <= 0) {
      return;
    }

    const nextPosition = (payload.screenPosition - origin) / size;
    if (payload.phase === "start") {
      this.finishDividerResize(host);
      const result = this.resizeDivider(host, target.divider, nextPosition);
      if (!result) {
        return;
      }

      host.activeDividerResize = {
        divider: target.divider,
        roleIds: result.roleIds,
        snappedPosition: result.position
      };
      this.sendDividerResizeIndicators(result.roleIds, "show");
      return;
    }

    const activeResize = host.activeDividerResize?.divider === target.divider
      ? host.activeDividerResize
      : undefined;
    const result = this.resizeDivider(
      host,
      target.divider,
      nextPosition,
      activeResize?.snappedPosition
    );
    if (!result || !activeResize || !result.changed) {
      return;
    }

    activeResize.snappedPosition = result.position;
    activeResize.roleIds = result.roleIds;
    this.sendDividerResizeIndicators(result.roleIds, "update");
  }

  private createHost(
    title: string,
    workspaceId?: string,
    launchBounds?: PixelBounds,
    workspaceAppearance: WorkspaceAppearanceSettings = DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
  ): GameHostWindow {
    const bounds = launchBounds ?? this.options.getLaunchWorkArea();
    const isWorkspace = Boolean(workspaceId);
    const prefersReducedTransparency = this.options.prefersReducedTransparency?.() ?? false;
    const window = this.options.createHostWindow({
      ...bounds,
      closable: true,
      frame: true,
      maximizable: true,
      minimizable: true,
      resizable: true,
      show: false,
      title,
      titleBarStyle: "default",
      ...(isWorkspace
        ? getWorkspaceWindowMaterialOptions(
            this.options.platform ?? process.platform,
            prefersReducedTransparency
          )
        : { backgroundColor: "#000000" })
    });
    if (isWorkspace) {
      window.contentView.setBackgroundColor("#00000000");
    }
    const host: GameHostWindow = {
      closing: false,
      dividers: [],
      id: randomUUID(),
      roleIds: new Set(),
      window,
      workspaceAppearance: { ...workspaceAppearance },
      workspaceId
    };

    this.hosts.set(host.id, host);
    if (workspaceId) {
      this.workspaceHostIds.set(workspaceId, host.id);
    }

    window.on("resize", () => this.layoutHost(host));
    window.on("restore", () => this.layoutHost(host));
    window.on("close", (event) => {
      if (host.closing) {
        return;
      }
      event.preventDefault();
      void this.stopHost(host.id);
    });
    window.once("closed", () => this.deleteHost(host));
    return host;
  }

  private createSession(
    role: Role,
    host: GameHostWindow,
    rect: NormalizedRect,
    zoomFactor: number
  ): BrowserSession {
    const partition = createRoleSessionPartition(role.id);
    const view = this.options.createView({
      webPreferences: {
        backgroundThrottling: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
        preload: this.options.embeddedPreloadPath,
        sandbox: true,
        spellcheck: false,
        webgl: true,
        zoomFactor
      }
    });
    const session: BrowserSession = {
      hostId: host.id,
      popupViews: new Set(),
      rect,
      role,
      state: "launching",
      target: new ElectronAutomationTarget(view, view.webContents),
      view,
      zoomFactor
    };

    this.sessions.set(role.id, session);
    host.roleIds.add(role.id);
    host.window.contentView.addChildView(view);
    this.layoutSession(host, session);
    this.configureZoomPersistence(session, view.webContents);
    this.configureWindowOpenHandler(session, view.webContents);
    this.configureCloseShortcut(host, view.webContents);
    view.webContents.once("destroyed", () => {
      if (this.sessions.get(role.id) === session) {
        this.sessions.delete(role.id);
        host.roleIds.delete(role.id);
        void this.resourceCoordinator.reconcileRuntimeRoleIds("embedded", this.sessions.keys());
        this.emitChange();
      }
    });
    this.emitChange();
    return session;
  }

  private async applyBrowserFonts(role: Role): Promise<void> {
    if (!this.options.applyBrowserFonts) {
      return;
    }

    try {
      await this.options.applyBrowserFonts(role, createRoleSessionPartition(role.id));
    } catch (error) {
      console.warn("Failed to apply browser font settings.", error);
    }
  }

  private async createHostDividers(host: GameHostWindow): Promise<void> {
    const descriptors = createDividerDescriptors(
      [...host.roleIds]
        .map((roleId) => this.sessions.get(roleId))
        .filter((session): session is BrowserSession => Boolean(session))
    );

    const loadPromises: Promise<void>[] = [];
    host.dividers = descriptors.map((descriptor) => {
      const view = this.options.createView({
        webPreferences: {
          backgroundThrottling: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: this.options.dividerPreloadPath,
          sandbox: true,
          transparent: true
        }
      });
      const divider: GameDivider = { ...descriptor, view };
      this.applyWorkspaceBackground(divider, host.workspaceAppearance);
      host.window.contentView.addChildView(view);
      const webContentsId = view.webContents.id;
      this.dividerByWebContentsId.set(webContentsId, { divider, hostId: host.id });
      view.webContents.once("destroyed", () => {
        this.dividerByWebContentsId.delete(webContentsId);
      });
      loadPromises.push(view.webContents.loadURL(createDividerDataUrl(divider.axis)).then(() => undefined));
      return divider;
    });
    this.layoutHost(host);
    await Promise.all(loadPromises);
  }

  private async finishLaunch(session: BrowserSession, zoomFactor: number): Promise<void> {
    await this.applyZoom(session, zoomFactor);
    await this.applyBrowserProxy(session);
    await this.applyCdnCompatibility(session);
    try {
      await session.view.webContents.loadURL(session.role.launchUrl);
    } catch {
      throw new BrowserGameLoadError();
    }
    await this.applyZoom(session, zoomFactor);
    await this.ensureSessionAuthenticated(session.role, session);
    session.state = "running";
    session.launchedAt = new Date().toISOString();
    await this.installMacroOverlay(session.role, session.view.webContents);
    this.emitChange();
  }

  private getBrowserLaunchMode(role?: Role): BrowserLaunchMode | Promise<BrowserLaunchMode> {
    return this.options.getBrowserLaunchMode?.(role) ?? "embedded";
  }

  private getLoginUrl(role: Role): string | Promise<string> {
    return this.options.getLoginUrl?.(role) ?? role.launchUrl;
  }

  private getWorkspaceAppearanceSettings():
    | WorkspaceAppearanceSettings
    | Promise<WorkspaceAppearanceSettings> {
    return this.options.getWorkspaceAppearanceSettings?.() ?? DEFAULT_WORKSPACE_APPEARANCE_SETTINGS;
  }

  private applyWorkspaceBackground(divider: GameDivider, settings: WorkspaceAppearanceSettings): void {
    divider.view.setBackgroundColor(settings.background === "black" ? "#FF000000" : "#00000000");
  }

  private async launchExternal(
    role: Role,
    notice?: string,
    zoomFactor = DEFAULT_BROWSER_ZOOM_FACTOR
  ): Promise<RoleStatus> {
    if (!this.options.externalChromeManager) {
      throw new Error("External Chrome compatibility mode is not available.");
    }

    return this.options.externalChromeManager.launch(role, { notice, zoomFactor });
  }

  private async launchExternalWorkspace(
    workspace: Pick<LaunchWorkspace, "browserZoomPercent" | "id" | "resourcePolicy">,
    items: ExternalChromeLaunchItem[],
    notice?: string,
    target?: BrowserWorkspaceLaunchTarget
  ): Promise<RoleStatus[]> {
    if (!this.options.externalChromeManager) {
      throw new Error("External Chrome compatibility mode is not available.");
    }

    const statuses = await this.options.externalChromeManager.launchWorkspace(workspace, items, {
      notice,
      workArea: target?.workArea,
      zoomFactor: workspace.browserZoomPercent / 100
    });
    await this.resourceCoordinator.activateWorkspace(
      workspace.id,
      workspace.resourcePolicy,
      this.createExternalResourceTargets(items)
    );
    return statuses.map((status) => this.withResourceStatus(status));
  }

  private createExternalResourceTargets(items: ExternalChromeLaunchItem[]): WorkspaceResourceTarget[] {
    return items.map((item) => {
      const automation = this.options.externalChromeManager?.getAutomationSession(item.role.id)?.target;
      if (!automation) {
        return {
          roleId: item.role.id,
          runtimeMode: "external" as const,
          onFocus: () => () => undefined,
          releaseThrottle: async () => undefined,
          setCpuThrottleRate: async () => {
            throw new Error("External Chrome DevTools control is unavailable.");
          }
        };
      }

      return {
        roleId: item.role.id,
        runtimeMode: "external" as const,
        focus: () => automation.focus(),
        onFocus: (listener) => automation.onFocus(listener),
        onInvalidated: (listener) => automation.onDisconnect(listener),
        releaseThrottle: () => automation.releaseThrottle(),
        setCpuThrottleRate: (rate) => automation.setCpuThrottleRate(rate)
      };
    });
  }

  private async ensureSessionAuthenticated(role: Role, session: BrowserSession): Promise<void> {
    const result = await this.checkSessionAuthentication(role, session);
    if (result.authState === "authenticated") {
      return;
    }

    await this.roleStore.updateAuthState(role.id, result.authState);
    throw new BrowserLaunchAuthError(result.message ?? NO_PERSISTED_LOGIN_SESSION_MESSAGE);
  }

  private async applyBrowserProxy(session: BrowserSession): Promise<void> {
    if (!this.options.applyBrowserProxy) {
      return;
    }

    await this.options.applyBrowserProxy(
      session.role,
      createRoleSessionPartition(session.role.id),
      session.view.webContents.session
    );
  }

  private async applyCdnCompatibility(session: BrowserSession): Promise<void> {
    if (!this.options.applyCdnCompatibility) {
      return;
    }

    try {
      await this.options.applyCdnCompatibility(
        session.role,
        createRoleSessionPartition(session.role.id),
        session.view.webContents.session
      );
    } catch (error) {
      console.warn("Failed to apply CDN compatibility settings.", error);
    }
  }

  private async checkSessionAuthentication(role: Role, session: BrowserSession): Promise<AuthSessionCheckResult> {
    const webContents = session.view.webContents;

    try {
      const [cookies, runtimeValue] = await Promise.all([
        webContents.session.cookies.get({ url: role.launchUrl }),
        webContents.executeJavaScript(LOGIN_STORAGE_EXPRESSION)
      ]);
      const snapshot = createLoginStorageSnapshot(cookies, runtimeValue);
      return classifyAuthSession(webContents.getURL(), snapshot.bodyText, isPersistedLoginStorageReady(snapshot));
    } catch (error) {
      return {
        authState: "auth_failed",
        finalUrl: webContents.getURL(),
        message: error instanceof Error ? error.message : "Unable to check embedded login session."
      };
    }
  }

  private configureWindowOpenHandler(session: BrowserSession, webContents: WebContents): void {
    webContents.setWindowOpenHandler(() => ({
      action: "allow",
      createWindow: (windowOptions) => this.createPopupView(session, windowOptions).webContents
    }));
  }

  private configureCloseShortcut(host: GameHostWindow, webContents: WebContents): void {
    webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key.toLowerCase() !== "w" || (!input.meta && !input.control)) {
        return;
      }
      event.preventDefault();
      void this.stopHost(host.id);
    });
  }

  private createPopupView(
    session: BrowserSession,
    windowOptions: BrowserWindowConstructorOptions
  ): WebContentsView {
    const host = this.hosts.get(session.hostId);
    if (!host || host.window.isDestroyed()) {
      throw new Error("The game window is no longer available.");
    }

    const popupView = this.options.createView({
      webPreferences: {
        ...windowOptions.webPreferences,
        backgroundThrottling: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: createRoleSessionPartition(session.role.id),
        sandbox: true,
        spellcheck: false,
        webgl: true,
        zoomFactor: session.zoomFactor
      }
    });

    popupView.setBounds(this.getSessionBounds(host, session));
    host.window.contentView.addChildView(popupView);
    session.popupViews.add(popupView);
    this.configureZoomPersistence(session, popupView.webContents);
    this.configureWindowOpenHandler(session, popupView.webContents);
    this.configureCloseShortcut(host, popupView.webContents);
    popupView.webContents.once("destroyed", () => {
      session.popupViews.delete(popupView);
      if (!host.window.isDestroyed()) {
        host.window.contentView.removeChildView(popupView);
      }
    });
    return popupView;
  }

  private layoutHost(host: GameHostWindow): void {
    if (!this.shouldLayoutHost(host)) {
      return;
    }

    host.roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (session) {
        this.layoutSession(host, session);
      }
    });
    this.layoutDividers(host);
  }

  private shouldLayoutHost(host: GameHostWindow): boolean {
    if (host.window.isDestroyed() || host.window.isMinimized()) {
      return false;
    }

    const contentBounds = host.window.getContentBounds();
    return contentBounds.width > 1 && contentBounds.height > 1;
  }

  private layoutSession(host: GameHostWindow, session: BrowserSession): void {
    const bounds = this.getSessionBounds(host, session);
    session.view.setBounds(bounds);
    session.popupViews.forEach((popupView) => popupView.setBounds(bounds));
  }

  private getSessionBounds(host: GameHostWindow, session: BrowserSession): PixelBounds {
    const bounds = normalizedRectToPixelBounds(session.rect, host.window.getContentBounds());
    const beforeInset = Math.floor(host.workspaceAppearance.gap / 2);
    const afterInset = host.workspaceAppearance.gap - beforeInset;

    host.dividers.forEach((divider) => {
      if (divider.axis === "vertical") {
        if (divider.beforeRoleIds.includes(session.role.id)) {
          bounds.width -= beforeInset;
        }
        if (divider.afterRoleIds.includes(session.role.id)) {
          bounds.x += afterInset;
          bounds.width -= afterInset;
        }
        return;
      }

      if (divider.beforeRoleIds.includes(session.role.id)) {
        bounds.height -= beforeInset;
      }
      if (divider.afterRoleIds.includes(session.role.id)) {
        bounds.y += afterInset;
        bounds.height -= afterInset;
      }
    });

    return {
      ...bounds,
      height: Math.max(1, bounds.height),
      width: Math.max(1, bounds.width)
    };
  }

  private layoutDividers(host: GameHostWindow): void {
    const contentBounds = host.window.getContentBounds();
    host.dividers.forEach((divider) => {
      const geometry = getDividerGeometry(divider, this.sessions);
      if (!geometry) {
        return;
      }
      divider.view.setBounds(
        dividerGeometryToPixelBounds(divider.axis, geometry, contentBounds, host.workspaceAppearance.gap)
      );
    });
  }

  private resizeDivider(
    host: GameHostWindow,
    divider: GameDivider,
    requestedPosition: number,
    previousPosition?: number
  ): GameDividerResizeResult | undefined {
    const linkedDividers = host.dividers.filter(
      (candidate) =>
        candidate.axis === divider.axis &&
        Math.abs(candidate.defaultPosition - divider.defaultPosition) < DIVIDER_EPSILON
    );
    const beforeRoleIds = new Set(linkedDividers.flatMap((candidate) => candidate.beforeRoleIds));
    const afterRoleIds = new Set(linkedDividers.flatMap((candidate) => candidate.afterRoleIds));
    const beforeSessions = [...beforeRoleIds]
      .map((roleId) => this.sessions.get(roleId))
      .filter((session): session is BrowserSession => Boolean(session));
    const afterSessions = [...afterRoleIds]
      .map((roleId) => this.sessions.get(roleId))
      .filter((session): session is BrowserSession => Boolean(session));
    if (beforeSessions.length === 0 || afterSessions.length === 0) {
      return undefined;
    }

    const startKey = divider.axis === "vertical" ? "x" : "y";
    const sizeKey = divider.axis === "vertical" ? "width" : "height";
    const min = Math.max(...beforeSessions.map((session) => session.rect[startKey] + MIN_WORKSPACE_SLOT_SIZE));
    const max = Math.min(
      ...afterSessions.map((session) => session.rect[startKey] + session.rect[sizeKey] - MIN_WORKSPACE_SLOT_SIZE)
    );
    const currentPosition = afterSessions[0].rect[startKey];
    const position = snapWorkspaceResizePosition(requestedPosition, {
      initialPosition: divider.defaultPosition,
      max,
      min,
      ...(previousPosition === undefined ? {} : { previousPosition })
    });
    const roleIds = [...new Set([...beforeRoleIds, ...afterRoleIds])];
    if (Math.abs(position - currentPosition) < DIVIDER_EPSILON) {
      return { changed: false, position, roleIds };
    }

    beforeSessions.forEach((session) => {
      session.rect = { ...session.rect, [sizeKey]: position - session.rect[startKey] };
    });
    afterSessions.forEach((session) => {
      const end = session.rect[startKey] + session.rect[sizeKey];
      session.rect = { ...session.rect, [startKey]: position, [sizeKey]: end - position };
    });
    this.layoutHost(host);
    return { changed: true, position, roleIds };
  }

  private finishDividerResize(host: GameHostWindow, divider?: GameDivider): void {
    const activeResize = host.activeDividerResize;
    if (!activeResize || (divider && activeResize.divider !== divider)) {
      return;
    }

    host.activeDividerResize = undefined;
    this.sendDividerResizeIndicators(activeResize.roleIds, "hide");
  }

  private sendDividerResizeIndicators(
    roleIds: string[],
    type: WorkspaceResizeIndicatorPayload["type"]
  ): void {
    roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (!session || session.view.webContents.isDestroyed()) {
        return;
      }

      const payload: WorkspaceResizeIndicatorPayload = type === "hide"
        ? { type }
        : { type, label: formatWorkspaceResizeRatio(session.rect) };
      session.view.webContents.send(WORKSPACE_RESIZE_INDICATOR_CHANNEL, payload);
    });
  }

  private async applyZoom(session: BrowserSession, zoomFactor: number): Promise<void> {
    session.zoomFactor = zoomFactor;
    session.view.webContents.setZoomFactor(zoomFactor);
    session.popupViews.forEach((popupView) => {
      if (!popupView.webContents.isDestroyed()) {
        popupView.webContents.setZoomFactor(zoomFactor);
      }
    });
  }

  private configureZoomPersistence(session: BrowserSession, webContents: WebContents): void {
    webContents.on("did-finish-load", () => {
      if (webContents.isDestroyed()) {
        return;
      }

      try {
        webContents.setZoomFactor(session.zoomFactor);
      } catch (error) {
        console.warn("Failed to reapply browser zoom after navigation.", error);
      }
    });
  }

  private async focusSession(session: BrowserSession): Promise<void> {
    const host = this.hosts.get(session.hostId);
    if (!host || host.window.isDestroyed()) {
      return;
    }
    if (host.window.isMinimized()) {
      host.window.restore();
    }
    host.window.show();
    host.window.focus();
    await session.target.focus();
  }

  private async installMacroOverlay(role: Role, webContents: WebContents): Promise<void> {
    if (!this.macroOverlayInstaller) {
      return;
    }
    try {
      await this.macroOverlayInstaller(role, webContents);
    } catch (error) {
      console.warn("Failed to install Rion Studio macro overlay.", error);
    }
  }

  private async stopHost(hostId: string): Promise<void> {
    const host = this.hosts.get(hostId);
    if (!host || host.closing) {
      return;
    }

    host.closing = true;
    if (host.workspaceId) {
      await this.resourceCoordinator.deactivateWorkspace(host.workspaceId);
    }
    const roleIds = [...host.roleIds];
    roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (session) {
        session.state = "stopping";
      }
    });
    this.emitChange();
    await this.runBeforeRolesStop(roleIds);
    roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (session) {
        this.destroySession(roleId, session);
      }
    });
    this.closeHostWindow(host);
  }

  private destroySession(roleId: string, session: BrowserSession): void {
    if (this.sessions.get(roleId) !== session) {
      return;
    }

    const host = this.hosts.get(session.hostId);
    if (host?.activeDividerResize?.roleIds.includes(roleId)) {
      this.finishDividerResize(host);
    }
    this.sessions.delete(roleId);
    void this.resourceCoordinator.reconcileRuntimeRoleIds("embedded", this.sessions.keys());
    host?.roleIds.delete(roleId);
    if (host && !host.window.isDestroyed()) {
      host.window.contentView.removeChildView(session.view);
      session.popupViews.forEach((popupView) => host.window.contentView.removeChildView(popupView));
    }
    session.popupViews.forEach((popupView) => {
      if (!popupView.webContents.isDestroyed()) {
        popupView.webContents.close();
      }
    });
    session.popupViews.clear();
    if (!session.view.webContents.isDestroyed()) {
      session.view.webContents.close();
    }
    this.emitChange();
  }

  private async runBeforeRolesStop(roleIds: string[]): Promise<void> {
    try {
      await this.beforeRolesStop?.(roleIds);
    } catch (error) {
      console.warn("Failed to stop macros before closing a game window.", error);
    }
  }

  private assertRolesAvailable(roleIds: string[]): void {
    if (roleIds.some((roleId) => this.blockedRoleIds.has(roleId))) {
      throw new Error("Role not found.");
    }
  }

  private withRoleOperationLocks<T>(roleIds: string[], operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(roleIds)].sort();
    const previous = ids.flatMap((roleId) => {
      const tail = this.roleOperationTails.get(roleId);
      return tail ? [tail] : [];
    });
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    ids.forEach((roleId) => this.roleOperationTails.set(roleId, tail));
    let result: Promise<T>;

    if (previous.length === 0) {
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
    } else {
      result = Promise.all(previous).then(operation);
    }

    return result.finally(() => {
      release();
      ids.forEach((roleId) => {
        if (this.roleOperationTails.get(roleId) === tail) {
          this.roleOperationTails.delete(roleId);
        }
      });
    });
  }

  private closeHostWindow(host: GameHostWindow): void {
    host.closing = true;
    this.finishDividerResize(host);
    host.dividers.forEach((divider) => {
      this.dividerByWebContentsId.delete(divider.view.webContents.id);
      if (!host.window.isDestroyed()) {
        host.window.contentView.removeChildView(divider.view);
      }
      if (!divider.view.webContents.isDestroyed()) {
        divider.view.webContents.close();
      }
    });
    host.dividers = [];
    this.deleteHost(host);
    if (!host.window.isDestroyed()) {
      host.window.close();
    }
  }

  private deleteHost(host: GameHostWindow): void {
    this.finishDividerResize(host);
    this.hosts.delete(host.id);
    if (host.workspaceId && this.workspaceHostIds.get(host.workspaceId) === host.id) {
      this.workspaceHostIds.delete(host.workspaceId);
      this.cleanupWorkspaceDisplayReservation(host.workspaceId);
    }
  }

  private reserveWorkspaceDisplay(workspaceId: string, workspaceName: string, displayId: number): void {
    const occupied = [...this.workspaceDisplayReservations].find(
      ([reservedWorkspaceId, reservation]) =>
        reservedWorkspaceId !== workspaceId && reservation.displayId === displayId
    );
    if (occupied) {
      throw new BrowserWorkspaceDisplayOccupiedError(displayId, occupied[0]);
    }

    this.workspaceDisplayReservations.set(workspaceId, { displayId, name: workspaceName });
  }

  private cleanupWorkspaceDisplayReservations(): void {
    [...this.workspaceDisplayReservations.keys()].forEach((workspaceId) => {
      this.cleanupWorkspaceDisplayReservation(workspaceId);
    });
  }

  private cleanupWorkspaceDisplayReservation(workspaceId: string): void {
    if (
      this.pendingWorkspaceLaunchIds.has(workspaceId) ||
      this.workspaceHostIds.has(workspaceId) ||
      this.options.externalChromeManager?.hasWorkspace?.(workspaceId)
    ) {
      return;
    }

    this.workspaceDisplayReservations.delete(workspaceId);
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }

  private toStatus(roleId: string, session: BrowserSession): RoleStatus {
    return { roleId, state: session.state, launchedAt: session.launchedAt, runtimeMode: "embedded" };
  }

  private withResourceStatus(status: RoleStatus): RoleStatus {
    const resourceStatus = this.resourceCoordinator.getStatus(status.roleId);
    return resourceStatus ? { ...status, ...resourceStatus } : status;
  }
}

function getWorkspaceRuntimeStatePriority(state: BrowserWorkspaceRuntimeState): number {
  switch (state) {
    case "running":
      return 1;
    case "launching":
      return 2;
    case "stopping":
      return 3;
  }
}

export function createRoleSessionPartition(roleId: string): string {
  return `persist:rion-role-${roleId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function normalizedRectToPixelBounds(rect: NormalizedRect, contentBounds: PixelBounds): PixelBounds {
  const left = Math.round(rect.x * contentBounds.width);
  const top = Math.round(rect.y * contentBounds.height);
  const right = Math.round((rect.x + rect.width) * contentBounds.width);
  const bottom = Math.round((rect.y + rect.height) * contentBounds.height);

  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top)
  };
}

interface DividerDescriptor {
  afterRoleIds: string[];
  axis: DividerAxis;
  beforeRoleIds: string[];
  defaultPosition: number;
}

interface DividerGeometry {
  end: number;
  position: number;
  start: number;
}

interface DividerSegment {
  afterRoleIds: string[];
  axis: DividerAxis;
  beforeRoleIds: string[];
  end: number;
  position: number;
  start: number;
}

const DIVIDER_EPSILON = 0.000_001;
function createDividerDescriptors(sessions: BrowserSession[]): DividerDescriptor[] {
  const segments: DividerSegment[] = [];

  for (let leftIndex = 0; leftIndex < sessions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sessions.length; rightIndex += 1) {
      const left = sessions[leftIndex];
      const right = sessions[rightIndex];
      addSharedEdgeSegment(segments, left, right, "vertical");
      addSharedEdgeSegment(segments, right, left, "vertical");
      addSharedEdgeSegment(segments, left, right, "horizontal");
      addSharedEdgeSegment(segments, right, left, "horizontal");
    }
  }

  segments.sort((left, right) => {
    if (left.axis !== right.axis) {
      return left.axis === "vertical" ? -1 : 1;
    }
    return left.position - right.position || left.start - right.start;
  });

  const groups: Array<DividerSegment & { after: Set<string>; before: Set<string> }> = [];
  segments.forEach((segment) => {
    const group = groups.find(
      (candidate) =>
        candidate.axis === segment.axis &&
        Math.abs(candidate.position - segment.position) < DIVIDER_EPSILON &&
        segment.start <= candidate.end + DIVIDER_EPSILON &&
        candidate.start <= segment.end + DIVIDER_EPSILON
    );
    if (group) {
      group.start = Math.min(group.start, segment.start);
      group.end = Math.max(group.end, segment.end);
      segment.beforeRoleIds.forEach((roleId) => group.before.add(roleId));
      segment.afterRoleIds.forEach((roleId) => group.after.add(roleId));
      return;
    }

    groups.push({
      ...segment,
      after: new Set(segment.afterRoleIds),
      before: new Set(segment.beforeRoleIds)
    });
  });

  return groups.map((group) => ({
    axis: group.axis,
    beforeRoleIds: [...group.before],
    afterRoleIds: [...group.after],
    defaultPosition: group.position
  }));
}

function addSharedEdgeSegment(
  segments: DividerSegment[],
  before: BrowserSession,
  after: BrowserSession,
  axis: DividerAxis
): void {
  const position = axis === "vertical" ? before.rect.x + before.rect.width : before.rect.y + before.rect.height;
  const afterPosition = axis === "vertical" ? after.rect.x : after.rect.y;
  if (Math.abs(position - afterPosition) >= DIVIDER_EPSILON) {
    return;
  }

  const beforeStart = axis === "vertical" ? before.rect.y : before.rect.x;
  const beforeEnd = beforeStart + (axis === "vertical" ? before.rect.height : before.rect.width);
  const afterStart = axis === "vertical" ? after.rect.y : after.rect.x;
  const afterEnd = afterStart + (axis === "vertical" ? after.rect.height : after.rect.width);
  const start = Math.max(beforeStart, afterStart);
  const end = Math.min(beforeEnd, afterEnd);
  if (end - start <= DIVIDER_EPSILON) {
    return;
  }

  segments.push({
    axis,
    position,
    start,
    end,
    beforeRoleIds: [before.role.id],
    afterRoleIds: [after.role.id]
  });
}

function getDividerGeometry(
  divider: DividerDescriptor,
  sessions: Map<string, BrowserSession>
): DividerGeometry | undefined {
  const beforeSessions = divider.beforeRoleIds
    .map((roleId) => sessions.get(roleId))
    .filter((session): session is BrowserSession => Boolean(session));
  const afterSessions = divider.afterRoleIds
    .map((roleId) => sessions.get(roleId))
    .filter((session): session is BrowserSession => Boolean(session));
  const allSessions = [...beforeSessions, ...afterSessions];
  if (beforeSessions.length === 0 || afterSessions.length === 0) {
    return undefined;
  }

  const position =
    divider.axis === "vertical" ? afterSessions[0].rect.x : afterSessions[0].rect.y;
  const start = Math.min(
    ...allSessions.map((session) => (divider.axis === "vertical" ? session.rect.y : session.rect.x))
  );
  const end = Math.max(
    ...allSessions.map((session) => {
      return divider.axis === "vertical"
        ? session.rect.y + session.rect.height
        : session.rect.x + session.rect.width;
    })
  );
  return { end, position, start };
}

function dividerGeometryToPixelBounds(
  axis: DividerAxis,
  geometry: DividerGeometry,
  contentBounds: PixelBounds,
  dividerSize: number
): PixelBounds {
  const beforeInset = Math.floor(dividerSize / 2);
  if (axis === "vertical") {
    const lineX = Math.round(geometry.position * contentBounds.width);
    const top = Math.round(geometry.start * contentBounds.height);
    const bottom = Math.round(geometry.end * contentBounds.height);
    return {
      x: lineX - beforeInset,
      y: top,
      width: dividerSize,
      height: Math.max(1, bottom - top)
    };
  }

  const lineY = Math.round(geometry.position * contentBounds.height);
  const left = Math.round(geometry.start * contentBounds.width);
  const right = Math.round(geometry.end * contentBounds.width);
  return {
    x: left,
    y: lineY - beforeInset,
    width: Math.max(1, right - left),
    height: dividerSize
  };
}

function createDividerDataUrl(axis: DividerAxis): string {
  const cursor = axis === "vertical" ? "col-resize" : "row-resize";
  const coordinate = axis === "vertical" ? "event.screenX" : "event.screenY";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;cursor:${cursor};user-select:none}
</style></head><body><script>
let dragging=false;
const send=(phase,event)=>window.rionStudioDivider.sendPointer({phase,screenPosition:${coordinate}});
const end=()=>window.rionStudioDivider.sendPointer({phase:"end"});
const reset=()=>window.rionStudioDivider.sendPointer({phase:"reset"});
const setDragging=value=>{dragging=value};
const finish=()=>{if(!dragging)return;setDragging(false);end()};
addEventListener("pointerdown",event=>{setDragging(true);document.body.setPointerCapture?.(event.pointerId);send("start",event);event.preventDefault()});
addEventListener("pointermove",event=>{if(dragging)send("move",event)});
addEventListener("pointerup",finish);
addEventListener("pointercancel",finish);
addEventListener("blur",finish);
addEventListener("dblclick",event=>{setDragging(false);reset();event.preventDefault()});
</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isGameDividerPointerPayload(value: unknown): value is GameDividerPointerPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Partial<GameDividerPointerPayload>;
  if (payload.phase === "reset" || payload.phase === "end") {
    return true;
  }

  return (
    (payload.phase === "start" || payload.phase === "move") &&
    typeof payload.screenPosition === "number" &&
    Number.isFinite(payload.screenPosition)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInBatches<T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
): Promise<void> {
  for (let index = 0; index < items.length; index += concurrency) {
    const results = await Promise.allSettled(
      items.slice(index, index + concurrency).map((item) => operation(item))
    );
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }
}
