import type { WebContents } from "electron";

import macroOverlayCss from "../../shared/browser-overlay/macroOverlay.css?raw";
import macroOverlayRuntimeSource from "../../shared/browser-overlay/macroOverlayRuntime.js?raw";
import macroOverlayShortcutGuardSource from "../../shared/browser-overlay/macroOverlayShortcutGuard.js?raw";

import type {
  MacroOverlayRequestRecord,
  MacroOverlayViewModelRecord
} from "../../shared/generated";
import type { AppLanguage, Role } from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

type OverlayCoreClient = Pick<AppCoreClient, "invoke">;

export type MacroOverlayRequest = MacroOverlayRequestRecord;

interface OverlayRefreshState {
  generation: number;
  inFlight: boolean;
  trailing: boolean;
}

const OVERLAY_REFRESH_STATE = Symbol("rionStudioOverlayRefreshState");
type RefreshTrackedWebContents = WebContents & {
  [OVERLAY_REFRESH_STATE]?: OverlayRefreshState;
};

export class MacroOverlayInjector {
  private readonly installedContents = new Set<WebContents>();
  private readonly initializedContents = new WeakSet<WebContents>();
  private readonly contentRoleIds = new WeakMap<WebContents, string>();
  private disposed = false;
  private language: AppLanguage | undefined;

  constructor(private readonly core: OverlayCoreClient) {}

  async install(role: Role, webContents: WebContents): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.trackInstalledContents(role.id, webContents);

    if (!this.initializedContents.has(webContents)) {
      this.initializedContents.add(webContents);
      webContents.on("did-finish-load", () => {
        if (!this.disposed) {
          void this.installContents(webContents);
        }
      });
    }

    await this.installContents(webContents);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const contents = [...this.installedContents];
    contents.forEach((webContents) => this.invalidateQueuedRefresh(webContents));
    this.installedContents.clear();
    await Promise.allSettled(contents.map(async (webContents) => {
      if (webContents.isDestroyed()) return;
      await webContents.executeJavaScript(
        "void window.__rionStudioMacroOverlay?.dispose?.()"
      );
    }));
  }

  refreshInstalledOverlays(roleIds?: string | string[]): void {
    if (this.disposed) return;
    const selectedRoleIds = roleIds === undefined
      ? undefined
      : new Set(Array.isArray(roleIds) ? roleIds : [roleIds]);
    this.installedContents.forEach((webContents) => {
      if (
        selectedRoleIds &&
        !selectedRoleIds.has(this.contentRoleIds.get(webContents) ?? "")
      ) {
        return;
      }
      this.scheduleContentsRefresh(webContents);
    });
  }

  async setLanguage(language: AppLanguage): Promise<void> {
    this.language = language;
    await this.core.invoke({ type: "overlayLanguageSet", language });
    this.refreshInstalledOverlays();
  }

  async handleEmbeddedRequest(
    webContents: WebContents,
    activeRoleId: string | undefined,
    request: unknown
  ): Promise<MacroOverlayViewModelRecord | {
    detached: true;
    language?: AppLanguage;
    macros: [];
    statuses: [];
  }> {
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

    return this.core.invoke({
      type: "overlayRequest",
      roleId: installedRoleId,
      requestJson: JSON.stringify(request),
      ...(this.language === undefined ? {} : { language: this.language })
    });
  }

  private trackInstalledContents(roleId: string, webContents: WebContents): void {
    const wasTracked = this.installedContents.has(webContents);
    this.installedContents.add(webContents);
    this.contentRoleIds.set(webContents, roleId);

    if (wasTracked) {
      return;
    }

    webContents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) {
        this.invalidateQueuedRefresh(webContents);
        void this.core.invoke({ type: "macroReleaseRole", roleId });
      }
    });
    webContents.on("did-fail-load", (_event, _errorCode, _errorDescription, _url, isMainFrame) => {
      if (isMainFrame) {
        this.invalidateQueuedRefresh(webContents);
      }
    });

    webContents.once("destroyed", () => {
      this.invalidateQueuedRefresh(webContents);
      this.installedContents.delete(webContents);
      void this.core.invoke({ type: "macroReleaseRole", roleId });
    });
  }

  private invalidateQueuedRefresh(webContents: WebContents): void {
    const trackedContents = webContents as RefreshTrackedWebContents;
    const state = trackedContents[OVERLAY_REFRESH_STATE];
    if (!state) {
      return;
    }
    state.generation += 1;
    state.trailing = false;
  }

  private scheduleContentsRefresh(webContents: WebContents): void {
    const trackedContents = webContents as RefreshTrackedWebContents;
    let state = trackedContents[OVERLAY_REFRESH_STATE];
    if (!state) {
      state = { generation: 0, inFlight: false, trailing: false };
      trackedContents[OVERLAY_REFRESH_STATE] = state;
    }
    if (state.inFlight) {
      state.trailing = true;
      return;
    }
    state.inFlight = true;
    void this.runContentsRefresh(webContents, state);
  }

  private async runContentsRefresh(
    webContents: WebContents,
    state: OverlayRefreshState
  ): Promise<void> {
    const generation = state.generation;
    try {
      do {
        state.trailing = false;
        if (
          generation !== state.generation ||
          webContents.isDestroyed() ||
          !this.installedContents.has(webContents)
        ) {
          break;
        }
        try {
          await webContents.executeJavaScript("void window.__rionStudioMacroOverlay?.refresh?.()");
        } catch (error) {
          if (!isBenignFrameInstallError(error)) {
            console.warn("Failed to refresh Rion Studio macro overlay.", {
              error,
              roleId: this.contentRoleIds.get(webContents)
            });
          }
          this.installedContents.delete(webContents);
          state.trailing = false;
          break;
        }
      } while (state.trailing && generation === state.generation);
    } finally {
      state.inFlight = false;
      if (state.trailing && generation === state.generation) {
        this.scheduleContentsRefresh(webContents);
      }
    }
  }

  private async installContents(webContents: WebContents): Promise<void> {
    if (this.disposed || webContents.isDestroyed()) {
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

export const MACRO_SHORTCUT_GUARD_SOURCE = macroOverlayShortcutGuardSource.trim();

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
