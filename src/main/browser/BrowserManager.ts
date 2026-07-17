import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  BaseWindow,
  BaseWindowConstructorOptions,
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
import { DEFAULT_WORKSPACE_APPEARANCE_SETTINGS } from "../../shared/browserFonts";
import type {
  AppLanguage,
  BrowserLaunchMode,
  EmbeddedRuntimeState,
  EmbeddedRuntimeTabSummary,
  EmbeddedRuntimeWindowSummary,
  LaunchWorkspace,
  NormalizedRect,
  PixelBounds,
  Role,
  RoleStatus,
  WorkspaceBrowserZoomMode,
  WorkspaceBrowserZoomPercent,
  WorkspaceAppearanceSettings,
  WorkspaceDisplayInfo,
  WorkspaceLayoutTemplate
} from "../../shared/types";
import {
  RUNTIME_TABS_STATE_CHANNEL,
  type RuntimeTabAction,
  type RuntimeTabChromeState
} from "../../shared/runtimeTabs";
import { WORKSPACE_RESIZE_INDICATOR_CHANNEL } from "../../shared/internalIpc";
import {
  getAdaptiveWorkspaceBrowserZoomPercent,
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
import type {
  MacRuntimeTabsController,
  MacRuntimeTabsControllerFactory
} from "./MacRuntimeTabsController";
import type { SystemPressureSource } from "./SystemPressureMonitor";
import { WorkspaceResourceCoordinator } from "./WorkspaceResourceCoordinator";

export interface BrowserManagerEvents {
  change: [RoleStatus[]];
  runtimeChange: [EmbeddedRuntimeState];
}

export interface BrowserLaunchOptions {
  zoomFactor?: number;
  target?: BrowserWorkspaceLaunchTarget;
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
  createRuntimeChromeView?: (options: WebContentsViewConstructorOptions) => WebContentsView;
  createTabbedHostWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  dividerPreloadPath: string;
  embeddedPreloadPath: string;
  runtimeTabsPageUrl?: string;
  runtimeTabsPreloadPath?: string;
  externalChromeManager?: ExternalChromeManager;
  getBrowserLaunchMode?: (role?: Role) => BrowserLaunchMode | Promise<BrowserLaunchMode>;
  getCursorScreenPoint?: () => { x: number; y: number };
  getLoginUrl?: (role: Role) => string | Promise<string>;
  getRuntimeTabGameIcon?: (role: Role) => string | undefined | Promise<string | undefined>;
  getLaunchWorkArea: () => PixelBounds;
  getDefaultLaunchTarget?: () => BrowserWorkspaceLaunchTarget;
  getWorkspaceDisplays?: () => WorkspaceDisplayInfo[];
  handleRuntimeTabAction?: (
    window: BaseWindow,
    displayId: number,
    action: RuntimeTabAction
  ) => void;
  createMacRuntimeTabsController?: MacRuntimeTabsControllerFactory;
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
  gameIconDataUrl?: string;
  id: string;
  displayHostId: string;
  hidden: boolean;
  htmlFullscreenWebContentsIds: Set<number>;
  lastFocusedView?: WebContentsView;
  name: string;
  roleIds: Set<string>;
  sourceId: string;
  type: "role" | "workspace";
  workspaceAppearance: WorkspaceAppearanceSettings;
  workspaceTemplate?: WorkspaceLayoutTemplate;
  window: BaseWindow;
  workspaceId?: string;
}

interface EmbeddedDisplayHost {
  activeTabId?: string;
  chromeView?: WebContentsView;
  chromeWebContents?: WebContents;
  closing: boolean;
  displayId: number;
  pendingWindowAction?: "close" | "hide";
  id: string;
  macNativeTabs?: MacRuntimeTabsController;
  macSystemMenuBarHeight: number;
  systemMenuBarTemporarilyRevealed: boolean;
  tabIds: string[];
  toolbarCursorMonitorTimer?: ReturnType<typeof setTimeout>;
  toolbarRevealLockCount: number;
  toolbarTemporarilyVisible: boolean;
  window: BaseWindow;
  windowFullscreen: boolean;
  windowFullscreenTransitionTarget?: boolean;
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
  zoomMode: WorkspaceBrowserZoomMode;
}

const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
const RUNTIME_TAB_CHROME_HEIGHT = 40;
const RUNTIME_TAB_FULLSCREEN_HOT_ZONE_HEIGHT = 2;
const RUNTIME_TAB_FULLSCREEN_REVEAL_DETECTION_HEIGHT = 4;
const RUNTIME_TAB_FULLSCREEN_REVEAL_ZONE_HEIGHT = 48;
const RUNTIME_TAB_MAC_MENU_BAR_FALLBACK_HEIGHT = 30;
const RUNTIME_TAB_MAC_MENU_BAR_MAX_HEIGHT = 64;
const RUNTIME_TAB_TOOLBAR_CURSOR_MONITOR_INTERVAL_MS = 50;
export const EXTERNAL_COMPAT_NOTICE =
  "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.";
const FULL_WINDOW_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

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
  private readonly displayHosts = new Map<number, EmbeddedDisplayHost>();
  private readonly displayHostByChromeWebContentsId = new Map<number, EmbeddedDisplayHost>();
  private readonly hosts = new Map<string, GameHostWindow>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly pendingWorkspaceLaunchIds = new Set<string>();
  private readonly roleOperationTails = new Map<string, Promise<void>>();
  private readonly workspaceDisplayReservations = new Map<string, { displayId: number; name: string }>();
  private readonly workspaceHostIds = new Map<string, string>();
  private runtimeTabsLanguage: AppLanguage = "en";
  private alwaysShowToolbarInFullScreen = false;
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

  listEmbeddedRuntimeState(): EmbeddedRuntimeState {
    const windows: EmbeddedRuntimeWindowSummary[] = [...this.displayHosts.values()].map((host) => ({
      displayId: host.displayId,
      bounds: getWindowBounds(host.window),
      visible: !host.window.isDestroyed() && isWindowVisible(host.window),
      ...(host.activeTabId ? { activeTabId: host.activeTabId } : {}),
      tabCount: host.tabIds.length
    }));
    const tabs: EmbeddedRuntimeTabSummary[] = [...this.displayHosts.values()].flatMap((displayHost) =>
      displayHost.tabIds.flatMap((tabId) => {
        const tab = this.hosts.get(tabId);
        return tab
          ? [{
              id: tab.id,
              type: tab.type,
              sourceId: tab.sourceId,
              name: tab.name,
              displayId: displayHost.displayId,
              roleIds: [...tab.roleIds],
              hidden: tab.hidden,
              active: displayHost.activeTabId === tab.id && !tab.hidden && isWindowVisible(displayHost.window)
            }]
          : [];
      })
    );
    return { windows, tabs };
  }

  setRuntimeTabsLanguage(language: AppLanguage): void {
    this.runtimeTabsLanguage = language;
    this.displayHosts.forEach((host) => this.sendRuntimeChromeState(host));
  }

  setAlwaysShowToolbarInFullScreen(value: boolean): void {
    if (this.alwaysShowToolbarInFullScreen === value) return;
    this.alwaysShowToolbarInFullScreen = value;
    this.displayHosts.forEach((host) => {
      if (host.macNativeTabs) {
        host.macNativeTabs.setFullscreenPolicy(value ? "always" : "autoHide");
        this.sendRuntimeChromeState(host);
        return;
      }
      if (value) this.clearRuntimeToolbarCursorMonitor(host);
      host.toolbarTemporarilyVisible = false;
      host.systemMenuBarTemporarilyRevealed = false;
      this.layoutDisplayHost(host);
      this.syncRuntimeToolbarCursorMonitor(host);
    });
  }

  handleRuntimeToolbarPointer(displayId: number, entered: boolean): void {
    const displayHost = this.displayHosts.get(displayId);
    if (
      !displayHost ||
      displayHost.macNativeTabs ||
      !this.isDisplayHostFullscreen(displayHost) ||
      this.alwaysShowToolbarInFullScreen
    ) return;

    if (entered) {
      this.revealRuntimeToolbar(displayHost);
      return;
    }

    this.collapseRuntimeToolbarIfCursorLeft(displayHost);
  }

  acquireRuntimeToolbarRevealLock(displayId: number): () => void {
    const displayHost = this.displayHosts.get(displayId);
    if (!displayHost || displayHost.closing) return () => undefined;
    displayHost.toolbarRevealLockCount += 1;
    if (displayHost.macNativeTabs) {
      if (displayHost.toolbarRevealLockCount === 1) {
        displayHost.macNativeTabs.setRevealLocked(true);
      }
      let nativeReleased = false;
      return () => {
        if (nativeReleased) return;
        nativeReleased = true;
        displayHost.toolbarRevealLockCount = Math.max(
          0,
          displayHost.toolbarRevealLockCount - 1
        );
        if (displayHost.toolbarRevealLockCount === 0) {
          displayHost.macNativeTabs?.setRevealLocked(false);
        }
      };
    }
    if (
      this.isDisplayHostFullscreen(displayHost) &&
      !this.alwaysShowToolbarInFullScreen
    ) this.revealRuntimeToolbar(displayHost);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      displayHost.toolbarRevealLockCount = Math.max(0, displayHost.toolbarRevealLockCount - 1);
      if (
        displayHost.toolbarRevealLockCount === 0 &&
        !displayHost.closing &&
        this.isDisplayHostFullscreen(displayHost) &&
        !this.alwaysShowToolbarInFullScreen
      ) {
        this.collapseRuntimeToolbarIfCursorLeft(displayHost);
      }
    };
  }

  getRuntimeDisplayIdForWebContents(webContentsId: number): number | undefined {
    return this.displayHostByChromeWebContentsId.get(webContentsId)?.displayId;
  }

  getRuntimeWindowForWebContents(webContentsId: number): BaseWindow | undefined {
    const displayHost = this.displayHostByChromeWebContentsId.get(webContentsId);
    return displayHost?.window.isDestroyed() ? undefined : displayHost?.window;
  }

  toggleRuntimeWindowFullscreenForWindow(windowId: number): boolean {
    const displayHost = [...this.displayHosts.values()].find((host) => host.window.id === windowId);
    if (!displayHost) return false;
    this.toggleRuntimeWindowFullscreen(displayHost);
    return true;
  }

  handleRuntimeWindowControl(
    displayId: number,
    control: "close" | "minimize" | "toggleFullscreen" | "zoom"
  ): void {
    const displayHost = this.displayHosts.get(displayId);
    if (!displayHost || displayHost.closing || displayHost.window.isDestroyed()) return;
    switch (control) {
      case "close":
        this.hideDisplayHost(displayHost);
        return;
      case "minimize":
        if (!this.isWindowFullscreenOrTransitioning(displayHost)) displayHost.window.minimize();
        return;
      case "toggleFullscreen":
        this.toggleRuntimeWindowFullscreen(displayHost);
        return;
      case "zoom":
        if (this.isWindowFullscreenOrTransitioning(displayHost)) return;
        if (displayHost.window.isMaximized()) displayHost.window.unmaximize();
        else displayHost.window.maximize();
    }
  }

  async showEmbeddedRuntimeWindows(displayId?: number): Promise<void> {
    const targets = displayId === undefined
      ? [...this.displayHosts.values()]
      : [this.displayHosts.get(displayId)].filter((host): host is EmbeddedDisplayHost => Boolean(host));
    await Promise.all(targets.map(async (host) => {
      const active = host.activeTabId ? this.hosts.get(host.activeTabId) : undefined;
      let foregroundTab = active;
      if (!active || active.hidden) {
        const next = host.tabIds.map((id) => this.hosts.get(id)).find(Boolean);
        if (next) {
          foregroundTab = next;
        }
      }
      if (foregroundTab) {
        await this.prepareRuntimeTabForeground(foregroundTab.id);
        foregroundTab.hidden = false;
        host.activeTabId = foregroundTab.id;
      }
      this.showDisplayHost(host);
    }));
    await this.reconcileRuntimeTabs();
  }

  async showRuntimeTab(tabId: string): Promise<void> {
    const tab = this.hosts.get(tabId);
    if (!tab) return;
    const displayHost = this.getDisplayHost(tab);
    if (!displayHost) return;
    await this.prepareRuntimeTabForeground(tab.id);
    tab.hidden = false;
    displayHost.activeTabId = tab.id;
    this.showDisplayHost(displayHost);
    this.layoutDisplayHost(displayHost);
    await this.reconcileRuntimeTabs();
  }

  async hideRuntimeTab(tabId: string): Promise<void> {
    const tab = this.hosts.get(tabId);
    if (!tab) return;
    const displayHost = this.getDisplayHost(tab);
    if (!displayHost) return;
    const nextTabId = displayHost.activeTabId === tab.id
      ? displayHost.tabIds.find((id) => !this.hosts.get(id)?.hidden && id !== tab.id)
      : displayHost.activeTabId;
    if (nextTabId && nextTabId !== displayHost.activeTabId) {
      await this.prepareRuntimeTabForeground(nextTabId);
    }
    tab.hidden = true;
    if (displayHost.activeTabId === tab.id) {
      displayHost.activeTabId = nextTabId;
    }
    if (!displayHost.activeTabId) {
      this.hideDisplayHost(displayHost);
    }
    this.layoutDisplayHost(displayHost);
    await this.reconcileRuntimeTabs();
  }

  stopRuntimeTab(tabId: string): Promise<void> {
    return this.stopHost(tabId);
  }

  reorderRuntimeTab(tabId: string, beforeTabId?: string): void {
    const tab = this.hosts.get(tabId);
    const displayHost = tab ? this.getDisplayHost(tab) : undefined;
    if (!tab || !displayHost) return;
    const without = displayHost.tabIds.filter((id) => id !== tabId);
    const beforeIndex = beforeTabId ? without.indexOf(beforeTabId) : -1;
    without.splice(beforeIndex < 0 ? without.length : beforeIndex, 0, tabId);
    displayHost.tabIds = without;
    this.sendRuntimeChromeState(displayHost);
    this.emitChange();
  }

  async moveRuntimeTab(tabId: string, displayId: number): Promise<void> {
    const tab = this.hosts.get(tabId);
    const source = tab ? this.getDisplayHost(tab) : undefined;
    const targetInfo = this.getLaunchTargetForDisplay(displayId);
    if (!tab || !source || !targetInfo || source.displayId === displayId) return;
    await this.prepareRuntimeTabForeground(tab.id);
    const target = this.getOrCreateDisplayHost(targetInfo);
    const sourceWasFullscreen = this.isDisplayHostFullscreen(source);
    const targetWasFullscreen = this.isDisplayHostFullscreen(target);

    this.detachTabViews(tab, source);
    source.tabIds = source.tabIds.filter((id) => id !== tab.id);
    if (source.activeTabId === tab.id) {
      source.activeTabId = source.tabIds.find((id) => !this.hosts.get(id)?.hidden);
    }
    tab.window = target.window;
    tab.displayHostId = target.id;
    tab.hidden = false;
    target.tabIds.push(tab.id);
    target.activeTabId = tab.id;
    this.attachTabViews(tab, target);
    this.handleDisplayHostFullscreenTransition(source, sourceWasFullscreen);
    this.handleDisplayHostFullscreenTransition(target, targetWasFullscreen);
    this.showDisplayHost(target);
    this.layoutDisplayHost(source);
    this.layoutDisplayHost(target);
    this.destroyDisplayHostIfEmpty(source);
    await this.reconcileRuntimeTabs();
  }

  handleDisplayRemoved(displayId: number, fallbackDisplayId: number): void {
    const source = this.displayHosts.get(displayId);
    const targetInfo = this.getLaunchTargetForDisplay(fallbackDisplayId);
    if (!source || !targetInfo || displayId === fallbackDisplayId) return;
    const sourceWasVisible = isWindowVisible(source.window);
    const target = this.getOrCreateDisplayHost(targetInfo);
    const targetWasFullscreen = this.isDisplayHostFullscreen(target);
    const targetHadActive = Boolean(target.activeTabId);
    const sourceActive = source.activeTabId;
    for (const tabId of [...source.tabIds]) {
      const tab = this.hosts.get(tabId);
      if (!tab) continue;
      this.detachTabViews(tab, source);
      tab.window = target.window;
      tab.displayHostId = target.id;
      target.tabIds.push(tab.id);
      this.attachTabViews(tab, target);
    }
    source.tabIds = [];
    this.handleDisplayHostFullscreenTransition(target, targetWasFullscreen);
    if (!targetHadActive && sourceActive) target.activeTabId = sourceActive;
    if (sourceWasVisible && !isWindowVisible(target.window)) showWindowWithoutFocus(target.window);
    this.layoutDisplayHost(target);
    this.destroyDisplayHostIfEmpty(source);
    void this.reconcileRuntimeTabs();
  }

  handleDisplayMetricsChanged(displayId: number, workArea: PixelBounds): void {
    const host = this.displayHosts.get(displayId);
    if (!host || host.window.isDestroyed()) return;
    this.refreshMacSystemMenuBarHeight(host, workArea);
    if (!this.isMacRuntimeFullscreen(host)) {
      host.window.setBounds(clampBoundsToWorkArea(getWindowBounds(host.window), workArea));
    }
    host.systemMenuBarTemporarilyRevealed = false;
    this.layoutDisplayHost(host);
    this.syncRuntimeToolbarCursorMonitor(host);
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

    const target = options.target ?? this.getDefaultLaunchTarget();
    const gameIconDataUrl = await this.resolveRuntimeTabGameIcon(role);
    const host = this.createHost(
      role.name,
      undefined,
      target.workArea,
      undefined,
      target.displayId,
      role.id,
      gameIconDataUrl
    );
    await this.applyBrowserFonts(role);
    const session = this.createSession(role, host, FULL_WINDOW_RECT, zoomFactor);

    try {
      const displayHost = this.getDisplayHost(host);
      if (displayHost) this.showDisplayHost(displayHost);
      await this.finishLaunch(session, zoomFactor);
      await this.resourceCoordinator.activateWorkspace(
        host.id,
        { mode: "unrestricted" },
        [new ElectronWorkspaceResourceTarget(role.id, session.view.webContents)]
      );
      await this.reconcileRuntimeTabs();
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
    workspace: Pick<LaunchWorkspace, "browserZoomMode" | "browserZoomPercent" | "id" | "name" | "resourcePolicy" | "template">,
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
    workspace: Pick<LaunchWorkspace, "browserZoomMode" | "browserZoomPercent" | "id" | "name" | "resourcePolicy" | "template">,
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

    this.pendingWorkspaceLaunchIds.add(workspace.id);
    this.emitChange();

    try {
      const launchMode = requestedLaunchMode ?? await this.getBrowserLaunchMode();
      if (launchMode === "external") {
        return this.launchExternalWorkspace(workspace, items, undefined, target);
      }

      const workspaceAppearance = await this.getWorkspaceAppearanceSettings();
      const host = this.createHost(
        workspace.name,
        workspace.id,
        target?.workArea,
        workspaceAppearance,
        target?.displayId,
        workspace.id,
        undefined,
        workspace.template
      );
      try {
        await Promise.all(items.map((item) => this.applyBrowserFonts(item.role)));
        const normalizedRects = normalizeWorkspaceRectEdges(items.map((item) => item.rect));
        const zoomFactor = workspace.browserZoomPercent / 100;
        const sessions = items.map((item, index) =>
          this.createSession(item.role, host, normalizedRects[index], zoomFactor, workspace.browserZoomMode)
        );
        await this.createHostDividers(host);
        const displayHost = this.getDisplayHost(host);
        if (displayHost) this.showDisplayHost(displayHost);
        const launchResults = await Promise.allSettled(
          sessions.map((session) => this.finishLaunch(session, session.zoomFactor))
        );
        const failedLaunch = launchResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (failedLaunch) throw failedLaunch.reason;
        if (host.closing || host.window.isDestroyed()) {
          return [];
        }
        await this.resourceCoordinator.activateWorkspace(
          host.id,
          workspace.resourcePolicy,
          sessions.map((session) =>
            new ElectronWorkspaceResourceTarget(session.role.id, session.view.webContents)
          )
        );
        await this.reconcileRuntimeTabs();
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
      this.pendingWorkspaceLaunchIds.delete(workspace.id);
      this.cleanupWorkspaceDisplayReservation(workspace.id);
      this.emitChange();
    }
  }

  startLogin(role: Role, options: BrowserLaunchOptions = {}): Promise<void> {
    return this.runRoleOperation([role.id], () => this.startLoginUnlocked(role, options));
  }

  private async startLoginUnlocked(role: Role, options: BrowserLaunchOptions): Promise<void> {
    let session = this.sessions.get(role.id);

    if (!session) {
      const target = options.target ?? this.getDefaultLaunchTarget();
      const gameIconDataUrl = await this.resolveRuntimeTabGameIcon(role);
      const host = this.createHost(
        role.name,
        undefined,
        target.workArea,
        undefined,
        target.displayId,
        role.id,
        gameIconDataUrl
      );
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
        const host = this.hosts.get(session.hostId);
        if (host && host.type === "role") {
          await this.resourceCoordinator.activateWorkspace(
            host.id,
            { mode: "unrestricted" },
            [new ElectronWorkspaceResourceTarget(session.role.id, session.view.webContents)]
          );
        }
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
    if (host && host.roleIds.size === 0 && !host.closing) {
      await this.closeHostWindow(host);
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
    const hostId = this.workspaceHostIds.get(workspaceId);
    await this.resourceCoordinator.deactivateWorkspace(hostId ?? workspaceId);
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

    const windowBounds = host.window.getContentBounds();
    const contentBounds = this.getTabContentBounds(host);
    const size = target.divider.axis === "vertical" ? contentBounds.width : contentBounds.height;
    const origin = target.divider.axis === "vertical"
      ? windowBounds.x
      : windowBounds.y + contentBounds.y;
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
    workspaceAppearance: WorkspaceAppearanceSettings = DEFAULT_WORKSPACE_APPEARANCE_SETTINGS,
    displayId?: number,
    sourceId = workspaceId ?? title,
    gameIconDataUrl?: string,
    workspaceTemplate?: WorkspaceLayoutTemplate
  ): GameHostWindow {
    const target = displayId === undefined
      ? this.getDefaultLaunchTarget()
      : { displayId, workArea: launchBounds ?? this.options.getLaunchWorkArea() };
    const displayHost = this.getOrCreateDisplayHost(target);
    const host: GameHostWindow = {
      closing: false,
      displayHostId: displayHost.id,
      dividers: [],
      ...(gameIconDataUrl ? { gameIconDataUrl } : {}),
      hidden: false,
      htmlFullscreenWebContentsIds: new Set(),
      id: randomUUID(),
      name: title,
      roleIds: new Set(),
      sourceId,
      type: workspaceId ? "workspace" : "role",
      window: displayHost.window,
      workspaceAppearance: { ...workspaceAppearance },
      ...(workspaceTemplate ? { workspaceTemplate } : {}),
      workspaceId
    };

    this.hosts.set(host.id, host);
    displayHost.tabIds.push(host.id);
    displayHost.activeTabId = host.id;
    if (workspaceId) {
      this.workspaceHostIds.set(workspaceId, host.id);
    }
    this.layoutDisplayHost(displayHost);
    this.sendRuntimeChromeState(displayHost);
    return host;
  }

  private getOrCreateDisplayHost(target: BrowserWorkspaceLaunchTarget): EmbeddedDisplayHost {
    const existing = this.displayHosts.get(target.displayId);
    if (existing && !existing.window.isDestroyed()) return existing;

    const platform = this.options.platform ?? process.platform;
    const prefersReducedTransparency = this.options.prefersReducedTransparency?.() ?? false;
    const commonOptions: BaseWindowConstructorOptions = {
      ...target.workArea,
      ...(platform === "darwin" ? { acceptFirstMouse: true } : {}),
      closable: true,
      frame: true,
      maximizable: true,
      minimizable: true,
      minHeight: 480,
      minWidth: 720,
      resizable: true,
      show: false,
      title: "Rion Studio",
      ...getWorkspaceWindowMaterialOptions(platform, prefersReducedTransparency)
    };
    let macNativeTabs: MacRuntimeTabsController | undefined;
    let window: BaseWindow;
    if (platform === "darwin" && this.options.createMacRuntimeTabsController) {
      const candidate = this.options.createHostWindow({
        ...commonOptions,
        frame: true,
        fullscreenable: true,
        titleBarStyle: "default"
      });
      try {
        macNativeTabs = this.options.createMacRuntimeTabsController(
          candidate,
          (action) => this.options.handleRuntimeTabAction?.(
            candidate,
            target.displayId,
            action
          )
        );
        macNativeTabs.setFullscreenPolicy(
          this.alwaysShowToolbarInFullScreen ? "always" : "autoHide"
        );
        window = candidate;
      } catch (error) {
        console.error(
          "Failed to attach native macOS runtime tabs; using the HTML fallback.",
          error
        );
        macNativeTabs?.destroy();
        macNativeTabs = undefined;
        candidate.close();
        window = this.options.createHostWindow({
          ...commonOptions,
          frame: false,
          fullscreenable: true
        });
      }
    } else {
      const useMacHtmlChrome = platform === "darwin" &&
        Boolean(this.options.createRuntimeChromeView);
      window = useMacHtmlChrome
        ? this.options.createHostWindow({
            ...commonOptions,
            frame: false,
            fullscreenable: true
          })
        : this.options.createTabbedHostWindow
          ? this.options.createTabbedHostWindow({
              ...commonOptions,
              autoHideMenuBar: platform !== "darwin",
              ...(platform === "win32"
                ? {
                    titleBarStyle: "hidden",
                    titleBarOverlay: {
                      height: RUNTIME_TAB_CHROME_HEIGHT
                    }
                  }
                : { titleBarStyle: "hidden" }),
              webPreferences: {
                backgroundThrottling: true,
                contextIsolation: true,
                nodeIntegration: false,
                preload: this.options.runtimeTabsPreloadPath,
                sandbox: true
              }
            })
          : this.options.createHostWindow({ ...commonOptions, titleBarStyle: "default" });
    }
    const useMacCustomChrome = platform === "darwin" &&
      !macNativeTabs && Boolean(this.options.createRuntimeChromeView);
    window.contentView.setBackgroundColor("#00000000");
    const displayHost: EmbeddedDisplayHost = {
      closing: false,
      displayId: target.displayId,
      id: randomUUID(),
      ...(macNativeTabs ? { macNativeTabs } : {}),
      macSystemMenuBarHeight: RUNTIME_TAB_MAC_MENU_BAR_FALLBACK_HEIGHT,
      systemMenuBarTemporarilyRevealed: false,
      tabIds: [],
      toolbarRevealLockCount: 0,
      toolbarTemporarilyVisible: false,
      window,
      windowFullscreen: false
    };
    this.displayHosts.set(target.displayId, displayHost);
    if (!macNativeTabs) this.refreshMacSystemMenuBarHeight(displayHost);
    window.on("enter-full-screen", () => this.completeWindowFullscreenTransition(displayHost, true));
    window.on("leave-full-screen", () => this.completeWindowFullscreenTransition(displayHost, false));

    if (useMacCustomChrome) {
      const chromeView = this.options.createRuntimeChromeView!({
        webPreferences: {
          backgroundThrottling: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: this.options.runtimeTabsPreloadPath,
          sandbox: true
        }
      });
      chromeView.setBackgroundColor("#00000000");
      displayHost.chromeView = chromeView;
      displayHost.chromeWebContents = chromeView.webContents;
      window.contentView.addChildView(chromeView);
      this.displayHostByChromeWebContentsId.set(chromeView.webContents.id, displayHost);
      chromeView.webContents.once("did-finish-load", () => this.sendRuntimeChromeState(displayHost));
      this.configureRuntimeWindowAccelerators(displayHost, chromeView.webContents);
      void chromeView.webContents.loadURL(this.options.runtimeTabsPageUrl ?? "about:blank").catch((error) => {
        console.error("Failed to load the runtime tab chrome.", error);
      });
    } else if (isBrowserWindow(window)) {
      displayHost.chromeWebContents = window.webContents;
      this.displayHostByChromeWebContentsId.set(window.webContents.id, displayHost);
      window.webContents.once("did-finish-load", () => this.sendRuntimeChromeState(displayHost));
      this.configureRuntimeWindowAccelerators(displayHost, window.webContents);
      void window.loadURL(this.options.runtimeTabsPageUrl ?? "about:blank").catch((error) => {
        console.error("Failed to load the runtime tab chrome.", error);
      });
    }
    window.on("resize", () => this.layoutDisplayHost(displayHost));
    window.on("restore", () => this.layoutDisplayHost(displayHost));
    window.on("focus", () => this.restoreActiveGameViewFocus(displayHost));
    window.on("show", () => {
      this.syncRuntimeToolbarCursorMonitor(displayHost);
      void this.reconcileRuntimeTabs();
    });
    window.on("hide", () => {
      this.clearRuntimeToolbarCursorMonitor(displayHost);
      displayHost.toolbarTemporarilyVisible = false;
      displayHost.systemMenuBarTemporarilyRevealed = false;
      this.applyRuntimeToolbarState(displayHost);
      void this.reconcileRuntimeTabs();
    });
    window.on("close", (event) => {
      if (displayHost.closing) return;
      event.preventDefault();
      this.hideDisplayHost(displayHost);
    });
    window.once("closed", () => {
      this.clearRuntimeToolbarCursorMonitor(displayHost);
      displayHost.macNativeTabs?.destroy();
      displayHost.macNativeTabs = undefined;
      if (displayHost.chromeWebContents) {
        this.displayHostByChromeWebContentsId.delete(displayHost.chromeWebContents.id);
      }
      if (this.displayHosts.get(displayHost.displayId) === displayHost) {
        this.displayHosts.delete(displayHost.displayId);
      }
    });
    return displayHost;
  }

  private getDefaultLaunchTarget(): BrowserWorkspaceLaunchTarget {
    return this.options.getDefaultLaunchTarget?.() ?? {
      displayId: 0,
      workArea: this.options.getLaunchWorkArea()
    };
  }

  private getLaunchTargetForDisplay(displayId: number): BrowserWorkspaceLaunchTarget | undefined {
    const display = this.options.getWorkspaceDisplays?.().find((item) => item.id === displayId);
    if (display) return { displayId: display.id, workArea: display.workArea };
    const fallback = this.getDefaultLaunchTarget();
    return fallback.displayId === displayId ? fallback : undefined;
  }

  private getDisplayHost(tab: GameHostWindow): EmbeddedDisplayHost | undefined {
    return [...this.displayHosts.values()].find((host) => host.id === tab.displayHostId);
  }

  private getTabContentBounds(tab: GameHostWindow): PixelBounds {
    const displayHost = this.getDisplayHost(tab);
    const bounds = tab.window.getContentBounds();
    const chromeHeight = displayHost ? this.getRuntimeContentTopInset(displayHost) : 0;
    return {
      x: 0,
      y: chromeHeight,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height - chromeHeight)
    };
  }

  private layoutDisplayHost(displayHost: EmbeddedDisplayHost | undefined): void {
    if (!displayHost || displayHost.window.isDestroyed()) return;
    displayHost.tabIds.forEach((tabId) => {
      const tab = this.hosts.get(tabId);
      if (tab) this.layoutHost(tab);
    });
    this.layoutRuntimeChrome(displayHost);
    this.sendRuntimeChromeState(displayHost);
  }

  private showDisplayHost(host: EmbeddedDisplayHost): void {
    if (host.window.isDestroyed()) return;
    if (host.pendingWindowAction === "hide") host.pendingWindowAction = undefined;
    if (host.window.isMinimized()) host.window.restore();
    host.window.show();
    host.window.focus();
    this.layoutDisplayHost(host);
    this.syncRuntimeToolbarCursorMonitor(host);
  }

  private hideDisplayHost(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.window.isDestroyed()) return;
    if (this.deferDisplayHostActionUntilFullscreenExit(displayHost, "hide")) return;
    this.performDisplayHostHide(displayHost);
  }

  private performDisplayHostHide(displayHost: EmbeddedDisplayHost): void {
    displayHost.pendingWindowAction = undefined;
    if (displayHost.window.isDestroyed()) return;
    displayHost.window.hide();
    void this.reconcileRuntimeTabs();
  }

  private detachTabViews(tab: GameHostWindow, displayHost: EmbeddedDisplayHost): void {
    if (displayHost.window.isDestroyed()) return;
    tab.roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (!session) return;
      displayHost.window.contentView.removeChildView(session.view);
      session.popupViews.forEach((view) => displayHost.window.contentView.removeChildView(view));
    });
    tab.dividers.forEach((divider) => displayHost.window.contentView.removeChildView(divider.view));
  }

  private attachTabViews(tab: GameHostWindow, displayHost: EmbeddedDisplayHost): void {
    if (displayHost.window.isDestroyed()) return;
    tab.roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (!session) return;
      displayHost.window.contentView.addChildView(session.view);
      session.popupViews.forEach((view) => displayHost.window.contentView.addChildView(view));
    });
    tab.dividers.forEach((divider) => displayHost.window.contentView.addChildView(divider.view));
    this.bringRuntimeChromeToFront(displayHost);
  }

  private destroyDisplayHostIfEmpty(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.tabIds.length > 0 || displayHost.closing) return;
    displayHost.closing = true;
    this.clearRuntimeToolbarCursorMonitor(displayHost);
    displayHost.systemMenuBarTemporarilyRevealed = false;
    if (this.deferDisplayHostActionUntilFullscreenExit(displayHost, "close")) return;
    this.finalizeDisplayHostDestroy(displayHost);
  }

  private finalizeDisplayHostDestroy(displayHost: EmbeddedDisplayHost): void {
    displayHost.pendingWindowAction = undefined;
    this.displayHosts.delete(displayHost.displayId);
    displayHost.macNativeTabs?.destroy();
    displayHost.macNativeTabs = undefined;
    if (displayHost.chromeWebContents) {
      this.displayHostByChromeWebContentsId.delete(displayHost.chromeWebContents.id);
    }
    if (!displayHost.window.isDestroyed()) displayHost.window.close();
  }

  private sendRuntimeChromeState(displayHost: EmbeddedDisplayHost): void {
    const chromeWebContents = displayHost.chromeWebContents;
    if (
      !displayHost.macNativeTabs &&
      (!chromeWebContents || chromeWebContents.isDestroyed())
    ) return;
    const state: RuntimeTabChromeState = {
      ...this.listEmbeddedRuntimeState(),
      alwaysShowToolbarInFullScreen: this.alwaysShowToolbarInFullScreen,
      displayId: displayHost.displayId,
      displays: this.options.getWorkspaceDisplays?.() ?? [],
      fullscreen: this.isDisplayHostFullscreen(displayHost),
      language: this.runtimeTabsLanguage,
      tabIconDataUrls: Object.fromEntries(
        [...this.hosts.values()].flatMap((host) =>
          host.gameIconDataUrl ? [[host.id, host.gameIconDataUrl] as const] : []
        )
      ),
      tabWorkspaceTemplates: Object.fromEntries(
        [...this.hosts.values()].flatMap((host) =>
          host.workspaceTemplate ? [[host.id, host.workspaceTemplate] as const] : []
        )
      ),
      toolbarVisible: this.isRuntimeToolbarVisible(displayHost),
      windowFullscreen: displayHost.windowFullscreen
    };
    if (displayHost.macNativeTabs) {
      try {
        displayHost.macNativeTabs.update(state);
      } catch (error) {
        console.error("Failed to update native macOS runtime tabs.", error);
      }
    }
    if (chromeWebContents && !chromeWebContents.isDestroyed()) {
      chromeWebContents.send(RUNTIME_TABS_STATE_CHANNEL, state);
    }
  }

  private async resolveRuntimeTabGameIcon(role: Role): Promise<string | undefined> {
    try {
      return await this.options.getRuntimeTabGameIcon?.(role);
    } catch {
      return undefined;
    }
  }

  private isDisplayHostFullscreen(displayHost: EmbeddedDisplayHost): boolean {
    return displayHost.windowFullscreen || displayHost.tabIds.some(
      (tabId) => (this.hosts.get(tabId)?.htmlFullscreenWebContentsIds.size ?? 0) > 0
    );
  }

  private setWindowFullscreen(displayHost: EmbeddedDisplayHost, fullscreen: boolean): void {
    const wasFullscreen = this.isDisplayHostFullscreen(displayHost);
    displayHost.windowFullscreen = fullscreen;
    this.handleDisplayHostFullscreenTransition(displayHost, wasFullscreen);
  }

  private completeWindowFullscreenTransition(
    displayHost: EmbeddedDisplayHost,
    fullscreen: boolean
  ): void {
    displayHost.windowFullscreenTransitionTarget = undefined;
    this.setWindowFullscreen(displayHost, fullscreen);
    if (!displayHost.pendingWindowAction) return;
    if (fullscreen) {
      this.requestWindowFullscreen(displayHost, false);
      return;
    }
    this.performPendingDisplayHostAction(displayHost);
  }

  private toggleRuntimeWindowFullscreen(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.window.isDestroyed() || displayHost.windowFullscreenTransitionTarget !== undefined) return;
    this.requestWindowFullscreen(displayHost, !displayHost.windowFullscreen);
  }

  private requestWindowFullscreen(displayHost: EmbeddedDisplayHost, fullscreen: boolean): boolean {
    if (
      displayHost.window.isDestroyed() ||
      displayHost.windowFullscreenTransitionTarget !== undefined ||
      displayHost.windowFullscreen === fullscreen
    ) return false;
    if (fullscreen && !displayHost.macNativeTabs) {
      this.refreshMacSystemMenuBarHeight(displayHost);
    }
    displayHost.windowFullscreenTransitionTarget = fullscreen;
    try {
      displayHost.macNativeTabs?.prepareFullscreenTransition(fullscreen);
      displayHost.window.setFullScreen(fullscreen);
    } catch (error) {
      if (fullscreen) {
        try {
          displayHost.macNativeTabs?.prepareFullscreenTransition(false);
        } catch (rollbackError) {
          console.error("Failed to roll back macOS fullscreen preflight.", rollbackError);
        }
      }
      displayHost.windowFullscreenTransitionTarget = undefined;
      throw error;
    }
    return true;
  }

  private isWindowFullscreenOrTransitioning(displayHost: EmbeddedDisplayHost): boolean {
    return displayHost.windowFullscreen || displayHost.windowFullscreenTransitionTarget !== undefined;
  }

  private deferDisplayHostActionUntilFullscreenExit(
    displayHost: EmbeddedDisplayHost,
    action: "close" | "hide"
  ): boolean {
    if (action === "close" || !displayHost.pendingWindowAction) {
      displayHost.pendingWindowAction = action;
    }
    if (displayHost.window.isDestroyed()) return false;
    if (displayHost.windowFullscreenTransitionTarget !== undefined) return true;
    if (!displayHost.windowFullscreen) return false;
    this.requestWindowFullscreen(displayHost, false);
    return true;
  }

  private performPendingDisplayHostAction(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.pendingWindowAction === "close") {
      this.finalizeDisplayHostDestroy(displayHost);
      return;
    }
    if (displayHost.pendingWindowAction === "hide") this.performDisplayHostHide(displayHost);
  }

  private setHtmlFullscreen(host: GameHostWindow, webContentsId: number, fullscreen: boolean): void {
    const displayHost = this.getDisplayHost(host);
    if (!displayHost) return;
    const wasFullscreen = this.isDisplayHostFullscreen(displayHost);
    if (fullscreen) {
      host.htmlFullscreenWebContentsIds.add(webContentsId);
    } else {
      host.htmlFullscreenWebContentsIds.delete(webContentsId);
    }
    this.handleDisplayHostFullscreenTransition(displayHost, wasFullscreen);
  }

  private handleDisplayHostFullscreenTransition(
    displayHost: EmbeddedDisplayHost,
    wasFullscreen: boolean
  ): void {
    const fullscreen = this.isDisplayHostFullscreen(displayHost);
    if (!wasFullscreen && fullscreen) {
      displayHost.toolbarTemporarilyVisible = false;
      displayHost.systemMenuBarTemporarilyRevealed = false;
    } else if (wasFullscreen && !fullscreen) {
      this.clearRuntimeToolbarCursorMonitor(displayHost);
      displayHost.toolbarTemporarilyVisible = false;
      displayHost.systemMenuBarTemporarilyRevealed = false;
    }
    if (fullscreen !== wasFullscreen) this.layoutDisplayHost(displayHost);
    this.applyRuntimeToolbarState(displayHost);
    this.syncRuntimeToolbarCursorMonitor(displayHost);
  }

  private applyRuntimeToolbarState(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.window.isDestroyed()) return;
    if (displayHost.chromeView) {
      if (this.alwaysShowToolbarInFullScreen && this.isDisplayHostFullscreen(displayHost)) {
        this.layoutDisplayHost(displayHost);
        return;
      }
      this.layoutRuntimeChrome(displayHost);
      this.sendRuntimeChromeState(displayHost);
    } else {
      this.layoutDisplayHost(displayHost);
    }
  }

  private getRuntimeToolbarHeight(displayHost: EmbeddedDisplayHost): number {
    return this.isRuntimeToolbarVisible(displayHost)
      ? RUNTIME_TAB_CHROME_HEIGHT
      : RUNTIME_TAB_FULLSCREEN_HOT_ZONE_HEIGHT;
  }

  private getRuntimeContentTopInset(displayHost: EmbeddedDisplayHost): number {
    if (displayHost.chromeView) {
      if (!this.isDisplayHostFullscreen(displayHost)) return RUNTIME_TAB_CHROME_HEIGHT;
      return this.alwaysShowToolbarInFullScreen
        ? RUNTIME_TAB_CHROME_HEIGHT
        : 0;
    }
    if (displayHost.chromeWebContents) return this.getRuntimeToolbarHeight(displayHost);
    return 0;
  }

  private layoutRuntimeChrome(displayHost: EmbeddedDisplayHost): void {
    const chromeView = displayHost.chromeView;
    if (!chromeView) return;
    const bounds = displayHost.window.getContentBounds();
    const safeAreaInset = this.getRuntimeToolbarSafeAreaInset(displayHost);
    chromeView.setBounds({
      x: 0,
      y: safeAreaInset,
      width: Math.max(1, bounds.width),
      height: this.getRuntimeToolbarHeight(displayHost)
    });
    this.bringRuntimeChromeToFront(displayHost);
  }

  private bringRuntimeChromeToFront(displayHost: EmbeddedDisplayHost | undefined): void {
    if (!displayHost?.chromeView || displayHost.window.isDestroyed()) return;
    displayHost.window.contentView.addChildView(displayHost.chromeView);
  }

  private collapseRuntimeToolbarIfCursorLeft(displayHost: EmbeddedDisplayHost): void {
    if (
      displayHost.closing ||
      !this.isDisplayHostFullscreen(displayHost) ||
      this.alwaysShowToolbarInFullScreen ||
      displayHost.toolbarRevealLockCount > 0
    ) return;

    const cursor = this.options.getCursorScreenPoint?.();
    if (cursor && this.isCursorInRuntimeToolbarZone(displayHost, cursor)) return;

    let changed = false;
    if (!this.alwaysShowToolbarInFullScreen && displayHost.toolbarTemporarilyVisible) {
      displayHost.toolbarTemporarilyVisible = false;
      changed = true;
    }
    if (displayHost.systemMenuBarTemporarilyRevealed) {
      displayHost.systemMenuBarTemporarilyRevealed = false;
      changed = true;
    }
    if (changed) this.applyRuntimeToolbarState(displayHost);
  }

  private syncRuntimeToolbarCursorMonitor(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.macNativeTabs) {
      this.clearRuntimeToolbarCursorMonitor(displayHost);
      return;
    }
    const shouldMonitor = !displayHost.closing &&
      this.isDisplayHostFullscreen(displayHost) &&
      !this.alwaysShowToolbarInFullScreen &&
      isWindowVisible(displayHost.window) &&
      Boolean(this.options.getCursorScreenPoint);
    if (!shouldMonitor) {
      this.clearRuntimeToolbarCursorMonitor(displayHost);
      return;
    }
    if (displayHost.toolbarCursorMonitorTimer) return;
    displayHost.toolbarCursorMonitorTimer = setTimeout(
      () => this.monitorRuntimeToolbarCursor(displayHost),
      RUNTIME_TAB_TOOLBAR_CURSOR_MONITOR_INTERVAL_MS
    );
  }

  private monitorRuntimeToolbarCursor(displayHost: EmbeddedDisplayHost): void {
    displayHost.toolbarCursorMonitorTimer = undefined;
    if (
      displayHost.closing ||
      !this.isDisplayHostFullscreen(displayHost) ||
      this.alwaysShowToolbarInFullScreen ||
      !isWindowVisible(displayHost.window)
    ) return;

    const cursor = this.options.getCursorScreenPoint?.();
    if (cursor) {
      const cursorInRevealBand = this.isCursorInRuntimeToolbarZone(
        displayHost,
        cursor,
        RUNTIME_TAB_FULLSCREEN_REVEAL_DETECTION_HEIGHT
      );
      const cursorInToolbarZone = this.isCursorInRuntimeToolbarZone(displayHost, cursor);
      if (cursorInRevealBand) {
        this.revealRuntimeToolbar(displayHost);
      } else if (
        displayHost.toolbarTemporarilyVisible ||
        displayHost.systemMenuBarTemporarilyRevealed
      ) {
        if (displayHost.toolbarRevealLockCount === 0 && !cursorInToolbarZone) {
          this.collapseRuntimeToolbarIfCursorLeft(displayHost);
        }
      }
    }

    this.syncRuntimeToolbarCursorMonitor(displayHost);
  }

  private isCursorInRuntimeToolbarZone(
    displayHost: EmbeddedDisplayHost,
    cursor: { x: number; y: number },
    height?: number
  ): boolean {
    const bounds = getWindowBounds(displayHost.window);
    const zoneHeight = height ?? this.getRuntimeToolbarHoldZoneHeight(displayHost);
    return cursor.x >= bounds.x &&
      cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + zoneHeight;
  }

  private revealRuntimeToolbar(displayHost: EmbeddedDisplayHost): void {
    let changed = false;
    if (!this.alwaysShowToolbarInFullScreen && !displayHost.toolbarTemporarilyVisible) {
      displayHost.toolbarTemporarilyVisible = true;
      changed = true;
    }
    if (
      !this.alwaysShowToolbarInFullScreen &&
      this.shouldTrackAutoHiddenSystemMenuBar(displayHost) &&
      !displayHost.systemMenuBarTemporarilyRevealed
    ) {
      displayHost.systemMenuBarTemporarilyRevealed = true;
      changed = true;
    }
    if (changed) this.applyRuntimeToolbarState(displayHost);
  }

  private isRuntimeToolbarVisible(displayHost: EmbeddedDisplayHost): boolean {
    return Boolean(displayHost.chromeWebContents) && (
      !this.isDisplayHostFullscreen(displayHost) ||
      this.alwaysShowToolbarInFullScreen ||
      displayHost.toolbarTemporarilyVisible
    );
  }

  private getRuntimeToolbarSafeAreaInset(displayHost: EmbeddedDisplayHost): number {
    if (
      this.alwaysShowToolbarInFullScreen ||
      !this.isRuntimeToolbarVisible(displayHost) ||
      !this.isMacRuntimeFullscreen(displayHost)
    ) {
      return 0;
    }
    const display = this.getWorkspaceDisplay(displayHost.displayId);
    if (!display) return 0;
    const liveMenuBarHeight = getMacSystemMenuBarHeight(display);
    const menuBarBottom = liveMenuBarHeight > 0
      ? display.workArea.y
      : displayHost.systemMenuBarTemporarilyRevealed
        ? display.bounds.y + displayHost.macSystemMenuBarHeight
        : undefined;
    if (menuBarBottom === undefined) return 0;
    return clampMacSystemMenuBarHeight(
      menuBarBottom - displayHost.window.getContentBounds().y
    );
  }

  private refreshMacSystemMenuBarHeight(
    displayHost: EmbeddedDisplayHost,
    workArea?: PixelBounds
  ): void {
    if ((this.options.platform ?? process.platform) !== "darwin") return;
    const display = this.getWorkspaceDisplay(displayHost.displayId);
    if (!display) return;
    const height = clampMacSystemMenuBarHeight(
      (workArea ?? display.workArea).y - display.bounds.y
    );
    if (height > 0) displayHost.macSystemMenuBarHeight = height;
  }

  private getWorkspaceDisplay(displayId: number): WorkspaceDisplayInfo | undefined {
    return this.options.getWorkspaceDisplays?.().find((candidate) => candidate.id === displayId);
  }

  private shouldTrackAutoHiddenSystemMenuBar(displayHost: EmbeddedDisplayHost): boolean {
    return this.isMacRuntimeFullscreen(displayHost) &&
      getMacSystemMenuBarHeight(this.getWorkspaceDisplay(displayHost.displayId)) === 0;
  }

  private isMacRuntimeFullscreen(displayHost: EmbeddedDisplayHost): boolean {
    return (this.options.platform ?? process.platform) === "darwin" &&
      Boolean(displayHost.chromeView || displayHost.macNativeTabs) &&
      displayHost.windowFullscreen;
  }

  private getRuntimeToolbarHoldZoneHeight(displayHost: EmbeddedDisplayHost): number {
    return this.getRuntimeToolbarSafeAreaInset(displayHost) +
      RUNTIME_TAB_FULLSCREEN_REVEAL_ZONE_HEIGHT;
  }

  private clearRuntimeToolbarCursorMonitor(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.toolbarCursorMonitorTimer) {
      clearTimeout(displayHost.toolbarCursorMonitorTimer);
      displayHost.toolbarCursorMonitorTimer = undefined;
    }
  }

  private configureHtmlFullscreen(host: GameHostWindow, webContents: WebContents): void {
    webContents.on("enter-html-full-screen", () => this.setHtmlFullscreen(host, webContents.id, true));
    webContents.on("leave-html-full-screen", () => this.setHtmlFullscreen(host, webContents.id, false));
    webContents.once("destroyed", () => this.setHtmlFullscreen(host, webContents.id, false));
  }

  private async reconcileRuntimeTabs(): Promise<void> {
    const hiddenRuntimeTabIds = [...this.hosts.values()].flatMap((tab) => {
      const displayHost = this.getDisplayHost(tab);
      const isInternalHidden = tab.hidden || displayHost?.activeTabId !== tab.id;
      return isInternalHidden ? [tab.id] : [];
    });
    const resourceUpdate = this.resourceCoordinator.setHiddenRuntimeTabIds(hiddenRuntimeTabIds);
    this.displayHosts.forEach((host) => {
      this.layoutDisplayHost(host);
      this.sendRuntimeChromeState(host);
    });
    this.emit("runtimeChange", this.listEmbeddedRuntimeState());
    await resourceUpdate.catch((error) => {
      console.warn("Failed to reconcile runtime tab resource state.", error);
    });
  }

  private async prepareRuntimeTabForeground(tabId: string): Promise<void> {
    await this.resourceCoordinator.prepareWorkspaceForeground(tabId).catch((error) => {
      console.warn(`Failed to release runtime tab throttling before display: ${tabId}`, error);
    });
  }

  private createSession(
    role: Role,
    host: GameHostWindow,
    rect: NormalizedRect,
    zoomFactor: number,
    zoomMode: WorkspaceBrowserZoomMode = "fixed"
  ): BrowserSession {
    const initialZoomFactor = zoomMode === "adaptive"
      ? getAdaptiveWorkspaceBrowserZoomPercent(
          normalizedRectToPixelBounds(rect, this.getTabContentBounds(host)).width
        ) / 100
      : zoomFactor;
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
        zoomFactor: initialZoomFactor
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
      zoomFactor: initialZoomFactor,
      zoomMode
    };

    this.sessions.set(role.id, session);
    host.roleIds.add(role.id);
    host.window.contentView.addChildView(view);
    this.layoutDisplayHost(this.getDisplayHost(host));
    this.configureZoomPersistence(session, view.webContents);
    this.configureWindowOpenHandler(session, view.webContents);
    this.configureCloseShortcut(host, view.webContents);
    this.configureHtmlFullscreen(host, view.webContents);
    this.trackGameViewFocus(host, view);
    view.webContents.once("destroyed", () => {
      if (this.sessions.get(role.id) === session) {
        this.sessions.delete(role.id);
        host.roleIds.delete(role.id);
        void this.resourceCoordinator.reconcileRuntimeRoleIds("embedded", this.sessions.keys());
        if (host.roleIds.size === 0 && !host.closing) {
          void this.closeHostWindow(host);
        }
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
      const displayHost = this.getDisplayHost(host);
      if (displayHost) this.configureRuntimeWindowAccelerators(displayHost, view.webContents);
      const webContentsId = view.webContents.id;
      this.dividerByWebContentsId.set(webContentsId, { divider, hostId: host.id });
      view.webContents.once("destroyed", () => {
        this.dividerByWebContentsId.delete(webContentsId);
      });
      loadPromises.push(view.webContents.loadURL(createDividerDataUrl(divider.axis)).then(() => undefined));
      return divider;
    });
    this.layoutHost(host);
    this.bringRuntimeChromeToFront(this.getDisplayHost(host));
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
    workspace: Pick<LaunchWorkspace, "browserZoomMode" | "browserZoomPercent" | "id" | "resourcePolicy">,
    items: ExternalChromeLaunchItem[],
    notice?: string,
    target?: BrowserWorkspaceLaunchTarget
  ): Promise<RoleStatus[]> {
    if (!this.options.externalChromeManager) {
      throw new Error("External Chrome compatibility mode is not available.");
    }

    if (target) {
      const workspaceName = "name" in workspace && typeof workspace.name === "string"
        ? workspace.name
        : workspace.id;
      this.reserveWorkspaceDisplay(workspace.id, workspaceName, target.displayId);
    }

    const statuses = await this.options.externalChromeManager.launchWorkspace(workspace, items, {
      notice,
      workArea: target?.workArea,
      zoomMode: workspace.browserZoomMode,
      zoomFactor: workspace.browserZoomPercent / 100
    });
    return statuses;
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
    const displayHost = this.getDisplayHost(host);
    if (displayHost) this.configureRuntimeWindowAccelerators(displayHost, webContents);
    webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key.toLowerCase() !== "w" || (!input.meta && !input.control)) {
        return;
      }
      event.preventDefault();
      void this.hideRuntimeTab(host.id);
    });
  }

  private configureRuntimeWindowAccelerators(
    displayHost: EmbeddedDisplayHost,
    webContents: WebContents
  ): void {
    if ((this.options.platform ?? process.platform) !== "darwin") return;
    webContents.on("before-input-event", (event, input) => {
      if (
        input.type !== "keyDown" ||
        input.isAutoRepeat ||
        input.key.toLowerCase() !== "f" ||
        !input.control ||
        !input.meta
      ) return;
      event.preventDefault();
      this.toggleRuntimeWindowFullscreen(displayHost);
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
    this.bringRuntimeChromeToFront(this.getDisplayHost(host));
    session.popupViews.add(popupView);
    this.configureZoomPersistence(session, popupView.webContents);
    this.configureWindowOpenHandler(session, popupView.webContents);
    this.configureCloseShortcut(host, popupView.webContents);
    this.configureHtmlFullscreen(host, popupView.webContents);
    this.trackGameViewFocus(host, popupView);
    popupView.webContents.once("destroyed", () => {
      session.popupViews.delete(popupView);
      if (!host.window.isDestroyed()) {
        host.window.contentView.removeChildView(popupView);
      }
    });
    return popupView;
  }

  private layoutHost(host: GameHostWindow): void {
    const displayHost = this.getDisplayHost(host);
    if (!displayHost || !this.shouldLayoutHost(host)) {
      return;
    }

    const visible = displayHost.activeTabId === host.id &&
      !host.hidden &&
      isWindowVisible(displayHost.window);
    host.roleIds.forEach((roleId) => {
      const session = this.sessions.get(roleId);
      if (!session) return;
      session.view.setVisible(visible);
      session.popupViews.forEach((popupView) => popupView.setVisible(visible));
    });
    host.dividers.forEach((divider) => divider.view.setVisible(visible));
    if (!visible) return;

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
    this.applyAdaptiveZoom(session, bounds.width);
  }

  private getSessionBounds(host: GameHostWindow, session: BrowserSession): PixelBounds {
    const bounds = normalizedRectToPixelBounds(session.rect, this.getTabContentBounds(host));
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
    const contentBounds = this.getTabContentBounds(host);
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
    this.setSessionZoomFactor(session, zoomFactor);
  }

  private applyAdaptiveZoom(session: BrowserSession, viewportWidth: number): void {
    if (session.zoomMode !== "adaptive") {
      return;
    }
    const currentPercent = Math.round(session.zoomFactor * 100) as WorkspaceBrowserZoomPercent;
    const nextPercent = getAdaptiveWorkspaceBrowserZoomPercent(viewportWidth, currentPercent);
    if (nextPercent === currentPercent) {
      return;
    }
    this.setSessionZoomFactor(session, nextPercent / 100);
  }

  private setSessionZoomFactor(session: BrowserSession, zoomFactor: number): void {
    session.zoomFactor = zoomFactor;
    if (!session.view.webContents.isDestroyed()) {
      session.view.webContents.setZoomFactor(zoomFactor);
    }
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

  private trackGameViewFocus(host: GameHostWindow, view: WebContentsView): void {
    if (!host.lastFocusedView) {
      host.lastFocusedView = view;
    }
    view.webContents.on("focus", () => {
      if (!host.closing && !view.webContents.isDestroyed()) {
        host.lastFocusedView = view;
      }
    });
    view.webContents.once("destroyed", () => {
      if (host.lastFocusedView === view) {
        host.lastFocusedView = undefined;
      }
    });
  }

  private restoreActiveGameViewFocus(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.closing || displayHost.window.isDestroyed()) {
      return;
    }
    const activeHost = displayHost.activeTabId
      ? this.hosts.get(displayHost.activeTabId)
      : undefined;
    if (!activeHost || activeHost.hidden || activeHost.closing) {
      return;
    }

    const rememberedView = activeHost.lastFocusedView;
    const fallbackViews = [...activeHost.roleIds].flatMap((roleId) => {
      const session = this.sessions.get(roleId);
      return session ? [...session.popupViews].reverse().concat(session.view) : [];
    });
    const targetView = [rememberedView, ...fallbackViews].find(
      (view): view is WebContentsView => Boolean(view && !view.webContents.isDestroyed())
    );
    if (!targetView) {
      return;
    }

    activeHost.lastFocusedView = targetView;
    targetView.webContents.focus();
  }

  private async focusSession(session: BrowserSession): Promise<void> {
    const host = this.hosts.get(session.hostId);
    if (!host || host.window.isDestroyed()) {
      return;
    }
    await this.showRuntimeTab(host.id);
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
    await this.resourceCoordinator.deactivateWorkspace(host.id);
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
    await this.closeHostWindow(host);
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

  private async closeHostWindow(host: GameHostWindow): Promise<void> {
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
    const displayHost = this.getDisplayHost(host);
    const displayHostWasFullscreen = displayHost
      ? this.isDisplayHostFullscreen(displayHost)
      : false;
    const nextActiveTabId = displayHost?.activeTabId === host.id
      ? displayHost.tabIds.find((tabId) => tabId !== host.id && !this.hosts.get(tabId)?.hidden)
      : displayHost?.activeTabId;
    if (nextActiveTabId && nextActiveTabId !== displayHost?.activeTabId) {
      await this.prepareRuntimeTabForeground(nextActiveTabId);
    }
    this.deleteHost(host);
    if (displayHost) {
      displayHost.tabIds = displayHost.tabIds.filter((tabId) => tabId !== host.id);
      if (displayHost.activeTabId === host.id) {
        displayHost.activeTabId = nextActiveTabId;
      }
      this.handleDisplayHostFullscreenTransition(displayHost, displayHostWasFullscreen);
      if (!displayHost.activeTabId) {
        this.hideDisplayHost(displayHost);
      }
      this.layoutDisplayHost(displayHost);
      this.destroyDisplayHostIfEmpty(displayHost);
    }
    await this.reconcileRuntimeTabs();
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
    const runtimeState = this.listEmbeddedRuntimeState();
    this.emit("runtimeChange", runtimeState);
    this.displayHosts.forEach((host) => this.sendRuntimeChromeState(host));
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

function isBrowserWindow(window: BaseWindow): window is BrowserWindow {
  return "webContents" in window && "loadURL" in window;
}

function toPixelBounds(bounds: { x: number; y: number; width: number; height: number }): PixelBounds {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function clampMacSystemMenuBarHeight(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(RUNTIME_TAB_MAC_MENU_BAR_MAX_HEIGHT, Math.round(value)));
}

function getMacSystemMenuBarHeight(display: WorkspaceDisplayInfo | undefined): number {
  if (!display) return 0;
  return clampMacSystemMenuBarHeight(display.workArea.y - display.bounds.y);
}

function getWindowBounds(window: BaseWindow): PixelBounds {
  const getBounds = (window as BaseWindow & {
    getBounds?: () => { x: number; y: number; width: number; height: number };
  }).getBounds;
  return toPixelBounds(getBounds ? getBounds.call(window) : window.getContentBounds());
}

function isWindowVisible(window: BaseWindow): boolean {
  const isVisible = (window as BaseWindow & { isVisible?: () => boolean }).isVisible;
  return isVisible ? isVisible.call(window) : true;
}

function showWindowWithoutFocus(window: BaseWindow): void {
  const showInactive = (window as BaseWindow & { showInactive?: () => void }).showInactive;
  if (showInactive) {
    showInactive.call(window);
    return;
  }
  window.show();
}

function clampBoundsToWorkArea(bounds: PixelBounds, workArea: PixelBounds): PixelBounds {
  const width = Math.min(Math.max(720, bounds.width), workArea.width);
  const height = Math.min(Math.max(480, bounds.height), workArea.height);
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height
  };
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
    x: contentBounds.x + left,
    y: contentBounds.y + top,
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
      x: contentBounds.x + lineX - beforeInset,
      y: contentBounds.y + top,
      width: dividerSize,
      height: Math.max(1, bottom - top)
    };
  }

  const lineY = Math.round(geometry.position * contentBounds.height);
  const left = Math.round(geometry.start * contentBounds.width);
  const right = Math.round(geometry.end * contentBounds.width);
  return {
    x: contentBounds.x + left,
    y: contentBounds.y + lineY - beforeInset,
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
