import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  BrowserWindow,
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
import type { BrowserLaunchMode, LaunchWorkspace, NormalizedRect, PixelBounds, Role, RoleStatus } from "../../shared/types";
import { MIN_WORKSPACE_SLOT_SIZE } from "../../shared/workspaceLayout";
import type { ExternalChromeLaunchItem, ExternalChromeManager } from "./ExternalChromeManager";
import { ElectronAutomationTarget, type BrowserAutomationTarget } from "./ElectronAutomationTarget";

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

export interface BrowserAutomationSession {
  role: Role;
  target: BrowserAutomationTarget;
}

export type BrowserMacroOverlayInstaller = (role: Role, webContents: WebContents) => Promise<void>;
export type BrowserProxyApplier = (role: Role, partition: string, session: Session) => Promise<void>;
export type BeforeRolesStop = (roleIds: string[]) => Promise<void>;

export interface BrowserManagerOptions {
  applyBrowserFonts?: (role: Role, partition: string) => Promise<void>;
  applyBrowserProxy?: BrowserProxyApplier;
  createHostWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  dividerPreloadPath: string;
  embeddedPreloadPath: string;
  externalChromeManager?: ExternalChromeManager;
  getBrowserLaunchMode?: () => BrowserLaunchMode | Promise<BrowserLaunchMode>;
  getLaunchWorkArea: () => PixelBounds;
  loginPollIntervalMs?: number;
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

interface GameHostWindow {
  closing: boolean;
  dividers: GameDivider[];
  id: string;
  roleIds: Set<string>;
  window: BrowserWindow;
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

export type GameDividerPointerPayload =
  | { phase: "move" | "start" | "end"; screenPosition: number }
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
}

const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
const EXTERNAL_COMPAT_NOTICE =
  "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.";
const FULL_WINDOW_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

export class BrowserManager extends EventEmitter<BrowserManagerEvents> {
  private readonly dividerByWebContentsId = new Map<number, { divider: GameDivider; hostId: string }>();
  private readonly hosts = new Map<string, GameHostWindow>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly workspaceHostIds = new Map<string, string>();
  private beforeRolesStop?: BeforeRolesStop;
  private macroOverlayInstaller?: BrowserMacroOverlayInstaller;

  constructor(
    private readonly roleStore: Pick<RoleStore, "updateAuthState">,
    private readonly options: BrowserManagerOptions
  ) {
    super();
    this.options.externalChromeManager?.on("change", () => this.emitChange());
  }

  setBeforeRolesStop(handler: BeforeRolesStop): void {
    this.beforeRolesStop = handler;
  }

  setMacroOverlayInstaller(installer: BrowserMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  listStatuses(): RoleStatus[] {
    return [
      ...[...this.sessions.entries()].map(([roleId, session]) => this.toStatus(roleId, session)),
      ...(this.options.externalChromeManager?.listStatuses() ?? [])
    ];
  }

  getRoleIdForWebContents(webContentsId: number): string | undefined {
    return [...this.sessions.entries()].find(([, session]) => session.view.webContents.id === webContentsId)?.[0];
  }

  getAutomationSession(roleId: string): BrowserAutomationSession | undefined {
    const session = this.sessions.get(roleId);

    if (session?.state !== "running" || session.view.webContents.isDestroyed()) {
      return undefined;
    }

    return { role: session.role, target: session.target };
  }

  async launch(role: Role, options: BrowserLaunchOptions = {}): Promise<RoleStatus> {
    const launchMode = await this.getBrowserLaunchMode();
    if (launchMode === "external") {
      return this.launchExternal(role);
    }

    const existing = this.sessions.get(role.id);
    if (existing) {
      existing.role = role;
      await this.applyZoom(existing, options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR);
      await this.ensureSessionAuthenticated(role, existing);
      await this.installMacroOverlay(role, existing.view.webContents);
      await this.focusSession(existing);
      return this.toStatus(role.id, existing);
    }

    if (this.options.externalChromeManager?.hasSession(role.id)) {
      return this.launchExternal(role);
    }

    const host = this.createHost(role.name);
    await this.applyBrowserFonts(role);
    const session = this.createSession(role, host, FULL_WINDOW_RECT);

    try {
      host.window.show();
      await this.finishLaunch(session, options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR);
      host.window.focus();
      await session.target.focus();
      return this.toStatus(role.id, session);
    } catch (error) {
      await this.stopHost(host.id);
      if (launchMode === "auto" && error instanceof BrowserGameLoadError) {
        return this.launchExternal(role, EXTERNAL_COMPAT_NOTICE);
      }
      throw error;
    }
  }

  async launchWorkspace(
    workspace: Pick<LaunchWorkspace, "browserZoomPercent" | "id" | "name">,
    items: BrowserWorkspaceLaunchItem[]
  ): Promise<RoleStatus[]> {
    const launchMode = await this.getBrowserLaunchMode();
    if (launchMode === "external") {
      return this.launchExternalWorkspace(workspace, items);
    }

    const runningRoles = items
      .map((item) => item.role)
      .filter((role) => this.sessions.has(role.id) || this.options.externalChromeManager?.hasSession(role.id));
    if (runningRoles.length > 0) {
      throw new BrowserRoleAlreadyRunningError(runningRoles);
    }

    const roleNames = items.map((item) => item.role.name).join(", ");
    const host = this.createHost(`${workspace.name} - ${roleNames}`, workspace.id);
    await Promise.all(items.map((item) => this.applyBrowserFonts(item.role)));
    const sessions = items.map((item) => this.createSession(item.role, host, item.rect));
    const zoomFactor = workspace.browserZoomPercent / 100;

    try {
      await this.createHostDividers(host);
      host.window.show();
      for (const session of sessions) {
        await this.finishLaunch(session, zoomFactor);
      }
      host.window.focus();
      return sessions.map((session) => this.toStatus(session.role.id, session));
    } catch (error) {
      await this.stopHost(host.id);
      if (launchMode === "auto" && error instanceof BrowserGameLoadError) {
        return this.launchExternalWorkspace(workspace, items, EXTERNAL_COMPAT_NOTICE);
      }
      throw error;
    }
  }

  async startLogin(role: Role): Promise<void> {
    let session = this.sessions.get(role.id);

    if (!session) {
      const host = this.createHost(role.name);
      await this.applyBrowserFonts(role);
      session = this.createSession(role, host, FULL_WINDOW_RECT);
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
      await session.view.webContents.loadURL(role.launchUrl);
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

  async stop(roleId: string): Promise<void> {
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

  async stopWorkspace(workspaceId: string): Promise<void> {
    const hostId = this.workspaceHostIds.get(workspaceId);
    if (hostId) {
      await this.stopHost(hostId);
    }
    await this.options.externalChromeManager?.stopWorkspace(workspaceId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.hosts.keys()].map((hostId) => this.stopHost(hostId)));
    await Promise.all(this.options.externalChromeManager?.listStatuses().map((status) => this.stop(status.roleId)) ?? []);
  }

  handleDividerPointer(webContentsId: number, payload: unknown): void {
    const target = this.dividerByWebContentsId.get(webContentsId);
    if (!target || !isGameDividerPointerPayload(payload) || payload.phase === "end") {
      return;
    }

    const host = this.hosts.get(target.hostId);
    if (!host || host.window.isDestroyed()) {
      return;
    }

    if (payload.phase === "reset") {
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
    this.resizeDivider(host, target.divider, nextPosition);
  }

  private createHost(title: string, workspaceId?: string): GameHostWindow {
    const bounds = this.options.getLaunchWorkArea();
    const window = this.options.createHostWindow({
      ...bounds,
      backgroundColor: "#000000",
      frame: true,
      show: false,
      title,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    const host: GameHostWindow = {
      closing: false,
      dividers: [],
      id: randomUUID(),
      roleIds: new Set(),
      window,
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

  private createSession(role: Role, host: GameHostWindow, rect: NormalizedRect): BrowserSession {
    const partition = createRoleSessionPartition(role.id);
    const view = this.options.createView({
      webPreferences: {
        backgroundThrottling: role.launchPreset !== "performance",
        contextIsolation: true,
        nodeIntegration: false,
        partition,
        preload: this.options.embeddedPreloadPath,
        sandbox: true
      }
    });
    const session: BrowserSession = {
      hostId: host.id,
      popupViews: new Set(),
      rect,
      role,
      state: "launching",
      target: new ElectronAutomationTarget(view, view.webContents),
      view
    };

    this.sessions.set(role.id, session);
    host.roleIds.add(role.id);
    host.window.contentView.addChildView(view);
    this.layoutSession(host, session);
    this.configureWindowOpenHandler(session, view.webContents);
    this.configureCloseShortcut(host, view.webContents);
    view.webContents.once("destroyed", () => {
      if (this.sessions.get(role.id) === session) {
        this.sessions.delete(role.id);
        host.roleIds.delete(role.id);
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
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          preload: this.options.dividerPreloadPath,
          sandbox: true
        }
      });
      const divider: GameDivider = { ...descriptor, view };
      host.window.contentView.addChildView(view);
      const webContentsId = view.webContents.id;
      this.dividerByWebContentsId.set(webContentsId, { divider, hostId: host.id });
      view.webContents.once("destroyed", () => {
        this.dividerByWebContentsId.delete(webContentsId);
      });
      loadPromises.push(view.webContents.loadURL(createDividerDataUrl(divider.axis)).then(() => undefined));
      return divider;
    });
    this.layoutDividers(host);
    await Promise.all(loadPromises);
  }

  private async finishLaunch(session: BrowserSession, zoomFactor: number): Promise<void> {
    await this.applyZoom(session, zoomFactor);
    await this.applyBrowserProxy(session);
    try {
      await session.view.webContents.loadURL(session.role.launchUrl);
    } catch {
      throw new BrowserGameLoadError();
    }
    await this.ensureSessionAuthenticated(session.role, session);
    session.state = "running";
    session.launchedAt = new Date().toISOString();
    await this.installMacroOverlay(session.role, session.view.webContents);
    this.emitChange();
  }

  private getBrowserLaunchMode(): BrowserLaunchMode | Promise<BrowserLaunchMode> {
    return this.options.getBrowserLaunchMode?.() ?? "embedded";
  }

  private async launchExternal(role: Role, notice?: string): Promise<RoleStatus> {
    if (!this.options.externalChromeManager) {
      throw new Error("External Chrome compatibility mode is not available.");
    }

    return this.options.externalChromeManager.launch(role, { notice });
  }

  private async launchExternalWorkspace(
    workspace: Pick<LaunchWorkspace, "id">,
    items: ExternalChromeLaunchItem[],
    notice?: string
  ): Promise<RoleStatus[]> {
    if (!this.options.externalChromeManager) {
      throw new Error("External Chrome compatibility mode is not available.");
    }

    return this.options.externalChromeManager.launchWorkspace(workspace, items, { notice });
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
        contextIsolation: true,
        nodeIntegration: false,
        partition: createRoleSessionPartition(session.role.id),
        sandbox: true
      }
    });

    popupView.setBounds(this.getSessionBounds(host, session));
    host.window.contentView.addChildView(popupView);
    session.popupViews.add(popupView);
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
    return normalizedRectToPixelBounds(session.rect, host.window.getContentBounds());
  }

  private layoutDividers(host: GameHostWindow): void {
    const contentBounds = host.window.getContentBounds();
    host.dividers.forEach((divider) => {
      const geometry = getDividerGeometry(divider, this.sessions);
      if (!geometry) {
        return;
      }
      divider.view.setBounds(dividerGeometryToPixelBounds(divider.axis, geometry, contentBounds));
    });
  }

  private resizeDivider(host: GameHostWindow, divider: GameDivider, requestedPosition: number): void {
    const beforeSessions = divider.beforeRoleIds
      .map((roleId) => this.sessions.get(roleId))
      .filter((session): session is BrowserSession => Boolean(session));
    const afterSessions = divider.afterRoleIds
      .map((roleId) => this.sessions.get(roleId))
      .filter((session): session is BrowserSession => Boolean(session));
    if (beforeSessions.length === 0 || afterSessions.length === 0) {
      return;
    }

    const startKey = divider.axis === "vertical" ? "x" : "y";
    const sizeKey = divider.axis === "vertical" ? "width" : "height";
    const min = Math.max(...beforeSessions.map((session) => session.rect[startKey] + MIN_WORKSPACE_SLOT_SIZE));
    const max = Math.min(
      ...afterSessions.map((session) => session.rect[startKey] + session.rect[sizeKey] - MIN_WORKSPACE_SLOT_SIZE)
    );
    const position = Math.min(max, Math.max(min, requestedPosition));

    beforeSessions.forEach((session) => {
      session.rect = { ...session.rect, [sizeKey]: position - session.rect[startKey] };
    });
    afterSessions.forEach((session) => {
      const end = session.rect[startKey] + session.rect[sizeKey];
      session.rect = { ...session.rect, [startKey]: position, [sizeKey]: end - position };
    });
    this.layoutHost(host);
  }

  private async applyZoom(session: BrowserSession, zoomFactor: number): Promise<void> {
    session.view.webContents.setZoomFactor(zoomFactor);
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

    this.sessions.delete(roleId);
    const host = this.hosts.get(session.hostId);
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

  private closeHostWindow(host: GameHostWindow): void {
    host.closing = true;
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
    this.hosts.delete(host.id);
    if (host.workspaceId && this.workspaceHostIds.get(host.workspaceId) === host.id) {
      this.workspaceHostIds.delete(host.workspaceId);
    }
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }

  private toStatus(roleId: string, session: BrowserSession): RoleStatus {
    return { roleId, state: session.state, launchedAt: session.launchedAt, runtimeMode: "embedded" };
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
const DIVIDER_SIZE = 4;

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

  const groups: Array<DividerSegment & { after: Set<string>; before: Set<string> }> = [];
  segments.forEach((segment) => {
    const group = groups.find(
      (candidate) =>
        candidate.axis === segment.axis && Math.abs(candidate.position - segment.position) < DIVIDER_EPSILON
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
  contentBounds: PixelBounds
): PixelBounds {
  if (axis === "vertical") {
    const lineX = Math.round(geometry.position * contentBounds.width);
    const top = Math.round(geometry.start * contentBounds.height);
    const bottom = Math.round(geometry.end * contentBounds.height);
    return {
      x: lineX - Math.floor(DIVIDER_SIZE / 2),
      y: top,
      width: DIVIDER_SIZE,
      height: Math.max(1, bottom - top)
    };
  }

  const lineY = Math.round(geometry.position * contentBounds.height);
  const left = Math.round(geometry.start * contentBounds.width);
  const right = Math.round(geometry.end * contentBounds.width);
  return {
    x: left,
    y: lineY - Math.floor(DIVIDER_SIZE / 2),
    width: Math.max(1, right - left),
    height: DIVIDER_SIZE
  };
}

function createDividerDataUrl(axis: DividerAxis): string {
  const cursor = axis === "vertical" ? "col-resize" : "row-resize";
  const coordinate = axis === "vertical" ? "event.screenX" : "event.screenY";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;cursor:${cursor};user-select:none}
</style></head><body><script>
let dragging=false;
const send=(phase,event)=>window.rionStudioDivider.sendPointer({phase,screenPosition:${coordinate}});
const reset=()=>window.rionStudioDivider.sendPointer({phase:"reset"});
addEventListener("pointerdown",event=>{dragging=true;document.body.setPointerCapture?.(event.pointerId);send("start",event);event.preventDefault()});
addEventListener("pointermove",event=>{if(dragging)send("move",event)});
addEventListener("pointerup",event=>{if(!dragging)return;dragging=false;send("end",event)});
addEventListener("pointercancel",event=>{if(!dragging)return;dragging=false;send("end",event)});
addEventListener("dblclick",event=>{dragging=false;reset();event.preventDefault()});
</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function isGameDividerPointerPayload(value: unknown): value is GameDividerPointerPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Partial<GameDividerPointerPayload>;
  if (payload.phase === "reset") {
    return true;
  }

  return (
    (payload.phase === "start" || payload.phase === "move" || payload.phase === "end") &&
    typeof payload.screenPosition === "number" &&
    Number.isFinite(payload.screenPosition)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
