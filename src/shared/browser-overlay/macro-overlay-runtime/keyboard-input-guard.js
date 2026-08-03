  function consumeShortcutEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }
  function suppressNextShortcut(code, phase = "keydown", expiresAt = Date.now() + 1000) {
    const now = Date.now();
    const normalizedCode = String(code);
    const normalizedExpiry = Math.min(Number(expiresAt), now + 1000);
    if (
      normalizedCode.length === 0 ||
      (phase !== "keydown" && phase !== "keyup") ||
      !Number.isFinite(normalizedExpiry) ||
      normalizedExpiry <= now
    ) {
      return false;
    }
    suppressedShortcutEvents = suppressedShortcutEvents.filter((item) => item.expiresAt > now);
    suppressedShortcutEvents.push({
      code: normalizedCode,
      expiresAt: normalizedExpiry,
      phase
    });
    return true;
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
      if (ignoresShortcut && event.cancelable) {
        event.preventDefault();
      }
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
    if (coordinateMeasurementController?.handleKeyUp(event)) {
      return;
    }
    if (coordinateMeasurementPending) {
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
      }, true, true);
    });
  }

  function releaseActiveHeldShortcuts() {
    [...activeHeldShortcuts.entries()].forEach(([macroId, active]) => {
      activeHeldShortcuts.delete(macroId);
      runAction("release", macroId, {
        pressId: active.pressId,
        releaseMode: "immediate"
      }, true, true);
    });
  }
