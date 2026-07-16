import type { WebContents } from "electron";

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

export const MACRO_OVERLAY_SCRIPT = String.raw`
(() => {
  const hostId = "rion-studio-macro-overlay-v26";
  const legacyHostIds = [
    "rion-studio-macro-overlay",
    "rion-studio-macro-overlay-v2",
    "rion-studio-macro-overlay-v3",
    "rion-studio-macro-overlay-v4",
    "rion-studio-macro-overlay-v5",
    "rion-studio-macro-overlay-v6",
    "rion-studio-macro-overlay-v7",
    "rion-studio-macro-overlay-v8",
    "rion-studio-macro-overlay-v9",
    "rion-studio-macro-overlay-v10",
    "rion-studio-macro-overlay-v11",
    "rion-studio-macro-overlay-v12",
    "rion-studio-macro-overlay-v13",
    "rion-studio-macro-overlay-v14",
    "rion-studio-macro-overlay-v15",
    "rion-studio-macro-overlay-v16",
    "rion-studio-macro-overlay-v17",
    "rion-studio-macro-overlay-v18",
    "rion-studio-macro-overlay-v19",
    "rion-studio-macro-overlay-v20",
    "rion-studio-macro-overlay-v21",
    "rion-studio-macro-overlay-v22",
    "rion-studio-macro-overlay-v23",
    "rion-studio-macro-overlay-v24",
    "rion-studio-macro-overlay-v25"
  ];
  const controllerKey = "__rionStudioMacroOverlay";
  const scriptVersion = "2026-07-16.3";
  const bindingName = "rionStudioMacroOverlay";
  const shouldIgnoreShortcutEvent = ${MACRO_SHORTCUT_GUARD_SOURCE};
  const hostStyleEntries = [
    ["bottom", "auto"],
    ["color-scheme", "dark"],
    ["display", "grid"],
    ["font-family", "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"],
    ["justify-items", "end"],
    ["left", "auto"],
    ["max-width", "320px"],
    ["pointer-events", "none"],
    ["position", "fixed"],
    ["right", "8px"],
    ["top", "8px"],
    ["transform", "none"],
    ["-webkit-font-smoothing", "antialiased"],
    ["width", "max-content"],
    ["z-index", "2147483647"]
  ];
  const messageSource = "rionStudioMacroOverlay";
  const binding = window[bindingName];
  const overlayTexts = {
    en: {
      clickStep: "Click",
      addMacro: "Add macro",
      createError: "Unable to open Rion Studio.",
      delayStep: "Delay",
      disable: "Disable",
      empty: "No macros assigned to this role.",
      enable: "Enable",
      everyMs: "Every {ms} ms",
      edit: "Edit",
      editError: "Unable to open this macro in Rion Studio.",
      keyStep: "Key",
      loadError: "Unable to load macros.",
      shortcutConflict: "Multiple macros use this shortcut for the current role.",
      noShortcut: "No shortcut",
      noSteps: "No steps",
      once: "Once",
      partialStartNotice: "Started for {started} role(s); skipped {skipped} unavailable role(s).",
      resourceMacroOverride: "Temporarily full speed",
      resourcePrimary: "Primary",
      resourceSharedProcess: "Shared process / full speed",
      resourceUnavailable: "Throttling unavailable",
      runError: "Unable to run macro.",
      stepsMore: "+{count} more",
      triggerAria: "Rion Studio Macros",
      triggerTitle: "Rion Studio Macros (Ctrl+Shift+M)"
    },
    "zh-TW": {
      clickStep: "點擊",
      addMacro: "新增巨集",
      createError: "無法開啟 Rion Studio。",
      delayStep: "延遲",
      disable: "停用",
      empty: "此角色未指派巨集。",
      enable: "啟用",
      everyMs: "每 {ms} ms",
      edit: "編輯",
      editError: "無法在 Rion Studio 開啟此巨集。",
      keyStep: "按鍵",
      loadError: "無法載入巨集。",
      shortcutConflict: "目前角色有多個巨集使用這組快捷鍵。",
      noShortcut: "無快捷鍵",
      noSteps: "無步驟",
      once: "執行一次",
      partialStartNotice: "已在 {started} 個角色啟動，略過 {skipped} 個未啟動或無法控制的角色。",
      resourceMacroOverride: "暫時全速",
      resourcePrimary: "主控",
      resourceSharedProcess: "共用程序／全速",
      resourceUnavailable: "無法節流",
      runError: "無法執行巨集。",
      stepsMore: "另有 {count} 個",
      triggerAria: "Rion Studio 巨集",
      triggerTitle: "Rion Studio 巨集 (Ctrl+Shift+M)"
    },
    "zh-CN": {
      clickStep: "点击",
      addMacro: "新增宏",
      createError: "无法打开 Rion Studio。",
      delayStep: "延迟",
      disable: "停用",
      empty: "此角色未分配宏。",
      enable: "启用",
      everyMs: "每 {ms} ms",
      edit: "编辑",
      editError: "无法在 Rion Studio 中打开此宏。",
      keyStep: "按键",
      loadError: "无法加载宏。",
      shortcutConflict: "当前角色有多个宏使用这组快捷键。",
      noShortcut: "无快捷键",
      noSteps: "无步骤",
      once: "执行一次",
      partialStartNotice: "已在 {started} 个角色启动，略过 {skipped} 个未启动或无法控制的角色。",
      resourceMacroOverride: "暂时全速",
      resourcePrimary: "主控",
      resourceSharedProcess: "共享进程／全速",
      resourceUnavailable: "无法限速",
      runError: "无法执行宏。",
      stepsMore: "另有 {count} 个",
      triggerAria: "Rion Studio 宏",
      triggerTitle: "Rion Studio 宏 (Ctrl+Shift+M)"
    },
    ja: {
      clickStep: "クリック",
      addMacro: "マクロを追加",
      createError: "Rion Studio を開けません。",
      delayStep: "遅延",
      disable: "無効にする",
      empty: "このロールに割り当てられたマクロはありません。",
      enable: "有効にする",
      everyMs: "{ms} ms ごと",
      edit: "編集",
      editError: "このマクロを Rion Studio で開けません。",
      keyStep: "キー",
      loadError: "マクロを読み込めません。",
      shortcutConflict: "現在のロールで複数のマクロがこのショートカットを使用しています。",
      noShortcut: "ショートカットなし",
      noSteps: "ステップなし",
      once: "1回",
      partialStartNotice: "{started} 件のロールで開始し、利用できない {skipped} 件をスキップしました。",
      resourceMacroOverride: "一時的にフル速度",
      resourcePrimary: "メイン",
      resourceSharedProcess: "共有プロセス／フル速度",
      resourceUnavailable: "速度制限不可",
      runError: "マクロを実行できません。",
      stepsMore: "ほか {count} 件",
      triggerAria: "Rion Studio マクロ",
      triggerTitle: "Rion Studio マクロ (Ctrl+Shift+M)"
    }
  };
  const triggerIconMarkup = [
    '<svg class="trigger-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M10 8h.01"/>',
    '<path d="M12 12h.01"/>',
    '<path d="M14 8h.01"/>',
    '<path d="M16 12h.01"/>',
    '<path d="M18 8h.01"/>',
    '<path d="M6 8h.01"/>',
    '<path d="M7 16h10"/>',
    '<path d="M8 12h.01"/>',
    '<rect width="20" height="16" x="2" y="4" rx="2"/>',
    "</svg>"
  ].join("");
  const createIconMarkup = [
    '<svg class="create-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M12 5v14"/>',
    '<path d="M5 12h14"/>',
    "</svg>"
  ].join("");
  const editIconMarkup = [
    '<svg class="edit-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M12 20h9"/>',
    '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    "</svg>"
  ].join("");
  const peopleIconMarkup = [
    '<svg class="people-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>',
    '<circle cx="9" cy="7" r="4"/>',
    '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    "</svg>"
  ].join("");
  let host = null;
  let root = null;
  let isInstalled = false;
  let cleanupInterval = undefined;
  let noticeTimeout = undefined;
  let refreshInterval = undefined;
  let suppressedShortcutEvents = [];

  if (typeof binding !== "function") {
    return;
  }

  removeLegacyHosts();

  if (window[controllerKey]?.version === scriptVersion) {
    void window[controllerKey].refresh({ renderAfter: false });
    return;
  }

  window[controllerKey]?.dispose?.();
  removeVisualHosts();
  delete window[controllerKey];

  const state = {
    cpuThrottleRate: 1,
    error: "",
    isOpen: false,
    language: detectOverlayLanguage(),
    lastRefreshAt: 0,
    macros: [],
    notice: "",
    requestVersion: 0,
    resourceState: undefined,
    statuses: []
  };
  const pendingMacroActions = new Set();

  function getText() {
    return overlayTexts[state.language] ?? overlayTexts[detectOverlayLanguage()] ?? overlayTexts.en;
  }

  function getResourceLabel() {
    const text = getText();
    switch (state.resourceState) {
      case "primary": return text.resourcePrimary;
      case "throttled": return String(state.cpuThrottleRate || 1) + "x";
      case "macro_override": return text.resourceMacroOverride;
      case "shared_process": return text.resourceSharedProcess;
      case "unavailable": return text.resourceUnavailable;
      default: return "";
    }
  }

  function normalizeOverlayLanguage(language) {
    return language === "en" || language === "zh-TW" || language === "zh-CN" || language === "ja"
      ? language
      : undefined;
  }

  function disposeIfDetached(nextState) {
    if (nextState?.detached !== true) {
      return false;
    }

    dispose();
    return true;
  }

  function showStartNotice(summary) {
    if (noticeTimeout !== undefined) {
      clearTimeout(noticeTimeout);
      noticeTimeout = undefined;
    }

    const startedCount = Number(summary?.startedCount);
    const skippedCount = Number(summary?.skippedCount);
    if (!Number.isFinite(startedCount) || !Number.isFinite(skippedCount) || skippedCount <= 0) {
      state.notice = "";
      return;
    }

    state.notice = getText().partialStartNotice
      .replace("{started}", String(startedCount))
      .replace("{skipped}", String(skippedCount));
    noticeTimeout = setTimeout(() => {
      noticeTimeout = undefined;
      state.notice = "";
      render();
    }, 4000);
  }

  function isRunning(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "running");
  }

  function isStopping(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "stopping");
  }

  function isFailed(macroId) {
    return state.statuses.some(
      (status) => status.macroId === macroId && (status.state === "failed" || status.state === "cancelled")
    );
  }

  function getRunningBadgeMacros() {
    return state.macros.filter((macro) => macro.enabled !== false && isRunning(macro.id));
  }

  function getRunningBadgeSignature() {
    return JSON.stringify(getRunningBadgeMacros().map((macro) => [macro.id, macro.name, formatShortcut(macro.trigger)]));
  }

  function getRenderSignature() {
    return JSON.stringify([
      state.cpuThrottleRate,
      state.error,
      state.isOpen,
      state.language,
      state.macros,
      state.notice,
      state.resourceState,
      state.statuses
    ]);
  }

  function formatCode(code) {
    return String(code)
      .replace(/^Key/, "")
      .replace(/^Digit/, "")
      .replace(/^Numpad/, "Num ")
      .replace("Arrow", "")
      .replace("Escape", "Esc")
      .replace("Space", "Space");
  }

  function formatShortcut(trigger) {
    const text = getText();

    if (!trigger) {
      return text.noShortcut;
    }

    const parts = [];
    if (trigger.ctrl) parts.push("Ctrl");
    if (trigger.alt) parts.push("Alt");
    if (trigger.shift) parts.push("Shift");
    if (trigger.meta) parts.push("Meta");
    parts.push(formatCode(trigger.code));
    return parts.join("+");
  }

  function formatRepeat(repeat) {
    const text = getText();

    if (!repeat || repeat.type === "once") {
      return text.once;
    }

    return text.everyMs.replace("{ms}", String(repeat.intervalMs));
  }

  function formatStep(step) {
    const text = getText();

    if (!step || !step.type) {
      return "";
    }

    if (step.type === "key") {
      return text.keyStep + ":" + formatCode(step.code);
    }

    if (step.type === "click") {
      return text.clickStep + ":X " + step.xPercent + "%, Y " + step.yPercent + "%";
    }

    if (step.type === "delay") {
      return text.delayStep + ":" + step.ms + "ms";
    }

    return "";
  }

  function formatSteps(steps) {
    const text = getText();

    if (!Array.isArray(steps) || steps.length === 0) {
      return text.noSteps;
    }

    const visibleSteps = steps.slice(0, 3).map(formatStep).filter(Boolean);
    if (steps.length > visibleSteps.length) {
      visibleSteps.push(text.stepsMore.replace("{count}", String(steps.length - visibleSteps.length)));
    }

    return visibleSteps.join(" > ");
  }

  function isTraditionalChineseLocale(locale) {
    const normalized = String(locale).toLowerCase();

    return (
      normalized === "zh-hant" ||
      normalized.startsWith("zh-hant-") ||
      normalized === "zh-tw" ||
      normalized.startsWith("zh-tw-") ||
      normalized === "zh-hk" ||
      normalized.startsWith("zh-hk-") ||
      normalized === "zh-mo" ||
      normalized.startsWith("zh-mo-")
    );
  }

  function isSimplifiedChineseLocale(locale) {
    const normalized = String(locale).toLowerCase();

    return (
      normalized === "zh" ||
      normalized === "zh-hans" ||
      normalized.startsWith("zh-hans-") ||
      normalized === "zh-cn" ||
      normalized.startsWith("zh-cn-") ||
      normalized === "zh-sg" ||
      normalized.startsWith("zh-sg-")
    );
  }

  function isJapaneseLocale(locale) {
    const normalized = String(locale).toLowerCase();

    return normalized === "ja" || normalized.startsWith("ja-");
  }

  function detectOverlayLanguage() {
    const navigatorLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
    const documentLanguage = document.documentElement?.lang;
    const locales = [...navigatorLanguages, navigator.language, documentLanguage].filter(Boolean);

    if (locales.some(isJapaneseLocale)) {
      return "ja";
    }

    if (locales.some(isTraditionalChineseLocale)) {
      return "zh-TW";
    }

    if (locales.some(isSimplifiedChineseLocale)) {
      return "zh-CN";
    }

    return "en";
  }

  function matchesShortcut(event, trigger) {
    return Boolean(
      trigger &&
        event.code === trigger.code &&
        Boolean(event.ctrlKey) === Boolean(trigger.ctrl) &&
        Boolean(event.altKey) === Boolean(trigger.alt) &&
        Boolean(event.shiftKey) === Boolean(trigger.shift) &&
        Boolean(event.metaKey) === Boolean(trigger.meta)
    );
  }

  function matchesMenuToggle(event) {
    return event.code === "KeyM" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function shouldRenderUi() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  function isTopWindow() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  function isVisibleElement(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function focusElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const hadTabIndex = element.hasAttribute("tabindex");

    if (!hadTabIndex) {
      element.setAttribute("tabindex", "-1");
    }

    try {
      element.focus({ preventScroll: true });
    } catch {
      element.focus();
    }

    if (!hadTabIndex && element !== document.body) {
      setTimeout(() => {
        element.removeAttribute("tabindex");
      }, 0);
    }

    return document.activeElement === element;
  }

  function getLargestVisibleElement(selector) {
    return Array.from(document.querySelectorAll(selector))
      .filter(isVisibleElement)
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
      })[0];
  }

  function focusAutomationTarget() {
    const canvas = getLargestVisibleElement("canvas");
    if (canvas && focusElement(canvas)) {
      return true;
    }

    const iframe = getLargestVisibleElement("iframe");
    if (iframe && focusElement(iframe)) {
      return true;
    }

    return focusElement(document.body);
  }

  function postTopMessage(type) {
    if (isTopWindow()) {
      return;
    }

    window.top?.postMessage({ source: messageSource, type }, "*");
  }

  function removeHost(id) {
    document.getElementById(id)?.remove();

    if (host?.id === id) {
      host = null;
      root = null;
    }
  }

  function removeLegacyHosts() {
    legacyHostIds.forEach(removeHost);
  }

  function removeVisualHosts() {
    removeLegacyHosts();
    removeHost(hostId);
  }

  function applyHostStyle() {
    if (host) {
      host.removeAttribute("style");
      hostStyleEntries.forEach(([property, value]) => {
        host.style.setProperty(property, value, "important");
      });
    }
  }

  function ensureHost() {
    removeLegacyHosts();

    if (!shouldRenderUi() || !document.body) {
      removeHost(hostId);
      return null;
    }

    if (host && host.isConnected && root) {
      return root;
    }

    const existingHost = document.getElementById(hostId);
    if (existingHost?.shadowRoot) {
      host = existingHost;
      root = existingHost.shadowRoot;
      applyHostStyle();
      return root;
    }

    host = document.createElement("div");
    host.id = hostId;
    root = host.attachShadow({ mode: "open" });
    applyHostStyle();
    document.body.appendChild(host);
    return root;
  }

  function render() {
    const targetRoot = ensureHost();

    if (!targetRoot) {
      return;
    }

    const text = getText();
    const resourceLabel = getResourceLabel();
    const runningBadges = getRunningBadgeMacros()
      .map((macro) => {
        const shortcut = formatShortcut(macro.trigger);

        return [
          '<span class="active-badge" aria-hidden="true">',
          '<span class="active-badge-name">',
          escapeHtml(macro.name),
          '</span><span class="active-badge-shortcut">',
          escapeHtml(shortcut),
          "</span>",
          "</span>"
        ].join("");
      })
      .join("");
    const macroRows = state.macros
      .map((macro) => {
        const enabled = macro.enabled !== false;
        const running = isRunning(macro.id);
        const stopping = isStopping(macro.id);
        const failed = isFailed(macro.id);
        const shortcut = formatShortcut(macro.trigger);
        const steps = formatSteps(macro.steps);
        const poll = formatRepeat(macro.repeat);
        const editLabel = text.edit + " " + macro.name;
        const toggleLabel = (enabled ? text.disable : text.enable) + " " + macro.name;
        const roleNames = Array.isArray(macro.roleNames) ? macro.roleNames : [];
        const roleTooltip = roleNames.join(", ");
        const roleCount = Array.isArray(macro.roleIds) ? macro.roleIds.length : roleNames.length;
        const multiRoleBadge = roleCount > 1
          ? '<span class="macro-role-count" data-tooltip="' + escapeHtml(roleTooltip) + '" aria-label="' + escapeHtml(roleTooltip) + '">' + peopleIconMarkup + '<span>' + roleCount + "</span></span>"
          : "";

        return [
          '<div class="macro-row" role="menuitem" data-macro-id="',
          escapeHtml(macro.id),
          '" data-enabled="',
          enabled ? "true" : "false",
          '" aria-disabled="',
          enabled ? "false" : "true",
          '"><span class="macro-title"><span class="status-dot ',
          !enabled ? "disabled" : failed ? "failed" : running || stopping ? "running" : "idle",
          '"></span><strong>',
          escapeHtml(macro.name),
          "</strong>",
          multiRoleBadge,
          '</span><span class="macro-details"><span class="macro-detail-steps"><b>',
          escapeHtml(steps),
          '</b></span><span class="macro-detail-shortcut"><b>',
          escapeHtml(shortcut),
          '</b></span><span class="macro-detail-poll"><b>',
          escapeHtml(poll),
          '</b></span></span><button class="macro-enabled-switch" type="button" role="switch" tabindex="-1" data-macro-id="',
          escapeHtml(macro.id),
          '" data-enabled="',
          enabled ? "true" : "false",
          '" aria-checked="',
          enabled ? "true" : "false",
          '" title="',
          escapeHtml(toggleLabel),
          '" aria-label="',
          escapeHtml(toggleLabel),
          '"><span></span></button><button class="macro-edit" type="button" tabindex="-1" data-macro-id="',
          escapeHtml(macro.id),
          '" title="',
          escapeHtml(editLabel),
          '" aria-label="',
          escapeHtml(editLabel),
          '"',
          running || stopping ? ' disabled aria-disabled="true"' : "",
          '>',
          editIconMarkup,
          "</button></div>"
        ].join("");
      })
      .join("");

    targetRoot.innerHTML = [
      "<style>",
      "*{box-sizing:border-box;font-family:inherit;-webkit-font-smoothing:antialiased;}",
      ".trigger{-webkit-backdrop-filter:blur(30px) saturate(140%);align-items:center;backdrop-filter:blur(30px) saturate(140%);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,0) 46%),rgba(20,23,31,.5);border:1px solid rgba(255,255,255,.14);border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.2);color:rgba(255,255,255,.94);cursor:pointer;display:flex;height:32px;justify-content:center;line-height:1;padding:0;pointer-events:auto;width:32px;}",
      ".trigger-icon{display:block;fill:none;height:16px;width:16px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.75;}",
      ".trigger:hover{background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,0) 46%),rgba(30,34,44,.82);border-color:rgba(255,255,255,.2);}",
      ".toolbar{align-items:center;display:flex;gap:6px;justify-content:flex-end;pointer-events:none;}",
      ".resource-state{-webkit-backdrop-filter:blur(30px) saturate(140%);backdrop-filter:blur(30px) saturate(140%);background:rgba(20,23,31,.7);border:1px solid rgba(255,255,255,.14);border-radius:999px;color:rgba(255,255,255,.92);font-size:9.5px;font-weight:650;line-height:1;max-width:170px;overflow:hidden;padding:6px 8px;pointer-events:none;text-overflow:ellipsis;white-space:nowrap;}",
      ".panel{display:",
      state.isOpen ? "grid" : "none",
      ";-webkit-backdrop-filter:blur(30px) saturate(140%);backdrop-filter:blur(30px) saturate(140%);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,0) 46%),rgba(20,23,31,.74);border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 14px 34px rgba(0,0,0,.22);gap:0;margin-top:7px;max-width:296px;overflow:visible;padding:4px;pointer-events:auto;text-shadow:none;width:min(288px,calc(100vw - 16px));}",
      ".macro-row,.create-row,.empty,.error{background:transparent;border:0;box-shadow:none;}",
      ".notice{-webkit-backdrop-filter:blur(30px) saturate(140%);backdrop-filter:blur(30px) saturate(140%);background:rgba(20,23,31,.82);border:1px solid rgba(125,255,114,.24);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.2);color:rgba(255,255,255,.92);font-size:11px;font-weight:550;line-height:1.35;margin-top:7px;max-width:288px;padding:8px 10px;pointer-events:none;width:max-content;}",
      ".panel>*+*{margin-top:6px;position:relative;}",
      ".panel>*+*::before{background:rgba(255,255,255,.085);content:'';height:1px;left:7px;pointer-events:none;position:absolute;right:7px;top:-3px;}",
      ".create-row{align-items:center;border-radius:8px;color:rgba(255,255,255,.9);cursor:pointer;display:flex;font-size:11.5px;font-weight:600;gap:7px;height:30px;justify-content:flex-start;line-height:1;padding:0 9px;text-align:left;width:100%;}",
      ".create-row:hover{background:rgba(255,255,255,.065);}",
      ".create-icon{color:rgba(255,255,255,.72);display:block;fill:none;flex:0 0 auto;height:14px;stroke:currentColor;stroke-linecap:round;stroke-width:2;width:14px;}",
      ".macro-row{align-items:center;border-radius:10px;color:rgba(255,255,255,.94);display:grid;gap:6px 7px;grid-template-areas:'title title toggle edit' 'steps shortcut poll poll';grid-template-columns:minmax(60px,1fr) auto 32px 24px;min-height:56px;padding:8px 9px;text-align:left;width:100%;}",
      ".macro-row[data-enabled='true']{cursor:pointer;}",
      ".macro-row[data-enabled='true']:hover{background:rgba(255,255,255,.065);}",
      ".macro-row[data-enabled='false']{cursor:not-allowed;}",
      ".status-dot{border-radius:999px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);display:block;height:7px;width:7px;}",
      ".status-dot.running{background:#7dff72;color:rgba(125,255,114,.42);}",
      ".status-dot.failed{background:#ffbd5c;color:rgba(255,189,92,.42);}",
      ".status-dot.idle{background:#ff5f57;color:rgba(255,95,87,.36);}",
      ".status-dot.disabled{background:#7d828c;color:rgba(125,130,140,.36);}",
      ".macro-title{align-items:center;display:flex;gap:7px;grid-area:title;min-width:0;}",
      ".macro-title strong{font-size:12px;font-weight:650;line-height:1.2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".macro-role-count{align-items:center;background:rgba(255,255,255,.075);border:1px solid rgba(255,255,255,.11);border-radius:999px;color:rgba(255,255,255,.76);display:inline-flex;flex:0 0 auto;font-size:9px;font-weight:650;gap:3px;height:18px;padding:0 5px;position:relative;}",
      ".macro-role-count:hover::after{background:rgba(12,14,20,.96);border:1px solid rgba(255,255,255,.16);border-radius:7px;box-shadow:0 8px 24px rgba(0,0,0,.3);color:rgba(255,255,255,.94);content:attr(data-tooltip);font-size:10px;font-weight:550;left:0;line-height:1.35;max-width:230px;min-width:max-content;padding:6px 8px;position:absolute;top:calc(100% + 5px);white-space:normal;width:max-content;z-index:3;}",
      ".people-icon{display:block;fill:none;height:11px;width:11px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.8;}",
      ".macro-details{display:contents;}",
      ".macro-details span{color:rgba(255,255,255,.78);font-size:9.5px;font-weight:500;line-height:1.1;min-width:0;}",
      ".macro-details b{font-weight:550;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".macro-detail-shortcut,.macro-detail-poll{align-items:center;background:rgba(255,255,255,.075);border:1px solid rgba(255,255,255,.11);border-radius:999px;color:rgba(255,255,255,.9);display:flex;font-size:9.5px;font-weight:600;line-height:1;min-height:22px;padding:4px 7px;}",
      ".macro-detail-shortcut{grid-area:shortcut;}",
      ".macro-detail-poll{grid-area:poll;}",
      ".macro-detail-shortcut b{max-width:56px;}",
      ".macro-detail-poll b{max-width:76px;}",
      ".macro-detail-steps{display:block;grid-area:steps;padding:0 1px 1px;}",
      ".macro-detail-steps b{color:rgba(255,255,255,.7);display:block;font-size:9.5px;line-height:1.35;}",
      ".macro-edit{align-items:center;background:rgba(255,255,255,.075);border:1px solid rgba(255,255,255,.11);border-radius:999px;color:rgba(255,255,255,.88);cursor:pointer;display:flex;grid-area:edit;height:24px;justify-content:center;padding:0;width:24px;}",
      ".macro-edit:hover{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.18);}",
      ".macro-edit:disabled{cursor:not-allowed;opacity:.42;}",
      ".edit-icon{display:block;fill:none;height:12px;width:12px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2;}",
      ".macro-enabled-switch{align-items:center;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.15);border-radius:999px;cursor:pointer;display:flex;grid-area:toggle;height:18px;padding:2px;width:32px;}",
      ".macro-enabled-switch[aria-checked='true']{background:oklch(62.3% .214 259.815);border-color:color-mix(in srgb,oklch(62.3% .214 259.815) 70%,transparent);}",
      ".macro-enabled-switch span{background:#fff;border-radius:999px;box-shadow:0 1px 3px rgba(0,0,0,.28);display:block;height:12px;transform:translateX(0);transition:transform .14s ease;width:12px;}",
      ".macro-enabled-switch[aria-checked='true'] span{transform:translateX(14px);}",
      ".active-badges{align-items:center;display:flex;flex-wrap:nowrap;gap:5px;justify-content:center;left:50%;max-width:min(76vw,620px);pointer-events:none;position:fixed;top:20%;transform:translateX(-50%);z-index:2147483647;}",
      ".active-badge{-webkit-backdrop-filter:blur(30px) saturate(140%);-webkit-font-smoothing:antialiased;align-items:center;backdrop-filter:blur(30px) saturate(140%);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,0) 46%),rgba(20,23,31,.5);border:1px solid rgba(255,255,255,.14);border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.2);color:rgba(255,255,255,.92);display:flex;font-size:10px;gap:5px;letter-spacing:0;line-height:1.15;max-width:156px;min-height:20px;padding:4px 8px;pointer-events:none;white-space:nowrap;}",
      ".active-badge-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".active-badge-shortcut{color:#fff;display:block;flex:0 0 auto;font-size:9.5px;font-weight:600;}",
      ".empty,.error{border-radius:10px;color:rgba(255,255,255,.7);font-size:11px;font-weight:500;line-height:1.35;padding:10px;}",
      ".error{color:#ffb4b4;}",
      "</style>",
      runningBadges ? '<div class="active-badges" aria-hidden="true">' + runningBadges + "</div>" : "",
      '<div class="toolbar">',
      resourceLabel ? '<div class="resource-state" title="' + escapeHtml(resourceLabel) + '">' + escapeHtml(resourceLabel) + "</div>" : "",
      '<button class="trigger" type="button" tabindex="-1" title="' + escapeHtml(text.triggerTitle) + '" aria-label="' + escapeHtml(text.triggerAria) + '">',
      triggerIconMarkup,
      "</button>",
      "</div>",
      state.notice ? '<div class="notice" role="status">' + escapeHtml(state.notice) + "</div>" : "",
      '<div class="panel" role="menu">',
      state.error ? '<div class="error">' + escapeHtml(state.error) + "</div>" : "",
      state.macros.length > 0 ? macroRows : '<div class="empty">' + escapeHtml(text.empty) + "</div>",
      '<button class="create-row" type="button" tabindex="-1" data-action="create" title="' + escapeHtml(text.addMacro) + '" aria-label="' + escapeHtml(text.addMacro) + '">' + createIconMarkup + '<span>' + escapeHtml(text.addMacro) + "</span></button>",
      "</div>"
    ].join("");

    targetRoot.querySelectorAll("button,.macro-row").forEach((control) => {
      control.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });

    targetRoot.querySelector(".trigger")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      togglePanel();
    });

    targetRoot.querySelector(".create-row")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void requestCreateMacro();
    });

    targetRoot.querySelectorAll(".macro-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const eventPath = event.composedPath?.() ?? [];
        if (eventPath.some((candidate) => candidate?.tagName === "BUTTON")) {
          return;
        }
        const macroId = row.getAttribute("data-macro-id");
        const macro = state.macros.find((item) => item.id === macroId);
        if (!macroId || !macro || macro.enabled === false) {
          return;
        }
        void runAction(isRunning(macroId) || isStopping(macroId) ? "stop" : "start", macroId, {
          closeAfter: true
        });
      });
    });

    targetRoot.querySelectorAll(".macro-edit").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) {
          return;
        }
        const macroId = button.getAttribute("data-macro-id");
        if (macroId) {
          void requestEditMacro(macroId);
        }
      });
    });

    targetRoot.querySelectorAll(".macro-enabled-switch").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const macroId = button.getAttribute("data-macro-id");
        if (macroId) {
          void runAction("set-enabled", macroId, {
            enabled: button.getAttribute("data-enabled") !== "true"
          });
        }
      });
    });
  }

  async function requestCreateMacro() {
    try {
      const nextState = await binding({ type: "create" });
      if (disposeIfDetached(nextState)) {
        return;
      }
      state.error = "";
      closePanel({ focus: false });
    } catch (error) {
      state.error = error instanceof Error ? error.message : getText().createError;
      render();
    }
  }

  async function requestEditMacro(macroId) {
    try {
      const nextState = await binding({ type: "edit", macroId });
      if (disposeIfDetached(nextState)) {
        return;
      }
      state.error = "";
      closePanel({ focus: false });
    } catch (error) {
      state.error = error instanceof Error ? error.message : getText().editError;
      render();
    }
  }

  async function refresh(options = {}) {
    if (pendingMacroActions.size > 0) {
      return;
    }
    const renderAfter = options.renderAfter !== false;
    const previousRenderSignature = getRenderSignature();
    const previousRunningBadgeSignature = getRunningBadgeSignature();
    const requestVersion = ++state.requestVersion;

    try {
      const nextState = await binding({ type: "list" });
      if (requestVersion !== state.requestVersion) {
        return;
      }
      if (disposeIfDetached(nextState)) {
        return;
      }
      state.error = "";
      state.language = normalizeOverlayLanguage(nextState?.language) ?? state.language;
      state.macros = Array.isArray(nextState?.macros) ? nextState.macros : [];
      state.resourceState = nextState?.resourceState;
      state.cpuThrottleRate = nextState?.cpuThrottleRate || 1;
      state.statuses = Array.isArray(nextState?.statuses) ? nextState.statuses : [];
      state.lastRefreshAt = Date.now();
    } catch (error) {
      if (requestVersion !== state.requestVersion) {
        return;
      }
      state.error = error instanceof Error ? error.message : getText().loadError;
    }

    const renderSignatureChanged = previousRenderSignature !== getRenderSignature();
    const runningBadgeSignatureChanged = previousRunningBadgeSignature !== getRunningBadgeSignature();
    const hostNeedsRender = !host || !host.isConnected || !root;
    if (hostNeedsRender || runningBadgeSignatureChanged || (renderAfter && renderSignatureChanged)) {
      render();
    }
  }

  async function runAction(action, macroId, options = {}) {
    if (pendingMacroActions.has(macroId)) {
      return;
    }
    const closeAfter = options.closeAfter === true;
    const requestVersion = ++state.requestVersion;
    pendingMacroActions.add(macroId);

    try {
      const nextState = await binding(
        action === "set-enabled"
          ? { type: action, macroId, enabled: options.enabled === true }
          : { type: action, macroId }
      );
      if (disposeIfDetached(nextState)) {
        return;
      }
      if (requestVersion === state.requestVersion) {
        state.error = "";
        state.language = normalizeOverlayLanguage(nextState?.language) ?? state.language;
        state.macros = Array.isArray(nextState?.macros) ? nextState.macros : state.macros;
        state.resourceState = nextState?.resourceState;
        state.cpuThrottleRate = nextState?.cpuThrottleRate || 1;
        state.statuses = Array.isArray(nextState?.statuses) ? nextState.statuses : state.statuses;
        state.lastRefreshAt = Date.now();
        if (action === "start") {
          showStartNotice(nextState?.startSummary);
        }
      }
    } catch (error) {
      if (requestVersion === state.requestVersion) {
        state.error = error instanceof Error ? error.message : getText().runError;
      }
    } finally {
      pendingMacroActions.delete(macroId);
    }

    if (closeAfter) {
      closePanel({ focus: true });
    } else {
      render();
    }
    if (pendingMacroActions.size === 0) {
      void refresh({ renderAfter: !closeAfter });
    }
  }

  function consumeShortcutEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function suppressNextShortcut(code) {
    const now = Date.now();
    suppressedShortcutEvents = suppressedShortcutEvents.filter((item) => item.expiresAt > now);
    suppressedShortcutEvents.push({ code: String(code), expiresAt: now + 1000 });
  }

  function clearSuppressedShortcut(code) {
    suppressedShortcutEvents = suppressedShortcutEvents.filter((item) => item.code !== code);
  }

  function consumeSuppressedShortcut(code) {
    const now = Date.now();
    suppressedShortcutEvents = suppressedShortcutEvents.filter((item) => item.expiresAt > now);
    const index = suppressedShortcutEvents.findIndex((item) => item.code === code);
    if (index === -1) {
      return false;
    }

    suppressedShortcutEvents.splice(index, 1);
    return true;
  }

  function togglePanel(forceOpen) {
    const wasOpen = state.isOpen;
    state.isOpen = typeof forceOpen === "boolean" ? forceOpen : !state.isOpen;
    if (state.isOpen) {
      void refresh();
    }
    render();

    if (wasOpen && !state.isOpen) {
      focusAutomationTarget();
    }
  }

  function closePanel(options = {}) {
    const shouldFocus = options.focus !== false;
    const wasOpen = state.isOpen;

    if (!wasOpen) {
      return;
    }

    state.isOpen = false;
    render();

    if (shouldFocus) {
      focusAutomationTarget();
    }
  }

  function refreshIfStale() {
    if (Date.now() - state.lastRefreshAt > 1200) {
      void refresh({ renderAfter: false });
    }
  }

  function handleKeyDown(event) {
    if (consumeSuppressedShortcut(event.code)) {
      return;
    }

    if (shouldIgnoreShortcutEvent(event, document.activeElement, document.designMode)) {
      return;
    }

    if (event.repeat) {
      if (matchesMenuToggle(event) || state.macros.some((item) => item.enabled !== false && matchesShortcut(event, item.trigger))) {
        consumeShortcutEvent(event);
      }
      return;
    }

    refreshIfStale();

    if (matchesMenuToggle(event)) {
      consumeShortcutEvent(event);
      togglePanel();
      return;
    }

    const matchingMacros = state.macros.filter(
      (item) => item.enabled !== false && matchesShortcut(event, item.trigger)
    );
    if (matchingMacros.length === 0) {
      return;
    }

    consumeShortcutEvent(event);
    if (matchingMacros.length > 1) {
      state.error = getText().shortcutConflict;
      render();
      return;
    }

    const macro = matchingMacros[0];
    void runAction(isRunning(macro.id) || isStopping(macro.id) ? "stop" : "start", macro.id);
  }

  function handleEscapeKeyDown(event) {
    if (event.key === "Escape" && state.isOpen) {
      closePanel({ focus: true });
    }
  }

  function handleFocus() {
    void refresh({ renderAfter: state.isOpen });
  }

  function handleResize() {
    render();
  }

  function handleDocumentPointerDown(event) {
    const path = event.composedPath?.() ?? [];

    if (host && path.includes(host)) {
      return;
    }

    if (isTopWindow()) {
      closePanel({ focus: false });
      return;
    }

    postTopMessage("closePanel");
  }

  function handleMessage(event) {
    const data = event.data;

    if (!data || data.source !== messageSource) {
      return;
    }

    if (data.type === "closePanel") {
      closePanel({ focus: false });
    }
  }

  function dispose() {
    document.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("keydown", handleEscapeKeyDown, true);
    document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
    document.removeEventListener("fullscreenchange", handleResize, true);
    window.removeEventListener("message", handleMessage);
    window.removeEventListener("focus", handleFocus, true);
    window.removeEventListener("resize", handleResize);

    if (cleanupInterval !== undefined) {
      clearInterval(cleanupInterval);
      cleanupInterval = undefined;
    }

    if (refreshInterval !== undefined) {
      clearInterval(refreshInterval);
      refreshInterval = undefined;
    }

    if (noticeTimeout !== undefined) {
      clearTimeout(noticeTimeout);
      noticeTimeout = undefined;
    }

    removeHost(hostId);

    if (window[controllerKey]?.version === scriptVersion) {
      delete window[controllerKey];
    }
  }

  function install() {
    if (isInstalled) {
      void refresh({ renderAfter: false });
      return;
    }

    document.addEventListener(
      "keydown",
      handleKeyDown,
      true
    );

    document.addEventListener(
      "keydown",
      handleEscapeKeyDown,
      true
    );

    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    window.addEventListener("focus", handleFocus, true);
    window.addEventListener("message", handleMessage);
    window.addEventListener("resize", handleResize, { passive: true });
    document.addEventListener("fullscreenchange", handleResize, true);

    refreshInterval = setInterval(() => {
      void refresh({ renderAfter: state.isOpen });
    }, 1500);

    cleanupInterval = setInterval(() => {
      removeLegacyHosts();

      if (!shouldRenderUi()) {
        removeHost(hostId);
      }
    }, 300);

    window[controllerKey] = {
      clearSuppressedShortcut,
      closePanel,
      dispose,
      focusAutomationTarget,
      refresh,
      suppressNextShortcut,
      version: scriptVersion,
      togglePanel
    };

    isInstalled = true;
    render();
    void refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      render();
      void refresh();
    }, { once: true });
  }

  install();
})();
`;
