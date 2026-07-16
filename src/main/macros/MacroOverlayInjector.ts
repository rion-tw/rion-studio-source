import type { WebContents } from "electron";

import macroOverlayCss from "./overlay/macroOverlay.css?raw";
import macroOverlayRuntimeSource from "./overlay/macroOverlayRuntime.js?raw";

import type { AppLanguage, Macro, MacroEditorRequest, MacroRunStatus, Role, RoleStatus } from "../../shared/types";
import type { MacroManager } from "./MacroManager";
import type { MacroStore } from "./MacroStore";
import type { RoleStore } from "../roles/RoleStore";

interface MacroOverlayItem extends Macro {
  roleNames: string[];
}

interface MacroOverlayState {
  cpuThrottleRate?: RoleStatus["cpuThrottleRate"];
  detached?: true;
  language?: AppLanguage;
  macros: MacroOverlayItem[];
  resourceState?: RoleStatus["resourceState"];
  startSummary?: {
    skippedCount: number;
    startedCount: number;
  };
  statuses: MacroRunStatus[];
}

export interface ExternalMacroOverlayHost {
  evaluate: <T = unknown>(source: string) => Promise<T>;
  installMacroOverlay: (source: string, handler: (request: unknown) => Promise<unknown>) => Promise<void>;
  onDisconnect: (listener: () => void) => () => void;
}

export type MacroOverlayRequest =
  | {
      type: "list";
    }
  | {
      type: "create";
    }
  | {
      macroId: string;
      type: "edit";
    }
  | {
      macroId: string;
      type: "start";
    }
  | {
      macroId: string;
      type: "stop";
    }
  | {
      enabled: boolean;
      macroId: string;
      type: "set-enabled";
    };

export class MacroOverlayInjector {
  private readonly externalHosts = new Set<ExternalMacroOverlayHost>();
  private readonly externalHostRoleIds = new WeakMap<ExternalMacroOverlayHost, string>();
  private readonly installedContents = new Set<WebContents>();
  private readonly initializedContents = new WeakSet<WebContents>();
  private readonly contentRoleIds = new WeakMap<WebContents, string>();
  private language: AppLanguage | undefined;

  constructor(
    private readonly macroStore: Pick<MacroStore, "listMacros" | "updateMacro">,
    private readonly macroManager: Pick<
      MacroManager,
      "listStatuses" | "startForRole" | "stopForRole" | "stopAndRunMutation"
    >,
    private readonly onMacroEditorRequested?: (request: MacroEditorRequest) => void | Promise<void>,
    private readonly getRoleStatus?: (roleId: string) => RoleStatus | undefined,
    private readonly roleStore?: Pick<RoleStore, "listRoles">,
    private readonly onMacrosChanged?: () => void
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
    host.onDisconnect(() => this.externalHosts.delete(host));
    try {
      await host.installMacroOverlay(MACRO_OVERLAY_SCRIPT, async (request) => {
        if (!isMacroOverlayRequest(request)) {
          throw new Error("Invalid macro overlay request.");
        }
        return this.handleRequest(role.id, request);
      });
    } catch (error) {
      this.externalHosts.delete(host);
      throw error;
    }
  }

  refreshInstalledOverlays(roleId?: string): void {
    this.installedContents.forEach((webContents) => {
      if (roleId && this.contentRoleIds.get(webContents) !== roleId) {
        return;
      }

      void this.refreshContentsOverlay(webContents);
    });
    this.externalHosts.forEach((host) => {
      if (roleId && this.externalHostRoleIds.get(host) !== roleId) {
        return;
      }
      void this.refreshExternalOverlay(host);
    });
  }

  setLanguage(language: AppLanguage): void {
    this.language = language;
    this.refreshInstalledOverlays();
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
    let startedCount: number | undefined;

    switch (request.type) {
      case "list":
        break;
      case "create":
        await this.onMacroEditorRequested?.({ roleId });
        break;
      case "edit":
        await this.assertMacroAssignedToRole(roleId, request.macroId);
        if (this.macroManager.listStatuses().some(
          (status) => status.macroId === request.macroId &&
            (status.state === "running" || status.state === "stopping")
        )) {
          throw new Error("Stop the macro before editing it.");
        }
        await this.onMacroEditorRequested?.({ macroId: request.macroId, roleId });
        break;
      case "start":
        startedCount = (await this.macroManager.startForRole(request.macroId, roleId)).length;
        break;
      case "stop":
        await this.macroManager.stopForRole(request.macroId, roleId);
        break;
      case "set-enabled":
        await this.assertMacroAssignedToRole(roleId, request.macroId);
        await this.macroManager.stopAndRunMutation(request.macroId, () =>
          this.macroStore.updateMacro(request.macroId, { enabled: request.enabled })
        );
        this.refreshInstalledOverlays();
        this.onMacrosChanged?.();
        break;
    }

    const state = await this.getOverlayState(roleId);
    if (request.type !== "start" || startedCount === undefined) {
      return state;
    }

    const macro = state.macros.find((item) => item.id === request.macroId);
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

    webContents.once("destroyed", () => {
      this.installedContents.delete(webContents);
    });
  }

  private async refreshContentsOverlay(webContents: WebContents): Promise<void> {
    try {
      await webContents.executeJavaScript(
        "window.__rionStudioMacroOverlay?.refresh?.({ renderAfter: true })"
      );
    } catch (error) {
      if (!isBenignFrameInstallError(error)) {
        console.warn("Failed to refresh Rion Studio macro overlay.", error);
      }

      this.installedContents.delete(webContents);
    }
  }

  private async refreshExternalOverlay(host: ExternalMacroOverlayHost): Promise<void> {
    try {
      await host.evaluate("window.__rionStudioMacroOverlay?.refresh?.({ renderAfter: true })");
    } catch (error) {
      if (!isBenignFrameInstallError(error)) {
        console.warn("Failed to refresh the external Chrome macro overlay.", error);
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
    const [macros, roles] = await Promise.all([
      this.macroStore.listMacros(),
      this.roleStore?.listRoles() ?? Promise.resolve([])
    ]);
    const statuses = this.macroManager.listStatuses();
    const roleStatus = this.getRoleStatus?.(roleId);
    const roleNameById = new Map(roles.map((role) => [role.id, role.name]));

    const assignedMacros = macros
      .filter((macro) => macro.roleIds.includes(roleId))
      .map((macro) => ({
        ...macro,
        roleNames: macro.roleIds.map((assignedRoleId) => roleNameById.get(assignedRoleId) ?? assignedRoleId)
      }));
    const assignedMacroIds = new Set(assignedMacros.map((macro) => macro.id));

    return {
      cpuThrottleRate: roleStatus?.cpuThrottleRate,
      language: this.language,
      macros: assignedMacros,
      resourceState: roleStatus?.resourceState,
      statuses: statuses.filter((status) => assignedMacroIds.has(status.macroId))
    };
  }

  private async assertMacroAssignedToRole(roleId: string, macroId: string): Promise<void> {
    const macro = (await this.macroStore.listMacros()).find((item) => item.id === macroId);
    if (!macro?.roleIds.includes(roleId)) {
      throw new Error("This macro is not assigned to the current role.");
    }
  }
}

export function isMacroOverlayRequest(value: unknown): value is MacroOverlayRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const request = value as { type?: unknown; macroId?: unknown; enabled?: unknown };
  if (request.type === "list" || request.type === "create") {
    return true;
  }
  if (request.type === "set-enabled") {
    return typeof request.macroId === "string" && Boolean(request.macroId) && typeof request.enabled === "boolean";
  }
  return (
    (request.type === "edit" || request.type === "start" || request.type === "stop") &&
    typeof request.macroId === "string" &&
    Boolean(request.macroId)
  );
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
    event.defaultPrevented ||
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
