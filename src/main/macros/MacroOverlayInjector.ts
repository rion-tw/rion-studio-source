import type { Frame, Page } from "playwright";

import type { AppLanguage, Macro, MacroEditorRequest, MacroRunStatus, Role } from "../../shared/types";
import type { MacroManager } from "./MacroManager";
import type { MacroStore } from "./MacroStore";

interface MacroOverlayState {
  language?: AppLanguage;
  macros: Macro[];
  statuses: MacroRunStatus[];
}

type MacroOverlayRequest =
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

const MACRO_OVERLAY_BINDING = "rionStudioMacroOverlay";

export class MacroOverlayInjector {
  private readonly installedPages = new Set<Page>();
  private readonly initializedPages = new WeakSet<Page>();
  private readonly pageRoleIds = new WeakMap<Page, string>();
  private language: AppLanguage | undefined;

  constructor(
    private readonly macroStore: Pick<MacroStore, "listMacros">,
    private readonly macroManager: Pick<MacroManager, "listStatuses" | "start" | "stop">,
    private readonly onMacroEditorRequested?: (request: MacroEditorRequest) => void | Promise<void>
  ) {}

  async install(role: Role, page: Page): Promise<void> {
    this.trackInstalledPage(role.id, page);
    await this.exposeBinding(role.id, page);

    if (!this.initializedPages.has(page)) {
      this.initializedPages.add(page);
      await page.addInitScript({ content: MACRO_OVERLAY_SCRIPT });
      this.registerFrameInstallers(page);
    }

    await Promise.all(page.frames().map((frame) => this.installFrame(frame)));
  }

  refreshInstalledOverlays(roleId?: string): void {
    this.installedPages.forEach((page) => {
      if (roleId && this.pageRoleIds.get(page) !== roleId) {
        return;
      }

      void this.refreshPageOverlay(page);
    });
  }

  setLanguage(language: AppLanguage): void {
    this.language = language;
    this.refreshInstalledOverlays();
  }

  private trackInstalledPage(roleId: string, page: Page): void {
    const wasTracked = this.installedPages.has(page);
    this.installedPages.add(page);
    this.pageRoleIds.set(page, roleId);

    if (wasTracked) {
      return;
    }

    const trackedPage = page as Page & { once?: Page["once"] };
    if (typeof trackedPage.once === "function") {
      trackedPage.once("close", () => {
        this.installedPages.delete(page);
      });
    }
  }

  private async refreshPageOverlay(page: Page): Promise<void> {
    try {
      await page.evaluate(() => {
        const controller = (
          window as Window & {
            __rionStudioMacroOverlay?: {
              refresh?: (options?: { renderAfter?: boolean }) => Promise<void>;
            };
          }
        ).__rionStudioMacroOverlay;

        return controller?.refresh?.({ renderAfter: true });
      });
    } catch (error) {
      if (!isBenignFrameInstallError(error)) {
        console.warn("Failed to refresh Rion Studio macro overlay.", error);
      }

      this.installedPages.delete(page);
    }
  }

  private async exposeBinding(roleId: string, page: Page): Promise<void> {
    try {
      await page.exposeBinding(MACRO_OVERLAY_BINDING, async (_source, request: MacroOverlayRequest) => {
        switch (request.type) {
          case "list":
            return this.getOverlayState(roleId);
          case "create":
            await this.onMacroEditorRequested?.({ roleId });
            return this.getOverlayState(roleId);
          case "edit":
            await this.onMacroEditorRequested?.({ macroId: request.macroId, roleId });
            return this.getOverlayState(roleId);
          case "start":
            await this.macroManager.start(roleId, request.macroId);
            return this.getOverlayState(roleId);
          case "stop":
            await this.macroManager.stop(roleId, request.macroId);
            return this.getOverlayState(roleId);
        }
      });
    } catch (error) {
      if (error instanceof Error && /already|registered/i.test(error.message)) {
        return;
      }

      throw error;
    }
  }

  private registerFrameInstallers(page: Page): void {
    const installFrame = (frame: Frame) => {
      void this.installFrame(frame);
    };

    page.on("frameattached", installFrame);
    page.on("framenavigated", installFrame);
  }

  private async installFrame(frame: Frame): Promise<void> {
    try {
      await frame.evaluate(MACRO_OVERLAY_SCRIPT);
    } catch (error) {
      if (!isBenignFrameInstallError(error)) {
        console.warn("Failed to install Rion Studio macro overlay in frame.", error);
      }
    }
  }

  private async getOverlayState(roleId: string): Promise<MacroOverlayState> {
    const [macros, statuses] = await Promise.all([
      this.macroStore.listMacros(),
      Promise.resolve(this.macroManager.listStatuses())
    ]);

    return {
      language: this.language,
      macros: macros.filter((macro) => macro.roleId === roleId),
      statuses: statuses.filter((status) => status.roleId === roleId)
    };
  }
}

function isBenignFrameInstallError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /detached|destroyed|closed|Cannot find context|Execution context/i.test(error.message);
}

export const MACRO_OVERLAY_SCRIPT = String.raw`
(() => {
  const hostId = "rion-studio-macro-overlay-v18";
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
    "rion-studio-macro-overlay-v17"
  ];
  const controllerKey = "__rionStudioMacroOverlay";
  const scriptVersion = "2026-07-12.12";
  const bindingName = "rionStudioMacroOverlay";
  const hostStyleEntries = [
    ["bottom", "auto"],
    ["color-scheme", "dark"],
    ["display", "grid"],
    ["font-family", "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"],
    ["justify-items", "end"],
    ["left", "auto"],
    ["max-width", "300px"],
    ["pointer-events", "none"],
    ["position", "fixed"],
    ["right", "6px"],
    ["top", "6px"],
    ["transform", "none"],
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
      noShortcut: "無快捷鍵",
      noSteps: "無步驟",
      once: "執行一次",
      runError: "無法執行巨集。",
      stepsMore: "另有 {count} 個",
      triggerAria: "Rion Studio 巨集",
      triggerTitle: "Rion Studio 巨集 (Ctrl+Shift+M)"
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
    return language === "en" || language === "zh-TW" ? language : undefined;
  }

  function isRunning(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "running");
  }

  function isStopping(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "stopping");
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

  function detectOverlayLanguage() {
    const navigatorLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
    const documentLanguage = document.documentElement?.lang;
    const locales = [...navigatorLanguages, navigator.language, documentLanguage].filter(Boolean);

    return locales.some(isTraditionalChineseLocale) ? "zh-TW" : "en";
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
        const shortcut = formatShortcut(macro.trigger);
        const steps = formatSteps(macro.steps);
        const poll = formatRepeat(macro.repeat);
        const editLabel = text.edit + " " + macro.name;

        return [
          '<div class="macro-row" role="menuitem"><span class="macro-title"><span class="status-dot ',
          running || stopping ? "running" : "idle",
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
      "*{box-sizing:border-box;}",
      ".trigger{-webkit-backdrop-filter:blur(18px) saturate(190%);align-items:center;backdrop-filter:blur(18px) saturate(190%);background:linear-gradient(135deg,rgba(255,255,255,.28),rgba(255,255,255,.08));border:1px solid rgba(255,255,255,.32);border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.18),inset 0 1px 1px rgba(255,255,255,.38),inset 0 -10px 18px rgba(255,255,255,.04);color:rgba(255,255,255,.96);cursor:pointer;display:flex;font-size:13px;font-weight:800;height:32px;justify-content:center;letter-spacing:0;line-height:1;padding:0;pointer-events:auto;text-shadow:0 1px 2px rgba(0,0,0,.28);width:32px;}",
      ".trigger-icon{display:block;fill:none;height:18px;width:18px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.24));stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2;}",
      ".trigger:hover{background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.13));border-color:rgba(255,255,255,.42);}",
      ".panel{display:",
      state.isOpen ? "grid" : "none",
      ";gap:7px;margin-top:6px;max-width:300px;padding:0;pointer-events:auto;width:min(294px,calc(100vw - 12px));}",
      ".macro-row,.create-row,.empty,.error{-webkit-backdrop-filter:blur(18px) saturate(190%);backdrop-filter:blur(18px) saturate(190%);background:linear-gradient(135deg,rgba(255,255,255,.28),rgba(255,255,255,.08));border:1px solid rgba(255,255,255,.32);box-shadow:0 8px 24px rgba(0,0,0,.18),inset 0 1px 1px rgba(255,255,255,.38),inset 0 -10px 18px rgba(255,255,255,.04);}",
      ".create-row{align-items:center;border-radius:9px;color:#fff;cursor:pointer;display:flex;font-size:12px;font-weight:850;gap:8px;height:34px;justify-content:flex-start;line-height:1;padding:0 10px;text-align:left;text-shadow:0 1px 2px rgba(0,0,0,.22);width:100%;}",
      ".create-row:hover{background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.13));border-color:rgba(255,255,255,.42);}",
      ".create-icon{align-items:center;background:rgba(255,255,255,.18);border-radius:999px;display:flex;font-size:15px;font-weight:900;height:18px;justify-content:center;line-height:18px;width:18px;}",
      ".macro-row{align-items:center;border-radius:9px;color:#fff;display:grid;gap:6px 7px;grid-template-areas:'title shortcut poll edit' 'steps steps steps steps';grid-template-columns:minmax(52px,1fr) auto auto 24px;min-height:58px;padding:7px 9px;text-align:left;text-shadow:0 1px 2px rgba(0,0,0,.28);width:100%;}",
      ".macro-row:hover{background:linear-gradient(135deg,rgba(255,255,255,.34),rgba(255,255,255,.13));border-color:rgba(255,255,255,.42);}",
      ".status-dot{border-radius:999px;box-shadow:0 0 0 1px rgba(255,255,255,.14),0 0 10px currentColor;display:block;height:8px;width:8px;}",
      ".status-dot.running{background:#7dff72;color:rgba(125,255,114,.42);}",
      ".status-dot.idle{background:#ff5f57;color:rgba(255,95,87,.36);}",
      ".macro-title{align-items:center;display:flex;gap:8px;grid-area:title;min-width:0;}",
      ".macro-title strong{font-size:12.5px;font-weight:800;line-height:1.15;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".macro-details{display:contents;}",
      ".macro-details span{color:rgba(255,255,255,.78);font-size:9.5px;font-weight:750;line-height:1;min-width:0;}",
      ".macro-details b{font-weight:750;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".macro-detail-shortcut,.macro-detail-poll{align-items:center;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:999px;color:rgba(255,255,255,.9);display:flex;font-size:9.5px;font-weight:850;line-height:1;min-height:24px;padding:4px 7px;}",
      ".macro-detail-shortcut{grid-area:shortcut;}",
      ".macro-detail-poll{grid-area:poll;}",
      ".macro-detail-shortcut b{max-width:52px;}",
      ".macro-detail-poll b{max-width:74px;}",
      ".macro-detail-steps{display:block;grid-area:steps;padding:0 1px;}",
      ".macro-detail-steps b{color:rgba(255,255,255,.64);display:block;font-size:9.5px;line-height:1.35;}",
      ".macro-edit{align-items:center;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:999px;color:rgba(255,255,255,.88);cursor:pointer;display:flex;grid-area:edit;height:24px;justify-content:center;padding:0;width:24px;}",
      ".macro-edit:hover{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.34);}",
      ".edit-icon{display:block;fill:none;height:12px;width:12px;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:2;}",
      ".active-badges{align-items:center;display:flex;flex-wrap:nowrap;gap:5px;justify-content:center;left:50%;max-width:min(76vw,620px);pointer-events:none;position:fixed;top:20%;transform:translateX(-50%);z-index:2147483647;}",
      ".active-badge{-webkit-backdrop-filter:blur(18px) saturate(190%);align-items:center;backdrop-filter:blur(18px) saturate(190%);background:linear-gradient(135deg,rgba(255,255,255,.25),rgba(255,255,255,.075));border:1px solid rgba(255,255,255,.34);border-radius:999px;box-shadow:0 8px 22px rgba(0,0,0,.18),inset 0 1px 1px rgba(255,255,255,.36),inset 0 -8px 14px rgba(255,255,255,.04);color:rgba(255,255,255,.92);display:flex;font-size:10.5px;font-weight:850;gap:5px;letter-spacing:0;line-height:1;max-width:156px;min-height:20px;overflow:hidden;padding:4px 8px;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.3);white-space:nowrap;}",
      ".active-badge-name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".active-badge-shortcut{color:rgba(255,255,255,.66);display:block;flex:0 0 auto;font-size:9.5px;font-weight:800;}",
      ".empty,.error{border-radius:9px;color:rgba(255,255,255,.64);font-size:11px;font-weight:700;line-height:1.35;padding:10px;}",
      ".error{color:#ffb4b4;}",
      "</style>",
      runningBadges ? '<div class="active-badges" aria-hidden="true">' + runningBadges + "</div>" : "",
      '<button class="trigger" type="button" tabindex="-1" title="' + escapeHtml(text.triggerTitle) + '" aria-label="' + escapeHtml(text.triggerAria) + '">',
      triggerIconMarkup,
      "</button>",
      '<div class="panel" role="menu">',
      state.error ? '<div class="error">' + escapeHtml(state.error) + "</div>" : "",
      state.macros.length > 0 ? macroRows : '<div class="empty">' + escapeHtml(text.empty) + "</div>",
      '<button class="create-row" type="button" tabindex="-1" data-action="create" title="' + escapeHtml(text.addMacro) + '" aria-label="' + escapeHtml(text.addMacro) + '"><span class="create-icon" aria-hidden="true">+</span><span>' + escapeHtml(text.addMacro) + "</span></button>",
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
    refreshIfStale();

    if (matchesMenuToggle(event)) {
      consumeShortcutEvent(event);
      togglePanel();
      return;
    }

    const macro = state.macros.find((item) => matchesShortcut(event, item.trigger));
    if (!macro) {
      return;
    }

    consumeShortcutEvent(event);
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
      closePanel,
      dispose,
      focusAutomationTarget,
      refresh,
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
