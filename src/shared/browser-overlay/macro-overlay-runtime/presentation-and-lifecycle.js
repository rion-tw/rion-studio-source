  function renderClickMarkers() {
    if (!clickMarkerLayerElement) return;
    if (!state.macroOverlay.showClickMarkers) {
      if (renderedClickOverlayMarkup !== "") {
        clickMarkerLayerElement.replaceChildren();
        renderedClickOverlayMarkup = "";
      }
      clickMarkerEvents.clear();
      clickMarkerFlashStates.clear();
      clickMarkerLayerElement.hidden = true;
      return;
    }
    const viewport = getVisualViewportSize();
    const markersByPosition = new Map();
    const connectorsByEvent = new Map();
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
            const eventKey = status.lastClick?.stepId === step.id && status.lastClick.sequence > 0
              ? [status.startedAt, status.lastClick.stepId, status.lastClick.sequence].join(":")
              : undefined;
            const shouldFlash = status.clickFlash === true;
            marker.sources.push({
              eventKey,
              shouldFlash,
              macroId: macro.id,
              stepId: step.id
            });
            if (eventKey && shouldFlash) {
              const anchor = resolveMacroClickAnchorPosition(step, viewport);
              if (anchor.xPx !== position.xPx || anchor.yPx !== position.yPx) {
                connectorsByEvent.set([macro.id, eventKey].join(":"), {
                  anchor,
                  eventKey,
                  position
                });
              }
            }
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
    const connectorMarkup = [...connectorsByEvent.values()].map((connector) => [
      '<line class="click-connector" data-connector-key="',
      escapeHtml(connector.eventKey),
      '" x1="',
      String(connector.anchor.xPx),
      '" y1="',
      String(connector.anchor.yPx),
      '" x2="',
      String(connector.position.xPx),
      '" y2="',
      String(connector.position.yPx),
      '" />'
    ].join("")).join("");
    const connectorLayerMarkup = connectorMarkup.length === 0
      ? ""
      : [
        '<svg class="click-connector-svg" aria-hidden="true" focusable="false"',
        ' viewBox="0 0 ',
        String(viewport.width),
        " ",
        String(viewport.height),
        '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">',
        connectorMarkup,
        "</svg>"
      ].join("");
    const markerMarkup = markers.map((marker) => {
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
    const nextMarkup = connectorLayerMarkup + markerMarkup;

    if (nextMarkup !== renderedClickOverlayMarkup) {
      clickMarkerLayerElement.innerHTML = nextMarkup;
      renderedClickOverlayMarkup = nextMarkup;
    }
    clickMarkerLayerElement.hidden = markers.length === 0;
  }

  function handleClickMarkerAnimationEnd(event) {
    const marker = event.target?.closest?.(".click-marker.is-click-flash");
    if (!marker) return;
    marker.classList.remove("is-click-flash");
    clickMarkerFlashStates.delete(marker.dataset.markerKey);
  }

  function handleActiveBadgeAnimationStart(event) {
    if (event.animationName !== "active-badge-border-flash" || event.pseudoElement !== "::after") {
      return;
    }
    const badge = event.target?.closest?.(".active-badge.is-iteration-flash");
    const macroId = badge?.dataset.macroId;
    const startedAt = badge?.dataset.startedAt;
    const iteration = Number(badge?.dataset.iteration) || 0;
    if (!macroId || !startedAt || iteration === 0) return;
    const traceKey = [badge.dataset.roleId, macroId, startedAt, iteration].join(":");
    const response = macroBadgeResponseTimings.get(traceKey);
    const animationStartedAt = browserMonotonicNowMs();
    const readTiming = (property) => {
      const value = Number.parseFloat(badge.style.getPropertyValue(property));
      return Number.isFinite(value) ? Math.round(value) : undefined;
    };
    reportMacroBadgeTiming({
      animationDelayMs: readTiming("--active-badge-flash-delay"),
      animationDurationMs: readTiming("--active-badge-flash-duration"),
      animationElapsedMs: Number.isFinite(event.elapsedTime)
        ? Math.round(event.elapsedTime * 1000)
        : undefined,
      clientMonotonicMs: animationStartedAt,
      iteration,
      macroId,
      phase: "animationStart",
      refreshRoundTripMs: 0,
      responseToAnimationMs: response
        ? Math.max(0, animationStartedAt - response.responseAt)
        : undefined,
      startedAt
    });
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
    const parts = [];
    if (trigger.ctrl) parts.push("Ctrl");
    if (trigger.alt) parts.push("Alt");
    if (trigger.shift) parts.push("Shift");
    if (trigger.meta) parts.push("Meta");
    parts.push(trigger.button === "middle" ? "Middle Click" : formatCode(trigger.code));
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
        typeof trigger.code === "string" &&
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
      destroyCoordinateMeasurement();
      activeBadgesElement = null;
      actionMenuElement = null;
      clickMarkerLayerElement = null;
      host = null;
      renderedActiveBadgesMarkup = null;
      renderedClickOverlayMarkup = null;
      root = null;
      triggerElement = null;
    }
  }

  function removeVisualHosts() {
    removeHost(hostId);
  }

  function applyHostStyle() {
    if (!host) return;
    host.removeAttribute("style");
    hostStyleEntries.forEach(([property, value]) => {
      host.style.setProperty(property, value, "important");
    });
    applyHostTheme();
  }

  function applyHostTheme() {
    if (!host) return;
    host.dataset.theme = state.resolvedTheme;
    host.style.setProperty("color-scheme", state.resolvedTheme, "important");
  }

  function ensureHost() {
    if (!shouldRenderUi() || !document.body) {
      removeHost(hostId);
      return null;
    }

    if (host?.isConnected && root && triggerElement && actionMenuElement && clickMarkerLayerElement) {
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
      "</div>"
    ].join("");
    activeBadgesElement = root.querySelector(".active-badges");
    clickMarkerLayerElement = root.querySelector(".click-marker-layer");
    triggerElement = root.querySelector(".trigger");
    actionMenuElement = root.querySelector(".action-menu");
    clickMarkerLayerElement?.addEventListener("animationend", handleClickMarkerAnimationEnd);
    activeBadgesElement?.addEventListener("animationstart", handleActiveBadgeAnimationStart);
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
      void startCoordinateMeasurement();
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
    if (!ensureHost() || !triggerElement || !activeBadgesElement) {
      return;
    }

    updateActiveBadgesPosition();
    renderClickMarkers();
    const text = getText();
    triggerElement.hidden = !state.macroOverlay.showToolButton;
    if (!state.macroOverlay.showToolButton) {
      cancelCoordinateMeasureHide();
      if (actionMenuElement) actionMenuElement.hidden = true;
      if (coordinateMeasurementController || coordinateMeasurementPending) {
        destroyCoordinateMeasurement();
      }
    }
    triggerElement.title = text.triggerTitle;
    triggerElement.setAttribute("aria-label", text.triggerAria);
    const coordinateAction = actionMenuElement?.querySelector(".action-menu-item");
    if (coordinateAction) {
      coordinateAction.setAttribute("aria-label", text.coordinateMeasureAria);
      coordinateAction.title = text.coordinateMeasureAria;
      const label = coordinateAction.querySelector(".action-menu-label");
      if (label) label.textContent = text.coordinateMeasure;
    }
    coordinateMeasurementController?.updatePresentation();

    const nextMarkup = (state.macroOverlay.showRunningBadges ? getRunningBadgeMacros() : [])
      .map((macro) => {
        const behavior = formatMacroBehavior(macro);
        const { delay, duration, iteration, status } = getMacroIteration(macro.id);
        const iterationFlashClass = iteration > 0 ? " is-iteration-flash" : "";
        const hasUsableShortcut = macro.trigger && isShortcutMacroId(macro.id);
        const shortcutlessClass = hasUsableShortcut ? "" : " is-shortcutless";
        const shortcutMarkup = hasUsableShortcut
          ? '<span class="active-badge-shortcut">' +
            escapeHtml(formatShortcut(macro.trigger)) +
            "</span>"
          : "";
        return [
          '<span class="active-badge',
          iterationFlashClass,
          shortcutlessClass,
          '" data-iteration="',
          String(iteration),
          '" data-macro-id="',
          escapeHtml(macro.id),
          '" data-role-id="',
          escapeHtml(status?.roleId ?? ""),
          '" data-started-at="',
          escapeHtml(status?.startedAt ?? ""),
          '" style="--active-badge-flash-duration:',
          String(duration),
          'ms;--active-badge-flash-delay:',
          String(delay),
          'ms">',
          shortcutMarkup,
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
      const requestStartedAt = browserMonotonicNowMs();
      try {
        const nextState = await binding({ type: "list" });
        if (requestVersion !== state.requestVersion || disposeIfDetached(nextState)) {
          return;
        }
        applyState(nextState);
        reportMacroBadgeSnapshotTimings(requestStartedAt);
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

  function runAction(action, macroId, details, queueBehindPending, bypassPendingTail = false) {
    if (!queueBehindPending && pendingMacroActions.has(macroId)) {
      return Promise.resolve();
    }

    pendingMacroActions.set(macroId, (pendingMacroActions.get(macroId) ?? 0) + 1);
    const requestVersion = ++state.requestVersion;
    const previous = bypassPendingTail
      ? Promise.resolve()
      : macroActionTails.get(macroId) ?? Promise.resolve();
    const actionPromise = previous.catch(() => undefined).then(async () => {
      try {
        const nextState = await binding({ type: action, macroId, ...details });
        if (requestVersion !== state.requestVersion) {
          return;
        }
        if (disposeIfDetached(nextState)) {
          return;
        }
        applyState(nextState);
        updatePresentation();
      } catch (error) {
        console.warn("Unable to run Rion Studio macro.", error);
      }
    });
    if (!bypassPendingTail) {
      macroActionTails.set(macroId, actionPromise);
    }
    void actionPromise.finally(() => {
      if (macroActionTails.get(macroId) === actionPromise) {
        macroActionTails.delete(macroId);
      }
      const remaining = (pendingMacroActions.get(macroId) ?? 1) - 1;
      if (remaining <= 0) {
        pendingMacroActions.delete(macroId);
      } else {
        pendingMacroActions.set(macroId, remaining);
      }
      if (pendingMacroActions.size === 0 && !isDisposed) {
        void refresh();
      }
    });
    return actionPromise;
  }

  function handleFocus() {
    scheduleGameInputContextRefresh();
    void refresh();
  }

  function handleBlur() {
    runtimeTabShortcutModifierCodes.clear();
    reportGameInputContext("document");
    cancelPendingPhysicalToggleShortcuts();
    releasePhysicalGameKeys();
    releaseActiveHeldShortcuts();
    destroyCoordinateMeasurement();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      runtimeTabShortcutModifierCodes.clear();
      reportGameInputContext("document");
      cancelPendingPhysicalToggleShortcuts();
      releasePhysicalGameKeys();
      releaseActiveHeldShortcuts();
      destroyCoordinateMeasurement();
      return;
    }
    scheduleGameInputContextRefresh();
    void refresh();
  }

  function dispose() {
    isDisposed = true;
    appliedPageZoomRequestRevision += 1;
    appliedPageZoom = 1;
    appliedPageZoomKnown = false;
    refreshQueued = false;
    cancelCoordinateMeasureHide();
    destroyCoordinateMeasurement();
    resetCoordinateMeasurementModuleLoader();
    reportGameInputContext("document");
    cancelPendingPhysicalToggleShortcuts();
    releaseActiveHeldShortcuts();
    releaseAllForwardedMacroKeys();
    releasePhysicalGameKeys();
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keypress", handleCoordinateKeyPress, true);
    window.removeEventListener("keyup", handleKeyUp, true);
    window.removeEventListener("mousedown", handleMiddleButtonDown, true);
    window.removeEventListener("mouseup", handleMiddleButtonUp, true);
    window.removeEventListener("auxclick", handleMiddleButtonAuxClick, true);
    window.removeEventListener("wheel", handleGameWheel, true);
    window.removeEventListener("focus", handleFocus, true);
    window.removeEventListener("blur", handleBlur, true);
    window.removeEventListener("pagehide", handleBlur, true);
    window.removeEventListener("resize", handleOverlayViewportResize, true);
    window.visualViewport?.removeEventListener("resize", handleOverlayViewportResize);
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
    consumedPhysicalShortcutCodes.clear();
    runtimeTabShortcutModifierCodes.clear();
    clickMarkerEvents.clear();
    clickMarkerFlashStates.clear();
    macroIterationTimings.clear();
    macroBadgeResponseTimings.clear();
    pendingMacroActions.clear();
    macroActionTails.clear();
    latestCoreStatuses = [];
    state.macros = [];
    state.shortcutMacroIds = [];
    state.shortcutStatuses = [];
    state.statuses = [];
    clearAllSuppressedShortcuts();

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
    window.addEventListener("mousedown", handleMiddleButtonDown, true);
    window.addEventListener("mouseup", handleMiddleButtonUp, true);
    window.addEventListener("auxclick", handleMiddleButtonAuxClick, true);
    window.addEventListener("wheel", handleGameWheel, { capture: true, passive: false });
    window.addEventListener("focus", handleFocus, true);
    window.addEventListener("blur", handleBlur, true);
    window.addEventListener("pagehide", handleBlur, true);
    window.addEventListener("resize", handleOverlayViewportResize, true);
    window.visualViewport?.addEventListener("resize", handleOverlayViewportResize);
    window.addEventListener("pointerdown", handleGameSurfacePointerDown, true);
    document.addEventListener("focusin", handleGameSurfaceFocusIn, true);
    document.addEventListener("focusout", handleGameSurfaceFocusOut, true);
    document.addEventListener("pointerlockchange", refreshGameInputContext, true);
    document.addEventListener("visibilitychange", handleVisibilityChange, true);
    window[controllerKey] = {
      automaticInputContext,
      clearSuppressedMiddleButtonShortcut,
      clearSuppressedShortcut,
      dispose,
      refresh,
      physicalModifierCodes,
      releaseForwardedMacroKey,
      suppressNextModifierProjection,
      suppressNextMiddleButtonShortcut,
      suppressNextShortcut,
      version: scriptVersion
    };
    isInstalled = true;
    refreshGameInputContext();
    updatePresentation();
    void binding.ready?.().catch(() => undefined);
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
