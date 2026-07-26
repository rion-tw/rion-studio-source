import type {
  RuntimeRestoreSessionRecord,
  RuntimeRestoreTabRecord,
  RuntimeRestoreWindowRecord
} from "../../shared/generated";
import type {
  DiscardSavedGameWindowsInput,
  EmbeddedRuntimeState,
  Game,
  GameBrowserSettings,
  LaunchWorkspace,
  RestoreSavedGameWindowsInput,
  Role,
  RuntimeWindowPreferences,
  SavedEmbeddedRuntimeWindowSummary,
  WorkspaceDisplayInfo
} from "../../shared/types";
import {
  createWorkspaceDisplayTarget,
  resolveWorkspaceDisplayTarget
} from "../../shared/workspaceDisplays";
import type { AppCoreClient } from "../core/nativeCore";
import type { GameBrowserSettingsStore } from "../game-browser/GameBrowserSettingsStore";
import type { GameStore } from "../games/GameStore";
import type { RoleStore } from "../roles/RoleStore";
import type { LaunchWorkspaceStore } from "../workspaces/LaunchWorkspaceStore";
import type {
  RuntimeHostLaunchTarget as BrowserWorkspaceLaunchTarget,
  RuntimeHostPort
} from "./ports/RuntimeHostPort";

const SAVE_DEBOUNCE_MS = 300;
const PERMANENT_RESTORE_ERROR_CODES = new Set([
  "GAME_NOT_FOUND",
  "ROLE_NOT_FOUND",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ROLES_REQUIRED",
  "WORKSPACE_ROLE_NOT_FOUND"
]);

interface RuntimeSessionManagerOptions {
  browserManager: RuntimeHostPort;
  canRestoreSavedWindows: () => Promise<boolean>;
  core: Pick<AppCoreClient, "invoke">;
  gameBrowserSettingsStore: Pick<GameBrowserSettingsStore, "getSettings">;
  gameStore: Pick<GameStore, "listGames">;
  getDefaultLaunchTarget: () => BrowserWorkspaceLaunchTarget;
  getPreferences: () => RuntimeWindowPreferences;
  getWorkspaceDisplays: () => WorkspaceDisplayInfo[];
  logger?: Pick<Console, "error" | "warn">;
  roleStore: Pick<RoleStore, "listRoles">;
  workspaceStore: Pick<LaunchWorkspaceStore, "listWorkspaces">;
}

interface RestoreCatalog {
  games: Map<string, Game>;
  roles: Map<string, Role>;
  settings: GameBrowserSettings;
  workspaces: Map<string, LaunchWorkspace>;
}

interface PlannedWindowRestore {
  reveal: boolean;
  savedWindow: RuntimeRestoreWindowRecord;
  target: BrowserWorkspaceLaunchTarget;
}

export class RuntimeSessionManager {
  private session: RuntimeRestoreSessionRecord = emptySession(false);
  private dormantWindows: RuntimeRestoreWindowRecord[] = [];
  private readonly failureByWindowId: Record<string, string> = {};
  private readonly restoringWindowIds = new Set<string>();
  private recoveryRequired = false;
  private initialized = false;
  private autoRestoreAttempted = false;
  private frozenForQuit = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingSave?: Promise<void>;
  private readonly logger: Pick<Console, "error" | "warn">;

  constructor(private readonly options: RuntimeSessionManagerOptions) {
    this.logger = options.logger ?? console;
    options.browserManager.setRuntimeSessionProjectionProvider(() => this.getProjection());
    options.browserManager.on("runtimeChange", () => {
      if (!this.initialized || this.frozenForQuit || this.restoringWindowIds.size > 0) return;
      this.removeLiveSourcesFromDormant();
      this.scheduleSave();
    });
  }

  async initialize(): Promise<void> {
    const stored = await this.options.core.invoke({ type: "runtimeRestoreSessionGet" });
    this.session = structuredClone(stored);
    this.dormantWindows = await this.pruneAndRefreshWindows(stored.windows);
    this.recoveryRequired = !stored.cleanExit && this.dormantWindows.length > 0;
    this.initialized = true;
    await this.persist(false);
    this.publish();
  }

  async restoreOnStartupIfEligible(legalAccepted: boolean): Promise<void> {
    if (
      !this.initialized ||
      this.autoRestoreAttempted ||
      !legalAccepted ||
      this.recoveryRequired ||
      !this.options.getPreferences().restoreGameWindowsOnStartup
    ) {
      return;
    }
    this.autoRestoreAttempted = true;
    await this.restore({ scope: "last-visible" });
  }

  getProjection(): Pick<EmbeddedRuntimeState, "savedWindows" | "recovery"> {
    const savedWindows = this.dormantWindows.map((window) => this.toSummary(window));
    return {
      ...(savedWindows.length > 0 ? { savedWindows } : {}),
      ...(this.recoveryRequired
        ? {
            recovery: {
              reason: "unclean-exit" as const,
              windowCount: savedWindows.length,
              tabCount: savedWindows.reduce((total, window) => total + window.tabCount, 0)
            }
          }
        : {})
    };
  }

  async showGameWindows(displayId?: number): Promise<void> {
    if (displayId === undefined) {
      await this.restore({ scope: "all" });
      await this.options.browserManager.showEmbeddedRuntimeWindows();
      return;
    }
    const matching = this.dormantWindows.filter((window) => {
      return this.resolveRestoreTarget(window).displayId === displayId;
    });
    for (const window of matching) {
      await this.restore({ scope: "window", windowId: window.id });
    }
    await this.options.browserManager.showEmbeddedRuntimeWindows(displayId).catch((error) => {
      if (matching.length === 0) throw error;
    });
  }

  async restore(input: RestoreSavedGameWindowsInput): Promise<void> {
    if (!(await this.options.canRestoreSavedWindows())) {
      throw new Error("Review and accept the legal terms before restoring Game Windows.");
    }
    this.recoveryRequired = false;
    const selected = this.selectWindows(input);
    if (selected.length === 0) {
      await this.persist(false);
      this.publish();
      return;
    }
    const catalog = await this.loadCatalog();
    const plans = selected.map((savedWindow): PlannedWindowRestore => ({
      reveal: input.scope !== "last-visible" || savedWindow.wasVisible,
      savedWindow,
      target: this.resolveRestoreTarget(savedWindow)
    }));
    const preparedDisplayIds = new Set<number>();
    for (const plan of plans) {
      if (preparedDisplayIds.has(plan.target.displayId)) continue;
      preparedDisplayIds.add(plan.target.displayId);
      this.options.browserManager.prepareRestoredWindow(
        plan.target.displayId,
        plan.savedWindow.id
      );
    }
    const activationByDisplayId = new Map<number, string>();
    const activationByWindowId = new Map<
      string,
      { displayId: number; tabId: string }
    >();
    try {
      for (const plan of plans) {
        try {
          const activeTabId = await this.restoreWindow(plan, catalog);
          if (plan.reveal && activeTabId) {
            activationByDisplayId.delete(plan.target.displayId);
            activationByDisplayId.set(plan.target.displayId, activeTabId);
            activationByWindowId.set(plan.savedWindow.id, {
              displayId: plan.target.displayId,
              tabId: activeTabId
            });
          }
        } catch (error) {
          this.failureByWindowId[plan.savedWindow.id] = errorMessage(error);
          this.logger.error(
            `Failed to restore saved Game Window ${plan.savedWindow.id}.`,
            error
          );
        }
      }
    } finally {
      preparedDisplayIds.forEach((displayId) => {
        this.options.browserManager.finishRestoredWindow(displayId);
      });
    }
    const lastFocusedActivation = this.session.lastFocusedWindowId
      ? activationByWindowId.get(this.session.lastFocusedWindowId)
      : undefined;
    if (lastFocusedActivation) {
      activationByDisplayId.delete(lastFocusedActivation.displayId);
      activationByDisplayId.set(
        lastFocusedActivation.displayId,
        lastFocusedActivation.tabId
      );
    }
    for (const activeTabId of activationByDisplayId.values()) {
      await this.options.browserManager.showRuntimeTab(activeTabId);
    }
    await this.persist(false);
    this.publish();
  }

  async discard(input: DiscardSavedGameWindowsInput): Promise<void> {
    const ids = input.scope === "all"
      ? new Set(this.dormantWindows.map((window) => window.id))
      : new Set([input.windowId]);
    this.dormantWindows = this.dormantWindows.filter((window) => !ids.has(window.id));
    ids.forEach((id) => {
      delete this.failureByWindowId[id];
      this.restoringWindowIds.delete(id);
    });
    if (input.scope === "all") this.recoveryRequired = false;
    if (this.dormantWindows.length === 0) this.recoveryRequired = false;
    await this.persist(false);
    this.publish();
  }

  async stopWindow(displayId: number): Promise<void> {
    await this.options.browserManager.stopRuntimeWindow(displayId);
    await this.persist(false);
  }

  async refreshSavedSources(): Promise<void> {
    this.dormantWindows = await this.pruneAndRefreshWindows(this.dormantWindows);
    if (this.dormantWindows.length === 0) this.recoveryRequired = false;
    await this.persist(false);
    this.publish();
  }

  async flushForQuit(): Promise<void> {
    this.frozenForQuit = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.pendingSave;
    await this.persist(true);
  }

  private selectWindows(input: RestoreSavedGameWindowsInput): RuntimeRestoreWindowRecord[] {
    if (input.scope === "window") {
      const window = this.dormantWindows.find((candidate) => candidate.id === input.windowId);
      return window ? [window] : [];
    }
    if (input.scope === "last-visible") {
      return this.dormantWindows.filter((window) => window.wasVisible);
    }
    return [...this.dormantWindows];
  }

  private resolveRestoreTarget(
    savedWindow: RuntimeRestoreWindowRecord
  ): BrowserWorkspaceLaunchTarget {
    const resolvedDisplay = resolveWorkspaceDisplayTarget(
      savedWindow.targetDisplay,
      this.options.getWorkspaceDisplays()
    );
    return resolvedDisplay
      ? { displayId: resolvedDisplay.id, workArea: resolvedDisplay.workArea }
      : this.options.getDefaultLaunchTarget();
  }

  private async restoreWindow(
    plan: PlannedWindowRestore,
    catalog: RestoreCatalog
  ): Promise<string | undefined> {
    const { reveal, savedWindow, target } = plan;
    this.restoringWindowIds.add(savedWindow.id);
    delete this.failureByWindowId[savedWindow.id];
    this.publish();

    const remaining: RuntimeRestoreTabRecord[] = [];
    const restoredSourceIds = new Set<string>();
    let failureMessage: string | undefined;
    try {
      for (const tab of savedWindow.tabs) {
        const refreshed = this.refreshTab(tab, catalog);
        if (!refreshed) continue;
        try {
          const restored = await this.options.browserManager.launchEmbeddedRestoreTab(
            {
              type: refreshed.tabType,
              sourceId: refreshed.sourceId,
              hidden: refreshed.hidden,
              audioMuted: refreshed.audioMuted
            },
            target
          );
          if (restored) restoredSourceIds.add(restored.sourceId);
          else remaining.push(refreshed);
        } catch (error) {
          const code = errorCode(error);
          if (!code || !PERMANENT_RESTORE_ERROR_CODES.has(code)) {
            remaining.push(refreshed);
            failureMessage = errorMessage(error);
          } else {
            this.logger.warn(`Discarded stale saved game tab ${refreshed.sourceId}.`, error);
          }
        }
      }

      const activeSourceId = savedWindow.activeSourceId;
      const runtimeState = this.options.browserManager.listEmbeddedRuntimeState();
      const active = runtimeState.tabs.find(
        (tab) =>
          tab.displayId === target.displayId &&
          tab.sourceId === activeSourceId &&
          restoredSourceIds.has(tab.sourceId) &&
          !tab.hidden
      ) ?? runtimeState.tabs.find(
        (tab) =>
          tab.displayId === target.displayId &&
          restoredSourceIds.has(tab.sourceId) &&
          !tab.hidden
      ) ?? (reveal
        ? runtimeState.tabs.find(
            (tab) =>
              tab.displayId === target.displayId &&
              restoredSourceIds.has(tab.sourceId)
          )
        : undefined);
      return reveal ? active?.id : undefined;
    } finally {
      this.restoringWindowIds.delete(savedWindow.id);
      if (remaining.length === 0) {
        this.dormantWindows = this.dormantWindows.filter(
          (window) => window.id !== savedWindow.id
        );
        delete this.failureByWindowId[savedWindow.id];
      } else {
        const activeSourceId = remaining.some(
          (tab) => tab.sourceId === savedWindow.activeSourceId
        )
          ? savedWindow.activeSourceId
          : undefined;
        const replacement = {
          ...savedWindow,
          ...(activeSourceId ? { activeSourceId } : { activeSourceId: undefined }),
          tabs: remaining
        };
        this.dormantWindows = this.dormantWindows.map((window) =>
          window.id === savedWindow.id ? replacement : window
        );
        this.failureByWindowId[savedWindow.id] =
          failureMessage ?? "One or more tabs could not be restored.";
      }
      this.removeLiveSourcesFromDormant();
      this.publish();
    }
  }

  private async loadCatalog(): Promise<RestoreCatalog> {
    const [games, roles, settings, workspaces] = await Promise.all([
      this.options.gameStore.listGames(),
      this.options.roleStore.listRoles(),
      this.options.gameBrowserSettingsStore.getSettings(),
      this.options.workspaceStore.listWorkspaces()
    ]);
    return {
      games: new Map(games.map((game) => [game.id, game])),
      roles: new Map(roles.map((role) => [role.id, role])),
      settings,
      workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    };
  }

  private async pruneAndRefreshWindows(
    windows: RuntimeRestoreWindowRecord[]
  ): Promise<RuntimeRestoreWindowRecord[]> {
    const catalog = await this.loadCatalog();
    const claimedSources = new Set<string>();
    const claimedRoleIds = new Set<string>();
    return windows.flatMap((window) => {
      const tabs = window.tabs.flatMap((tab) => {
        const refreshed = this.refreshTab(tab, catalog);
        if (!refreshed) {
          this.logger.warn(`Discarded stale saved game tab ${tab.sourceId}.`);
          return [];
        }
        const sourceKey = `${refreshed.tabType}:${refreshed.sourceId}`;
        if (
          claimedSources.has(sourceKey) ||
          refreshed.roleIds.some((roleId) => claimedRoleIds.has(roleId))
        ) {
          this.logger.warn(`Discarded conflicting saved game tab ${tab.sourceId}.`);
          return [];
        }
        claimedSources.add(sourceKey);
        refreshed.roleIds.forEach((roleId) => claimedRoleIds.add(roleId));
        return [refreshed];
      });
      if (tabs.length === 0) return [];
      return [{
        ...window,
        activeSourceId: tabs.some((tab) => tab.sourceId === window.activeSourceId)
          ? window.activeSourceId
          : undefined,
        tabs
      }];
    });
  }

  private refreshTab(
    tab: RuntimeRestoreTabRecord,
    catalog: RestoreCatalog
  ): RuntimeRestoreTabRecord | undefined {
    if (tab.tabType === "role") {
      const role = catalog.roles.get(tab.sourceId);
      return role
        ? { ...tab, name: role.name, roleIds: [role.id] }
        : undefined;
    }
    const workspace = catalog.workspaces.get(tab.sourceId);
    if (!workspace) return undefined;
    const roleIds = workspace.slots.flatMap((slot) =>
      slot.roleId && catalog.roles.has(slot.roleId) ? [slot.roleId] : []
    );
    return { ...tab, name: workspace.name, roleIds };
  }

  private toSummary(window: RuntimeRestoreWindowRecord): SavedEmbeddedRuntimeWindowSummary {
    const displays = this.options.getWorkspaceDisplays();
    const resolved = resolveWorkspaceDisplayTarget(window.targetDisplay, displays);
    const fallback = this.options.getDefaultLaunchTarget();
    const targetDisplay = resolved ??
      displays.find((display) => display.id === fallback.displayId);
    const displayLabel =
      targetDisplay?.label.trim() ||
      window.targetDisplay.fingerprint?.label.trim() ||
      `Display ${window.targetDisplay.id}`;
    return {
      id: window.id,
      displayId: targetDisplay?.id ?? fallback.displayId,
      displayLabel,
      wasVisible: window.wasVisible,
      ...(window.activeSourceId ? { activeSourceId: window.activeSourceId } : {}),
      tabCount: window.tabs.length,
      roleCount: new Set(window.tabs.flatMap((tab) => tab.roleIds)).size,
      tabNames: window.tabs.map((tab) => tab.name),
      state: this.restoringWindowIds.has(window.id)
        ? "restoring"
        : this.failureByWindowId[window.id]
          ? "failed"
          : "saved",
      ...(this.failureByWindowId[window.id]
        ? { failureMessage: this.failureByWindowId[window.id] }
        : {})
    };
  }

  private removeLiveSourcesFromDormant(): void {
    const liveTabs = this.options.browserManager.listEmbeddedRuntimeState().tabs;
    const liveSources = new Set(liveTabs.map((tab) => `${tab.type}:${tab.sourceId}`));
    const liveRoleIds = new Set(liveTabs.flatMap((tab) => tab.roleIds));
    this.dormantWindows = this.dormantWindows.flatMap((window) => {
      const tabs = window.tabs.filter(
        (tab) =>
          !liveSources.has(`${tab.tabType}:${tab.sourceId}`) &&
          !tab.roleIds.some((roleId) => liveRoleIds.has(roleId))
      );
      return tabs.length > 0 ? [{ ...window, tabs }] : [];
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      const save = (this.pendingSave ?? Promise.resolve())
        .then(() => this.persist(false))
        .catch((error) => this.logger.error("Failed to save Game Window session.", error));
      const pending = save.finally(() => {
        if (this.pendingSave === pending) this.pendingSave = undefined;
      });
      this.pendingSave = pending;
    }, SAVE_DEBOUNCE_MS);
  }

  private async persist(cleanExit: boolean): Promise<void> {
    const liveState = this.options.browserManager.listEmbeddedRuntimeState();
    const statuses = new Map(
      this.options.browserManager.listStatuses().map((status) => [status.roleId, status])
    );
    const displays = this.options.getWorkspaceDisplays();
    const dormantSources = new Set(
      this.dormantWindows.flatMap((window) =>
        window.tabs.map((tab) => `${tab.tabType}:${tab.sourceId}`)
      )
    );
    const liveWindows = liveState.windows.flatMap((window) => {
      const display = displays.find((candidate) => candidate.id === window.displayId);
      if (!display) return [];
      const tabs = liveState.tabs
        .filter(
          (tab) =>
            tab.displayId === window.displayId &&
            tab.roleIds.every((roleId) => statuses.get(roleId)?.state === "running")
        )
        .map((tab): RuntimeRestoreTabRecord => ({
          tabType: tab.type,
          sourceId: tab.sourceId,
          name: tab.name,
          roleIds: [...tab.roleIds],
          hidden: tab.hidden,
          audioMuted: tab.audioMuted
        }));
      if (tabs.length === 0) return [];
      tabs.forEach((tab) => dormantSources.delete(`${tab.tabType}:${tab.sourceId}`));
      const activeTab = liveState.tabs.find((tab) => tab.id === window.activeTabId);
      return [{
        id: window.id ?? `display-${window.displayId}`,
        targetDisplay: createWorkspaceDisplayTarget(display),
        wasVisible: window.visible,
        ...(activeTab ? { activeSourceId: activeTab.sourceId } : {}),
        tabs
      } satisfies RuntimeRestoreWindowRecord];
    });
    const dormantWindows = this.dormantWindows.flatMap((window) => {
      const tabs = window.tabs.filter((tab) =>
        dormantSources.has(`${tab.tabType}:${tab.sourceId}`)
      );
      return tabs.length > 0 ? [{ ...window, tabs }] : [];
    });
    const focusedWindow = liveState.windows.find((window) => window.focused);
    const next: RuntimeRestoreSessionRecord = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      cleanExit,
      lastFocusedWindowId:
        focusedWindow?.id ??
        this.session.lastFocusedWindowId,
      windows: [...liveWindows, ...dormantWindows]
    };
    this.session = await this.options.core.invoke({
      type: "runtimeRestoreSessionReplace",
      session: next
    });
    this.dormantWindows = dormantWindows;
  }

  private publish(): void {
    this.options.browserManager.publishRuntimeSessionChange();
  }
}

function emptySession(cleanExit: boolean): RuntimeRestoreSessionRecord {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    cleanExit,
    windows: []
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "One or more tabs could not be restored.";
}
