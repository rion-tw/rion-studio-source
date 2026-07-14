import type { WebContents } from "electron";

import type { AppLanguage, Macro, MacroEditorRequest, MacroRunStatus, Role } from "../../shared/types";
import type { MacroManager } from "./MacroManager";
import type { MacroStore } from "./MacroStore";

interface MacroOverlayState {
  language?: AppLanguage;
  macros: Macro[];
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
    };

export class MacroOverlayInjector {
  private readonly externalHosts = new Set<ExternalMacroOverlayHost>();
  private readonly externalHostRoleIds = new WeakMap<ExternalMacroOverlayHost, string>();
  private readonly installedContents = new Set<WebContents>();
  private readonly initializedContents = new WeakSet<WebContents>();
  private readonly contentRoleIds = new WeakMap<WebContents, string>();
  private language: AppLanguage | undefined;

  constructor(
    private readonly macroStore: Pick<MacroStore, "listMacros">,
    private readonly macroManager: Pick<MacroManager, "listStatuses" | "startForRole" | "stopForRole">,
    private readonly onMacroEditorRequested?: (request: MacroEditorRequest) => void | Promise<void>
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

  async handleRequest(roleId: string, request: MacroOverlayRequest): Promise<MacroOverlayState> {
    switch (request.type) {
      case "list":
        break;
      case "create":
        await this.onMacroEditorRequested?.({ roleId });
        break;
      case "edit":
        await this.assertMacroAssignedToRole(roleId, request.macroId);
        await this.onMacroEditorRequested?.({ macroId: request.macroId, roleId });
        break;
      case "start":
        await this.macroManager.startForRole(request.macroId, roleId);
        break;
      case "stop":
        await this.macroManager.stopForRole(request.macroId, roleId);
        break;
    }

    return this.getOverlayState(roleId);
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
    const [macros, statuses] = await Promise.all([
      this.macroStore.listMacros(),
      Promise.resolve(this.macroManager.listStatuses())
    ]);

    const assignedMacros = macros.filter((macro) => macro.roleIds.includes(roleId));
    const assignedMacroIds = new Set(assignedMacros.map((macro) => macro.id));

    return {
      language: this.language,
      macros: assignedMacros,
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
  const request = value as { type?: unknown; macroId?: unknown };
  if (request.type === "list" || request.type === "create") {
    return true;
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
  const scriptVersion = "2026-07-14.12";
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
      empty: "No macros assigned to this role.",
      everyMs: "Every {ms} ms",
      edit: "Edit",
      editError: "Unable to open this macro in Rion Studio.",
      keyStep: "Key",
      loadError: "Unable to load macros.",
      shortcutConflict: "Multiple macros use this shortcut for the current role.",
      noShortcut: "No shortcut",
      noSteps: "No steps",
      once: "Once",
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
      empty: "此角色未指派巨集。",
      everyMs: "每 {ms} ms",
      edit: "編輯",
      editError: "無法在 Rion Studio 開啟此巨集。",
      keyStep: "按鍵",
      loadError: "無法載入巨集。",
      shortcutConflict: "目前角色有多個巨集使用這組快捷鍵。",
      noShortcut: "無快捷鍵",
      noSteps: "無步驟",
      once: "執行一次",
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
      empty: "此角色未分配宏。",
      everyMs: "每 {ms} ms",
      edit: "编辑",
      editError: "无法在 Rion Studio 中打开此宏。",
      keyStep: "按键",
      loadError: "无法加载宏。",
      shortcutConflict: "当前角色有多个宏使用这组快捷键。",
      noShortcut: "无快捷键",
      noSteps: "无步骤",
      once: "执行一次",
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
      empty: "このロールに割り当てられたマクロはありません。",
      everyMs: "{ms} ms ごと",
      edit: "編集",
      editError: "このマクロを Rion Studio で開けません。",
      keyStep: "キー",
      loadError: "マクロを読み込めません。",
      shortcutConflict: "現在のロールで複数のマクロがこのショートカットを使用しています。",
      noShortcut: "ショートカットなし",
      noSteps: "ステップなし",
      once: "1回",
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
  let host = null;
  let root = null;
  let isInstalled = false;
  let cleanupInterval = undefined;
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
    error: "",
    isOpen: false,
    language: detectOverlayLanguage(),
    lastRefreshAt: 0,
    macros: [],
    statuses: []
  };

  function getText() {
    return overlayTexts[state.language] ?? overlayTexts[detectOverlayLanguage()] ?? overlayTexts.en;
  }

  function normalizeOverlayLanguage(language) {
    return language === "en" || language === "zh-TW" || language === "zh-CN" || language === "ja"
      ? language
      : undefined;
  }

  function isRunning(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "running");
  }

  function isStopping(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "stopping");
  }

  function isFailed(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "failed");
  }

  function getRunningBadgeMacros() {
    return state.macros.filter((macro) => isRunning(macro.id));
  }

  function getRunningBadgeSignature() {
    return JSON.stringify(getRunningBadgeMacros().map((macro) => [macro.id, macro.name, formatShortcut(macro.trigger)]));
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
        const running = isRunning(macro.id);
        const stopping = isStopping(macro.id);
        const failed = isFailed(macro.id);
        const shortcut = formatShortcut(macro.trigger);
        const steps = formatSteps(macro.steps);
        const poll = formatRepeat(macro.repeat);
        const editLabel = text.edit + " " + macro.name;

        return [
          '<div class="macro-row" role="menuitem"><span class="macro-title"><span class="status-dot ',
          failed ? "failed" : running || stopping ? "running" : "idle",
          '"></span><strong>',
          escapeHtml(macro.name),
          '</strong></span><span class="macro-details"><span class="macro-detail-steps"><b>',
          escapeHtml(steps),
          '</b></span><span class="macro-detail-shortcut"><b>',
          escapeHtml(shortcut),
          '</b></span><span class="macro-detail-poll"><b>',
          escapeHtml(poll),
          '</b></span></span><button class="macro-edit" type="button" tabindex="-1" data-macro-id="',
          escapeHtml(macro.id),
          '" title="',
          escapeHtml(editLabel),
          '" aria-label="',
          escapeHtml(editLabel),
          '">',
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
      ".panel{display:",
      state.isOpen ? "grid" : "none",
      ";-webkit-backdrop-filter:blur(30px) saturate(140%);backdrop-filter:blur(30px) saturate(140%);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,0) 46%),rgba(20,23,31,.74);border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 14px 34px rgba(0,0,0,.22);gap:0;margin-top:7px;max-width:296px;overflow:hidden;padding:4px;pointer-events:auto;text-shadow:none;width:min(288px,calc(100vw - 16px));}",
      ".macro-row,.create-row,.empty,.error{background:transparent;border:0;box-shadow:none;}",
      ".panel>*+*{margin-top:6px;position:relative;}",
      ".panel>*+*::before{background:rgba(255,255,255,.085);content:'';height:1px;left:7px;pointer-events:none;position:absolute;right:7px;top:-3px;}",
      ".create-row{align-items:center;border-radius:8px;color:rgba(255,255,255,.9);cursor:pointer;display:flex;font-size:11.5px;font-weight:600;gap:7px;height:30px;justify-content:flex-start;line-height:1;padding:0 9px;text-align:left;width:100%;}",
      ".create-row:hover{background:rgba(255,255,255,.065);}",
      ".create-icon{color:rgba(255,255,255,.72);display:block;fill:none;flex:0 0 auto;height:14px;stroke:currentColor;stroke-linecap:round;stroke-width:2;width:14px;}",
      ".macro-row{align-items:center;border-radius:10px;color:rgba(255,255,255,.94);display:grid;gap:6px 7px;grid-template-areas:'title shortcut poll edit' 'steps steps steps steps';grid-template-columns:minmax(60px,1fr) auto auto 24px;min-height:56px;padding:8px 9px;text-align:left;width:100%;}",
      ".macro-row:hover{background:rgba(255,255,255,.065);}",
      ".status-dot{border-radius:999px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.18);display:block;height:7px;width:7px;}",
      ".status-dot.running{background:#7dff72;color:rgba(125,255,114,.42);}",
      ".status-dot.failed{background:#ffbd5c;color:rgba(255,189,92,.42);}",
      ".status-dot.idle{background:#ff5f57;color:rgba(255,95,87,.36);}",
      ".macro-title{align-items:center;display:flex;gap:7px;grid-area:title;min-width:0;}",
      ".macro-title strong{font-size:12px;font-weight:650;line-height:1.2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
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
      ".edit-icon{display:block;fill:none;height:12px;width:12px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2;}",
      ".active-badges{align-items:center;display:flex;flex-wrap:nowrap;gap:5px;justify-content:center;left:50%;max-width:min(76vw,620px);pointer-events:none;position:fixed;top:20%;transform:translateX(-50%);z-index:2147483647;}",
      ".active-badge{-webkit-backdrop-filter:blur(30px) saturate(140%);-webkit-font-smoothing:antialiased;align-items:center;backdrop-filter:blur(30px) saturate(140%);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,0) 46%),rgba(20,23,31,.5);border:1px solid rgba(255,255,255,.14);border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.2);color:rgba(255,255,255,.92);display:flex;font-size:10px;gap:5px;letter-spacing:0;line-height:1.15;max-width:156px;min-height:20px;padding:4px 8px;pointer-events:none;white-space:nowrap;}",
      ".active-badge-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".active-badge-shortcut{color:#fff;display:block;flex:0 0 auto;font-size:9.5px;font-weight:600;}",
      ".empty,.error{border-radius:10px;color:rgba(255,255,255,.7);font-size:11px;font-weight:500;line-height:1.35;padding:10px;}",
      ".error{color:#ffb4b4;}",
      "</style>",
      runningBadges ? '<div class="active-badges" aria-hidden="true">' + runningBadges + "</div>" : "",
      '<button class="trigger" type="button" tabindex="-1" title="' + escapeHtml(text.triggerTitle) + '" aria-label="' + escapeHtml(text.triggerAria) + '">',
      triggerIconMarkup,
      "</button>",
      '<div class="panel" role="menu">',
      state.error ? '<div class="error">' + escapeHtml(state.error) + "</div>" : "",
      state.macros.length > 0 ? macroRows : '<div class="empty">' + escapeHtml(text.empty) + "</div>",
      '<button class="create-row" type="button" tabindex="-1" data-action="create" title="' + escapeHtml(text.addMacro) + '" aria-label="' + escapeHtml(text.addMacro) + '">' + createIconMarkup + '<span>' + escapeHtml(text.addMacro) + "</span></button>",
      "</div>"
    ].join("");

    targetRoot.querySelectorAll("button").forEach((button) => {
      button.addEventListener("pointerdown", (event) => {
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

    targetRoot.querySelectorAll(".macro-edit").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const macroId = button.getAttribute("data-macro-id");
        if (macroId) {
          void requestEditMacro(macroId);
        }
      });
    });
  }

  async function requestCreateMacro() {
    try {
      await binding({ type: "create" });
      state.error = "";
      closePanel({ focus: false });
    } catch (error) {
      state.error = error instanceof Error ? error.message : getText().createError;
      render();
    }
  }

  async function requestEditMacro(macroId) {
    try {
      await binding({ type: "edit", macroId });
      state.error = "";
      closePanel({ focus: false });
    } catch (error) {
      state.error = error instanceof Error ? error.message : getText().editError;
      render();
    }
  }

  async function refresh(options = {}) {
    const renderAfter = options.renderAfter !== false;
    const previousRunningBadgeSignature = getRunningBadgeSignature();

    try {
      const nextState = await binding({ type: "list" });
      state.error = "";
      state.language = normalizeOverlayLanguage(nextState?.language) ?? state.language;
      state.macros = Array.isArray(nextState?.macros) ? nextState.macros : [];
      state.statuses = Array.isArray(nextState?.statuses) ? nextState.statuses : [];
      state.lastRefreshAt = Date.now();
    } catch (error) {
      state.error = error instanceof Error ? error.message : getText().loadError;
    }

    if (renderAfter || previousRunningBadgeSignature !== getRunningBadgeSignature()) {
      render();
    }
  }

  async function runAction(action, macroId, options = {}) {
    const closeAfter = options.closeAfter === true;

    try {
      const nextState = await binding({ type: action, macroId });
      state.error = "";
      state.language = normalizeOverlayLanguage(nextState?.language) ?? state.language;
      state.macros = Array.isArray(nextState?.macros) ? nextState.macros : state.macros;
      state.statuses = Array.isArray(nextState?.statuses) ? nextState.statuses : state.statuses;
      state.lastRefreshAt = Date.now();
    } catch (error) {
      state.error = error instanceof Error ? error.message : getText().runError;
    }

    if (closeAfter) {
      closePanel({ focus: true });
    } else {
      render();
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

    state.isOpen = false;
    render();

    if (shouldFocus || wasOpen) {
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

    refreshIfStale();

    if (matchesMenuToggle(event)) {
      consumeShortcutEvent(event);
      togglePanel();
      return;
    }

    const matchingMacros = state.macros.filter((item) => matchesShortcut(event, item.trigger));
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
      closePanel({ focus: true });
      return;
    }

    focusAutomationTarget();
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
