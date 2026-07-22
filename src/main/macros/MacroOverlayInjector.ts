import type { WebContents } from "electron";

import macroOverlayCss from "./overlay/macroOverlay.css?raw";
import macroOverlayRuntimeSource from "./overlay/macroOverlayRuntime.js?raw";

import { findUnassignedMacroDependency } from "../../shared/macroDependencies";
import type { MacroCoordinateMeasurement } from "../../shared/macroCoordinates";
import { DEFAULT_MACRO_BADGE_POSITION } from "../../shared/macroOverlay";
import type {
  AppLanguage,
  Macro,
  MacroBadgePositionSettings,
  MacroPageRequest,
  MacroRunStatus,
  Role,
  RoleStatus
} from "../../shared/types";
import type { HeldTriggerReleaseMode, MacroRuntimeManager } from "./MacroManager";
import type { MacroStore } from "./MacroStore";

interface MacroOverlayState {
  cpuThrottleRate?: RoleStatus["cpuThrottleRate"];
  detached?: true;
  language?: AppLanguage;
  macroBadgePosition?: MacroBadgePositionSettings;
  macros: Macro[];
  resourceState?: RoleStatus["resourceState"];
  startSummary?: {
    skippedCount: number;
    startedCount: number;
  };
  statuses: MacroOverlayStatus[];
}

type MacroOverlayStatus = MacroRunStatus & {
  clickFlash?: true;
};

interface PendingClickStatus {
  status: MacroOverlayStatus;
  timer?: ReturnType<typeof setTimeout>;
}

interface OverlayRefreshState {
  disconnected: boolean;
  inFlight: boolean;
  lastStartedAt: number;
  source: string;
  timer?: ReturnType<typeof setTimeout>;
  trailing: boolean;
}

export interface ExternalMacroOverlayHost {
  evaluate: <T = unknown>(source: string) => Promise<T>;
  installMacroOverlay: (source: string, handler: (request: unknown) => Promise<unknown>) => Promise<void>;
  onDisconnect: (listener: () => void) => () => void;
  onNavigation?: (listener: () => void) => () => void;
}

export type MacroOverlayRequest =
  | {
      active: boolean;
      type: "game-input-context";
    }
  | {
      type: "list";
    }
  | {
      type: "open";
    }
  | (MacroCoordinateMeasurement & {
      type: "copy-coordinate";
      viewportHeightPx: number;
      viewportWidthPx: number;
    })
  | {
      macroId: string;
      type: "start";
    }
  | {
      macroId: string;
      type: "stop";
    }
  | {
      macroId: string;
      pressId: string;
      type: "press";
    }
  | {
      macroId: string;
      pressId: string;
      releaseMode?: HeldTriggerReleaseMode;
      type: "release";
    };

export class MacroOverlayInjector {
  private static readonly CLICK_MARKER_STATUS_RETENTION_MS = 180;
  private static readonly EXTERNAL_REFRESH_MIN_INTERVAL_MS = 250;
  private readonly externalHosts = new Set<ExternalMacroOverlayHost>();
  private readonly externalHostRoleIds = new WeakMap<ExternalMacroOverlayHost, string>();
  private readonly externalRefreshStates = new WeakMap<ExternalMacroOverlayHost, OverlayRefreshState>();
  private readonly installedContents = new Set<WebContents>();
  private readonly initializedContents = new WeakSet<WebContents>();
  private readonly contentRoleIds = new WeakMap<WebContents, string>();
  private readonly contentRefreshStates = new WeakMap<WebContents, OverlayRefreshState>();
  private readonly pendingClickStatuses = new Map<string, PendingClickStatus>();
  private previousMacroStatuses = new Map<string, {
    iteration: number;
    lastClickSequence?: number;
    lastClickStepId?: string;
    roleId: string;
    state: MacroRunStatus["state"];
  }>();
  private previousRolePresentation = new Map<string, string>();
  private language: AppLanguage | undefined;

  constructor(
    private readonly macroStore: Pick<MacroStore, "listMacros">,
    private readonly macroManager: Pick<
      MacroRuntimeManager,
      "listStatuses" | "startForRole" | "stopForRole"
    > & Partial<Pick<
      MacroRuntimeManager,
      "pressForRole" | "releaseForRole" | "releaseHeldTriggersForRole"
    >>,
    private readonly onMacroPageRequested?: (request: MacroPageRequest) => void | Promise<void>,
    private readonly getRoleStatus?: (roleId: string) => RoleStatus | undefined,
    private readonly onExternalRefresh?: (details: {
      roleId: string | undefined;
      source: string;
      trailing: boolean;
    }) => void,
    private readonly onEmbeddedRefresh?: (details: {
      roleId: string | undefined;
      source: string;
      trailing: boolean;
    }) => void,
    private readonly getMacroBadgePosition?: () => Promise<MacroBadgePositionSettings>,
    private readonly copyCoordinateToClipboard?: (
      coordinate: MacroCoordinateMeasurement
    ) => void | Promise<void>
  ) {}

  async install(role: Role, webContents: WebContents): Promise<void> {
    this.trackInstalledContents(role.id, webContents);

    if (!this.initializedContents.has(webContents)) {
      this.initializedContents.add(webContents);
      webContents.on("did-finish-load", () => {
        void this.installContents(webContents);
      });
    }

    await this.installContents(webContents);
  }

  async installExternal(role: Role, host: ExternalMacroOverlayHost): Promise<void> {
    this.externalHosts.add(host);
    this.externalHostRoleIds.set(host, role.id);
    const refreshState: OverlayRefreshState = {
      disconnected: false,
      inFlight: false,
      lastStartedAt: 0,
      source: "install",
      trailing: false
    };
    this.externalRefreshStates.set(host, refreshState);
    host.onDisconnect(() => {
      this.externalHosts.delete(host);
      refreshState.disconnected = true;
      refreshState.trailing = false;
      if (refreshState.timer) clearTimeout(refreshState.timer);
      refreshState.timer = undefined;
      void this.macroManager.releaseHeldTriggersForRole?.(role.id);
    });
    host.onNavigation?.(() => {
      void this.macroManager.releaseHeldTriggersForRole?.(role.id);
    });
    try {
      await host.installMacroOverlay(MACRO_OVERLAY_SCRIPT, async (request) => {
        if (!isMacroOverlayRequest(request)) {
          throw new Error("Invalid macro overlay request.");
        }
        return this.handleRequest(role.id, request);
      });
    } catch (error) {
      this.externalHosts.delete(host);
      refreshState.disconnected = true;
      throw error;
    }
  }

  refreshInstalledOverlays(roleId?: string, source = "manual"): void {
    this.installedContents.forEach((webContents) => {
      if (roleId && this.contentRoleIds.get(webContents) !== roleId) {
        return;
      }

      this.scheduleContentsRefresh(webContents, source);
    });
    this.externalHosts.forEach((host) => {
      if (roleId && this.externalHostRoleIds.get(host) !== roleId) {
        return;
      }
      this.scheduleExternalRefresh(host, source);
    });
  }

  refreshChangedMacroStatuses(statuses: MacroRunStatus[]): void {
    const next = new Map(
      statuses.map((status) => [
        `${status.roleId}:${status.macroId}`,
        {
          iteration: status.iteration ?? 0,
          lastClickSequence: status.lastClick?.sequence,
          lastClickStepId: status.lastClick?.stepId,
          roleId: status.roleId,
          state: status.state
        }
      ])
    );
    const changedRoleIds = new Set<string>();
    statuses.forEach((status) => {
      const key = `${status.roleId}:${status.macroId}`;
      const previous = this.previousMacroStatuses.get(key);
      if (
        status.lastClick &&
        (previous?.lastClickSequence !== status.lastClick.sequence ||
          previous?.lastClickStepId !== status.lastClick.stepId)
      ) {
        this.retainPendingClickStatus(status);
      }
    });
    new Set([...this.previousMacroStatuses.keys(), ...next.keys()]).forEach((key) => {
      const previous = this.previousMacroStatuses.get(key);
      const current = next.get(key);
      if (
        previous?.state !== current?.state ||
        previous?.iteration !== current?.iteration ||
        previous?.lastClickSequence !== current?.lastClickSequence ||
        previous?.lastClickStepId !== current?.lastClickStepId
      ) {
        changedRoleIds.add(current?.roleId ?? previous!.roleId);
      }
    });
    this.previousMacroStatuses = next;
    changedRoleIds.forEach((roleId) => this.refreshInstalledOverlays(roleId, "macro_status"));
  }

  refreshChangedRoleStatuses(statuses: RoleStatus[]): void {
    const next = new Map(
      statuses.map((status) => [status.roleId, rolePresentationKey(status)])
    );
    const changedRoleIds = new Set([...this.previousRolePresentation.keys(), ...next.keys()]);
    changedRoleIds.forEach((roleId) => {
      if (this.previousRolePresentation.get(roleId) !== next.get(roleId)) {
        this.refreshInstalledOverlays(roleId, "role_status");
      }
    });
    this.previousRolePresentation = next;
  }

  setLanguage(language: AppLanguage): void {
    this.language = language;
    this.refreshInstalledOverlays(undefined, "language");
  }

  async handleEmbeddedRequest(
    webContents: WebContents,
    activeRoleId: string | undefined,
    request: MacroOverlayRequest
  ): Promise<MacroOverlayState> {
    const installedRoleId = this.contentRoleIds.get(webContents);
    if (!this.installedContents.has(webContents) || !installedRoleId) {
      throw new Error("Embedded game view is not associated with a role.");
    }
    if (!activeRoleId) {
      return {
        detached: true,
        language: this.language,
        macros: [],
        statuses: []
      };
    }
    if (activeRoleId !== installedRoleId) {
      throw new Error("Embedded game view is associated with a different role.");
    }

    return this.handleRequest(installedRoleId, request);
  }

  async handleRequest(roleId: string, request: MacroOverlayRequest): Promise<MacroOverlayState> {
    switch (request.type) {
      case "game-input-context":
        return { macros: [], statuses: [] };
      case "list":
        break;
      case "open":
        await this.onMacroPageRequested?.({ roleId });
        break;
      case "copy-coordinate":
        if (!this.copyCoordinateToClipboard) {
          throw new Error("Coordinate clipboard support is unavailable.");
        }
        await this.copyCoordinateToClipboard({
          xPercent: request.xPercent,
          xPx: request.xPx,
          viewportHeightPx: request.viewportHeightPx,
          viewportWidthPx: request.viewportWidthPx,
          yPercent: request.yPercent,
          yPx: request.yPx
        });
        break;
      case "start":
        return this.withStartSummary(
          roleId,
          request.macroId,
          (await this.macroManager.startForRole(request.macroId, roleId)).length
        );
      case "stop":
        await this.macroManager.stopForRole(request.macroId, roleId);
        break;
      case "press":
        if (!this.macroManager.pressForRole) {
          throw new Error("Tap-or-hold macro control is unavailable.");
        }
        return this.withStartSummary(
          roleId,
          request.macroId,
          (await this.macroManager.pressForRole(request.macroId, roleId, request.pressId)).length
        );
      case "release":
        await this.macroManager.releaseForRole?.(
          request.macroId,
          roleId,
          request.pressId,
          request.releaseMode
        );
        break;
    }

    return this.getOverlayState(roleId);
  }

  private async withStartSummary(
    roleId: string,
    macroId: string,
    startedCount: number
  ): Promise<MacroOverlayState> {
    const state = await this.getOverlayState(roleId);
    const macro = state.macros.find((item) => item.id === macroId);
    return {
      ...state,
      startSummary: {
        skippedCount: Math.max(0, (macro?.roleIds.length ?? startedCount) - startedCount),
        startedCount
      }
    };
  }

  private trackInstalledContents(roleId: string, webContents: WebContents): void {
    const wasTracked = this.installedContents.has(webContents);
    this.installedContents.add(webContents);
    this.contentRoleIds.set(webContents, roleId);

    if (wasTracked) {
      return;
    }

    const refreshState: OverlayRefreshState = {
      disconnected: false,
      inFlight: false,
      lastStartedAt: 0,
      source: "install",
      trailing: false
    };
    this.contentRefreshStates.set(webContents, refreshState);

    webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        refreshState.trailing = false;
        void this.macroManager.releaseHeldTriggersForRole?.(roleId);
      }
    });
    webContents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) {
        refreshState.trailing = false;
      }
    });

    webContents.once("destroyed", () => {
      refreshState.disconnected = true;
      refreshState.trailing = false;
      this.installedContents.delete(webContents);
      void this.macroManager.releaseHeldTriggersForRole?.(roleId);
    });
  }

  private scheduleContentsRefresh(
    webContents: WebContents,
    source: string,
    trailing = false
  ): void {
    const state = this.contentRefreshStates.get(webContents);
    if (
      !state ||
      state.disconnected ||
      webContents.isDestroyed() ||
      !this.installedContents.has(webContents)
    ) {
      return;
    }
    if (state.inFlight) {
      state.trailing = true;
      state.source = source;
      return;
    }

    state.inFlight = true;
    state.source = source;
    this.onEmbeddedRefresh?.({
      roleId: this.contentRoleIds.get(webContents),
      source,
      trailing
    });
    void this.refreshContentsOverlay(webContents, source).finally(() => {
      state.inFlight = false;
      if (
        !state.trailing ||
        state.disconnected ||
        webContents.isDestroyed() ||
        !this.installedContents.has(webContents)
      ) {
        state.trailing = false;
        return;
      }
      const trailingSource = state.source;
      state.trailing = false;
      this.scheduleContentsRefresh(webContents, trailingSource, true);
    });
  }

  private async refreshContentsOverlay(webContents: WebContents, source: string): Promise<void> {
    try {
      await webContents.executeJavaScript("void window.__rionStudioMacroOverlay?.refresh?.()");
    } catch (error) {
      if (!isBenignFrameInstallError(error)) {
        console.warn("Failed to refresh Rion Studio macro overlay.", {
          error,
          roleId: this.contentRoleIds.get(webContents),
          source
        });
      }

      this.installedContents.delete(webContents);
      const state = this.contentRefreshStates.get(webContents);
      if (state) {
        state.disconnected = webContents.isDestroyed();
        state.trailing = false;
      }
    }
  }

  private scheduleExternalRefresh(
    host: ExternalMacroOverlayHost,
    source: string,
    trailing = false
  ): void {
    const state = this.externalRefreshStates.get(host);
    if (!state || state.disconnected || !this.externalHosts.has(host)) {
      return;
    }
    const roleId = this.externalHostRoleIds.get(host);
    if (roleId && this.getRoleStatus?.(roleId)?.pageHealth === "unresponsive") {
      state.trailing = false;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      return;
    }
    if (state.inFlight) {
      state.trailing = true;
      state.source = source;
      return;
    }

    const remainingDelay = Math.max(
      0,
      MacroOverlayInjector.EXTERNAL_REFRESH_MIN_INTERVAL_MS - (Date.now() - state.lastStartedAt)
    );
    if (remainingDelay > 0) {
      state.trailing = true;
      state.source = source;
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = undefined;
          if (!state.trailing) return;
          const trailingSource = state.source;
          state.trailing = false;
          this.scheduleExternalRefresh(host, trailingSource, true);
        }, remainingDelay);
      }
      return;
    }

    state.inFlight = true;
    state.lastStartedAt = Date.now();
    state.source = source;
    this.onExternalRefresh?.({
      roleId: this.externalHostRoleIds.get(host),
      source,
      trailing
    });
    void this.refreshExternalOverlay(host, source).finally(() => {
      state.inFlight = false;
      if (!state.trailing || state.disconnected || !this.externalHosts.has(host)) {
        state.trailing = false;
        return;
      }
      const trailingSource = state.source;
      state.trailing = false;
      this.scheduleExternalRefresh(host, trailingSource, true);
    });
  }

  private async refreshExternalOverlay(host: ExternalMacroOverlayHost, source: string): Promise<void> {
    try {
      await host.evaluate("void window.__rionStudioMacroOverlay?.refresh?.()");
    } catch (error) {
      if (!isBenignFrameInstallError(error)) {
        console.warn("Failed to refresh the external Chrome macro overlay.", {
          error,
          roleId: this.externalHostRoleIds.get(host),
          source
        });
      }
    }
  }

  private async installContents(webContents: WebContents): Promise<void> {
    if (webContents.isDestroyed()) {
      return;
    }

    try {
      await webContents.executeJavaScript(MACRO_OVERLAY_SCRIPT);
    } catch (error) {
      if (!isBenignFrameInstallError(error)) {
        console.warn("Failed to install Rion Studio macro overlay.", error);
      }
    }
  }

  private async getOverlayState(roleId: string): Promise<MacroOverlayState> {
    const [macros, macroBadgePosition] = await Promise.all([
      this.macroStore.listMacros(),
      this.getMacroBadgePosition?.() ?? Promise.resolve({ ...DEFAULT_MACRO_BADGE_POSITION })
    ]);
    const statuses = this.macroManager.listStatuses();
    const currentRunningStatusKeys = new Set(
      statuses
        .filter((status) => status.state === "running")
        .map((status) => `${status.roleId}:${status.macroId}`)
    );
    const pendingStatuses = [...this.pendingClickStatuses.entries()]
      .filter(([key, { status }]) => {
        if (status.roleId !== roleId || currentRunningStatusKeys.has(key)) {
          return false;
        }
        this.armPendingClickStatus(key);
        return true;
      })
      .map(([, { status }]) => status);
    const roleStatus = this.getRoleStatus?.(roleId);
    const assignedMacros = macros.filter(
      (macro) =>
        macro.roleIds.includes(roleId) &&
        !findUnassignedMacroDependency(macros, macro.id)
    );
    const assignedMacroIds = new Set(assignedMacros.map((macro) => macro.id));

    return {
      cpuThrottleRate: roleStatus?.cpuThrottleRate,
      language: this.language,
      macroBadgePosition,
      macros: assignedMacros,
      resourceState: roleStatus?.resourceState,
      statuses: [...statuses, ...pendingStatuses].filter((status) => assignedMacroIds.has(status.macroId))
    };
  }

  private retainPendingClickStatus(status: MacroRunStatus): void {
    if (!status.lastClick) return;
    const key = `${status.roleId}:${status.macroId}`;
    const previous = this.pendingClickStatuses.get(key);
    if (previous?.timer) clearTimeout(previous.timer);

    const pendingStatus: MacroOverlayStatus = {
      ...status,
      clickFlash: true,
      lastClick: { ...status.lastClick }
    };
    this.pendingClickStatuses.set(key, { status: pendingStatus });
  }

  private armPendingClickStatus(key: string): void {
    const pending = this.pendingClickStatuses.get(key);
    if (!pending || pending.timer) return;

    pending.timer = setTimeout(() => {
      const current = this.pendingClickStatuses.get(key);
      if (current !== pending) {
        return;
      }
      this.pendingClickStatuses.delete(key);
      this.refreshInstalledOverlays(pending.status.roleId, "macro_click_complete");
    }, MacroOverlayInjector.CLICK_MARKER_STATUS_RETENTION_MS);
  }
}

function rolePresentationKey(status: RoleStatus): string {
  return JSON.stringify({
    automationState: status.automationState,
    cpuThrottleRate: status.cpuThrottleRate,
    resourceState: status.resourceState,
    state: status.state
  });
}

export function isMacroOverlayRequest(value: unknown): value is MacroOverlayRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const request = value as {
    active?: unknown;
    type?: unknown;
    macroId?: unknown;
    pressId?: unknown;
    releaseMode?: unknown;
    xPercent?: unknown;
    xPx?: unknown;
    viewportHeightPx?: unknown;
    viewportWidthPx?: unknown;
    yPercent?: unknown;
    yPx?: unknown;
  };
  if (request.type === "game-input-context") {
    return typeof request.active === "boolean";
  }
  if (request.type === "list" || request.type === "open") {
    return true;
  }
  if (request.type === "copy-coordinate") {
    return (
      isFiniteNonNegativeInteger(request.viewportWidthPx) &&
      isFiniteNonNegativeInteger(request.viewportHeightPx) &&
      request.viewportWidthPx > 0 &&
      request.viewportHeightPx > 0 &&
      isFiniteNonNegativeInteger(request.xPx) &&
      isFiniteNonNegativeInteger(request.yPx) &&
      request.xPx < request.viewportWidthPx &&
      request.yPx < request.viewportHeightPx &&
      isFinitePercent(request.xPercent) &&
      isFinitePercent(request.yPercent)
    );
  }
  return (
    (request.type === "start" || request.type === "stop") &&
    typeof request.macroId === "string" &&
    Boolean(request.macroId)
  ) || (
    (request.type === "press" || request.type === "release") &&
    typeof request.macroId === "string" &&
    Boolean(request.macroId) &&
    typeof request.pressId === "string" &&
    Boolean(request.pressId) &&
    (
      request.type !== "release" ||
      request.releaseMode === undefined ||
      request.releaseMode === "complete_first_iteration" ||
      request.releaseMode === "immediate"
    )
  );
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFinitePercent(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isBenignFrameInstallError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /detached|destroyed|closed|Cannot find context|Execution context/i.test(error.message);
}

interface MacroShortcutKeyboardEvent {
  composedPath(): unknown[];
  defaultPrevented: boolean;
  isComposing: boolean;
  key: string;
  keyCode: number;
  target: unknown;
}

export function shouldIgnoreMacroShortcutEvent(
  event: MacroShortcutKeyboardEvent,
  activeElement?: unknown,
  designMode?: string
): boolean {
  if (
    event.isComposing ||
    event.key === "Process" ||
    event.keyCode === 229 ||
    designMode?.toLowerCase() === "on"
  ) {
    return true;
  }

  function hasEditableContext(candidate: unknown): boolean {
    const pending = [candidate];
    const visited = new Set<unknown>();

    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || typeof current !== "object" || visited.has(current)) {
        continue;
      }
      visited.add(current);

      const element = current as {
        getAttribute?: (name: string) => string | null;
        getRootNode?: () => unknown;
        isContentEditable?: unknown;
        localName?: unknown;
        parentElement?: unknown;
        parentNode?: { host?: unknown } | null;
        shadowRoot?: { activeElement?: unknown } | null;
        tagName?: unknown;
      };
      const rawName = typeof element.localName === "string" ? element.localName : element.tagName;
      const name = typeof rawName === "string" ? rawName.toLowerCase() : "";

      if (name === "input" || name === "textarea" || name === "select" || element.isContentEditable === true) {
        return true;
      }

      if (typeof element.getAttribute === "function") {
        const contentEditable = element.getAttribute("contenteditable");
        if (contentEditable !== null && contentEditable.toLowerCase() !== "false") {
          return true;
        }

        const editableRoles = ["textbox", "searchbox", "combobox", "spinbutton"];
        const roles = element.getAttribute("role")?.toLowerCase().split(/\s+/) ?? [];
        if (roles.some((role) => editableRoles.includes(role))) {
          return true;
        }
      }

      pending.push(element.parentElement, element.parentNode?.host, element.shadowRoot?.activeElement);

      if (typeof element.getRootNode === "function") {
        try {
          const root = element.getRootNode() as { host?: unknown } | null;
          pending.push(root?.host);
        } catch {
          // Ignore page-owned DOM accessors that throw while the event is being dispatched.
        }
      }
    }

    return false;
  }

  let eventPath: unknown[] = [];
  try {
    eventPath = event.composedPath();
  } catch {
    // Fall back to the target and active element for non-standard synthetic events.
  }

  return [...eventPath, event.target, activeElement].some(hasEditableContext);
}

export const MACRO_SHORTCUT_GUARD_SOURCE = `(${Function.prototype.toString.call(
  shouldIgnoreMacroShortcutEvent
)})`;

const MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN = "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__";
const MACRO_OVERLAY_CSS_TOKEN = "__RION_STUDIO_MACRO_OVERLAY_CSS__";

function replaceSingleSourceToken(source: string, token: string, replacement: string): string {
  const firstIndex = source.indexOf(token);
  if (firstIndex < 0 || source.indexOf(token, firstIndex + token.length) >= 0) {
    throw new Error(`Expected exactly one ${token} token in the macro overlay runtime.`);
  }

  return source.slice(0, firstIndex) + replacement + source.slice(firstIndex + token.length);
}

const macroOverlayRuntimeWithGuard = replaceSingleSourceToken(
  macroOverlayRuntimeSource,
  JSON.stringify(MACRO_OVERLAY_SHORTCUT_GUARD_TOKEN),
  MACRO_SHORTCUT_GUARD_SOURCE
);

export const MACRO_OVERLAY_SCRIPT = replaceSingleSourceToken(
  macroOverlayRuntimeWithGuard,
  JSON.stringify(MACRO_OVERLAY_CSS_TOKEN),
  JSON.stringify(macroOverlayCss)
);
