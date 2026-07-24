import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  BaseWindow,
  BaseWindowConstructorOptions,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  KeyboardEvent as ElectronKeyboardEvent,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions
} from "electron";

import { DEFAULT_WORKSPACE_APPEARANCE_SETTINGS } from "../../shared/browserFonts";
import type {
  BrowserRuntimeSnapshot,
  CoreEffectAction,
  CoreJsonValue,
  LayoutRoleInput,
  ResourceRuntimeEffectRecord,
  ResourceRuntimeTargetRecord,
  WorkspaceDividerDescriptor,
  WorkspaceDividerResizeInput,
  WorkspaceDividerResizeOutput,
  WorkspaceLayoutInput,
  WorkspaceLayoutOutput
} from "../../shared/generated";
import type {
  AppLanguage,
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
  WorkspaceSlotBrowserZoomPercent,
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
import { isWorkspaceSlotBrowserZoomPercent } from "../../shared/workspaceLayout";
import {
  formatWorkspaceResizeRatio,
  type WorkspaceResizeIndicatorPayload
} from "../../shared/workspaceResize";
import type { EmbeddedRuntimeDiagnosticContext } from "./EmbeddedRuntimeDiagnostics";
import { ElectronAutomationTarget, type BrowserAutomationTarget } from "./ElectronAutomationTarget";
import type { AppCoreClient, EmbeddedKeyRuntimeClient } from "../core/nativeCore";
import { ElectronWorkspaceResourceTarget } from "./ElectronWorkspaceResourceTarget";
import type {
  MacRuntimeTabsContentLayout,
  MacRuntimeTabsController,
  MacRuntimeTabsControllerFactory
} from "./MacRuntimeTabsController";

export interface ElectronBrowserRuntimeEvents {
  change: [RoleStatus[]];
  runtimeChange: [EmbeddedRuntimeState];
}

export interface BrowserLaunchOptions {
  zoomFactor?: number;
  target?: BrowserWorkspaceLaunchTarget;
}

export interface BrowserWorkspaceLaunchItem {
  browserZoomPercent?: WorkspaceSlotBrowserZoomPercent;
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
export type WorkspaceRoleZoomPersister = (
  workspaceId: string,
  roleId: string,
  browserZoomPercent: WorkspaceSlotBrowserZoomPercent
) => Promise<void>;
export type NativeZoomPerformer = (
  action: NativeZoomShortcutAction,
  window: BaseWindow,
  webContents: WebContents,
  event: ElectronKeyboardEvent
) => boolean;
type MaybePromise<T> = T | Promise<T>;

export interface ElectronBrowserRuntimeOptions {
  applyBrowserFonts?: (role: Role, partition: string) => Promise<void>;
  applyBrowserProxy?: BrowserProxyApplier;
  applyCdnCompatibility?: BrowserCdnCompatibilityApplier;
  browserRuntimeState: Pick<AppCoreClient, "invoke" | "subscribe">;
  createHostWindow: (options: BaseWindowConstructorOptions) => BaseWindow;
  createRuntimeChromeView?: (options: WebContentsViewConstructorOptions) => WebContentsView;
  createTabbedHostWindow?: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  dividerPreloadPath: string;
  embeddedKeyRuntime: EmbeddedKeyRuntimeClient;
  embeddedPreloadPath: string;
  runtimeTabsPageUrl?: string;
  runtimeTabsPreloadPath?: string;
  getRoleSession?: (role: Role) => Session | undefined | Promise<Session | undefined>;
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
  onEmbeddedWebContentsCreated?: (
    context: EmbeddedRuntimeDiagnosticContext,
    webContents: WebContents
  ) => void;
  performNativeZoom?: NativeZoomPerformer;
  persistWorkspaceRoleZoom?: WorkspaceRoleZoomPersister;
  adaptiveZoomResolver: (
    viewportWidth: number,
    currentPercent?: WorkspaceBrowserZoomPercent
  ) => MaybePromise<WorkspaceBrowserZoomPercent>;
  workspaceDividerResolver: (roles: LayoutRoleInput[]) => MaybePromise<WorkspaceDividerDescriptor[]>;
  workspaceDividerResizeResolver: (
    input: WorkspaceDividerResizeInput
  ) => MaybePromise<WorkspaceDividerResizeOutput>;
  workspaceLayoutResolver: (input: WorkspaceLayoutInput) => MaybePromise<WorkspaceLayoutOutput>;
  recordLayoutPass?: (count?: number) => void;
  recordRuntimePublish?: (count?: number) => void;
  recordTabActivationLatency?: (durationMs: number) => void;
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

export class BrowserLaunchCancelledError extends Error {
  readonly code = "LAUNCH_CANCELLED";

  constructor() {
    super("Browser launch was cancelled.");
    this.name = "BrowserLaunchCancelledError";
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
  audioMuted: boolean;
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

interface HostLayoutState {
  generation: number;
  inFlight?: Promise<void>;
  trailing: boolean;
}

interface EmbeddedDisplayHost {
  activeTabId?: string;
  chromeView?: WebContentsView;
  chromeWebContents?: WebContents;
  closing: boolean;
  displayId: number;
  pendingWindowAction?: "close" | "hide";
  id: string;
  macNativeContentLayout?: RuntimeContentLayout;
  macNativeContentLayoutUpdate?: ReturnType<typeof setImmediate>;
  macNativeTabs?: MacRuntimeTabsController;
  macSystemMenuBarHeight: number;
  systemMenuBarTemporarilyRevealed: boolean;
  tabIds: string[];
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

interface RuntimeContentLayout {
  heightInset: number;
  yOffset: number;
}

export type GameDividerPointerPayload =
  | { phase: "move" | "start"; screenPosition: number }
  | { phase: "end" }
  | { phase: "reset" };

export const GAME_DIVIDER_POINTER_CHANNEL = "game-divider:pointer";

interface BrowserSession {
  abortController: AbortController;
  gameInputContextActive: boolean;
  hostId: string;
  popupViews: Set<WebContentsView>;
  rect: NormalizedRect;
  removeResourceInvalidation: () => void;
  resourceTarget: ElectronWorkspaceResourceTarget;
  role: Role;
  target: BrowserAutomationTarget;
  view: WebContentsView;
  webContents: WebContents;
  zoomFactor: number;
  zoomMode: WorkspaceBrowserZoomMode;
  zoomPersistenceTimer?: ReturnType<typeof setTimeout>;
}

interface NativeZoomShortcutInput {
  alt: boolean;
  code: string;
  control: boolean;
  isComposing: boolean;
  key: string;
  meta: boolean;
  shift: boolean;
  type: string;
}

export type NativeZoomShortcutAction = "in" | "out" | "reset";
export type RuntimeTabSwitchDirection = "next" | "previous";
type EmbeddedCoreEffectAction = Extract<
  CoreEffectAction,
  {
    type:
      | "embeddedActivateResources"
      | "embeddedApplyResourceEffects"
      | "embeddedApplyRuntime"
      | "embeddedConfigureRoleSessions"
      | "embeddedCreateTab"
      | "embeddedDestroyRole"
      | "embeddedDestroyTab"
      | "embeddedFocusRole"
      | "embeddedInstallOverlays"
      | "embeddedLoadRoles";
  }
>;

const DEFAULT_BROWSER_ZOOM_FACTOR = 1;
const WORKSPACE_ROLE_ZOOM_PERSIST_DEBOUNCE_MS = 200;
const RUNTIME_TAB_CHROME_HEIGHT = 40;
const RUNTIME_TAB_FULLSCREEN_HOT_ZONE_HEIGHT = 2;
const RUNTIME_TAB_MAC_MENU_BAR_FALLBACK_HEIGHT = 30;
const RUNTIME_TAB_MAC_MENU_BAR_MAX_HEIGHT = 64;
export const EXTERNAL_COMPAT_NOTICE =
  "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.";

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function effectError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function asCpuThrottleRate(effect: ResourceRuntimeEffectRecord): 1 | 2 | 4 {
  if (effect.cpuThrottleRate === 1 || effect.cpuThrottleRate === 2 ||
    effect.cpuThrottleRate === 4) {
    return effect.cpuThrottleRate;
  }
  throw effectError(
    "RESOURCE_THROTTLE_RATE_INVALID",
    `Unsupported CPU throttle rate: ${effect.cpuThrottleRate}`
  );
}

async function waitForAllEffects(effects: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(effects);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failed) throw failed.reason;
}

export function classifyNativeZoomShortcut(
  input: NativeZoomShortcutInput,
  platform: NodeJS.Platform
): NativeZoomShortcutAction | undefined {
  const usesMeta = platform === "darwin";
  if (
    input.type !== "keyDown" ||
    input.isComposing ||
    input.alt ||
    input.meta !== usesMeta ||
    input.control === usesMeta
  ) {
    return undefined;
  }

  if (input.code === "NumpadAdd" || input.code === "Equal" || input.code === "Plus") {
    return "in";
  }
  if (!input.shift && (input.code === "NumpadSubtract" || input.code === "Minus")) {
    return "out";
  }
  if (!input.shift && (input.code === "Digit0" || input.code === "Numpad0")) {
    return "reset";
  }
  return undefined;
}

export function classifyRuntimeTabSwitchShortcut(
  input: NativeZoomShortcutInput
): RuntimeTabSwitchDirection | undefined {
  if (
    input.type !== "keyDown" ||
    input.isComposing ||
    input.code !== "Tab" ||
    !input.control ||
    input.alt ||
    input.meta
  ) {
    return undefined;
  }

  return input.shift ? "previous" : "next";
}

export function isExpectedNativeZoomResult(
  action: NativeZoomShortcutAction,
  previousPercent: number,
  nextPercent: number
): boolean {
  if (action === "reset") {
    return nextPercent === 100;
  }
  if (action === "in") {
    return nextPercent > previousPercent || (previousPercent >= 300 && nextPercent === previousPercent);
  }
  return nextPercent < previousPercent || (previousPercent <= 50 && nextPercent === previousPercent);
}

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

export class ElectronBrowserRuntime extends EventEmitter<ElectronBrowserRuntimeEvents> {
  private readonly dividerByWebContentsId = new Map<number, { divider: GameDivider; hostId: string }>();
  private readonly displayHosts = new Map<number, EmbeddedDisplayHost>();
  private readonly displayHostByChromeWebContentsId = new Map<number, EmbeddedDisplayHost>();
  private readonly tabHandles = new Map<string, GameHostWindow>();
  private readonly roleHandles = new Map<string, BrowserSession>();
  private readonly workspaceTabHandleIds = new Map<string, string>();
  private readonly hostLayoutStates = new Map<string, HostLayoutState>();
  private readonly lastRuntimeChromeStateByDisplay = new Map<number, string>();
  private lastEmittedRuntimeState = "";
  private lastEmittedStatuses = "";
  private runtimeSnapshot: BrowserRuntimeSnapshot = {
    displays: [],
    roles: [],
    tabs: [],
    workspaces: []
  };
  private roleStatuses: RoleStatus[] = [];
  private workspaceStatuses: BrowserWorkspaceRuntimeStatus[] = [];
  private runtimeTabsLanguage: AppLanguage = "en";
  private alwaysShowToolbarInFullScreen = false;
  private macroOverlayInstaller?: BrowserMacroOverlayInstaller;

  constructor(
    private readonly options: ElectronBrowserRuntimeOptions
  ) {
    super();
    options.browserRuntimeState.subscribe((events) => {
      for (const event of events) {
        if (event.type === "browserStatuses") {
          this.roleStatuses = event.statuses.map((status) => status as RoleStatus);
          this.emitChange();
        }
      }
    });
    void options.browserRuntimeState.invoke({ type: "browserStatuses" })
      .then((statuses) => {
        this.roleStatuses = statuses.map((status) => status as RoleStatus);
      });
    void options.browserRuntimeState.invoke({ type: "browserWorkspaceStatuses" })
      .then((statuses) => {
        this.workspaceStatuses = statuses;
      });
  }

  setBeforeRolesStop(handler: BeforeRolesStop): void {
    void handler;
  }

  setWorkspaceAppearanceSettings(settings: WorkspaceAppearanceSettings): void {
    this.tabHandles.forEach((host) => {
      if (!host.workspaceId) {
        return;
      }

      host.workspaceAppearance = { ...settings };
      host.dividers.forEach((divider) => this.applyWorkspaceBackground(divider, settings));
      void this.layoutHost(host);
    });
  }

  setMacroOverlayInstaller(installer: BrowserMacroOverlayInstaller): void {
    this.macroOverlayInstaller = installer;
  }

  async executeEmbeddedEffect(
    action: EmbeddedCoreEffectAction
  ): Promise<CoreJsonValue | undefined> {
    switch (action.type) {
      case "embeddedCreateTab": {
        const tab = action.tab;
        const host = this.createHost(
          tab.name,
          tab.workspaceId,
          tab.target.workArea,
          tab.workspaceAppearance,
          tab.target.displayId,
          tab.sourceId,
          undefined,
          tab.workspaceTemplate as WorkspaceLayoutTemplate | undefined,
          tab.tabId
        );
        for (const [index, role] of tab.roles.entries()) {
          await this.createSession(
            role.role,
            host,
            role.rect,
            role.zoomFactor,
            role.zoomMode
          );
          if ((index + 1) % 2 === 0 && index + 1 < tab.roles.length) {
            await yieldToElectronMainLoop();
          }
        }
        if (tab.roles.length > 1) await this.createHostDividers(host);
        await this.layoutHost(host);
        this.emitChange();
        const firstRole = tab.roles[0]?.role;
        if (firstRole && !tab.workspaceId) {
          void this.resolveRuntimeTabGameIcon(firstRole)
            .then((gameIconDataUrl) => {
              if (!gameIconDataUrl || this.tabHandles.get(host.id) !== host || host.closing) return;
              host.gameIconDataUrl = gameIconDataUrl;
              this.emitChange();
            });
        }
        return undefined;
      }
      case "embeddedApplyRuntime":
        await this.applyEmbeddedRuntimeEffect(
          action.snapshot,
          action.target,
          action.revealDisplayIds,
          action.focusWindowDisplayIds,
          action.focusTabId
        );
        return undefined;
      case "embeddedConfigureRoleSessions": {
        await waitForAllEffects(action.roleIds.map(async (roleId) => {
          const session = this.requireEmbeddedSession(roleId);
          await this.applyBrowserProxy(session);
          this.assertSessionActive(session);
          await this.applyCdnCompatibility(session);
          this.assertSessionActive(session);
        }));
        return undefined;
      }
      case "embeddedLoadRoles": {
        await waitForAllEffects(action.roles.map(async (role) => {
          const session = this.requireEmbeddedSession(role.roleId);
          this.assertSessionActive(session);
          if (session.zoomMode !== "adaptive") {
            await this.applyZoom(session, role.zoomFactor);
          }
          this.assertSessionActive(session);
          try {
            await session.webContents.loadURL(role.url);
          } catch {
            this.assertSessionActive(session);
            throw new BrowserGameLoadError();
          }
          this.assertSessionActive(session);
          if (session.zoomMode === "adaptive") {
            const host = this.tabHandles.get(session.hostId);
            if (host) await this.layoutHost(host);
          } else {
            await this.applyZoom(session, role.zoomFactor);
          }
        }));
        return undefined;
      }
      case "embeddedInstallOverlays": {
        await waitForAllEffects(action.roleIds.map(async (roleId) => {
          const session = this.requireEmbeddedSession(roleId);
          await this.installMacroOverlay(session.role, session.webContents);
          this.assertSessionActive(session);
        }));
        return undefined;
      }
      case "embeddedActivateResources": {
        const targets = action.roleIds.map((roleId): ResourceRuntimeTargetRecord => {
          const target = this.requireEmbeddedSession(roleId).resourceTarget;
          return {
            roleId,
            runtimeMode: "embedded",
            ...(target.getProcessId() ? { processId: target.getProcessId() } : {})
          };
        });
        await this.requireEmbeddedSession(action.roleIds[0] ?? "").resourceTarget.focus();
        return targets;
      }
      case "embeddedApplyResourceEffects": {
        const unavailableRoleIds = new Set<string>();
        await Promise.all(action.effects.flatMap((effect) =>
          effect.roleIds.map(async (roleId) => {
            const target = this.roleHandles.get(roleId)?.resourceTarget;
            if (!target) {
              unavailableRoleIds.add(roleId);
              return;
            }
            try {
              if (effect.release) {
                await target.releaseThrottle();
              } else {
                await target.setCpuThrottleRate(asCpuThrottleRate(effect));
              }
            } catch (error) {
              unavailableRoleIds.add(roleId);
              await target.releaseThrottle().catch(() => undefined);
              console.warn(`Workspace CPU throttling is unavailable for role ${roleId}.`, error);
            }
          })
        ));
        return { unavailableRoleIds: [...unavailableRoleIds] };
      }
      case "embeddedFocusRole": {
        const session = this.requireEmbeddedSession(action.roleId);
        if (typeof action.zoomFactor === "number") {
          await this.applyZoom(session, action.zoomFactor);
          this.assertSessionActive(session);
        }
        await session.target.focus();
        return undefined;
      }
      case "embeddedDestroyRole":
        await this.destroyRoleHandles(action.roleId);
        return undefined;
      case "embeddedDestroyTab":
        await this.destroyTabHandles(action.tabId);
        return undefined;
    }
  }

  private syncRuntimeProjection(snapshot: BrowserRuntimeSnapshot): void {
    this.runtimeSnapshot = snapshot;
    const displays = new Map(snapshot.displays.map((display) => [display.displayId, display]));
    this.displayHosts.forEach((handle, displayId) => {
      const display = displays.get(displayId);
      handle.activeTabId = display?.activeTabId;
      handle.tabIds = display ? [...display.tabIds] : [];
    });
    snapshot.tabs.forEach((tab) => {
      const handle = this.tabHandles.get(tab.id);
      const display = this.displayHosts.get(tab.displayId);
      if (!handle) return;
      handle.hidden = tab.hidden;
      if (display) {
        handle.displayHostId = display.id;
        handle.window = display.window;
      }
    });
  }

  private requireEmbeddedSession(roleId: string): BrowserSession {
    const session = this.roleHandles.get(roleId);
    if (!session || session.webContents.isDestroyed()) {
      throw effectError(
        "EMBEDDED_ROLE_HANDLE_NOT_FOUND",
        `The embedded role handle was not found: ${roleId}`
      );
    }
    return session;
  }

  private async applyEmbeddedRuntimeEffect(
    snapshot: BrowserRuntimeSnapshot,
    target: BrowserWorkspaceLaunchTarget | undefined,
    revealDisplayIds: number[],
    focusWindowDisplayIds: number[],
    focusTabId: string | undefined
  ): Promise<void> {
    const runtimeDisplays = new Map(
      snapshot.displays.map((display) => [display.displayId, display])
    );
    const touchedDisplays = new Set<EmbeddedDisplayHost>();
    for (const runtimeTab of snapshot.tabs) {
      const tab = this.tabHandles.get(runtimeTab.id);
      if (!tab) continue;
      const source = this.getDisplayHost(tab);
      const destination = this.displayHosts.get(runtimeTab.displayId) ??
        (target?.displayId === runtimeTab.displayId
          ? this.getOrCreateDisplayHost(target)
          : undefined);
      if (!destination) {
        throw effectError(
          "EMBEDDED_DISPLAY_HANDLE_NOT_FOUND",
          `The embedded display handle was not found: ${runtimeTab.displayId}`
        );
      }
      if (source && source !== destination) {
        const sourceWasFullscreen = this.isDisplayHostFullscreen(source);
        const destinationWasFullscreen = this.isDisplayHostFullscreen(destination);
        this.detachTabViews(tab, source);
        tab.window = destination.window;
        tab.displayHostId = destination.id;
        this.attachTabViews(tab, destination);
        this.handleDisplayHostFullscreenTransition(source, sourceWasFullscreen);
        this.handleDisplayHostFullscreenTransition(destination, destinationWasFullscreen);
        touchedDisplays.add(source);
      }
      touchedDisplays.add(destination);
    }

    this.syncRuntimeProjection(snapshot);
    const displaysFocusedByShow = new Set<number>();
    this.displayHosts.forEach((displayHost, displayId) => {
      const runtimeDisplay = runtimeDisplays.get(displayId);
      if (!runtimeDisplay?.activeTabId) {
        this.hideDisplayHost(displayHost);
      } else if (revealDisplayIds.includes(displayId)) {
        if (!isWindowVisible(displayHost.window) || displayHost.window.isMinimized()) {
          displaysFocusedByShow.add(displayId);
          this.showDisplayHost(displayHost);
        } else if (focusWindowDisplayIds.includes(displayId)) {
          displayHost.window.focus();
        }
      }
      touchedDisplays.add(displayHost);
    });
    touchedDisplays.forEach((displayHost) => {
      this.layoutDisplayHost(displayHost);
      this.sendRuntimeChromeState(displayHost);
      if (!runtimeDisplays.has(displayHost.displayId)) {
        this.destroyDisplayHostIfEmpty(displayHost);
      }
    });
    this.reconcileRuntimeTabs();
    if (focusTabId) {
      const tab = this.tabHandles.get(focusTabId);
      const displayHost = tab ? this.getDisplayHost(tab) : undefined;
      if (displayHost && !displaysFocusedByShow.has(displayHost.displayId)) {
        this.restoreActiveGameViewFocus(displayHost);
      }
    }
  }

  listStatuses(): RoleStatus[] {
    return this.roleStatuses.map((status) => ({ ...status }));
  }

  notifyResourceStatusesChanged(): void {
    this.emitChange();
  }

  listEmbeddedRuntimeState(): EmbeddedRuntimeState {
    const runtime = this.runtimeSnapshot;
    const windows: EmbeddedRuntimeWindowSummary[] = runtime.displays.flatMap((display) => {
      const host = this.displayHosts.get(display.displayId);
      return host
        ? [{
            displayId: display.displayId,
            bounds: getWindowBounds(host.window),
            visible: !host.window.isDestroyed() && isWindowVisible(host.window),
            ...(display.activeTabId ? { activeTabId: display.activeTabId } : {}),
            tabCount: display.tabIds.length
          }]
        : [];
    });
    const tabById = new Map(runtime.tabs.map((tab) => [tab.id, tab]));
    const tabs: EmbeddedRuntimeTabSummary[] = runtime.displays.flatMap((display) =>
      display.tabIds.flatMap((tabId) => {
        const runtimeTab = tabById.get(tabId);
        const handle = this.tabHandles.get(tabId);
        const displayHost = this.displayHosts.get(display.displayId);
        return runtimeTab && handle && displayHost
          ? [{
              id: runtimeTab.id,
              type: runtimeTab.tabType === "workspace" ? "workspace" as const : "role" as const,
              sourceId: runtimeTab.sourceId,
              name: runtimeTab.name,
              displayId: runtimeTab.displayId,
              roleIds: [...runtimeTab.roleIds],
              ...(runtimeTab.tabType === "workspace"
                ? {
                    roleNames: runtimeTab.roleIds.map(
                      (roleId) => this.roleHandles.get(roleId)?.role.name ?? roleId
                    )
                  }
                : {}),
              hidden: runtimeTab.hidden,
              active: display.activeTabId === runtimeTab.id &&
                !runtimeTab.hidden && isWindowVisible(displayHost.window),
              ...this.getRuntimeTabAudioState(handle)
            }]
          : [];
      })
    );
    return { windows, tabs };
  }

  setRuntimeTabAudioMuted(tabId: string, muted: boolean): void {
    const tab = this.tabHandles.get(tabId);
    if (!tab || tab.audioMuted === muted) return;

    tab.audioMuted = muted;
    this.getRuntimeTabWebContents(tab).forEach((webContents) => {
      if (!webContents.isDestroyed()) webContents.setAudioMuted(muted);
    });
    this.emitChange();
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
        host.macNativeContentLayout = undefined;
        host.macNativeTabs.setFullscreenPolicy(value ? "always" : "autoHide");
        this.refreshMacNativeContentLayout(host);
        this.clearMacNativeContentLayoutUpdate(host);
        // Always-show follows AppKit's unobscured rect. Auto-hide remains an
        // overlay even while its native toolbar is temporarily revealed.
        this.layoutDisplayHost(host);
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
    await this.options.browserRuntimeState.invoke({
      type: "embeddedWindowsShow",
      ...(displayId === undefined ? {} : { displayId })
    });
  }

  async showRuntimeTab(tabId: string): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.options.browserRuntimeState.invoke({
        type: "embeddedTabActivate",
        tabId
      });
    } finally {
      this.options.recordTabActivationLatency?.(performance.now() - startedAt);
    }
  }

  async hideRuntimeTab(tabId: string): Promise<void> {
    await this.options.browserRuntimeState.invoke({
      type: "embeddedTabHide",
      tabId
    });
  }

  stopRuntimeTab(tabId: string): Promise<void> {
    const host = this.tabHandles.get(tabId);
    if (!host) return Promise.resolve();
    if (host.workspaceId) return this.stopWorkspace(host.workspaceId);
    const roleId = host.roleIds.values().next().value;
    return roleId ? this.stop(roleId) : Promise.resolve();
  }

  reorderRuntimeTab(tabId: string, beforeTabId?: string): void {
    void this.options.browserRuntimeState.invoke({
      type: "embeddedTabReorder",
      tabId,
      ...(beforeTabId ? { beforeTabId } : {})
    }).catch((error) => {
      console.error("Failed to reorder embedded runtime tab.", error);
    });
  }

  async moveRuntimeTab(tabId: string, displayId: number): Promise<void> {
    const targetInfo = this.getLaunchTargetForDisplay(displayId);
    if (!targetInfo) return;
    await this.options.browserRuntimeState.invoke({
      type: "embeddedTabMove",
      tabId,
      target: targetInfo
    });
  }

  handleDisplayRemoved(displayId: number, fallbackDisplayId: number): void {
    const targetInfo = this.getLaunchTargetForDisplay(fallbackDisplayId);
    if (!targetInfo || displayId === fallbackDisplayId) return;
    void this.options.browserRuntimeState.invoke({
      type: "embeddedDisplayRemove",
      displayId,
      fallback: targetInfo
    }).catch((error) => {
      console.error("Failed to move embedded tabs from a removed display.", error);
    });
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
    return this.runtimeSnapshot.workspaces
      .filter(
        (workspace): workspace is typeof workspace & { displayId: number } =>
          workspace.exclusiveDisplay && workspace.displayId !== undefined
      )
      .map((workspace) => ({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.name,
          displayId: workspace.displayId
        }));
  }

  listWorkspaceRuntimeStatuses(): BrowserWorkspaceRuntimeStatus[] {
    return this.workspaceStatuses.map((status) => ({ ...status }));
  }

  getRoleIdForWebContents(webContentsId: number): string | undefined {
    return [...this.roleHandles.entries()].find(([, session]) =>
      session.webContents.id === webContentsId ||
      [...session.popupViews].some((view) => view.webContents?.id === webContentsId)
    )?.[0];
  }

  setGameInputContext(webContentsId: number, active: boolean): void {
    const session = [...this.roleHandles.values()].find(
      (candidate) => candidate.webContents.id === webContentsId
    );
    if (!session || session.webContents.isDestroyed()) return;

    const nextActive = active && this.isEmbeddedRoleRunning(session.role.id);
    if (session.gameInputContextActive === nextActive) return;
    session.gameInputContextActive = nextActive;
    session.webContents.setIgnoreMenuShortcuts(nextActive);
  }

  getAutomationSession(roleId: string): BrowserAutomationSession | undefined {
    const session = this.roleHandles.get(roleId);

    if (!session || !this.isEmbeddedRoleRunning(roleId) || session.webContents.isDestroyed()) {
      return undefined;
    }

    return { role: session.role, target: session.target };
  }

  getExternalRoleName(roleId: string): string {
    return roleId;
  }

  getEmbeddedAutomationSession(roleId: string): BrowserAutomationSession | undefined {
    const session = this.roleHandles.get(roleId);
    return session && this.isEmbeddedRoleRunning(roleId) && !session.webContents.isDestroyed()
      ? { role: session.role, target: session.target }
      : undefined;
  }

  captureExternalRoleDiagnostics(roleId: string) {
    return this.options.browserRuntimeState.invoke({
      type: "externalDiagnosticsCapture",
      roleId
    });
  }

  recoverExternalRole(roleId: string): Promise<RoleStatus> {
    return this.options.browserRuntimeState.invoke({
      type: "browserExternalRecover",
      roleId
    }) as Promise<RoleStatus>;
  }

  listExternalRoleDiagnostics() {
    return this.options.browserRuntimeState.invoke({ type: "externalDiagnosticsList" });
  }

  async captureAllExternalRoleDiagnostics() {
    const statuses = this.roleStatuses.filter((status) => status.runtimeMode === "external");
    return Promise.all(statuses.map(({ roleId }) => this.captureExternalRoleDiagnostics(roleId)));
  }

  async launch(role: Role, options: BrowserLaunchOptions = {}): Promise<RoleStatus | null> {
    const zoomFactor = options.zoomFactor ?? DEFAULT_BROWSER_ZOOM_FACTOR;
    const target = options.target ?? this.getDefaultLaunchTarget();
    try {
      const [status] = await this.options.browserRuntimeState.invoke({
        type: "browserRoleLaunch",
        roleId: role.id,
        target: {
          displayId: target.displayId,
          workArea: target.workArea
        },
        zoomFactor
      });
      return status ?? null;
    } catch (error) {
      if (getErrorCode(error) === "LAUNCH_CANCELLED") return null;
      throw error;
    }
  }

  launchWorkspace(
    workspace: Pick<LaunchWorkspace, "browserZoomMode" | "browserZoomPercent" | "id" | "name" | "template">,
    items: BrowserWorkspaceLaunchItem[],
    target?: BrowserWorkspaceLaunchTarget,
    _launchMode?: "auto" | "embedded" | "external"
  ): Promise<RoleStatus[]> {
    void items;
    return this.launchWorkspaceThroughCore(workspace, target);
  }

  private async launchWorkspaceThroughCore(
    workspace: Pick<LaunchWorkspace, "browserZoomMode" | "browserZoomPercent" | "id" | "name" | "template">,
    target?: BrowserWorkspaceLaunchTarget
  ): Promise<RoleStatus[]> {
    const resolvedTarget = target ?? this.getDefaultLaunchTarget();
    try {
      return await this.options.browserRuntimeState.invoke({
        type: "browserWorkspaceLaunch",
        workspaceId: workspace.id,
        target: {
          displayId: resolvedTarget.displayId,
          workArea: resolvedTarget.workArea
        }
      });
    } catch (error) {
      if (getErrorCode(error) === "LAUNCH_CANCELLED") return [];
      if (getErrorCode(error) === "WORKSPACE_DISPLAY_OCCUPIED") {
        const occupied = this.runtimeSnapshot.workspaces.find(
            (candidate) =>
              candidate.exclusiveDisplay && candidate.displayId === resolvedTarget.displayId
          );
        throw new BrowserWorkspaceDisplayOccupiedError(
          resolvedTarget.displayId,
          occupied?.workspaceId ?? "unknown"
        );
      }
      throw error;
    }
  }

  async stop(roleId: string): Promise<void> {
    await this.options.browserRuntimeState.invoke({
      type: "browserRoleStop",
      roleId
    });
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    await this.options.browserRuntimeState.invoke({
      type: "browserWorkspaceStop",
      workspaceId
    });
  }

  async stopAll(): Promise<void> {
    const statuses = await this.options.browserRuntimeState.invoke({ type: "browserStatuses" });
    const roleIds = [...new Set(statuses.map((status) => status.roleId))];
    await Promise.all(roleIds.map((roleId) => this.stop(roleId)));
  }

  handleDividerPointer(webContentsId: number, payload: unknown): void | Promise<void> {
    const target = this.dividerByWebContentsId.get(webContentsId);
    if (!target || !isGameDividerPointerPayload(payload)) {
      return;
    }

    const host = this.tabHandles.get(target.hostId);
    if (!host || host.window.isDestroyed()) {
      return;
    }

    if (payload.phase === "end") {
      this.finishDividerResize(host, target.divider);
      return;
    }

    if (payload.phase === "reset") {
      this.finishDividerResize(host);
      const reset = this.resizeDivider(host, target.divider, target.divider.defaultPosition);
      if (isPromiseLike(reset)) return reset.then(() => undefined);
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
      const beginResize = (resolved: GameDividerResizeResult | undefined): void => {
        if (!resolved) return;
        host.activeDividerResize = {
          divider: target.divider,
          roleIds: resolved.roleIds,
          snappedPosition: resolved.position
        };
        this.sendDividerResizeIndicators(resolved.roleIds, "show");
      };
      if (isPromiseLike(result)) return result.then(beginResize);
      beginResize(result);
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
    const updateResize = (resolved: GameDividerResizeResult | undefined): void => {
      if (!resolved || !activeResize || !resolved.changed) return;
      activeResize.snappedPosition = resolved.position;
      activeResize.roleIds = resolved.roleIds;
      this.sendDividerResizeIndicators(resolved.roleIds, "update");
    };
    if (isPromiseLike(result)) return result.then(updateResize);
    updateResize(result);
  }

  private createHost(
    title: string,
    workspaceId?: string,
    launchBounds?: PixelBounds,
    workspaceAppearance: WorkspaceAppearanceSettings = DEFAULT_WORKSPACE_APPEARANCE_SETTINGS,
    displayId?: number,
    sourceId = workspaceId ?? title,
    gameIconDataUrl?: string,
    workspaceTemplate?: WorkspaceLayoutTemplate,
    runtimeTabId?: string
  ): GameHostWindow {
    const target = displayId === undefined
      ? this.getDefaultLaunchTarget()
      : { displayId, workArea: launchBounds ?? this.options.getLaunchWorkArea() };
    const id = runtimeTabId;
    if (!id) {
      throw effectError(
        "EMBEDDED_TAB_ID_REQUIRED",
        "Rust must create the embedded runtime tab before Electron handles."
      );
    }
    const displayHost = this.getOrCreateDisplayHost(target);
    const host: GameHostWindow = {
      audioMuted: false,
      closing: false,
      displayHostId: displayHost.id,
      dividers: [],
      ...(gameIconDataUrl ? { gameIconDataUrl } : {}),
      hidden: true,
      htmlFullscreenWebContentsIds: new Set(),
      id,
      name: title,
      roleIds: new Set(),
      sourceId,
      type: workspaceId ? "workspace" : "role",
      window: displayHost.window,
      workspaceAppearance: { ...workspaceAppearance },
      ...(workspaceTemplate ? { workspaceTemplate } : {}),
      workspaceId
    };

    this.tabHandles.set(host.id, host);
    if (!displayHost.tabIds.includes(host.id)) {
      displayHost.tabIds.push(host.id);
    }
    if (workspaceId) {
      this.workspaceTabHandleIds.set(workspaceId, host.id);
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
    let initialMacNativeContentLayout: RuntimeContentLayout | undefined;
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
          ),
          (layout) => this.handleMacNativeContentLayoutChange(
            candidate,
            target.displayId,
            layout
          )
        );
        macNativeTabs.setFullscreenPolicy(
          this.alwaysShowToolbarInFullScreen ? "always" : "autoHide"
        );
        const contentLayout = macNativeTabs.getContentLayout();
        if (contentLayout.valid) {
          initialMacNativeContentLayout = {
            heightInset: contentLayout.heightInset,
            yOffset: contentLayout.yOffset
          };
        }
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
      ...(initialMacNativeContentLayout
        ? { macNativeContentLayout: initialMacNativeContentLayout }
        : {}),
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
      chromeView.webContents.once("did-finish-load", () =>
        this.sendRuntimeChromeState(displayHost, true)
      );
      this.configureRuntimeWindowAccelerators(displayHost, chromeView.webContents);
      void chromeView.webContents.loadURL(this.options.runtimeTabsPageUrl ?? "about:blank").catch((error) => {
        console.error("Failed to load the runtime tab chrome.", error);
      });
    } else if (isBrowserWindow(window)) {
      displayHost.chromeWebContents = window.webContents;
      this.displayHostByChromeWebContentsId.set(window.webContents.id, displayHost);
      window.webContents.once("did-finish-load", () =>
        this.sendRuntimeChromeState(displayHost, true)
      );
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
      this.clearMacNativeContentLayoutUpdate(displayHost);
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
    const contentLayout = displayHost
      ? this.getRuntimeContentLayout(displayHost)
      : { heightInset: 0, yOffset: 0 };
    return {
      x: 0,
      y: contentLayout.yOffset,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height - contentLayout.heightInset)
    };
  }

  private layoutDisplayHost(displayHost: EmbeddedDisplayHost | undefined): void {
    if (!displayHost || displayHost.window.isDestroyed()) return;
    displayHost.tabIds.forEach((tabId) => {
      const tab = this.tabHandles.get(tabId);
      if (tab) void this.layoutHost(tab);
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
      const session = this.roleHandles.get(roleId);
      if (!session) return;
      displayHost.window.contentView.removeChildView(session.view);
      session.popupViews.forEach((view) => displayHost.window.contentView.removeChildView(view));
    });
    tab.dividers.forEach((divider) => displayHost.window.contentView.removeChildView(divider.view));
  }

  private attachTabViews(tab: GameHostWindow, displayHost: EmbeddedDisplayHost): void {
    if (displayHost.window.isDestroyed()) return;
    tab.roleIds.forEach((roleId) => {
      const session = this.roleHandles.get(roleId);
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
    this.lastRuntimeChromeStateByDisplay.delete(displayHost.displayId);
    this.clearMacNativeContentLayoutUpdate(displayHost);
    displayHost.macNativeTabs?.destroy();
    displayHost.macNativeTabs = undefined;
    if (displayHost.chromeWebContents) {
      this.displayHostByChromeWebContentsId.delete(displayHost.chromeWebContents.id);
    }
    if (!displayHost.window.isDestroyed()) displayHost.window.close();
  }

  private sendRuntimeChromeState(displayHost: EmbeddedDisplayHost, force = false): void {
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
        [...this.tabHandles.values()].flatMap((host) =>
          host.gameIconDataUrl ? [[host.id, host.gameIconDataUrl] as const] : []
        )
      ),
      tabWorkspaceTemplates: Object.fromEntries(
        [...this.tabHandles.values()].flatMap((host) =>
          host.workspaceTemplate ? [[host.id, host.workspaceTemplate] as const] : []
        )
      ),
      toolbarVisible: this.isRuntimeToolbarVisible(displayHost),
      windowFullscreen: displayHost.windowFullscreen
    };
    const serializedState = JSON.stringify(state);
    if (
      !force &&
      this.lastRuntimeChromeStateByDisplay.get(displayHost.displayId) === serializedState
    ) {
      return;
    }
    this.lastRuntimeChromeStateByDisplay.set(displayHost.displayId, serializedState);
    this.options.recordRuntimePublish?.();
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
      (tabId) => (this.tabHandles.get(tabId)?.htmlFullscreenWebContentsIds.size ?? 0) > 0
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
    this.refreshMacNativeContentLayout(displayHost);
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
      if (displayHost.macNativeTabs) {
        this.refreshMacNativeContentLayout(displayHost);
        this.clearMacNativeContentLayoutUpdate(displayHost);
        this.layoutDisplayHost(displayHost);
      }
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
      if (displayHost.macNativeTabs) {
        this.refreshMacNativeContentLayout(displayHost);
        this.clearMacNativeContentLayoutUpdate(displayHost);
        this.layoutDisplayHost(displayHost);
      }
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

  private getRuntimeContentLayout(displayHost: EmbeddedDisplayHost): RuntimeContentLayout {
    if (displayHost.macNativeTabs) {
      const transitioning = displayHost.windowFullscreenTransitionTarget !== undefined;
      const htmlFullscreen = displayHost.tabIds.some(
        (tabId) => (this.tabHandles.get(tabId)?.htmlFullscreenWebContentsIds.size ?? 0) > 0
      );
      if (
        displayHost.windowFullscreenTransitionTarget === true &&
        !this.alwaysShowToolbarInFullScreen
      ) {
        return { heightInset: 0, yOffset: 0 };
      }
      if (!transitioning) {
        if (htmlFullscreen && !displayHost.windowFullscreen) {
          return { heightInset: 0, yOffset: 0 };
        }
        if (displayHost.windowFullscreen && !this.alwaysShowToolbarInFullScreen) {
          return { heightInset: 0, yOffset: 0 };
        }
      }
      if (displayHost.macNativeContentLayout) {
        return displayHost.macNativeContentLayout;
      }
      const windowFullscreenOrEntering =
        displayHost.windowFullscreen ||
        displayHost.windowFullscreenTransitionTarget === true;
      const inset = windowFullscreenOrEntering && this.alwaysShowToolbarInFullScreen
        ? RUNTIME_TAB_CHROME_HEIGHT
        : 0;
      return { heightInset: inset, yOffset: inset };
    }
    if (displayHost.chromeView) {
      const inset = !this.isDisplayHostFullscreen(displayHost) ||
        this.alwaysShowToolbarInFullScreen
        ? RUNTIME_TAB_CHROME_HEIGHT
        : 0;
      return { heightInset: inset, yOffset: inset };
    }
    if (displayHost.chromeWebContents) {
      const inset = this.getRuntimeToolbarHeight(displayHost);
      return { heightInset: inset, yOffset: inset };
    }
    return { heightInset: 0, yOffset: 0 };
  }

  private handleMacNativeContentLayoutChange(
    window: BaseWindow,
    displayId: number,
    layout: MacRuntimeTabsContentLayout
  ): void {
    if (!layout.valid) return;
    const displayHost = this.displayHosts.get(displayId);
    if (
      !displayHost ||
      displayHost.closing ||
      displayHost.window !== window ||
      !displayHost.macNativeTabs
    ) return;
    const nextLayout = {
      heightInset: layout.heightInset,
      yOffset: layout.yOffset
    };
    if (
      displayHost.macNativeContentLayout?.heightInset === nextLayout.heightInset &&
      displayHost.macNativeContentLayout.yOffset === nextLayout.yOffset
    ) return;
    displayHost.macNativeContentLayout = nextLayout;
    if (!this.shouldApplyMacNativeContentLayout(displayHost)) return;
    this.scheduleMacNativeContentLayoutUpdate(displayHost);
  }

  private shouldApplyMacNativeContentLayout(displayHost: EmbeddedDisplayHost): boolean {
    if (displayHost.windowFullscreenTransitionTarget !== undefined) {
      return displayHost.windowFullscreenTransitionTarget === false ||
        this.alwaysShowToolbarInFullScreen;
    }
    if (displayHost.windowFullscreen) return this.alwaysShowToolbarInFullScreen;
    return !displayHost.tabIds.some(
      (tabId) => (this.tabHandles.get(tabId)?.htmlFullscreenWebContentsIds.size ?? 0) > 0
    );
  }

  private refreshMacNativeContentLayout(displayHost: EmbeddedDisplayHost): boolean {
    const layout = displayHost.macNativeTabs?.getContentLayout();
    if (!layout?.valid) return false;
    displayHost.macNativeContentLayout = {
      heightInset: layout.heightInset,
      yOffset: layout.yOffset
    };
    return true;
  }

  private scheduleMacNativeContentLayoutUpdate(displayHost: EmbeddedDisplayHost): void {
    if (displayHost.macNativeContentLayoutUpdate) return;
    displayHost.macNativeContentLayoutUpdate = setImmediate(() => {
      displayHost.macNativeContentLayoutUpdate = undefined;
      if (
        displayHost.closing ||
        displayHost.window.isDestroyed() ||
        this.displayHosts.get(displayHost.displayId) !== displayHost
      ) return;
      this.layoutDisplayHost(displayHost);
    });
  }

  private clearMacNativeContentLayoutUpdate(displayHost: EmbeddedDisplayHost): void {
    if (!displayHost.macNativeContentLayoutUpdate) return;
    clearImmediate(displayHost.macNativeContentLayoutUpdate);
    displayHost.macNativeContentLayoutUpdate = undefined;
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

  private syncRuntimeToolbarCursorMonitor(_displayHost: EmbeddedDisplayHost): void {
    // Fullscreen chrome is driven by renderer hot-zone pointer enter/leave
    // events. This intentionally performs no Electron main-thread polling.
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

  private clearRuntimeToolbarCursorMonitor(_displayHost: EmbeddedDisplayHost): void {}

  private configureHtmlFullscreen(host: GameHostWindow, webContents: WebContents): void {
    webContents.on("enter-html-full-screen", () => this.setHtmlFullscreen(host, webContents.id, true));
    webContents.on("leave-html-full-screen", () => this.setHtmlFullscreen(host, webContents.id, false));
    webContents.once("destroyed", () => this.setHtmlFullscreen(host, webContents.id, false));
  }

  private configureAudioState(host: GameHostWindow, webContents: WebContents): void {
    if (host.audioMuted && !webContents.isDestroyed()) {
      webContents.setAudioMuted(true);
    }
    webContents.on("audio-state-changed", () => {
      if (this.tabHandles.get(host.id) === host) this.emitChange();
    });
  }

  private getRuntimeTabWebContents(host: GameHostWindow): WebContents[] {
    return [...host.roleIds].flatMap((roleId) => {
      const session = this.roleHandles.get(roleId);
      return session ? [session.webContents, ...[...session.popupViews].flatMap((view) =>
        view.webContents ? [view.webContents] : [])] : [];
    });
  }

  private getRuntimeTabAudioState(host: GameHostWindow): Pick<EmbeddedRuntimeTabSummary, "audible" | "audioMuted"> {
    return {
      audible: this.getRuntimeTabWebContents(host).some((webContents) =>
        !webContents.isDestroyed() && webContents.isCurrentlyAudible()
      ),
      audioMuted: host.audioMuted
    };
  }

  private reconcileRuntimeTabs(): void {
    this.displayHosts.forEach((host) => {
      this.layoutDisplayHost(host);
      this.sendRuntimeChromeState(host);
    });
    this.emit("runtimeChange", this.listEmbeddedRuntimeState());
  }

  private async createSession(
    role: Role,
    host: GameHostWindow,
    rect: NormalizedRect,
    zoomFactor: number,
    zoomMode: WorkspaceBrowserZoomMode = "fixed"
  ): Promise<BrowserSession> {
    const initialZoomFactor = zoomFactor;
    const partition = createRoleSessionPartition(role.id);
    await this.applyBrowserFonts(role);
    const roleSession = await this.options.getRoleSession?.(role);
    const view = this.options.createView({
      webPreferences: {
        backgroundThrottling: true,
        contextIsolation: true,
        nodeIntegration: false,
        ...(roleSession ? { session: roleSession } : { partition }),
        preload: this.options.embeddedPreloadPath,
        sandbox: true,
        spellcheck: false,
        webgl: true,
        zoomFactor: initialZoomFactor
      }
    });
    const webContents = view.webContents;
    const resourceTarget = new ElectronWorkspaceResourceTarget(role.id, webContents);
    const session: BrowserSession = {
      abortController: new AbortController(),
      gameInputContextActive: false,
      hostId: host.id,
      popupViews: new Set(),
      rect,
      removeResourceInvalidation: () => undefined,
      resourceTarget,
      role,
      target: new ElectronAutomationTarget(
        view,
        webContents,
        this.options.embeddedKeyRuntime,
        role.id,
        this.options.platform ?? process.platform
      ),
      view,
      webContents,
      zoomFactor: initialZoomFactor,
      zoomMode
    };

    this.roleHandles.set(role.id, session);
    session.removeResourceInvalidation = resourceTarget.onInvalidated(() => {
      if (this.roleHandles.get(role.id) !== session) return;
      void this.options.browserRuntimeState.invoke({
        type: "resourceRefreshTarget",
        workspaceId: host.id,
        roleId: role.id,
        ...(resourceTarget.getProcessId() ? { processId: resourceTarget.getProcessId() } : {})
      }).catch((error) => {
        console.warn(`Failed to refresh resource target for role ${role.id}.`, error);
      });
    });
    host.roleIds.add(role.id);
    host.window.contentView.addChildView(view);
    this.options.onEmbeddedWebContentsCreated?.({
      hostId: host.id,
      kind: "game",
      roleId: role.id,
      ...(host.workspaceId ? { workspaceId: host.workspaceId } : {})
    }, webContents);
    this.configureZoomPersistence(session, webContents);
    this.configureAudioState(host, webContents);
    this.configureNativeZoomShortcuts(host, session, webContents);
    this.configureWindowOpenHandler(session, webContents);
    this.configureCloseShortcut(host, session, webContents);
    this.configureHtmlFullscreen(host, webContents);
    this.trackGameViewFocus(host, view);
    webContents.on("blur", () => this.setGameInputContext(webContents.id, false));
    webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) this.setGameInputContext(webContents.id, false);
    });
    webContents.once("destroyed", () => {
      if (session.zoomPersistenceTimer) {
        clearTimeout(session.zoomPersistenceTimer);
        session.zoomPersistenceTimer = undefined;
      }
      if (this.roleHandles.get(role.id) === session) {
        void this.options.browserRuntimeState.invoke({
          type: "embeddedRoleStop",
          roleId: role.id
        }).catch(() => {
          if (this.roleHandles.get(role.id) !== session) return;
          this.roleHandles.delete(role.id);
          host.roleIds.delete(role.id);
          this.emitChange();
        });
      }
    });
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
    const descriptors = await this.options.workspaceDividerResolver(
      [...host.roleIds]
        .map((roleId) => this.roleHandles.get(roleId))
        .filter((session): session is BrowserSession => Boolean(session))
        .map((session) => ({ rect: session.rect, roleId: session.role.id }))
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
    this.bringRuntimeChromeToFront(this.getDisplayHost(host));
    await Promise.all(loadPromises);
  }

  private assertSessionActive(session: BrowserSession): void {
    const host = this.tabHandles.get(session.hostId);
    if (this.roleHandles.get(session.role.id) !== session ||
      !host || host.closing || host.window.isDestroyed() ||
      session.abortController.signal.aborted || session.webContents.isDestroyed()) {
      throw new BrowserLaunchCancelledError();
    }
  }

  private getWorkspaceAppearanceSettings():
    | WorkspaceAppearanceSettings
    | Promise<WorkspaceAppearanceSettings> {
    return this.options.getWorkspaceAppearanceSettings?.() ?? DEFAULT_WORKSPACE_APPEARANCE_SETTINGS;
  }

  private applyWorkspaceBackground(divider: GameDivider, settings: WorkspaceAppearanceSettings): void {
    divider.view.setBackgroundColor(settings.background === "black" ? "#FF000000" : "#00000000");
  }

  private async applyBrowserProxy(session: BrowserSession): Promise<void> {
    if (!this.options.applyBrowserProxy) {
      return;
    }

    await this.options.applyBrowserProxy(
      session.role,
      createRoleSessionPartition(session.role.id),
      session.webContents.session
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
        session.webContents.session
      );
    } catch (error) {
      console.warn("Failed to apply CDN compatibility settings.", error);
    }
  }


  private configureWindowOpenHandler(session: BrowserSession, webContents: WebContents): void {
    webContents.setWindowOpenHandler(() => ({
      action: "allow",
      createWindow: (windowOptions) => this.createPopupView(session, windowOptions).webContents
    }));
  }

  private configureCloseShortcut(
    host: GameHostWindow,
    session: BrowserSession,
    webContents: WebContents
  ): void {
    const displayHost = this.getDisplayHost(host);
    if (displayHost) this.configureRuntimeWindowAccelerators(displayHost, webContents, session);
    webContents.on("before-input-event", (event, input) => {
      if (this.isProtectedGameInputActive(session, webContents)) return;
      if (input.type !== "keyDown" || input.key.toLowerCase() !== "w" || (!input.meta && !input.control)) {
        return;
      }
      event.preventDefault();
      void this.hideRuntimeTab(host.id);
    });
  }

  private configureRuntimeWindowAccelerators(
    displayHost: EmbeddedDisplayHost,
    webContents: WebContents,
    session?: BrowserSession
  ): void {
    webContents.on("before-input-event", (event, input) => {
      const tabSwitchDirection = classifyRuntimeTabSwitchShortcut(input);
      if (tabSwitchDirection) {
        event.preventDefault();
        this.switchRuntimeTabFromShortcut(displayHost, tabSwitchDirection);
        return;
      }

      if ((this.options.platform ?? process.platform) !== "darwin") return;
      if (session && this.isProtectedGameInputActive(session, webContents)) return;
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

  private switchRuntimeTabFromShortcut(
    displayHost: EmbeddedDisplayHost,
    direction: RuntimeTabSwitchDirection
  ): void {
    void this.options.browserRuntimeState.invoke({
      type: "embeddedTabActivateAdjacent",
      displayId: displayHost.displayId,
      direction
    }).catch((error) => {
      console.error("Failed to switch embedded runtime tab.", error);
    });
  }

  private isProtectedGameInputActive(session: BrowserSession, webContents: WebContents): boolean {
    return session.gameInputContextActive && session.webContents === webContents;
  }

  private createPopupView(
    session: BrowserSession,
    windowOptions: BrowserWindowConstructorOptions
  ): WebContentsView {
    const host = this.tabHandles.get(session.hostId);
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
        preload: this.options.embeddedPreloadPath,
        sandbox: true,
        spellcheck: false,
        webgl: true,
        zoomFactor: session.zoomFactor
      }
    });

    popupView.setBounds(session.view.getBounds());
    host.window.contentView.addChildView(popupView);
    this.bringRuntimeChromeToFront(this.getDisplayHost(host));
    session.popupViews.add(popupView);
    this.options.onEmbeddedWebContentsCreated?.({
      hostId: host.id,
      kind: "popup",
      roleId: session.role.id,
      ...(host.workspaceId ? { workspaceId: host.workspaceId } : {})
    }, popupView.webContents);
    this.configureZoomPersistence(session, popupView.webContents);
    this.configureAudioState(host, popupView.webContents);
    this.configureNativeZoomShortcuts(host, session, popupView.webContents);
    this.configureWindowOpenHandler(session, popupView.webContents);
    this.configureCloseShortcut(host, session, popupView.webContents);
    this.configureHtmlFullscreen(host, popupView.webContents);
    this.trackGameViewFocus(host, popupView);
    popupView.webContents.once("destroyed", () => {
      session.popupViews.delete(popupView);
      if (!host.window.isDestroyed()) {
        host.window.contentView.removeChildView(popupView);
      }
      if (this.tabHandles.get(host.id) === host) this.emitChange();
    });
    return popupView;
  }

  private layoutHost(host: GameHostWindow): Promise<void> {
    const displayHost = this.getDisplayHost(host);
    if (!displayHost || !this.shouldLayoutHost(host)) {
      return Promise.resolve();
    }

    const state = this.hostLayoutStates.get(host.id) ?? {
      generation: 0,
      trailing: false
    };
    this.hostLayoutStates.set(host.id, state);
    state.generation += 1;
    const generation = state.generation;
    if (state.inFlight) {
      state.trailing = true;
      return state.inFlight;
    }

    const contentBounds = this.getTabContentBounds(host);
    this.options.recordLayoutPass?.();
    const pendingLayout = this.options.workspaceLayoutResolver({
      active: displayHost.activeTabId === host.id,
      contentBounds,
      dividers: host.dividers.map((divider) => ({
        afterRoleIds: divider.afterRoleIds,
        axis: divider.axis,
        beforeRoleIds: divider.beforeRoleIds
      })),
      gap: host.workspaceAppearance.gap,
      hidden: host.hidden,
      roles: [...host.roleIds].flatMap((roleId) => {
        const session = this.roleHandles.get(roleId);
        return session ? [{ rect: session.rect, roleId }] : [];
      }),
      windowVisible: isWindowVisible(displayHost.window)
    });
    const applyLayout = (resolvedLayout: WorkspaceLayoutOutput): void => {
      if (
        generation !== state.generation ||
        this.tabHandles.get(host.id) !== host ||
        host.closing
      ) {
        return;
      }
      const visible = resolvedLayout.visible;
      host.roleIds.forEach((roleId) => {
        const session = this.roleHandles.get(roleId);
        if (!session) return;
        session.view.setVisible(visible);
        session.popupViews.forEach((popupView) => popupView.setVisible(visible));
      });
      host.dividers.forEach((divider) => divider.view.setVisible(visible));
      if (!visible) return;

      const boundsByRole = new Map(
        resolvedLayout.roles.map((role) => [role.roleId, role.bounds])
      );
      host.roleIds.forEach((roleId) => {
        const session = this.roleHandles.get(roleId);
        const bounds = boundsByRole.get(roleId);
        if (!session || !bounds) return;
        session.view.setBounds(bounds);
        session.popupViews.forEach((popupView) => popupView.setBounds(bounds));
        void this.applyAdaptiveZoom(session, bounds.width);
      });
      resolvedLayout.dividers.forEach(({ bounds, index }) => {
        host.dividers[index]?.view.setBounds(bounds);
      });
    };
    if (isPromiseLike(pendingLayout)) {
      const operation = pendingLayout
        .then((resolvedLayout) => applyLayout(resolvedLayout))
        .then(async () => {
          if (
            !state.trailing ||
            this.tabHandles.get(host.id) !== host ||
            host.closing
          ) {
            return;
          }
          state.trailing = false;
          state.inFlight = undefined;
          await this.layoutHost(host);
        })
        .finally(() => {
          if (state.inFlight === operation) state.inFlight = undefined;
        });
      state.inFlight = operation;
      return operation;
    }
    applyLayout(pendingLayout);
    return Promise.resolve();
  }

  private shouldLayoutHost(host: GameHostWindow): boolean {
    if (host.window.isDestroyed() || host.window.isMinimized()) {
      return false;
    }

    const contentBounds = host.window.getContentBounds();
    return contentBounds.width > 1 && contentBounds.height > 1;
  }

  private resizeDivider(
    host: GameHostWindow,
    divider: GameDivider,
    requestedPosition: number,
    previousPosition?: number
  ): MaybePromise<GameDividerResizeResult | undefined> {
    const dividerIndex = host.dividers.indexOf(divider);
    if (dividerIndex < 0) return undefined;
    const pendingResult = this.options.workspaceDividerResizeResolver({
      dividerIndex,
      dividers: host.dividers.map(({ afterRoleIds, axis, beforeRoleIds, defaultPosition }) => ({
        afterRoleIds,
        axis,
        beforeRoleIds,
        defaultPosition
      })),
      ...(previousPosition === undefined ? {} : { previousPosition }),
      requestedPosition,
      roles: [...host.roleIds].flatMap((roleId) => {
        const candidate = this.roleHandles.get(roleId);
        return candidate ? [{ rect: candidate.rect, roleId }] : [];
      })
    });
    const applyResult = (result: WorkspaceDividerResizeOutput): GameDividerResizeResult => {
      if (result.changed) {
        result.roles.forEach(({ rect, roleId }) => {
          const session = this.roleHandles.get(roleId);
          if (session) session.rect = rect;
        });
        void this.layoutHost(host);
      }
      return { changed: result.changed, position: result.position, roleIds: result.roleIds };
    };
    return isPromiseLike(pendingResult) ? pendingResult.then(applyResult) : applyResult(pendingResult);
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
      const session = this.roleHandles.get(roleId);
      if (!session || session.webContents.isDestroyed()) {
        return;
      }

      const payload: WorkspaceResizeIndicatorPayload = type === "hide"
        ? { type }
        : { type, label: formatWorkspaceResizeRatio(session.rect) };
      session.webContents.send(WORKSPACE_RESIZE_INDICATOR_CHANNEL, payload);
    });
  }

  private async applyZoom(session: BrowserSession, zoomFactor: number): Promise<void> {
    this.setSessionZoomFactor(session, zoomFactor);
  }

  private applyAdaptiveZoom(session: BrowserSession, viewportWidth: number): Promise<void> {
    if (session.zoomMode !== "adaptive") {
      return Promise.resolve();
    }
    const currentPercent = Math.round(session.zoomFactor * 100) as WorkspaceBrowserZoomPercent;
    const pendingPercent = this.options.adaptiveZoomResolver(viewportWidth, currentPercent);
    const applyPercent = (nextPercent: WorkspaceBrowserZoomPercent): void => {
      if (nextPercent !== currentPercent) this.setSessionZoomFactor(session, nextPercent / 100);
    };
    if (isPromiseLike(pendingPercent)) return pendingPercent.then(applyPercent);
    applyPercent(pendingPercent);
    return Promise.resolve();
  }

  private setSessionZoomFactor(session: BrowserSession, zoomFactor: number): void {
    session.zoomFactor = zoomFactor;
    if (!session.webContents.isDestroyed()) {
      session.webContents.setZoomFactor(zoomFactor);
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

  private configureNativeZoomShortcuts(
    host: GameHostWindow,
    session: BrowserSession,
    webContents: WebContents
  ): void {
    webContents.on("before-input-event", (_event, input) => {
      const zoomAction = classifyNativeZoomShortcut(input, this.options.platform ?? process.platform);
      if (!zoomAction) {
        return;
      }

      let previousPercent: number;
      try {
        previousPercent = Math.round(webContents.getZoomFactor() * 100);
      } catch (error) {
        console.warn("Failed to read browser zoom before the native action.", error);
        return;
      }

      webContents.setIgnoreMenuShortcuts(true);
      let didPerformNativeZoom = false;
      try {
        didPerformNativeZoom = this.options.performNativeZoom?.(
          zoomAction,
          host.window,
          webContents,
          {
            altKey: input.alt,
            ctrlKey: input.control,
            metaKey: input.meta,
            shiftKey: input.shift,
            triggeredByAccelerator: true
          }
        ) ?? false;
      } catch (error) {
        console.warn("Failed to execute native browser zoom for the game role.", error);
      }

      setImmediate(() => {
        if (!webContents.isDestroyed()) {
          webContents.setIgnoreMenuShortcuts(this.isProtectedGameInputActive(session, webContents));
        }
        if (webContents.isDestroyed()) {
          return;
        }

        if (!didPerformNativeZoom) {
          console.warn("Native browser zoom was unavailable for the game role.", {
            roleId: session.role.id,
            zoomAction
          });
          return;
        }

        try {
          const browserZoomPercent = Math.round(webContents.getZoomFactor() * 100);
          if (!isWorkspaceSlotBrowserZoomPercent(browserZoomPercent)) {
            console.warn("Ignoring browser zoom outside the supported workspace role range.", {
              browserZoomPercent,
              roleId: session.role.id
            });
            return;
          }
          if (!isExpectedNativeZoomResult(zoomAction, previousPercent, browserZoomPercent)) {
            this.setSessionZoomFactor(session, session.zoomFactor);
            console.warn("Native browser zoom did not change the targeted game role as expected.", {
              browserZoomPercent,
              previousPercent,
              roleId: session.role.id,
              zoomAction
            });
            return;
          }

          session.zoomMode = "fixed";
          this.setSessionZoomFactor(session, browserZoomPercent / 100);
          this.scheduleWorkspaceRoleZoomPersistence(host, session, browserZoomPercent);
        } catch (error) {
          console.warn("Failed to synchronize native browser zoom.", error);
        }
      });
    });
  }

  private scheduleWorkspaceRoleZoomPersistence(
    host: GameHostWindow,
    session: BrowserSession,
    browserZoomPercent: WorkspaceSlotBrowserZoomPercent
  ): void {
    if (!host.workspaceId || !this.options.persistWorkspaceRoleZoom) {
      return;
    }

    if (session.zoomPersistenceTimer) {
      clearTimeout(session.zoomPersistenceTimer);
    }
    session.zoomPersistenceTimer = setTimeout(() => {
      session.zoomPersistenceTimer = undefined;
      void this.options.persistWorkspaceRoleZoom?.(
        host.workspaceId as string,
        session.role.id,
        browserZoomPercent
      ).catch((error) => {
        console.warn("Failed to persist workspace role browser zoom.", error);
      });
    }, WORKSPACE_ROLE_ZOOM_PERSIST_DEBOUNCE_MS);
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
      ? this.tabHandles.get(displayHost.activeTabId)
      : undefined;
    if (!activeHost || activeHost.hidden || activeHost.closing) {
      return;
    }

    const rememberedView = activeHost.lastFocusedView;
    const fallbackViews = [...activeHost.roleIds].flatMap((roleId) => {
      const session = this.roleHandles.get(roleId);
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

  private async destroyTabHandles(hostId: string): Promise<void> {
    const host = this.tabHandles.get(hostId);
    if (!host || host.closing) {
      return;
    }

    host.closing = true;
    const roleIds = [...host.roleIds];
    await Promise.all(roleIds.map(async (roleId) => {
      const session = this.roleHandles.get(roleId);
      if (session) {
        await this.destroySession(roleId, session);
      }
    }));
    await this.closeHostWindow(host);
  }

  private async destroyRoleHandles(roleId: string): Promise<void> {
    const session = this.roleHandles.get(roleId);
    if (!session) return;
    const host = this.tabHandles.get(session.hostId);
    await this.destroySession(roleId, session);
    if (host && host.roleIds.size === 0 && !host.closing) {
      await this.closeHostWindow(host);
    }
  }

  private async destroySession(roleId: string, session: BrowserSession): Promise<void> {
    if (this.roleHandles.get(roleId) !== session) {
      return;
    }

    session.abortController.abort();
    session.removeResourceInvalidation();
    const host = this.tabHandles.get(session.hostId);
    if (host?.activeDividerResize?.roleIds.includes(roleId)) {
      this.finishDividerResize(host);
    }
    this.roleHandles.delete(roleId);
    host?.roleIds.delete(roleId);
    await session.target.dispose().catch(() => undefined);
    await session.resourceTarget.releaseThrottle().catch(() => undefined);
    if (host && !host.window.isDestroyed()) {
      host.window.contentView.removeChildView(session.view);
      session.popupViews.forEach((popupView) => host.window.contentView.removeChildView(popupView));
    }
    session.popupViews.forEach((popupView) => {
      const popupWebContents = popupView.webContents;
      if (popupWebContents && !popupWebContents.isDestroyed()) {
        popupWebContents.close();
      }
    });
    session.popupViews.clear();
    if (!session.webContents.isDestroyed()) {
      session.webContents.close();
    }
    this.emitChange();
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
    this.deleteHost(host);
    if (displayHost) {
      this.handleDisplayHostFullscreenTransition(displayHost, displayHostWasFullscreen);
      if (!displayHost.activeTabId) {
        this.hideDisplayHost(displayHost);
      }
      this.layoutDisplayHost(displayHost);
      this.destroyDisplayHostIfEmpty(displayHost);
    }
    this.reconcileRuntimeTabs();
  }

  private deleteHost(host: GameHostWindow): void {
    this.finishDividerResize(host);
    this.tabHandles.delete(host.id);
    this.hostLayoutStates.delete(host.id);
    const displayHost = this.getDisplayHost(host);
    if (displayHost) {
      displayHost.tabIds = displayHost.tabIds.filter((tabId) => tabId !== host.id);
      if (displayHost.activeTabId === host.id) {
        displayHost.activeTabId = displayHost.tabIds.find(
          (tabId) => !this.tabHandles.get(tabId)?.hidden
        );
      }
    }
    if (host.workspaceId && this.workspaceTabHandleIds.get(host.workspaceId) === host.id) {
      this.workspaceTabHandleIds.delete(host.workspaceId);
    }
  }

  private emitChange(): void {
    const statuses = this.listStatuses();
    const serializedStatuses = JSON.stringify(statuses);
    let published = 0;
    if (serializedStatuses !== this.lastEmittedStatuses) {
      this.lastEmittedStatuses = serializedStatuses;
      this.emit("change", statuses);
      published += 1;
    }
    const runtimeState = this.listEmbeddedRuntimeState();
    const serializedRuntimeState = JSON.stringify(runtimeState);
    if (serializedRuntimeState !== this.lastEmittedRuntimeState) {
      this.lastEmittedRuntimeState = serializedRuntimeState;
      this.emit("runtimeChange", runtimeState);
      published += 1;
    }
    if (published > 0) this.options.recordRuntimePublish?.(published);
    this.displayHosts.forEach((host) => this.sendRuntimeChromeState(host));
  }

  private toStatus(roleId: string): RoleStatus {
    const role = this.runtimeSnapshot.roles
      .find((candidate) => candidate.roleId === roleId && candidate.runtime === "embedded");
    if (!role) {
      throw new Error("Rust browser runtime is missing the embedded role state.");
    }
    return {
      roleId,
      state: role.state,
      ...(role.launchedAt ? { launchedAt: role.launchedAt } : {}),
      runtimeMode: "embedded"
    };
  }

  private isEmbeddedRoleRunning(roleId: string): boolean {
    return this.runtimeSnapshot.roles
      .some((role) => role.roleId === roleId && role.runtime === "embedded" && role.state === "running");
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

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as Promise<T>)?.then === "function";
}

function yieldToElectronMainLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
