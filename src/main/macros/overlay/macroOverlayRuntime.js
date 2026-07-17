(() => {
  const hostId = "rion-studio-macro-overlay-v31";
  const legacyHostIds = [
    "rion-studio-macro-overlay",
    ...Array.from({ length: 29 }, (_value, index) => "rion-studio-macro-overlay-v" + (index + 2))
  ];
  const controllerKey = "__rionStudioMacroOverlay";
  const scriptVersion = "2026-07-17.1";
  const bindingName = "rionStudioMacroOverlay";
  const shouldIgnoreShortcutEvent = "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__";
  const overlayCss = "__RION_STUDIO_MACRO_OVERLAY_CSS__";
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
  const binding = window[bindingName];
  const overlayTexts = {
    en: {
      holdUntilStop: "Hold",
      noShortcut: "No shortcut",
      resourceMacroOverride: "Temporarily full speed",
      resourceSharedProcess: "Shared process / full speed",
      resourceUnavailable: "Throttling unavailable",
      triggerAria: "Open Rion Studio Macros",
      triggerTitle: "Open Rion Studio Macros (Ctrl+Shift+M)",
      whileHeld: "While held"
    },
    "zh-TW": {
      holdUntilStop: "保持",
      noShortcut: "無快捷鍵",
      resourceMacroOverride: "暫時全速",
      resourceSharedProcess: "共用程序／全速",
      resourceUnavailable: "無法節流",
      triggerAria: "開啟 Rion Studio 巨集",
      triggerTitle: "開啟 Rion Studio 巨集 (Ctrl+Shift+M)",
      whileHeld: "按住"
    },
    "zh-CN": {
      holdUntilStop: "保持",
      noShortcut: "无快捷键",
      resourceMacroOverride: "暂时全速",
      resourceSharedProcess: "共享进程／全速",
      resourceUnavailable: "无法限速",
      triggerAria: "打开 Rion Studio 宏",
      triggerTitle: "打开 Rion Studio 宏 (Ctrl+Shift+M)",
      whileHeld: "按住"
    },
    ja: {
      holdUntilStop: "保持",
      noShortcut: "ショートカットなし",
      resourceMacroOverride: "一時的にフル速度",
      resourceSharedProcess: "共有プロセス／フル速度",
      resourceUnavailable: "速度制限不可",
      triggerAria: "Rion Studio マクロを開く",
      triggerTitle: "Rion Studio マクロを開く (Ctrl+Shift+M)",
      whileHeld: "押している間"
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
  let activeBadgesElement = null;
  const activeHeldShortcuts = new Map();
  let cleanupInterval = undefined;
  let host = null;
  let isInstalled = false;
  let isOpenRequestPending = false;
  let refreshInterval = undefined;
  let resourceElement = null;
  let root = null;
  let suppressedShortcutEvents = [];
  let triggerElement = null;

  if (typeof binding !== "function") {
    return;
  }

  removeLegacyHosts();

  if (window[controllerKey]?.version === scriptVersion) {
    void window[controllerKey].refresh();
    return;
  }

  window[controllerKey]?.dispose?.();
  removeVisualHosts();
  delete window[controllerKey];

  const state = {
    cpuThrottleRate: 1,
    language: detectOverlayLanguage(),
    lastRefreshAt: 0,
    macros: [],
    requestVersion: 0,
    resourceState: undefined,
    statuses: []
  };
  const pendingMacroActions = new Set();
  const macroActionTails = new Map();
  let nextPressId = 1;

  function getText() {
    return overlayTexts[state.language] ?? overlayTexts[detectOverlayLanguage()] ?? overlayTexts.en;
  }

  function getResourceLabel() {
    const text = getText();
    switch (state.resourceState) {
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

  function applyState(nextState) {
    state.language = normalizeOverlayLanguage(nextState?.language) ?? state.language;
    state.macros = Array.isArray(nextState?.macros) ? nextState.macros : state.macros;
    state.resourceState = nextState?.resourceState;
    state.cpuThrottleRate = nextState?.cpuThrottleRate || 1;
    state.statuses = Array.isArray(nextState?.statuses) ? nextState.statuses : state.statuses;
    state.lastRefreshAt = Date.now();
  }

  function isRunning(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "running");
  }

  function isStopping(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "stopping");
  }

  function getRunningBadgeMacros() {
    return state.macros.filter((macro) => macro.enabled !== false && isRunning(macro.id));
  }

  function formatCode(code) {
    return String(code)
      .replace(/^Key/, "")
      .replace(/^Digit/, "")
      .replace(/^Numpad/, "Num ")
      .replace("Arrow", "")
      .replace("Escape", "Esc");
  }

  function formatShortcut(trigger) {
    if (!trigger) {
      return getText().noShortcut;
    }

    const parts = [];
    if (trigger.ctrl) parts.push("Ctrl");
    if (trigger.alt) parts.push("Alt");
    if (trigger.shift) parts.push("Shift");
    if (trigger.meta) parts.push("Meta");
    parts.push(formatCode(trigger.code));
    return parts.join("+");
  }

  function formatMacroBehavior(macro) {
    const text = getText();
    const parts = [];
    if ((macro.activationMode ?? "toggle") === "while_held") {
      parts.push(text.whileHeld);
    }
    if (macro.steps?.some((step) => step.type === "key" && step.action === "hold_until_stop")) {
      parts.push(text.holdUntilStop);
    }
    return parts.join(" · ");
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

  function matchesOpenShortcut(event) {
    return event.code === "KeyM" && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function isTraditionalChineseLocale(locale) {
    const normalized = String(locale).toLowerCase();
    return normalized === "zh-hant" || normalized.startsWith("zh-hant-") ||
      normalized === "zh-tw" || normalized.startsWith("zh-tw-") ||
      normalized === "zh-hk" || normalized.startsWith("zh-hk-") ||
      normalized === "zh-mo" || normalized.startsWith("zh-mo-");
  }

  function isSimplifiedChineseLocale(locale) {
    const normalized = String(locale).toLowerCase();
    return normalized === "zh" || normalized === "zh-hans" || normalized.startsWith("zh-hans-") ||
      normalized === "zh-cn" || normalized.startsWith("zh-cn-") ||
      normalized === "zh-sg" || normalized.startsWith("zh-sg-");
  }

  function isJapaneseLocale(locale) {
    const normalized = String(locale).toLowerCase();
    return normalized === "ja" || normalized.startsWith("ja-");
  }

  function detectOverlayLanguage() {
    const navigatorLanguages = Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language];
    const locales = [
      ...navigatorLanguages,
      navigator.language,
      document.documentElement?.lang
    ].filter(Boolean);

    if (locales.some(isJapaneseLocale)) return "ja";
    if (locales.some(isTraditionalChineseLocale)) return "zh-TW";
    if (locales.some(isSimplifiedChineseLocale)) return "zh-CN";
    return "en";
  }

  function shouldRenderUi() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  function removeHost(id) {
    document.getElementById(id)?.remove();
    if (host?.id === id) {
      activeBadgesElement = null;
      host = null;
      resourceElement = null;
      root = null;
      triggerElement = null;
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
    if (!host) return;
    host.removeAttribute("style");
    hostStyleEntries.forEach(([property, value]) => {
      host.style.setProperty(property, value, "important");
    });
  }

  function ensureHost() {
    removeLegacyHosts();

    if (!shouldRenderUi() || !document.body) {
      removeHost(hostId);
      return null;
    }

    if (host?.isConnected && root && triggerElement) {
      return root;
    }

    removeHost(hostId);
    host = document.createElement("div");
    host.id = hostId;
    root = host.attachShadow({ mode: "open" });
    applyHostStyle();
    root.innerHTML = [
      "<style>",
      overlayCss,
      "</style>",
      '<div class="active-badges" aria-hidden="true"></div>',
      '<div class="toolbar">',
      '<div class="resource-state" hidden></div>',
      '<button class="trigger" type="button" tabindex="-1">',
      triggerIconMarkup,
      "</button>",
      "</div>"
    ].join("");
    activeBadgesElement = root.querySelector(".active-badges");
    resourceElement = root.querySelector(".resource-state");
    triggerElement = root.querySelector(".trigger");
    triggerElement?.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    triggerElement?.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    triggerElement?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void requestOpenMacroPage();
    });
    document.body.appendChild(host);
    return root;
  }

  function updatePresentation() {
    if (!ensureHost() || !triggerElement || !activeBadgesElement || !resourceElement) {
      return;
    }

    const text = getText();
    triggerElement.title = text.triggerTitle;
    triggerElement.setAttribute("aria-label", text.triggerAria);

    const resourceLabel = getResourceLabel();
    resourceElement.hidden = !resourceLabel;
    resourceElement.textContent = resourceLabel;
    resourceElement.title = resourceLabel;

    activeBadgesElement.innerHTML = getRunningBadgeMacros()
      .map((macro) => {
        const behavior = formatMacroBehavior(macro);
        return [
          '<span class="active-badge">',
          '<span class="active-badge-name">',
          escapeHtml(macro.name),
          '</span><span class="active-badge-shortcut">',
          escapeHtml(formatShortcut(macro.trigger)),
          behavior ? " · " + escapeHtml(behavior) : "",
          "</span></span>"
        ].join("");
      })
      .join("");
    activeBadgesElement.hidden = activeBadgesElement.childElementCount === 0;
  }

  async function refresh() {
    if (pendingMacroActions.size > 0) {
      return;
    }

    const requestVersion = ++state.requestVersion;
    try {
      const nextState = await binding({ type: "list" });
      if (requestVersion !== state.requestVersion || disposeIfDetached(nextState)) {
        return;
      }
      applyState(nextState);
      updatePresentation();
    } catch (error) {
      console.warn("Unable to refresh Rion Studio macro shortcuts.", error);
    }
  }

  async function requestOpenMacroPage() {
    if (isOpenRequestPending) {
      return;
    }

    isOpenRequestPending = true;
    try {
      const nextState = await binding({ type: "open" });
      if (disposeIfDetached(nextState)) {
        return;
      }
      applyState(nextState);
      updatePresentation();
    } catch (error) {
      console.warn("Unable to open Rion Studio macros.", error);
    } finally {
      isOpenRequestPending = false;
    }
  }

  function runAction(action, macroId, details, queueBehindPending) {
    if (!queueBehindPending && pendingMacroActions.has(macroId)) {
      return;
    }

    pendingMacroActions.add(macroId);
    const previous = macroActionTails.get(macroId) ?? Promise.resolve();
    const actionPromise = previous.catch(() => undefined).then(async () => {
      const requestVersion = ++state.requestVersion;
      try {
        const nextState = await binding({ type: action, macroId, ...details });
        if (disposeIfDetached(nextState)) {
          return;
        }
        if (requestVersion === state.requestVersion) {
          applyState(nextState);
          updatePresentation();
        }
      } catch (error) {
        console.warn("Unable to run Rion Studio macro.", error);
      }
    });
    macroActionTails.set(macroId, actionPromise);
    void actionPromise.finally(() => {
      if (macroActionTails.get(macroId) === actionPromise) {
        macroActionTails.delete(macroId);
        pendingMacroActions.delete(macroId);
        if (pendingMacroActions.size === 0) {
          void refresh();
        }
      }
    });
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

  function refreshIfStale() {
    if (Date.now() - state.lastRefreshAt > 1200) {
      void refresh();
    }
  }

  function handleKeyDown(event) {
    if (consumeSuppressedShortcut(event.code)) {
      return;
    }
    if (shouldIgnoreShortcutEvent(event, undefined, document.designMode)) {
      return;
    }

    const matchesMacroShortcut = state.macros.some(
      (macro) => macro.enabled !== false && matchesShortcut(event, macro.trigger)
    );
    if (event.repeat) {
      if (matchesOpenShortcut(event) || matchesMacroShortcut) {
        consumeShortcutEvent(event);
      }
      return;
    }

    refreshIfStale();
    if (matchesOpenShortcut(event)) {
      consumeShortcutEvent(event);
      void requestOpenMacroPage();
      return;
    }

    const matchingMacros = state.macros.filter(
      (macro) => macro.enabled !== false && matchesShortcut(event, macro.trigger)
    );
    if (matchingMacros.length === 0) {
      return;
    }

    consumeShortcutEvent(event);
    if (matchingMacros.length !== 1) {
      console.warn("Multiple Rion Studio macros use the same shortcut for this role.");
      return;
    }

    const macro = matchingMacros[0];
    if ((macro.activationMode ?? "toggle") === "while_held") {
      if (activeHeldShortcuts.has(macro.id)) return;
      const pressId = `${Date.now()}-${nextPressId++}`;
      activeHeldShortcuts.set(macro.id, { code: event.code, pressId });
      runAction("press", macro.id, { pressId }, true);
      return;
    }
    runAction(isRunning(macro.id) || isStopping(macro.id) ? "stop" : "start", macro.id);
  }

  function handleKeyUp(event) {
    const matches = [...activeHeldShortcuts.entries()].filter(
      ([, active]) => active.code === event.code
    );
    if (matches.length === 0) return;
    consumeShortcutEvent(event);
    matches.forEach(([macroId, active]) => {
      activeHeldShortcuts.delete(macroId);
      runAction("release", macroId, { pressId: active.pressId }, true);
    });
  }

  function releaseActiveHeldShortcuts() {
    [...activeHeldShortcuts.entries()].forEach(([macroId, active]) => {
      activeHeldShortcuts.delete(macroId);
      runAction("release", macroId, { pressId: active.pressId }, true);
    });
  }

  function handleFocus() {
    void refresh();
  }

  function handleBlur() {
    releaseActiveHeldShortcuts();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      releaseActiveHeldShortcuts();
    }
  }

  function dispose() {
    releaseActiveHeldShortcuts();
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keyup", handleKeyUp, true);
    window.removeEventListener("focus", handleFocus, true);
    window.removeEventListener("blur", handleBlur, true);
    window.removeEventListener("pagehide", handleBlur, true);
    document.removeEventListener("visibilitychange", handleVisibilityChange, true);

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
      void refresh();
      return;
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("focus", handleFocus, true);
    window.addEventListener("blur", handleBlur, true);
    window.addEventListener("pagehide", handleBlur, true);
    document.addEventListener("visibilitychange", handleVisibilityChange, true);
    refreshInterval = setInterval(() => void refresh(), 1500);
    cleanupInterval = setInterval(() => {
      removeLegacyHosts();
      if (!shouldRenderUi()) {
        removeHost(hostId);
      }
    }, 300);

    window[controllerKey] = {
      clearSuppressedShortcut,
      dispose,
      refresh,
      suppressNextShortcut,
      version: scriptVersion
    };
    isInstalled = true;
    updatePresentation();
    void refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      updatePresentation();
      void refresh();
    }, { once: true });
  }

  install();
})();
