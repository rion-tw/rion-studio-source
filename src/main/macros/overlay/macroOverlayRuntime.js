(() => {
  const hostId = "rion-studio-macro-overlay-v44";
  const legacyHostIds = [
    "rion-studio-macro-overlay",
    ...Array.from({ length: 42 }, (_value, index) => "rion-studio-macro-overlay-v" + (index + 2))
  ];
  const controllerKey = "__rionStudioMacroOverlay";
  const scriptVersion = "2026-07-20.2";
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
      tapOrHold: "Tap or hold"
    },
    "zh-TW": {
      holdUntilStop: "保持",
      noShortcut: "無快捷鍵",
      resourceMacroOverride: "暫時全速",
      resourceSharedProcess: "共用程序／全速",
      resourceUnavailable: "無法節流",
      triggerAria: "開啟 Rion Studio 巨集",
      triggerTitle: "開啟 Rion Studio 巨集 (Ctrl+Shift+M)",
      tapOrHold: "點按或按住"
    },
    "zh-CN": {
      holdUntilStop: "保持",
      noShortcut: "无快捷键",
      resourceMacroOverride: "暂时全速",
      resourceSharedProcess: "共享进程／全速",
      resourceUnavailable: "无法限速",
      triggerAria: "打开 Rion Studio 宏",
      triggerTitle: "打开 Rion Studio 宏 (Ctrl+Shift+M)",
      tapOrHold: "点按或按住"
    },
    ja: {
      holdUntilStop: "保持",
      noShortcut: "ショートカットなし",
      resourceMacroOverride: "一時的にフル速度",
      resourceSharedProcess: "共有プロセス／フル速度",
      resourceUnavailable: "速度制限不可",
      triggerAria: "Rion Studio マクロを開く",
      triggerTitle: "Rion Studio マクロを開く (Ctrl+Shift+M)",
      tapOrHold: "短押し／長押し"
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
  const gameBrowserDefaultCodes = new Set([
    "Tab",
    "Space",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "Backspace"
  ]);
  const macroBadgeTopPositionsPx = new Set(
    Array.from({ length: 41 }, (_value, index) => index * 8)
  );
  const macroBadgeHorizontalMarginsPx = new Set(
    Array.from({ length: 17 }, (_value, index) => index * 8)
  );
  let activeBadgesElement = null;
  const activeHeldShortcuts = new Map();
  const macroIterationTimings = new Map();
  let renderedActiveBadgesMarkup = null;
  let cleanupInterval = undefined;
  let gameInputContextActive = false;
  let host = null;
  let isDisposed = false;
  let isInstalled = false;
  let isOpenRequestPending = false;
  let refreshInFlight = null;
  let refreshInterval = undefined;
  let refreshQueued = false;
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
    macroBadgePosition: {
      horizontalAlign: "center",
      horizontalMarginPx: 8,
      topPx: 128
    },
    macros: [],
    requestVersion: 0,
    resourceState: undefined,
    statuses: []
  };
  const pendingMacroActions = new Set();
  const macroActionTails = new Map();
  let nextPressId = 1;

  function isCanvas(candidate) {
    return typeof HTMLCanvasElement !== "undefined" && candidate instanceof HTMLCanvasElement;
  }

  function eventPathIncludesCanvas(event) {
    try {
      return event.composedPath().some(isCanvas);
    } catch {
      return isCanvas(event.target);
    }
  }

  function getDeepActiveElement() {
    let activeElement = document.activeElement;
    const visited = new Set();
    while (activeElement?.shadowRoot?.activeElement && !visited.has(activeElement)) {
      visited.add(activeElement);
      activeElement = activeElement.shadowRoot.activeElement;
    }
    return activeElement;
  }

  function hasActiveGameCanvas() {
    return isCanvas(getDeepActiveElement()) || isCanvas(document.pointerLockElement);
  }

  function reportGameInputContext(active) {
    const nextActive = Boolean(active);
    if (gameInputContextActive === nextActive) return;
    gameInputContextActive = nextActive;
    void Promise.resolve(binding({ type: "game-input-context", active: nextActive })).catch(() => undefined);
  }

  function refreshGameInputContext() {
    reportGameInputContext(hasActiveGameCanvas());
  }

  function scheduleGameInputContextRefresh() {
    Promise.resolve().then(() => {
      if (!isDisposed) refreshGameInputContext();
    });
  }

  function handleGameSurfacePointerDown(event) {
    if (eventPathIncludesCanvas(event)) {
      reportGameInputContext(true);
      return;
    }
    scheduleGameInputContextRefresh();
  }

  function handleGameSurfaceFocusIn(event) {
    reportGameInputContext(eventPathIncludesCanvas(event) || hasActiveGameCanvas());
  }

  function handleGameSurfaceFocusOut() {
    scheduleGameInputContextRefresh();
  }

  function isMacPlatform() {
    const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
    return /mac/i.test(String(platform));
  }

  function isSystemOwnedShortcut(event) {
    if (event.code === "Tab" && (event.metaKey || event.altKey)) return true;
    if (event.metaKey && event.code === "Space") return true;
    if (!isMacPlatform() && event.metaKey) return true;
    return isMacPlatform() && event.ctrlKey && event.code.startsWith("Arrow");
  }

  function isBrowserNavigationShortcut(event) {
    if (event.code === "BrowserBack" || event.code === "BrowserForward") return true;
    if (event.altKey && (event.code === "ArrowLeft" || event.code === "ArrowRight")) return true;
    return isMacPlatform() && event.metaKey &&
      (event.code === "BracketLeft" || event.code === "BracketRight" ||
        event.code === "ArrowLeft" || event.code === "ArrowRight");
  }

  function isReservedBrowserZoomShortcutEvent(event) {
    if (event.altKey || event.ctrlKey === event.metaKey || (!event.ctrlKey && !event.metaKey)) {
      return false;
    }
    if (event.code === "Equal" || event.code === "Plus" || event.code === "NumpadAdd") {
      return true;
    }
    if (event.shiftKey) return false;
    return event.code === "Minus" || event.code === "NumpadSubtract" ||
      event.code === "Digit0" || event.code === "Numpad0";
  }

  function preventGameBrowserDefault(event) {
    if (!gameInputContextActive && !eventPathIncludesCanvas(event)) return;
    if (isSystemOwnedShortcut(event)) return;

    if (gameBrowserDefaultCodes.has(event.code) || isBrowserNavigationShortcut(event)) {
      event.preventDefault();
    }
  }

  function handleGameWheel(event) {
    if ((!gameInputContextActive && !eventPathIncludesCanvas(event)) || (!event.ctrlKey && !event.metaKey)) {
      return;
    }
    event.preventDefault();
  }

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

  function normalizeMacroBadgePosition(value, fallback = state.macroBadgePosition) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      horizontalAlign:
        input.horizontalAlign === "left" || input.horizontalAlign === "center" || input.horizontalAlign === "right"
          ? input.horizontalAlign
          : fallback.horizontalAlign,
      horizontalMarginPx:
        Number.isInteger(input.horizontalMarginPx) &&
        macroBadgeHorizontalMarginsPx.has(input.horizontalMarginPx)
          ? input.horizontalMarginPx
          : fallback.horizontalMarginPx,
      topPx:
        Number.isInteger(input.topPx) && macroBadgeTopPositionsPx.has(input.topPx)
          ? input.topPx
          : fallback.topPx
    };
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
    state.macroBadgePosition = normalizeMacroBadgePosition(nextState?.macroBadgePosition);
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

  function getMacroIteration(macroId) {
    const status = state.statuses
      .filter((status) => status.macroId === macroId && status.state === "running")
      .sort((left, right) => (right.iteration ?? 0) - (left.iteration ?? 0))[0];
    const iteration = status?.iteration ?? 0;
    const timestamp = Date.parse(status?.updatedAt ?? "") || Date.now();
    const previous = macroIterationTimings.get(macroId);
    const hasSameIteration =
      previous &&
      previous.startedAt === status?.startedAt &&
      previous.iteration === iteration;
    let duration = hasSameIteration ? previous.duration : 120;
    let delay = hasSameIteration ? previous.delay : 0;
    if (
      previous &&
      previous.startedAt === status?.startedAt &&
      iteration > previous.iteration
    ) {
      const period = timestamp - previous.timestamp;
      if (period > 0) {
        duration = Math.min(220, Math.max(70, Math.round(period * 0.32)));
      }
      delay = -Math.min(duration, Math.max(0, Date.now() - timestamp));
    }
    macroIterationTimings.set(macroId, {
      delay,
      duration,
      iteration,
      startedAt: status?.startedAt,
      timestamp
    });
    return { delay, duration, iteration };
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
      parts.push(text.tapOrHold);
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
      renderedActiveBadgesMarkup = null;
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

  function updateActiveBadgesPosition() {
    if (!activeBadgesElement) return;

    const position = state.macroBadgePosition;
    activeBadgesElement.style.top = String(position.topPx) + "px";
    activeBadgesElement.style.left = "0px";
    activeBadgesElement.style.right = "0px";
    activeBadgesElement.style.width = "100vw";
    activeBadgesElement.style.justifyContent = "center";
    activeBadgesElement.style.transform = "none";

    if (position.horizontalAlign === "left") {
      activeBadgesElement.style.left = String(position.horizontalMarginPx) + "px";
      activeBadgesElement.style.right = "auto";
      activeBadgesElement.style.width = "max-content";
      activeBadgesElement.style.justifyContent = "flex-start";
      return;
    }

    if (position.horizontalAlign === "right") {
      activeBadgesElement.style.left = "auto";
      activeBadgesElement.style.right = String(position.horizontalMarginPx) + "px";
      activeBadgesElement.style.width = "max-content";
      activeBadgesElement.style.justifyContent = "flex-end";
      return;
    }
  }

  function updatePresentation() {
    if (!ensureHost() || !triggerElement || !activeBadgesElement || !resourceElement) {
      return;
    }

    updateActiveBadgesPosition();
    const text = getText();
    triggerElement.title = text.triggerTitle;
    triggerElement.setAttribute("aria-label", text.triggerAria);

    const resourceLabel = getResourceLabel();
    resourceElement.hidden = !resourceLabel;
    resourceElement.textContent = resourceLabel;
    resourceElement.title = resourceLabel;

    const nextMarkup = getRunningBadgeMacros()
      .map((macro) => {
        const behavior = formatMacroBehavior(macro);
        const { delay, duration, iteration } = getMacroIteration(macro.id);
        const iterationFlashClass = iteration > 0 ? " is-iteration-flash" : "";
        return [
          '<span class="active-badge',
          iterationFlashClass,
          '" data-iteration="',
          String(iteration),
          '" style="--active-badge-flash-duration:',
          String(duration),
          'ms;--active-badge-flash-delay:',
          String(delay),
          'ms">',
          '<span class="active-badge-shortcut">',
          escapeHtml(formatShortcut(macro.trigger)),
          "</span>",
          '<span class="active-badge-name">',
          escapeHtml(macro.name),
          "</span>",
          behavior
            ? '<span class="active-badge-behavior"> · ' + escapeHtml(behavior) + "</span>"
            : "",
          "</span>"
        ].join("");
      })
      .join("");
    if (nextMarkup !== renderedActiveBadgesMarkup) {
      activeBadgesElement.innerHTML = nextMarkup;
      renderedActiveBadgesMarkup = nextMarkup;
    }
    activeBadgesElement.hidden = nextMarkup.length === 0;
  }

  function refresh() {
    if (isDisposed) {
      return Promise.resolve();
    }
    if (pendingMacroActions.size > 0) {
      refreshQueued = true;
      return refreshInFlight ?? Promise.resolve();
    }
    if (refreshInFlight) {
      refreshQueued = true;
      const currentRefresh = refreshInFlight;
      return currentRefresh.then(() => refreshInFlight ?? undefined);
    }

    refreshQueued = false;
    const operation = (async () => {
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
    })();
    refreshInFlight = operation;
    void operation.finally(() => {
      if (refreshInFlight !== operation) {
        return;
      }
      refreshInFlight = null;
      if (refreshQueued && !isDisposed) {
        refreshQueued = false;
        void refresh();
      }
    });
    return operation;
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

  function suppressNextShortcut(code, phase = "keydown") {
    const now = Date.now();
    suppressedShortcutEvents = suppressedShortcutEvents.filter((item) => item.expiresAt > now);
    suppressedShortcutEvents.push({ code: String(code), expiresAt: now + 1000, phase });
  }

  function clearSuppressedShortcut(code, phase = "keydown") {
    suppressedShortcutEvents = suppressedShortcutEvents.filter(
      (item) => item.code !== code || item.phase !== phase
    );
  }

  function consumeSuppressedShortcut(code, phase) {
    const now = Date.now();
    suppressedShortcutEvents = suppressedShortcutEvents.filter((item) => item.expiresAt > now);
    const index = suppressedShortcutEvents.findIndex(
      (item) => item.code === code && item.phase === phase
    );
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
    const activeElement = gameInputContextActive ? undefined : document.activeElement;
    const ignoresShortcut = shouldIgnoreShortcutEvent(event, activeElement, document.designMode);
    if (!ignoresShortcut) {
      preventGameBrowserDefault(event);
    }
    if (consumeSuppressedShortcut(event.code, "keydown")) {
      return;
    }
    if (ignoresShortcut) {
      return;
    }
    if (isReservedBrowserZoomShortcutEvent(event)) {
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
    if (consumeSuppressedShortcut(event.code, "keyup")) {
      return;
    }
    const matches = [...activeHeldShortcuts.entries()].filter(
      ([, active]) => active.code === event.code
    );
    if (matches.length === 0) return;
    consumeShortcutEvent(event);
    matches.forEach(([macroId, active]) => {
      activeHeldShortcuts.delete(macroId);
      runAction("release", macroId, {
        pressId: active.pressId,
        releaseMode: "complete_first_iteration"
      }, true);
    });
  }

  function releaseActiveHeldShortcuts() {
    [...activeHeldShortcuts.entries()].forEach(([macroId, active]) => {
      activeHeldShortcuts.delete(macroId);
      runAction("release", macroId, {
        pressId: active.pressId,
        releaseMode: "immediate"
      }, true);
    });
  }

  function handleFocus() {
    scheduleGameInputContextRefresh();
    void refresh();
  }

  function handleBlur() {
    reportGameInputContext(false);
    releaseActiveHeldShortcuts();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      reportGameInputContext(false);
      releaseActiveHeldShortcuts();
      return;
    }
    scheduleGameInputContextRefresh();
  }

  function dispose() {
    isDisposed = true;
    refreshQueued = false;
    reportGameInputContext(false);
    releaseActiveHeldShortcuts();
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keyup", handleKeyUp, true);
    window.removeEventListener("wheel", handleGameWheel, true);
    window.removeEventListener("focus", handleFocus, true);
    window.removeEventListener("blur", handleBlur, true);
    window.removeEventListener("pagehide", handleBlur, true);
    window.removeEventListener("pointerdown", handleGameSurfacePointerDown, true);
    document.removeEventListener("focusin", handleGameSurfaceFocusIn, true);
    document.removeEventListener("focusout", handleGameSurfaceFocusOut, true);
    document.removeEventListener("pointerlockchange", refreshGameInputContext, true);
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

    isDisposed = false;
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("wheel", handleGameWheel, { capture: true, passive: false });
    window.addEventListener("focus", handleFocus, true);
    window.addEventListener("blur", handleBlur, true);
    window.addEventListener("pagehide", handleBlur, true);
    window.addEventListener("pointerdown", handleGameSurfacePointerDown, true);
    document.addEventListener("focusin", handleGameSurfaceFocusIn, true);
    document.addEventListener("focusout", handleGameSurfaceFocusOut, true);
    document.addEventListener("pointerlockchange", refreshGameInputContext, true);
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
    refreshGameInputContext();
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
