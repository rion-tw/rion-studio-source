import type { WebContents } from "electron";

import macroOverlayCss from "./overlay/macroOverlay.css?raw";
import macroOverlayRuntimeSource from "./overlay/macroOverlayRuntime.js?raw";

import type {
  MacroOverlayRequestRecord,
  MacroOverlayViewModelRecord
} from "../../shared/generated";
import type { AppLanguage, Role } from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

type OverlayCoreClient = Pick<AppCoreClient, "invokeTyped">;

export type MacroOverlayRequest = MacroOverlayRequestRecord;

export class MacroOverlayInjector {
  private readonly installedContents = new Set<WebContents>();
  private readonly initializedContents = new WeakSet<WebContents>();
  private readonly contentRoleIds = new WeakMap<WebContents, string>();
  private language: AppLanguage | undefined;

  constructor(private readonly core: OverlayCoreClient) {}

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

  refreshInstalledOverlays(roleIds?: string | string[]): void {
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
      void this.refreshContentsOverlay(webContents);
    });
  }

  async setLanguage(language: AppLanguage): Promise<void> {
    this.language = language;
    await this.core.invokeTyped({ type: "overlayLanguageSet", language });
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

    return this.core.invokeTyped({
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
        void this.core.invokeTyped({ type: "macroReleaseRole", roleId });
      }
    });

    webContents.once("destroyed", () => {
      this.installedContents.delete(webContents);
      void this.core.invokeTyped({ type: "macroReleaseRole", roleId });
    });
  }

  private async refreshContentsOverlay(webContents: WebContents): Promise<void> {
    if (webContents.isDestroyed() || !this.installedContents.has(webContents)) {
      return;
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
