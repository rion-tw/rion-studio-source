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
  const scriptVersion = "2026-07-16.4";
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
      overlayCss,
      "</style>",
      runningBadges ? '<div class="active-badges" aria-hidden="true">' + runningBadges + "</div>" : "",
      '<div class="toolbar">',
      resourceLabel ? '<div class="resource-state" title="' + escapeHtml(resourceLabel) + '">' + escapeHtml(resourceLabel) + "</div>" : "",
      '<button class="trigger" type="button" tabindex="-1" title="' + escapeHtml(text.triggerTitle) + '" aria-label="' + escapeHtml(text.triggerAria) + '">',
      triggerIconMarkup,
      "</button>",
      "</div>",
      state.notice ? '<div class="notice" role="status">' + escapeHtml(state.notice) + "</div>" : "",
      '<div class="panel" data-open="',
      state.isOpen ? "true" : "false",
      '" role="menu">',
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
