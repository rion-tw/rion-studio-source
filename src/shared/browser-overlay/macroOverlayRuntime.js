(() => {
  const hostId = "rion-studio-macro-overlay-v56";
  const legacyHostIds = [
    "rion-studio-macro-overlay",
    ...Array.from({ length: 54 }, (_value, index) => "rion-studio-macro-overlay-v" + (index + 2))
  ];
  const controllerKey = "__rionStudioMacroOverlay";
  const scriptVersion = "2026-07-29.1";
  const shouldIgnoreShortcutEvent = "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__";
  const isTrustedUserEvent = "__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__";
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
  const binding = "__RION_STUDIO_MACRO_OVERLAY_BINDING__";
  const overlayTexts = {
    en: {
      holdUntilStop: "Hold",
      noShortcut: "No shortcut",
      coordinateCopied: "Copied",
      coordinateCopyFailed: "Unable to copy coordinates. Try again.",
      coordinateCopying: "Copying…",
      coordinateMeasure: "Measure coordinates",
      coordinateMeasureAria: "Measure game coordinates",
      coordinateMeasureHint: "Click to copy · Esc to cancel",
      triggerAria: "Open Rion Studio Macros",
      triggerTitle: "Open Rion Studio Macros (Ctrl+Shift+M)",
      tapOrHold: "Tap or hold"
    },
    "zh-TW": {
      holdUntilStop: "保持",
      noShortcut: "無快捷鍵",
      coordinateCopied: "已複製",
      coordinateCopyFailed: "無法複製座標，請再試一次。",
      coordinateCopying: "複製中…",
      coordinateMeasure: "測量座標",
      coordinateMeasureAria: "測量遊戲座標",
      coordinateMeasureHint: "點擊複製 · Esc 取消",
      triggerAria: "開啟 Rion Studio 巨集",
      triggerTitle: "開啟 Rion Studio 巨集 (Ctrl+Shift+M)",
      tapOrHold: "點按或按住"
    },
    "zh-CN": {
      holdUntilStop: "保持",
      noShortcut: "无快捷键",
      coordinateCopied: "已复制",
      coordinateCopyFailed: "无法复制坐标，请重试。",
      coordinateCopying: "复制中…",
      coordinateMeasure: "测量坐标",
      coordinateMeasureAria: "测量游戏坐标",
      coordinateMeasureHint: "点击复制 · Esc 取消",
      triggerAria: "打开 Rion Studio 宏",
      triggerTitle: "打开 Rion Studio 宏 (Ctrl+Shift+M)",
      tapOrHold: "点按或按住"
    },
    ja: {
      holdUntilStop: "保持",
      noShortcut: "ショートカットなし",
      coordinateCopied: "コピーしました",
      coordinateCopyFailed: "座標をコピーできません。もう一度お試しください。",
      coordinateCopying: "コピー中…",
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
  const coordinateAnchorDefinitions = [
    { anchor: "top-left", xPercent: 0, yPercent: 0 },
    { anchor: "top-center", xPercent: 50, yPercent: 0 },
    { anchor: "top-right", xPercent: 100, yPercent: 0 },
    { anchor: "center-left", xPercent: 0, yPercent: 50 },
    { anchor: "center", xPercent: 50, yPercent: 50 },
    { anchor: "center-right", xPercent: 100, yPercent: 50 },
    { anchor: "bottom-left", xPercent: 0, yPercent: 100 },
    { anchor: "bottom-center", xPercent: 50, yPercent: 100 },
    { anchor: "bottom-right", xPercent: 100, yPercent: 100 }
  ];
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
  let renderedClickMarkersMarkup = null;
  let coordinateCopyInFlight = false;
  let coordinateMeasureActive = false;
  let coordinateAnchorLayerElement = null;
  let coordinateMeasureElement = null;
  let coordinateReadoutElement = null;
  let clickMarkerLayerElement = null;
  let coordinateMeasureHideTimer = undefined;
  let coordinateMeasureFrameId = undefined;
  let coordinateMeasurement = null;
  let pendingCoordinateMeasurement = null;
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

  removeLegacyHosts();

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
    macros: [],
    requestVersion: 0,
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
    void Promise.resolve(binding({ type: "activate" })).catch(() => undefined);
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

  function roundCoordinatePercent(value) {
    return Math.round(value * 100) / 100;
  }

  function coordinateMeasurementFromEvent(event) {
    const viewport = getVisualViewportSize();
    const xPx = clampCoordinate(event.clientX, viewport.width);
    const yPx = clampCoordinate(event.clientY, viewport.height);
    return {
      xPercent: roundCoordinatePercent((xPx / viewport.width) * 100),
      xPx,
      viewportHeightPx: viewport.height,
      viewportWidthPx: viewport.width,
      yPercent: roundCoordinatePercent((yPx / viewport.height) * 100),
      yPx
    };
  }

  function formatCoordinatePercent(value) {
    return String(roundCoordinatePercent(value));
  }

  function formatCoordinateMeasurement(measurement) {
    return [
      "X: ",
      String(measurement.xPx),
      "px (",
      formatCoordinatePercent(measurement.xPercent),
      "%), Y: ",
      String(measurement.yPx),
      "px (",
      formatCoordinatePercent(measurement.yPercent),
      "%)"
    ].join("");
  }

  function setCoordinateReadoutStatus(status) {
    if (!coordinateReadoutElement) return;
    coordinateReadoutElement.dataset.status = status || "ready";
    if (status === "copying") {
      coordinateReadoutElement.textContent = getText().coordinateCopying;
      return;
    }
    if (status === "failed") {
      coordinateReadoutElement.textContent = getText().coordinateCopyFailed;
      return;
    }
    if (status === "copied") {
      coordinateReadoutElement.textContent = getText().coordinateCopied;
      return;
    }
    if (coordinateMeasurement) {
      coordinateReadoutElement.textContent = formatCoordinateMeasurement(coordinateMeasurement);
    }
  }

  function updateCoordinateMeasurement(measurement) {
    coordinateMeasurement = measurement;
    if (!coordinateMeasureElement) return;
    const viewport = getVisualViewportSize();
    updateCoordinateAnchorGuides(viewport);
    coordinateMeasureElement.style.setProperty("--coordinate-x", String(measurement.xPx) + "px");
    coordinateMeasureElement.style.setProperty("--coordinate-y", String(measurement.yPx) + "px");
    coordinateMeasureElement.style.setProperty("--coordinate-width", String(viewport.width) + "px");
    coordinateMeasureElement.style.setProperty("--coordinate-height", String(viewport.height) + "px");
    if (!coordinateReadoutElement) return;
    coordinateReadoutElement.style.left = String(Math.min(measurement.xPx + 14, Math.max(8, viewport.width - 280))) + "px";
    coordinateReadoutElement.style.top = String(Math.min(measurement.yPx + 14, Math.max(8, viewport.height - 42))) + "px";
    setCoordinateReadoutStatus("ready");
  }

  function cancelCoordinateMeasurementFrame() {
    if (coordinateMeasureFrameId !== undefined) {
      cancelAnimationFrame(coordinateMeasureFrameId);
      coordinateMeasureFrameId = undefined;
    }
    pendingCoordinateMeasurement = null;
  }

  function flushCoordinateMeasurement() {
    if (coordinateMeasureFrameId !== undefined) {
      cancelAnimationFrame(coordinateMeasureFrameId);
      coordinateMeasureFrameId = undefined;
    }
    const measurement = pendingCoordinateMeasurement;
    pendingCoordinateMeasurement = null;
    if (measurement && coordinateMeasureActive) {
      updateCoordinateMeasurement(measurement);
    }
  }

  function scheduleCoordinateMeasurement(measurement) {
    pendingCoordinateMeasurement = measurement;
    if (coordinateMeasureFrameId !== undefined) return;
    coordinateMeasureFrameId = requestAnimationFrame(() => {
      coordinateMeasureFrameId = undefined;
      const nextMeasurement = pendingCoordinateMeasurement;
      pendingCoordinateMeasurement = null;
      if (nextMeasurement && coordinateMeasureActive) {
        updateCoordinateMeasurement(nextMeasurement);
      }
    });
  }

  function updateCoordinateAnchorGuides(viewport = getVisualViewportSize()) {
    if (!coordinateAnchorLayerElement) return;
    const markers = coordinateAnchorLayerElement.querySelectorAll(".coordinate-anchor-marker");
    coordinateAnchorDefinitions.forEach((definition, index) => {
      const marker = markers[index];
      if (!marker) return;
      marker.style.left = String(clampCoordinate((viewport.width * definition.xPercent) / 100, viewport.width)) + "px";
      marker.style.top = String(clampCoordinate((viewport.height * definition.yPercent) / 100, viewport.height)) + "px";
    });
  }

  function handleCoordinateViewportResize() {
    if (coordinateMeasureActive) {
      updateCoordinateAnchorGuides();
    }
    renderClickMarkers();
  }

  function cancelCoordinateMeasureHide() {
    if (coordinateMeasureHideTimer !== undefined) {
      clearTimeout(coordinateMeasureHideTimer);
      coordinateMeasureHideTimer = undefined;
    }
  }

  function setActionMenuVisible(visible) {
    if (!actionMenuElement || coordinateMeasureActive) return;
    actionMenuElement.hidden = !visible;
  }

  function scheduleActionMenuHide() {
    cancelCoordinateMeasureHide();
    coordinateMeasureHideTimer = setTimeout(() => {
      coordinateMeasureHideTimer = undefined;
      setActionMenuVisible(false);
    }, 140);
  }

  function startCoordinateMeasurement() {
    cancelCoordinateMeasureHide();
    cancelCoordinateMeasurementFrame();
    setActionMenuVisible(false);
    if (!coordinateMeasureElement) return;
    coordinateMeasureActive = true;
    coordinateCopyInFlight = false;
    coordinateMeasureElement.hidden = false;
    if (coordinateAnchorLayerElement) {
      coordinateAnchorLayerElement.hidden = false;
    }
    const viewport = getVisualViewportSize();
    const xPx = Math.floor(viewport.width / 2);
    const yPx = Math.floor(viewport.height / 2);
    updateCoordinateMeasurement({
      xPercent: roundCoordinatePercent((xPx / viewport.width) * 100),
      xPx,
      viewportHeightPx: viewport.height,
      viewportWidthPx: viewport.width,
      yPercent: roundCoordinatePercent((yPx / viewport.height) * 100),
      yPx
    });
  }

  function stopCoordinateMeasurement() {
    cancelCoordinateMeasurementFrame();
    coordinateMeasureActive = false;
    coordinateCopyInFlight = false;
    coordinateMeasurement = null;
    if (coordinateMeasureElement) {
      coordinateMeasureElement.hidden = true;
    }
    if (coordinateAnchorLayerElement) {
      coordinateAnchorLayerElement.hidden = true;
    }
  }

  async function copyCoordinateMeasurement() {
    if (!coordinateMeasureActive || coordinateCopyInFlight || !coordinateMeasurement) return;
    coordinateCopyInFlight = true;
    setCoordinateReadoutStatus("copying");
    try {
      const nextState = await binding({ type: "copy-coordinate", ...coordinateMeasurement });
      if (disposeIfDetached(nextState)) return;
      applyState(nextState);
      updatePresentation();
      stopCoordinateMeasurement();
    } catch (error) {
      coordinateCopyInFlight = false;
      setCoordinateReadoutStatus("failed");
      console.warn("Unable to copy Rion Studio game coordinates.", error);
    }
  }

  function handleCoordinatePointerMove(event) {
    if (!coordinateMeasureActive) return;
    event.preventDefault();
    event.stopPropagation();
    scheduleCoordinateMeasurement(coordinateMeasurementFromEvent(event));
  }

  function handleCoordinatePointerDown(event) {
    if (!coordinateMeasureActive) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleCoordinateClick(event) {
    if (!coordinateMeasureActive || !isTrustedUserEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    pendingCoordinateMeasurement = coordinateMeasurementFromEvent(event);
    flushCoordinateMeasurement();
    void copyCoordinateMeasurement();
  }

  function handleCoordinateKeyDown(event) {
    if (!coordinateMeasureActive) return false;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape") {
      stopCoordinateMeasurement();
    }
    return true;
  }

  function handleCoordinateKeyPress(event) {
    if (!coordinateMeasureActive) return;
    event.preventDefault();
    event.stopPropagation();
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
    clickStatusRetentionTimer = setTimeout(() => {
      clickStatusRetentionTimer = undefined;
      retainAndApplyClickStatuses();
      updatePresentation();
    }, Math.max(0, nextExpiry - now));
  }

  function isRunning(macroId) {
    return state.statuses.some((status) => status.macroId === macroId && status.state === "running");
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
    const isPixel = step.unit === "px";
    const xOffset = Number(isPixel ? step.xPx : step.xPercent) || 0;
    const yOffset = Number(isPixel ? step.yPx : step.yPercent) || 0;
    const x = isPixel
      ? (viewport.width * anchor.xPercent) / 100 + xOffset
      : (viewport.width * (anchor.xPercent + xOffset)) / 100;
    const y = isPixel
      ? (viewport.height * anchor.yPercent) / 100 + yOffset
      : (viewport.height * (anchor.yPercent + yOffset)) / 100;
    return {
      xPx: clampCoordinate(x, viewport.width),
      yPx: clampCoordinate(y, viewport.height)
    };
  }

  function getRunningMacroStatuses(macroId) {
    return state.statuses.filter(
      (status) => status.macroId === macroId && status.state === "running"
    );
  }

  function renderClickMarkers() {
    if (!clickMarkerLayerElement) return;
    const viewport = getVisualViewportSize();
    const markersByPosition = new Map();
    state.macros
      .filter((macro) => macro.enabled !== false)
      .forEach((macro) => {
        const statuses = getRunningMacroStatuses(macro.id);
        if (statuses.length === 0) return;
        (macro.steps || []).forEach((step) => {
          if (step.type !== "click") return;
          const position = resolveMacroClickMarkerPosition(step, viewport);
          const key = String(position.xPx) + ":" + String(position.yPx);
          let marker = markersByPosition.get(key);
          if (!marker) {
            marker = { key, sources: [], xPx: position.xPx, yPx: position.yPx };
            markersByPosition.set(key, marker);
          }
          statuses.forEach((status) => {
            marker.sources.push({
              eventKey: status.lastClick?.stepId === step.id && status.lastClick.sequence > 0
                ? [status.startedAt, status.lastClick.stepId, status.lastClick.sequence].join(":")
                : undefined,
              shouldFlash: status.clickFlash === true,
              macroId: macro.id,
              stepId: step.id
            });
          });
        });
      });

    const markers = [...markersByPosition.values()];
    const activeMarkerKeys = new Set(markers.map((marker) => marker.key));
    clickMarkerEvents.forEach((_value, key) => {
      if (!activeMarkerKeys.has(key)) clickMarkerEvents.delete(key);
    });
    clickMarkerFlashStates.forEach((_value, key) => {
      if (!activeMarkerKeys.has(key)) clickMarkerFlashStates.delete(key);
    });
    const nextMarkup = markers.map((marker) => {
      const eventKey = marker.sources
        .map((source) => source.eventKey)
        .filter(Boolean)
        .sort()
        .join("|");
      const previousEventKey = clickMarkerEvents.get(marker.key);
      const isNewClick =
        eventKey.length > 0 &&
        previousEventKey !== eventKey &&
        (previousEventKey !== undefined || marker.sources.some((source) => source.shouldFlash));
      if (isNewClick) {
        clickMarkerFlashStates.set(marker.key, {
          eventKey,
          expiresAt: Date.now() + clickMarkerFlashDurationMs
        });
      }
      const flashState = clickMarkerFlashStates.get(marker.key);
      const isClickFlashActive =
        flashState?.eventKey === eventKey && flashState.expiresAt > Date.now();
      if (flashState && !isClickFlashActive) {
        clickMarkerFlashStates.delete(marker.key);
      }
      clickMarkerEvents.set(marker.key, eventKey);
      const flashClass = isClickFlashActive ? " is-click-flash" : "";
      return [
        '<span class="click-marker',
        flashClass,
        '" data-marker-key="',
        marker.key,
        '" style="--click-marker-x:',
        String(marker.xPx),
        'px;--click-marker-y:',
        String(marker.yPx),
        'px">',
        clickMarkerIconMarkup,
        "</span>"
      ].join("");
    }).join("");

    if (nextMarkup !== renderedClickMarkersMarkup) {
      clickMarkerLayerElement.innerHTML = nextMarkup;
      renderedClickMarkersMarkup = nextMarkup;
    }
    clickMarkerLayerElement.hidden = markers.length === 0;
  }

  function handleClickMarkerAnimationEnd(event) {
    const marker = event.target?.closest?.(".click-marker.is-click-flash");
    if (!marker) return;
    marker.classList.remove("is-click-flash");
    clickMarkerFlashStates.delete(marker.dataset.markerKey);
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
      cancelCoordinateMeasureHide();
      cancelCoordinateMeasurementFrame();
      activeBadgesElement = null;
      actionMenuElement = null;
      clickMarkerLayerElement = null;
      host = null;
      renderedActiveBadgesMarkup = null;
      renderedClickMarkersMarkup = null;
      root = null;
      triggerElement = null;
      coordinateMeasureElement = null;
      coordinateAnchorLayerElement = null;
      coordinateReadoutElement = null;
      coordinateMeasureActive = false;
      coordinateCopyInFlight = false;
      coordinateMeasurement = null;
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

    if (host?.isConnected && root && triggerElement && actionMenuElement && clickMarkerLayerElement && coordinateAnchorLayerElement && coordinateMeasureElement) {
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
      '<div class="click-marker-layer" hidden aria-hidden="true"></div>',
      '<div class="active-badges" aria-hidden="true"></div>',
      '<div class="toolbar">',
      '<button class="trigger" type="button" tabindex="-1">',
      triggerIconMarkup,
      "</button>",
      '<div class="action-menu" hidden role="menu">',
      '<button class="action-menu-item" type="button" role="menuitem" tabindex="-1">',
      coordinateIconMarkup,
      '<span class="action-menu-label"></span>',
      "</button>",
      "</div>",
      "</div>",
      '<div class="coordinate-picker" hidden>',
      '<div class="coordinate-anchor-layer" hidden aria-hidden="true">',
      coordinateAnchorDefinitions.map((definition) => '<div class="coordinate-anchor-marker" data-anchor="' + definition.anchor + '"></div>').join(""),
      "</div>",
      '<div class="coordinate-line coordinate-line-horizontal"></div>',
      '<div class="coordinate-line coordinate-line-vertical"></div>',
      '<div class="coordinate-readout"></div>',
      '<div class="coordinate-hint"></div>',
      "</div>"
    ].join("");
    activeBadgesElement = root.querySelector(".active-badges");
    clickMarkerLayerElement = root.querySelector(".click-marker-layer");
    triggerElement = root.querySelector(".trigger");
    actionMenuElement = root.querySelector(".action-menu");
    coordinateAnchorLayerElement = root.querySelector(".coordinate-anchor-layer");
    coordinateMeasureElement = root.querySelector(".coordinate-picker");
    coordinateReadoutElement = root.querySelector(".coordinate-readout");
    clickMarkerLayerElement?.addEventListener("animationend", handleClickMarkerAnimationEnd);
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
      if (!isTrustedUserEvent(event)) return;
      setActionMenuVisible(false);
      void requestOpenMacroPage();
    });
    triggerElement?.addEventListener("pointerenter", () => {
      cancelCoordinateMeasureHide();
      setActionMenuVisible(true);
    });
    triggerElement?.addEventListener("pointerleave", scheduleActionMenuHide);
    triggerElement?.addEventListener("mouseenter", () => {
      cancelCoordinateMeasureHide();
      setActionMenuVisible(true);
    });
    triggerElement?.addEventListener("mouseleave", scheduleActionMenuHide);
    actionMenuElement?.addEventListener("pointerenter", cancelCoordinateMeasureHide);
    actionMenuElement?.addEventListener("pointerleave", scheduleActionMenuHide);
    actionMenuElement?.addEventListener("mouseenter", cancelCoordinateMeasureHide);
    actionMenuElement?.addEventListener("mouseleave", scheduleActionMenuHide);
    const coordinateAction = actionMenuElement?.querySelector(".action-menu-item");
    coordinateAction?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    coordinateAction?.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    coordinateAction?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!isTrustedUserEvent(event)) return;
      startCoordinateMeasurement();
    });
    coordinateMeasureElement?.addEventListener("pointermove", handleCoordinatePointerMove);
    coordinateMeasureElement?.addEventListener("mousemove", handleCoordinatePointerMove);
    ["pointerdown", "mousedown", "pointerup", "mouseup", "wheel", "contextmenu"].forEach((eventName) => {
      coordinateMeasureElement?.addEventListener(eventName, handleCoordinatePointerDown, { passive: false });
    });
    coordinateMeasureElement?.addEventListener("click", handleCoordinateClick);
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
    if (!ensureHost() || !triggerElement || !activeBadgesElement) {
      return;
    }

    updateActiveBadgesPosition();
    renderClickMarkers();
    const text = getText();
    triggerElement.title = text.triggerTitle;
    triggerElement.setAttribute("aria-label", text.triggerAria);
    const coordinateAction = actionMenuElement?.querySelector(".action-menu-item");
    if (coordinateAction) {
      coordinateAction.setAttribute("aria-label", text.coordinateMeasureAria);
      coordinateAction.title = text.coordinateMeasureAria;
      const label = coordinateAction.querySelector(".action-menu-label");
      if (label) label.textContent = text.coordinateMeasure;
    }
    const coordinateHint = coordinateMeasureElement?.querySelector(".coordinate-hint");
    if (coordinateHint) coordinateHint.textContent = text.coordinateMeasureHint;
    if (coordinateMeasureActive && coordinateMeasurement && coordinateReadoutElement?.dataset.status === "ready") {
      setCoordinateReadoutStatus("ready");
    }

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
    if (!isTrustedUserEvent(event)) {
      return;
    }
    if (handleCoordinateKeyDown(event)) {
      return;
    }
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
    if (isReservedBrowserZoomShortcutEvent(event) || isReservedRuntimeTabSwitchShortcutEvent(event)) {
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
    runAction("toggle", macro.id, undefined, true);
  }

  function handleKeyUp(event) {
    if (!isTrustedUserEvent(event)) {
      return;
    }
    if (coordinateMeasureActive) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
    stopCoordinateMeasurement();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      reportGameInputContext(false);
      releaseActiveHeldShortcuts();
      stopCoordinateMeasurement();
      return;
    }
    scheduleGameInputContextRefresh();
    void refresh();
  }

  function dispose() {
    isDisposed = true;
    refreshQueued = false;
    cancelCoordinateMeasureHide();
    stopCoordinateMeasurement();
    reportGameInputContext(false);
    releaseActiveHeldShortcuts();
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keypress", handleCoordinateKeyPress, true);
    window.removeEventListener("keyup", handleKeyUp, true);
    window.removeEventListener("wheel", handleGameWheel, true);
    window.removeEventListener("focus", handleFocus, true);
    window.removeEventListener("blur", handleBlur, true);
    window.removeEventListener("pagehide", handleBlur, true);
    window.removeEventListener("resize", handleCoordinateViewportResize, true);
    window.visualViewport?.removeEventListener("resize", handleCoordinateViewportResize);
    window.removeEventListener("pointerdown", handleGameSurfacePointerDown, true);
    document.removeEventListener("focusin", handleGameSurfaceFocusIn, true);
    document.removeEventListener("focusout", handleGameSurfaceFocusOut, true);
    document.removeEventListener("pointerlockchange", refreshGameInputContext, true);
    document.removeEventListener("visibilitychange", handleVisibilityChange, true);

    if (clickStatusRetentionTimer !== undefined) {
      clearTimeout(clickStatusRetentionTimer);
      clickStatusRetentionTimer = undefined;
    }
    retainedClickStatuses.clear();
    seenClickStatusEvents.clear();
    activeHeldShortcuts.clear();
    clickMarkerEvents.clear();
    clickMarkerFlashStates.clear();
    macroIterationTimings.clear();
    pendingMacroActions.clear();
    macroActionTails.clear();
    latestCoreStatuses = [];
    state.macros = [];
    state.statuses = [];
    suppressedShortcutEvents = [];

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
    window.addEventListener("keypress", handleCoordinateKeyPress, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("wheel", handleGameWheel, { capture: true, passive: false });
    window.addEventListener("focus", handleFocus, true);
    window.addEventListener("blur", handleBlur, true);
    window.addEventListener("pagehide", handleBlur, true);
    window.addEventListener("resize", handleCoordinateViewportResize, true);
    window.visualViewport?.addEventListener("resize", handleCoordinateViewportResize);
    window.addEventListener("pointerdown", handleGameSurfacePointerDown, true);
    document.addEventListener("focusin", handleGameSurfaceFocusIn, true);
    document.addEventListener("focusout", handleGameSurfaceFocusOut, true);
    document.addEventListener("pointerlockchange", refreshGameInputContext, true);
    document.addEventListener("visibilitychange", handleVisibilityChange, true);
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
