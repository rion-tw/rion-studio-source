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
import type {
  GameStageLayout,
  PixelBounds,
  Role,
  RoleStatus,
  UpdateGameStageBoundsInput
} from "../../shared/types";
import { ElectronAutomationTarget, type BrowserAutomationTarget } from "./ElectronAutomationTarget";

export interface BrowserManagerEvents {
  change: [RoleStatus[]];
  layoutChange: [GameStageLayout | null];
}

export interface BrowserLaunchOptions {
  preserveLayout?: boolean;
  zoomFactor?: number;
}

export interface BrowserAutomationSession {
  role: Role;
  target: BrowserAutomationTarget;
}

export type BrowserMacroOverlayInstaller = (role: Role, webContents: WebContents) => Promise<void>;

export interface BrowserManagerOptions {
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  embeddedPreloadPath: string;
  getHostWindow: () => BrowserWindow | null;
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

interface BrowserSession {
  hostWindow: BrowserWindow;
  launchedAt?: string;
  role: Role;
  popupViews: Set<WebContentsView>;
  state: RoleStatus["state"];
  target: BrowserAutomationTarget;
  view: WebContentsView;
}

const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
const HIDDEN_VIEW_BOUNDS: PixelBounds = { x: -10_000, y: -10_000, width: 1, height: 1 };

export class BrowserManager extends EventEmitter<BrowserManagerEvents> {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly viewBounds = new Map<string, PixelBounds>();
  private activeLayout: GameStageLayout | null = null;
  private macroOverlayInstaller?: BrowserMacroOverlayInstaller;
  private stageVisible = false;

  constructor(
    private readonly roleStore: Pick<RoleStore, "updateAuthState">,
    private readonly options: BrowserManagerOptions
  ) {
    super();
  }

  setMacroOverlayInstaller(installer: BrowserMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  listStatuses(): RoleStatus[] {
    return [...this.sessions.entries()].map(([roleId, session]) => this.toStatus(roleId, session));
  }

  getActiveLayout(): GameStageLayout | null {
    return this.activeLayout ? structuredClone(this.activeLayout) : null;
  }

  getRoleIdForWebContents(webContentsId: number): string | undefined {
    return [...this.sessions.entries()].find(([, session]) => session.view.webContents.id === webContentsId)?.[0];
  }

  getAutomationSession(roleId: string): BrowserAutomationSession | undefined {
    const session = this.sessions.get(roleId);

    if (session?.state !== "running" || session.view.webContents.isDestroyed()) {
      return undefined;
    }

    return {
      role: session.role,
      target: session.target
    };
  }

  setActiveLayout(layout: GameStageLayout | null): void {
    this.activeLayout = layout ? structuredClone(layout) : null;
    this.stageVisible = false;
    this.viewBounds.clear();
    this.sessions.forEach((session) => session.view.setVisible(false));
    this.emit("layoutChange", this.getActiveLayout());
  }

  updateViewBounds(input: UpdateGameStageBoundsInput): void {
    this.stageVisible = input.visible;
    this.viewBounds.clear();

    for (const item of input.views) {
      this.viewBounds.set(item.roleId, item.bounds);
    }

    this.sessions.forEach((session, roleId) => this.applyRequestedBounds(roleId, session));
  }

  async launch(role: Role, options: BrowserLaunchOptions = {}): Promise<RoleStatus> {
    if (!options.preserveLayout) {
      this.setActiveLayout(createSingleRoleLayout(role, "role"));
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

    const session = this.createSession(role);
    this.sessions.set(role.id, session);
    this.emitChange();

    try {
      await this.applyZoom(session, options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR);
      await session.view.webContents.loadURL(role.launchUrl);
      await this.ensureSessionAuthenticated(role, session);
      session.state = "running";
      session.launchedAt = new Date().toISOString();
      await this.installMacroOverlay(role, session.view.webContents);
      await this.focusSession(session);
      this.emitChange();
      return this.toStatus(role.id, session);
    } catch (error) {
      await this.destroySession(role.id, session);
      throw error;
    }
  }

  async startLogin(role: Role): Promise<void> {
    this.setActiveLayout(createSingleRoleLayout(role, "login"));
    let session = this.sessions.get(role.id);

    if (!session) {
      session = this.createSession(role);
      this.sessions.set(role.id, session);
      this.emitChange();
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
      this.removeRoleFromActiveLayout(roleId);
      return;
    }

    session.state = "stopping";
    this.emitChange();
    await this.destroySession(roleId, session);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((roleId) => this.stop(roleId)));
    this.setActiveLayout(null);
  }

  private createSession(role: Role): BrowserSession {
    const hostWindow = this.options.getHostWindow();

    if (!hostWindow || hostWindow.isDestroyed()) {
      throw new Error("The Rion Studio window is not available.");
    }

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

    view.setBounds(HIDDEN_VIEW_BOUNDS);
    view.setVisible(false);
    hostWindow.contentView.addChildView(view);
    const session: BrowserSession = {
      hostWindow,
      popupViews: new Set(),
      role,
      state: "launching",
      target: new ElectronAutomationTarget(view, view.webContents),
      view
    };

    this.configureWindowOpenHandler(session, view.webContents);

    view.webContents.once("destroyed", () => {
      if (this.sessions.get(role.id) === session) {
        this.sessions.delete(role.id);
        this.removeRoleFromActiveLayout(role.id);
        this.emitChange();
      }
    });

    this.applyRequestedBounds(role.id, session);
    return session;
  }

  private async ensureSessionAuthenticated(role: Role, session: BrowserSession): Promise<void> {
    const result = await this.checkSessionAuthentication(role, session);

    if (result.authState === "authenticated") {
      return;
    }

    await this.roleStore.updateAuthState(role.id, result.authState);
    throw new BrowserLaunchAuthError(result.message ?? NO_PERSISTED_LOGIN_SESSION_MESSAGE);
  }

  private async checkSessionAuthentication(
    role: Role,
    session: BrowserSession
  ): Promise<AuthSessionCheckResult> {
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

  private applyRequestedBounds(roleId: string, session: BrowserSession): void {
    const bounds = this.viewBounds.get(roleId);
    const belongsToLayout = this.activeLayout?.slots.some((slot) => slot.roleId === roleId) ?? false;
    const visible = this.stageVisible && belongsToLayout && Boolean(bounds);

    if (bounds) {
      session.view.setBounds(bounds);
      session.popupViews.forEach((popupView) => popupView.setBounds(bounds));
    }
    session.view.setVisible(visible);
    session.popupViews.forEach((popupView) => popupView.setVisible(visible));
  }

  private configureWindowOpenHandler(session: BrowserSession, webContents: WebContents): void {
    webContents.setWindowOpenHandler(() => ({
      action: "allow",
      createWindow: (windowOptions) => this.createPopupView(session, windowOptions).webContents
    }));
  }

  private createPopupView(
    session: BrowserSession,
    windowOptions: BrowserWindowConstructorOptions
  ): WebContentsView {
    const popupView = this.options.createView({
      webPreferences: {
        ...windowOptions.webPreferences,
        contextIsolation: true,
        nodeIntegration: false,
        partition: createRoleSessionPartition(session.role.id),
        sandbox: true
      }
    });

    const bounds = this.viewBounds.get(session.role.id) ?? HIDDEN_VIEW_BOUNDS;
    popupView.setBounds(bounds);
    popupView.setVisible(this.stageVisible && this.viewBounds.has(session.role.id));
    session.hostWindow.contentView.addChildView(popupView);
    session.popupViews.add(popupView);
    this.configureWindowOpenHandler(session, popupView.webContents);
    popupView.webContents.once("destroyed", () => {
      session.popupViews.delete(popupView);
      if (!session.hostWindow.isDestroyed()) {
        session.hostWindow.contentView.removeChildView(popupView);
      }
    });
    return popupView;
  }

  private async applyZoom(session: BrowserSession, zoomFactor: number): Promise<void> {
    session.view.webContents.setZoomFactor(zoomFactor);
  }

  private async focusSession(session: BrowserSession): Promise<void> {
    if (session.hostWindow.isMinimized()) {
      session.hostWindow.restore();
    }
    session.hostWindow.show();
    session.hostWindow.focus();
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

  private async destroySession(roleId: string, session: BrowserSession): Promise<void> {
    if (this.sessions.get(roleId) !== session) {
      return;
    }

    this.sessions.delete(roleId);
    this.viewBounds.delete(roleId);
    this.removeRoleFromActiveLayout(roleId);

    if (!session.hostWindow.isDestroyed()) {
      session.hostWindow.contentView.removeChildView(session.view);
      session.popupViews.forEach((popupView) => session.hostWindow.contentView.removeChildView(popupView));
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

  private removeRoleFromActiveLayout(roleId: string): void {
    if (!this.activeLayout?.slots.some((slot) => slot.roleId === roleId)) {
      return;
    }

    const slots = this.activeLayout.slots.filter((slot) => slot.roleId !== roleId);
    this.activeLayout = slots.length > 0 ? { ...this.activeLayout, slots } : null;
    this.emit("layoutChange", this.getActiveLayout());
  }

  private emitChange(): void {
    this.emit("change", this.listStatuses());
  }

  private toStatus(roleId: string, session: BrowserSession): RoleStatus {
    return {
      roleId,
      state: session.state,
      launchedAt: session.launchedAt
    };
  }
}

export function createRoleSessionPartition(roleId: string): string {
  return `persist:rion-role-${roleId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function createSingleRoleLayout(role: Role, mode: "login" | "role"): GameStageLayout {
  return {
    id: `${mode}:${role.id}`,
    mode,
    name: role.name,
    slots: [
      {
        roleId: role.id,
        rect: { x: 0, y: 0, width: 1, height: 1 }
      }
    ]
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
