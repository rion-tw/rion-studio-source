(() => {
  const hostId = "rion-studio-macro-overlay-v60";
  const controllerKey = "__rionStudioMacroOverlay";
  const scriptVersion = "2026-08-12.1";
  const shouldIgnoreShortcutEvent = "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__";
  const isTrustedUserEvent = "__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__";
  const overlayCss = "__RION_STUDIO_MACRO_OVERLAY_CSS__";
  const coordinateMeasurementModuleSource = "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE__";
  const importCoordinateMeasurementModule = "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER__";
  const hostStyleEntries = [
    ["bottom", "auto"],
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
  const binding = "__RION_STUDIO_MACRO_OVERLAY_BINDING__";
  const overlayTexts = {
    en: {
      holdUntilStop: "Hold",
      coordinateCopied: "Copied",
      coordinateCopyFailed: "Unable to copy coordinates. Try again.",
      coordinateCopying: "Copying…",
      coordinateAnchor: "Anchor",
      coordinateMeasure: "Measure coordinates",
      coordinateMeasureAria: "Measure game coordinates",
      coordinateMeasureHint: "Click to copy · Esc to cancel",
      triggerAria: "Open Rion Studio Macros",
      triggerTitle: "Open Rion Studio Macros (Ctrl+Shift+M)",
      tapOrHold: "Tap or hold"
    },
    "zh-TW": {
      holdUntilStop: "保持",
      coordinateCopied: "已複製",
      coordinateCopyFailed: "無法複製座標，請再試一次。",
      coordinateCopying: "複製中…",
      coordinateAnchor: "錨點",
      coordinateMeasure: "測量座標",
      coordinateMeasureAria: "測量遊戲座標",
      coordinateMeasureHint: "點擊複製 · Esc 取消",
      triggerAria: "開啟 Rion Studio 巨集",
      triggerTitle: "開啟 Rion Studio 巨集 (Ctrl+Shift+M)",
      tapOrHold: "點按或按住"
    },
    "zh-CN": {
      holdUntilStop: "保持",
      coordinateCopied: "已复制",
      coordinateCopyFailed: "无法复制坐标，请重试。",
      coordinateCopying: "复制中…",
      coordinateAnchor: "锚点",
      coordinateMeasure: "测量坐标",
      coordinateMeasureAria: "测量游戏坐标",
      coordinateMeasureHint: "点击复制 · Esc 取消",
      triggerAria: "打开 Rion Studio 宏",
      triggerTitle: "打开 Rion Studio 宏 (Ctrl+Shift+M)",
      tapOrHold: "点按或按住"
    },
    ja: {
      holdUntilStop: "保持",
      coordinateCopied: "コピーしました",
      coordinateCopyFailed: "座標をコピーできません。もう一度お試しください。",
      coordinateCopying: "コピー中…",
      coordinateAnchor: "アンカー",
      coordinateMeasure: "座標を測定",
      coordinateMeasureAria: "ゲーム座標を測定",
      coordinateMeasureHint: "クリックでコピー · Esc でキャンセル",
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
  const coordinateIconMarkup = [
    '<svg class="coordinate-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M12 3v18"/>',
    '<path d="M3 12h18"/>',
    '<circle cx="12" cy="12" r="3"/>',
    "</svg>"
  ].join("");
  const clickMarkerIconMarkup = [
    '<svg class="click-marker-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
    '<circle class="click-marker-ring" cx="12" cy="12" r="4.5"/>',
    '<circle class="click-marker-dot" cx="12" cy="12" r="1.5"/>',
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
  let actionMenuElement = null;
  let appliedPageZoom = 1;
  let appliedPageZoomKnown = false;
  let appliedPageZoomRequestRevision = 0;
  const activeHeldShortcuts = new Map();
  const clickMarkerEvents = new Map();
  const clickMarkerFlashStates = new Map();
  const clickMarkerFlashDurationMs = 120;
  const clickStatusRetentionMs = 180;
  const retainedClickStatuses = new Map();
  const seenClickStatusEvents = new Map();
  let clickStatusRetentionTimer = undefined;
  let latestCoreStatuses = [];
  const macroIterationTimings = new Map();
  let renderedActiveBadgesMarkup = null;
  let renderedClickOverlayMarkup = null;
  let coordinateMeasurementController = null;
  let coordinateMeasurementLoadGeneration = 0;
  let coordinateMeasurementModulePromise = null;
  let coordinateMeasurementModuleUrl = null;
  let coordinateMeasurementPending = false;
  let clickMarkerLayerElement = null;
  let coordinateMeasureHideTimer = undefined;
  let gameInputContextActive = false;
  let host = null;
  let isDisposed = false;
  let isInstalled = false;
  let isOpenRequestPending = false;
  let refreshInFlight = null;
  let refreshQueued = false;
  let root = null;
  let suppressedShortcutEvents = [];
  let triggerElement = null;

  if (typeof binding !== "function") {
    return;
  }


  if (window[controllerKey]?.version === scriptVersion) {
    void window[controllerKey].refresh();
    return;
  }

  window[controllerKey]?.dispose?.();
  removeVisualHosts();
  delete window[controllerKey];

  const state = {
    language: detectOverlayLanguage(),
    lastRefreshAt: 0,
    macroBadgePosition: {
      horizontalAlign: "center",
      horizontalMarginPx: 8,
      topPx: 128
    },
    macroOverlay: {
      showClickMarkers: true,
      showRunningBadges: true,
      showToolButton: true
    },
    macros: [],
    requestVersion: 0,
    resolvedTheme: "light",
    shortcutMacroIds: [],
    shortcutStatuses: [],
    statuses: []
  };
  const pendingMacroActions = new Map();
  const macroActionTails = new Map();
  let nextPressId = 1;

  function isCanvas(candidate) {
    return typeof HTMLCanvasElement !== "undefined" && candidate instanceof HTMLCanvasElement;
  }

  function eventPathCanvas(event) {
    try {
      return event.composedPath().find(isCanvas) ?? null;
    } catch {
      return isCanvas(event.target) ? event.target : null;
    }
  }

  function eventPathIncludesCanvas(event) {
    return eventPathCanvas(event) !== null;
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
    const activeCanvas = [getDeepActiveElement(), document.pointerLockElement].find(isCanvas);
    if (activeCanvas) rememberMacroGameCanvas(activeCanvas);
    reportGameInputContext(Boolean(activeCanvas));
  }

  function scheduleGameInputContextRefresh() {
    Promise.resolve().then(() => {
      if (!isDisposed) refreshGameInputContext();
    });
  }

  function handleGameSurfacePointerDown(event) {
    // A physical pointer event can arrive while this document already owns the
    // keyboard responder. Reapplying native WebView focus in that state resets
    // held-key input in both WKWebView and WebView2 (for example, W + right
    // mouse). Only use the shell focus fallback when the document is actually
    // unfocused.
    if (!document.hasFocus()) {
      void Promise.resolve(binding({ type: "activate" })).catch(() => undefined);
    }
    const canvas = eventPathCanvas(event);
    if (canvas) {
      rememberMacroGameCanvas(canvas);
      reportGameInputContext(true);
      return;
    }
    scheduleGameInputContextRefresh();
  }

  function handleGameSurfaceFocusIn(event) {
    const canvas = eventPathCanvas(event);
    if (canvas) rememberMacroGameCanvas(canvas);
    handleMacroGameFocusIn(event);
    reportGameInputContext(Boolean(canvas) || hasActiveGameCanvas());
  }

  function handleGameSurfaceFocusOut(event) {
    handleMacroGameFocusOut(event);
    scheduleGameInputContextRefresh();
  }

  function isMacPlatform() {
    const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
    return /mac/i.test(String(platform));
  }

  function isSystemOwnedShortcut(event) {
    if (event.code === "Tab" && (event.ctrlKey || event.metaKey || event.altKey)) return true;
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

  function isReservedRuntimeTabSwitchShortcutEvent(event) {
    return event.code === "Tab" && event.ctrlKey && !event.altKey && !event.metaKey;
  }

  const runtimeTabShortcutModifierCodes = new Set();

  function updateRuntimeTabShortcutModifier(event, pressed) {
    if (!["ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight"].includes(event.code)) {
      return;
    }
    if (pressed) runtimeTabShortcutModifierCodes.add(event.code);
    else runtimeTabShortcutModifierCodes.delete(event.code);
  }

  function currentRuntimeTabShortcutModifierCodes(event) {
    const codes = [...runtimeTabShortcutModifierCodes];
    if (event.ctrlKey && !codes.some((code) => code.startsWith("Control"))) {
      codes.push("ControlLeft");
    }
    if (event.shiftKey && !codes.some((code) => code.startsWith("Shift"))) {
      codes.push("ShiftLeft");
    }
    return codes;
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

  function getVisualViewportSize() {
    const visualViewport = window.visualViewport;
    const documentWidth = Number(document.documentElement?.clientWidth) || 0;
    const documentHeight = Number(document.documentElement?.clientHeight) || 0;
    const width = Number(visualViewport?.width) || documentWidth || Number(window.innerWidth) || 1;
    const height = Number(visualViewport?.height) || documentHeight || Number(window.innerHeight) || 1;
    return {
      height: Math.max(1, Math.round(Number(height) || 1)),
      width: Math.max(1, Math.round(Number(width) || 1))
    };
  }

  function clampCoordinate(value, maximum) {
    return Math.max(0, Math.min(maximum - 1, Math.round(Number(value) || 0)));
  }

  function cancelCoordinateMeasureHide() {
    if (coordinateMeasureHideTimer !== undefined) {
      clearTimeout(coordinateMeasureHideTimer);
      coordinateMeasureHideTimer = undefined;
    }
  }

  function setActionMenuVisible(visible) {
    if (!actionMenuElement || coordinateMeasurementController || coordinateMeasurementPending) return;
    actionMenuElement.hidden = !visible;
  }

  function scheduleActionMenuHide() {
    cancelCoordinateMeasureHide();
    // event-topology: presentation
    coordinateMeasureHideTimer = setTimeout(() => {
      coordinateMeasureHideTimer = undefined;
      setActionMenuVisible(false);
    }, 140);
  }

  function revokeCoordinateMeasurementModuleUrl() {
    if (!coordinateMeasurementModuleUrl) return;
    window.URL.revokeObjectURL(coordinateMeasurementModuleUrl);
    coordinateMeasurementModuleUrl = null;
  }

  function resetCoordinateMeasurementModuleLoader() {
    coordinateMeasurementModulePromise = null;
    revokeCoordinateMeasurementModuleUrl();
  }

  function loadCoordinateMeasurementModule() {
    if (coordinateMeasurementModulePromise) return coordinateMeasurementModulePromise;
    coordinateMeasurementModuleUrl = window.URL.createObjectURL(new window.Blob(
      [coordinateMeasurementModuleSource],
      { type: "text/javascript" }
    ));
    const moduleUrl = coordinateMeasurementModuleUrl;
    const modulePromise = importCoordinateMeasurementModule(moduleUrl).catch((error) => {
      if (coordinateMeasurementModulePromise === modulePromise) {
        resetCoordinateMeasurementModuleLoader();
      }
      throw error;
    });
    coordinateMeasurementModulePromise = modulePromise;
    return modulePromise;
  }

  function destroyCoordinateMeasurement() {
    coordinateMeasurementLoadGeneration += 1;
    coordinateMeasurementPending = false;
    const controller = coordinateMeasurementController;
    coordinateMeasurementController = null;
    controller?.destroy();
  }

  async function copyCoordinateMeasurement(coordinate) {
    const nextState = await binding({ type: "copy-coordinate", ...coordinate });
    if (disposeIfDetached(nextState)) return;
    applyState(nextState);
    updatePresentation();
  }

  async function getCoordinateMeasurementContext() {
    const context = await binding({ type: "coordinate-context" });
    const zoom = Number(context?.appliedPageZoom);
    if (!Number.isFinite(zoom) || zoom <= 0) {
      throw new Error("Rion Studio coordinate context is invalid.");
    }
    appliedPageZoom = zoom;
    appliedPageZoomKnown = true;
    return context;
  }

  function hasReferencePixelMacroSteps() {
    return state.macros.some((macro) => Array.isArray(macro?.steps) && macro.steps.some(
      (step) => step?.type === "click" && step.unit === "reference-px"
    ));
  }

  async function refreshAppliedPageZoomForMarkers() {
    const requestRevision = ++appliedPageZoomRequestRevision;
    try {
      await getCoordinateMeasurementContext();
      if (requestRevision === appliedPageZoomRequestRevision && !isDisposed) {
        renderClickMarkers();
      }
    } catch (error) {
      if (requestRevision === appliedPageZoomRequestRevision && !isDisposed) {
        console.warn("Unable to refresh Rion Studio click marker page zoom.", error);
      }
    }
  }

  async function startCoordinateMeasurement() {
    if (
      isDisposed ||
      coordinateMeasurementController ||
      coordinateMeasurementPending ||
      !root ||
      !host?.isConnected
    ) {
      return;
    }
    cancelCoordinateMeasureHide();
    setActionMenuVisible(false);
    coordinateMeasurementPending = true;
    const generation = ++coordinateMeasurementLoadGeneration;
    let loadFailed = false;
    try {
      const [measurementModule, coordinateContext] = await Promise.all([
        loadCoordinateMeasurementModule(),
        getCoordinateMeasurementContext()
      ]);
      if (
        isDisposed ||
        !coordinateMeasurementPending ||
        generation !== coordinateMeasurementLoadGeneration ||
        !root ||
        !host?.isConnected
      ) {
        return;
      }
      if (typeof measurementModule?.createMacroCoordinateMeasurement !== "function") {
        throw new Error("Rion Studio coordinate measurement module is invalid.");
      }
      let controller = null;
      controller = measurementModule.createMacroCoordinateMeasurement({
        copyCoordinate: copyCoordinateMeasurement,
        getCoordinateContext: getCoordinateMeasurementContext,
        getText,
        initialCoordinateContext: coordinateContext,
        isTrustedUserEvent,
        onCancel: () => {
          if (coordinateMeasurementController === controller) destroyCoordinateMeasurement();
        },
        onComplete: () => {
          if (coordinateMeasurementController === controller) destroyCoordinateMeasurement();
        },
        root
      });
      coordinateMeasurementController = controller;
    } catch (error) {
      if (generation === coordinateMeasurementLoadGeneration && !isDisposed) {
        loadFailed = true;
        resetCoordinateMeasurementModuleLoader();
        console.warn("Unable to load Rion Studio coordinate measurement.", error);
      }
    } finally {
      if (generation === coordinateMeasurementLoadGeneration) {
        coordinateMeasurementPending = false;
        if (loadFailed) setActionMenuVisible(true);
      }
    }
  }

  function handleCoordinateKeyDown(event) {
    if (coordinateMeasurementController) {
      return coordinateMeasurementController.handleKeyDown(event);
    }
    if (!coordinateMeasurementPending) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape") destroyCoordinateMeasurement();
    return true;
  }

  function handleCoordinateKeyPress(event) {
    if (coordinateMeasurementController) {
      coordinateMeasurementController.handleKeyPress(event);
      return;
    }
    if (!coordinateMeasurementPending) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleOverlayViewportResize() {
    renderClickMarkers();
    if (hasReferencePixelMacroSteps()) void refreshAppliedPageZoomForMarkers();
  }

  function normalizeOverlayLanguage(language) {
    return language === "en" || language === "zh-TW" || language === "zh-CN" || language === "ja"
      ? language
      : undefined;
  }

  function normalizeResolvedTheme(theme, fallback = state.resolvedTheme) {
    return theme === "light" || theme === "dark" ? theme : fallback;
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

  function normalizeMacroOverlay(value, fallback = state.macroOverlay) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      showClickMarkers:
        typeof input.showClickMarkers === "boolean" ? input.showClickMarkers : fallback.showClickMarkers,
      showRunningBadges:
        typeof input.showRunningBadges === "boolean" ? input.showRunningBadges : fallback.showRunningBadges,
      showToolButton:
        typeof input.showToolButton === "boolean" ? input.showToolButton : fallback.showToolButton
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
    state.macroOverlay = normalizeMacroOverlay(nextState?.macroOverlay);
    state.macros = Array.isArray(nextState?.macros) ? nextState.macros : state.macros;
    if (hasReferencePixelMacroSteps() && !appliedPageZoomKnown) {
      void refreshAppliedPageZoomForMarkers();
    }
    state.shortcutMacroIds = Array.isArray(nextState?.shortcutMacroIds)
      ? nextState.shortcutMacroIds.map(String)
      : state.macros.filter((macro) => macro.trigger).map((macro) => String(macro.id));
    state.shortcutStatuses = Array.isArray(nextState?.shortcutStatuses)
      ? nextState.shortcutStatuses
      : [];
    state.resolvedTheme = normalizeResolvedTheme(nextState?.resolvedTheme);
    applyHostTheme();
    const activeMacroIds = new Set(state.macros.map((macro) => String(macro.id)));
    macroIterationTimings.forEach((_value, macroId) => {
      if (!activeMacroIds.has(macroId)) macroIterationTimings.delete(macroId);
    });
    seenClickStatusEvents.forEach((_value, key) => {
      const macroId = String(key).slice(String(key).indexOf(":") + 1);
      if (!activeMacroIds.has(macroId)) seenClickStatusEvents.delete(key);
    });
    retainedClickStatuses.forEach((_value, key) => {
      const macroId = String(key).slice(String(key).indexOf(":") + 1);
      if (!activeMacroIds.has(macroId)) retainedClickStatuses.delete(key);
    });
    if (Array.isArray(nextState?.statuses)) {
      latestCoreStatuses = nextState.statuses;
      retainAndApplyClickStatuses();
    }
    state.lastRefreshAt = Date.now();
  }

  function retainAndApplyClickStatuses() {
    const now = Date.now();
    const statuses = latestCoreStatuses.map((status) => ({ ...status }));
    statuses.forEach((status) => {
      if (!status?.lastClick) return;
      const key = String(status.roleId) + ":" + String(status.macroId);
      const eventKey = [
        status.startedAt,
        status.lastClick.stepId,
        status.lastClick.sequence
      ].join(":");
      if (seenClickStatusEvents.get(key) !== eventKey) {
        seenClickStatusEvents.set(key, eventKey);
        retainedClickStatuses.set(key, {
          eventKey,
          expiresAt: now + clickStatusRetentionMs,
          status: { ...status, clickFlash: true }
        });
      }
    });

    retainedClickStatuses.forEach((retained, key) => {
      if (retained.expiresAt <= now) {
        retainedClickStatuses.delete(key);
        return;
      }
      const index = statuses.findIndex(
        (status) => String(status.roleId) + ":" + String(status.macroId) === key
      );
      if (index >= 0) {
        const status = statuses[index];
        const eventKey = status.lastClick
          ? [status.startedAt, status.lastClick.stepId, status.lastClick.sequence].join(":")
          : "";
        if (eventKey === retained.eventKey) {
          statuses[index] = { ...status, clickFlash: true };
        }
      } else {
        statuses.push({ ...retained.status });
      }
    });
    state.statuses = statuses;
    scheduleClickStatusRetention();
  }

  function scheduleClickStatusRetention() {
    if (clickStatusRetentionTimer !== undefined) {
      clearTimeout(clickStatusRetentionTimer);
      clickStatusRetentionTimer = undefined;
    }
    if (retainedClickStatuses.size === 0 || isDisposed) return;
    const now = Date.now();
    const nextExpiry = Math.min(
      ...[...retainedClickStatuses.values()].map((retained) => retained.expiresAt)
    );
    // event-topology: presentation
    clickStatusRetentionTimer = setTimeout(() => {
      clickStatusRetentionTimer = undefined;
      retainAndApplyClickStatuses();
      updatePresentation();
    }, Math.max(0, nextExpiry - now));
  }

  function isRunning(macroId) {
    return getBadgeStatuses().some(
      (status) => status.macroId === macroId && status.state === "running"
    );
  }

  function isShortcutMacroId(macroId) {
    return state.shortcutMacroIds.some((id) => id === String(macroId));
  }

  function getBadgeStatuses() {
    const statusesByRoleAndMacro = new Map();
    [...state.shortcutStatuses, ...state.statuses].forEach((status) => {
      statusesByRoleAndMacro.set(
        String(status.roleId) + ":" + String(status.macroId),
        status
      );
    });
    return [...statusesByRoleAndMacro.values()];
  }

  function getRunningBadgeMacros() {
    return state.macros.filter((macro) => macro.enabled !== false && isRunning(macro.id));
  }

  function getMacroIteration(macroId) {
    const status = getBadgeStatuses()
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

  function getMacroClickAnchorBase(anchorValue) {
    const parts = String(anchorValue || "top-left").split("-");
    const vertical = parts[0];
    const horizontal = parts.length > 1 ? parts[1] : "center";
    return {
      xPercent: horizontal === "left" ? 0 : horizontal === "right" ? 100 : 50,
      yPercent: vertical === "top" ? 0 : vertical === "bottom" ? 100 : 50
    };
  }

  function resolveMacroClickMarkerPosition(step, viewport) {
    const anchor = getMacroClickAnchorBase(step.anchor);
    const isReferencePixel = step.unit === "reference-px";
    const isPixel = step.unit === "px" || isReferencePixel;
    const xOffset = Number(
      isReferencePixel ? step.xReferencePx : isPixel ? step.xPx : step.xPercent
    ) || 0;
    const yOffset = Number(
      isReferencePixel ? step.yReferencePx : isPixel ? step.yPx : step.yPercent
    ) || 0;
    const resolvedXOffset = isReferencePixel ? xOffset / appliedPageZoom : xOffset;
    const resolvedYOffset = isReferencePixel ? yOffset / appliedPageZoom : yOffset;
    const x = isPixel
      ? (viewport.width * anchor.xPercent) / 100 + resolvedXOffset
      : (viewport.width * (anchor.xPercent + xOffset)) / 100;
    const y = isPixel
      ? (viewport.height * anchor.yPercent) / 100 + resolvedYOffset
      : (viewport.height * (anchor.yPercent + yOffset)) / 100;
    return {
      xPx: clampCoordinate(x, viewport.width),
      yPx: clampCoordinate(y, viewport.height)
    };
  }

  function resolveMacroClickAnchorPosition(step, viewport) {
    const anchor = getMacroClickAnchorBase(step.anchor);
    return {
      xPx: clampCoordinate((viewport.width * anchor.xPercent) / 100, viewport.width),
      yPx: clampCoordinate((viewport.height * anchor.yPercent) / 100, viewport.height)
    };
  }

  function getRunningMacroStatuses(macroId) {
    return state.statuses.filter(
      (status) => status.macroId === macroId && status.state === "running"
    );
  }
