import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
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
import type { LaunchWorkspace, NormalizedRect, PixelBounds, Role, RoleStatus } from "../../shared/types";
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
export type BeforeRolesStop = (roleIds: string[]) => Promise<void>;

export interface BrowserManagerOptions {
  createHostWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  embeddedPreloadPath: string;
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
  id: string;
  roleIds: Set<string>;
  window: BrowserWindow;
  workspaceId?: string;
}

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
const FULL_WINDOW_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

export class BrowserManager extends EventEmitter<BrowserManagerEvents> {
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
  }

  setBeforeRolesStop(handler: BeforeRolesStop): void {
    this.beforeRolesStop = handler;
  }

  setMacroOverlayInstaller(installer: BrowserMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  listStatuses(): RoleStatus[] {
    return [...this.sessions.entries()].map(([roleId, session]) => this.toStatus(roleId, session));
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
    const existing = this.sessions.get(role.id);
    if (existing) {
      existing.role = role;
      await this.applyZoom(existing, options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR);
      await this.ensureSessionAuthenticated(role, existing);
      await this.installMacroOverlay(role, existing.view.webContents);
      await this.focusSession(existing);
      return this.toStatus(role.id, existing);
    }

    const host = this.createHost(role.name);
    const session = this.createSession(role, host, FULL_WINDOW_RECT);

    try {
      host.window.show();
      await this.finishLaunch(session, options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR);
      host.window.focus();
      await session.target.focus();
      return this.toStatus(role.id, session);
    } catch (error) {
      await this.stopHost(host.id);
      throw error;
    }
  }

  async launchWorkspace(
    workspace: Pick<LaunchWorkspace, "browserZoomPercent" | "id" | "name">,
    items: BrowserWorkspaceLaunchItem[]
  ): Promise<RoleStatus[]> {
    const runningRoles = items.map((item) => item.role).filter((role) => this.sessions.has(role.id));
    if (runningRoles.length > 0) {
      throw new BrowserRoleAlreadyRunningError(runningRoles);
    }

    const host = this.createHost(workspace.name, workspace.id);
    const sessions = items.map((item) => this.createSession(item.role, host, item.rect));
    const zoomFactor = workspace.browserZoomPercent / 100;

    try {
      host.window.show();
      for (const session of sessions) {
        await this.finishLaunch(session, zoomFactor);
      }
      host.window.focus();
      return sessions.map((session) => this.toStatus(session.role.id, session));
    } catch (error) {
      await this.stopHost(host.id);
      throw error;
    }
  }

  async startLogin(role: Role): Promise<void> {
    let session = this.sessions.get(role.id);

    if (!session) {
      const host = this.createHost(role.name);
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
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.hosts.keys()].map((hostId) => this.stopHost(hostId)));
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
    const view = this.options.createView({
      webPreferences: {
        backgroundThrottling: role.launchPreset !== "performance",
        contextIsolation: true,
        nodeIntegration: false,
        partition: createRoleSessionPartition(role.id),
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

  private async finishLaunch(session: BrowserSession, zoomFactor: number): Promise<void> {
    await this.applyZoom(session, zoomFactor);
    await session.view.webContents.loadURL(session.role.launchUrl);
    await this.ensureSessionAuthenticated(session.role, session);
    session.state = "running";
    session.launchedAt = new Date().toISOString();
    await this.installMacroOverlay(session.role, session.view.webContents);
    this.emitChange();
  }

  private async ensureSessionAuthenticated(role: Role, session: BrowserSession): Promise<void> {
    const result = await this.checkSessionAuthentication(role, session);
    if (result.authState === "authenticated") {
      return;
    }

    await this.roleStore.updateAuthState(role.id, result.authState);
    throw new BrowserLaunchAuthError(result.message ?? NO_PERSISTED_LOGIN_SESSION_MESSAGE);
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
    host.roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (session) {
        this.layoutSession(host, session);
      }
    });
  }

  private layoutSession(host: GameHostWindow, session: BrowserSession): void {
    const bounds = this.getSessionBounds(host, session);
    session.view.setBounds(bounds);
    session.popupViews.forEach((popupView) => popupView.setBounds(bounds));
  }

  private getSessionBounds(host: GameHostWindow, session: BrowserSession): PixelBounds {
    return normalizedRectToPixelBounds(session.rect, host.window.getContentBounds());
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
    return { roleId, state: session.state, launchedAt: session.launchedAt };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
