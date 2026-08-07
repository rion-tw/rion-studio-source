  const activeMacroGameKeys = new Map();
  const forwardedMacroGameEvents = new WeakSet();
  let lastMacroGameCanvas = null;
  let macroGameKeyReassertQueued = false;
  let macroGameKeysNeedReassert = false;

  function consumeShortcutEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function clearSuppressedShortcutTimer(item) {
    if (item?.expiryTimer !== undefined) {
      clearTimeout(item.expiryTimer);
      item.expiryTimer = undefined;
    }
  }

  function removeSuppressedShortcutItem(item, releaseExpiredKeyUp = false) {
    const index = suppressedShortcutEvents.indexOf(item);
    if (index !== -1) suppressedShortcutEvents.splice(index, 1);
    clearSuppressedShortcutTimer(item);
    if (releaseExpiredKeyUp && item?.phase === "keyup") {
      releaseForwardedMacroKey(item.code);
    }
  }

  function pruneSuppressedShortcutEvents(now = Date.now()) {
    for (const item of [...suppressedShortcutEvents]) {
      if (item.expiresAt <= now) removeSuppressedShortcutItem(item, true);
    }
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
    pruneSuppressedShortcutEvents(now);
    const item = {
      code: normalizedCode,
      expiresAt: normalizedExpiry,
      expiryTimer: undefined,
      phase
    };
    // event-topology-exception: embedded-shortcut-suppression-expiry
    item.expiryTimer = setTimeout(() => {
      removeSuppressedShortcutItem(item, true);
    }, Math.max(0, normalizedExpiry - now));
    suppressedShortcutEvents.push(item);
    return true;
  }

  function clearSuppressedShortcut(code, phase = "keydown") {
    for (const item of [...suppressedShortcutEvents]) {
      if (item.code === code && item.phase === phase) removeSuppressedShortcutItem(item);
    }
  }

  function consumeSuppressedShortcut(code, phase) {
    pruneSuppressedShortcutEvents();
    const item = suppressedShortcutEvents.find(
      (item) => item.code === code && item.phase === phase
    );
    if (!item) return false;
    removeSuppressedShortcutItem(item);
    return true;
  }

  function clearAllSuppressedShortcuts() {
    for (const item of [...suppressedShortcutEvents]) removeSuppressedShortcutItem(item);
  }

  function isConnectedGameCanvas(candidate) {
    return isCanvas(candidate) && candidate.isConnected && candidate.ownerDocument === document;
  }

  function rememberMacroGameCanvas(candidate) {
    if (isConnectedGameCanvas(candidate)) lastMacroGameCanvas = candidate;
  }

  function collectOpenGameCanvases(root, canvases, visited) {
    if (!root || visited.has(root) || canvases.length > 1) return;
    visited.add(root);
    if (isConnectedGameCanvas(root)) canvases.push(root);
    if (typeof root.querySelectorAll !== "function") return;
    for (const canvas of root.querySelectorAll("canvas")) {
      if (isConnectedGameCanvas(canvas) && !canvases.includes(canvas)) canvases.push(canvas);
      if (canvases.length > 1) return;
    }
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) collectOpenGameCanvases(element.shadowRoot, canvases, visited);
      if (canvases.length > 1) return;
    }
  }

  function resolveMacroGameCanvas(preferred = null) {
    if (isConnectedGameCanvas(preferred)) return preferred;
    if (isConnectedGameCanvas(document.pointerLockElement)) {
      rememberMacroGameCanvas(document.pointerLockElement);
      return document.pointerLockElement;
    }
    const activeCanvas = getDeepActiveElement();
    if (isConnectedGameCanvas(activeCanvas)) {
      rememberMacroGameCanvas(activeCanvas);
      return activeCanvas;
    }
    if (isConnectedGameCanvas(lastMacroGameCanvas)) return lastMacroGameCanvas;
    lastMacroGameCanvas = null;
    const canvases = [];
    collectOpenGameCanvases(document, canvases, new Set());
    if (canvases.length !== 1) return null;
    rememberMacroGameCanvas(canvases[0]);
    return canvases[0];
  }

  function snapshotMacroKeyboardEvent(event, repeat = event.repeat) {
    return {
      altKey: event.altKey,
      charCode: event.charCode,
      code: event.code,
      ctrlKey: event.ctrlKey,
      isComposing: event.isComposing,
      key: event.key,
      keyCode: event.keyCode,
      location: event.location,
      metaKey: event.metaKey,
      repeat: Boolean(repeat),
      shiftKey: event.shiftKey,
      which: event.which
    };
  }

  function dispatchForwardedMacroGameEvent(target, type, snapshot) {
    if (!isConnectedGameCanvas(target) || typeof window.KeyboardEvent !== "function") return false;
    try {
      const event = new window.KeyboardEvent(type, {
        altKey: snapshot.altKey,
        bubbles: false,
        cancelable: true,
        code: snapshot.code,
        composed: false,
        ctrlKey: snapshot.ctrlKey,
        isComposing: snapshot.isComposing,
        key: snapshot.key,
        location: snapshot.location,
        metaKey: snapshot.metaKey,
        repeat: snapshot.repeat,
        shiftKey: snapshot.shiftKey
      });
      for (const property of ["charCode", "keyCode", "which"]) {
        const value = Number(snapshot[property]) || 0;
        if (event[property] === value) continue;
        try {
          Object.defineProperty(event, property, { configurable: true, value });
        } catch {
          // `code` and `key` remain available when a WebView rejects a legacy field override.
        }
      }
      forwardedMacroGameEvents.add(event);
      target.dispatchEvent(event);
      return true;
    } catch (error) {
      console.warn("Unable to forward a macro key to the game canvas.", error);
      return false;
    }
  }

  function releaseForwardedMacroKey(code) {
    const normalizedCode = String(code);
    clearSuppressedShortcut(normalizedCode, "keyup");
    const active = activeMacroGameKeys.get(normalizedCode);
    if (!active) return false;
    activeMacroGameKeys.delete(normalizedCode);
    if (activeMacroGameKeys.size === 0) macroGameKeysNeedReassert = false;
    dispatchForwardedMacroGameEvent(
      active.target,
      "keyup",
      { ...active.snapshot, repeat: false }
    );
    return true;
  }

  function releaseAllForwardedMacroKeys() {
    for (const code of [...activeMacroGameKeys.keys()].reverse()) {
      releaseForwardedMacroKey(code);
    }
    macroGameKeysNeedReassert = false;
  }

  function routeMacroGameKeyDown(event, editableContext) {
    const directCanvas = eventPathCanvas(event);
    if (directCanvas) rememberMacroGameCanvas(directCanvas);
    const target = directCanvas ?? (editableContext ? resolveMacroGameCanvas() : null);
    if (!target) return;
    const snapshot = snapshotMacroKeyboardEvent(event);
    activeMacroGameKeys.set(event.code, { snapshot, target });
    if (!directCanvas) dispatchForwardedMacroGameEvent(target, "keydown", snapshot);
  }

  function routeMacroGameKeyUp(event, editableContext) {
    const directCanvas = eventPathCanvas(event);
    if (directCanvas) rememberMacroGameCanvas(directCanvas);
    const active = activeMacroGameKeys.get(event.code);
    const target = active?.target ?? (editableContext ? resolveMacroGameCanvas() : directCanvas);
    activeMacroGameKeys.delete(event.code);
    if (target && directCanvas !== target) {
      dispatchForwardedMacroGameEvent(target, "keyup", snapshotMacroKeyboardEvent(event, false));
    }
  }

  function reassertForwardedMacroKeys() {
    for (const [code, active] of [...activeMacroGameKeys]) {
      if (!isConnectedGameCanvas(active.target)) {
        activeMacroGameKeys.delete(code);
        continue;
      }
      dispatchForwardedMacroGameEvent(
        active.target,
        "keydown",
        { ...active.snapshot, repeat: false }
      );
    }
  }

  function handleMacroGameFocusIn(event) {
    const canvas = eventPathCanvas(event);
    if (canvas) {
      rememberMacroGameCanvas(canvas);
      macroGameKeysNeedReassert = false;
      return;
    }
    const activeElement = getDeepActiveElement();
    if (!shouldIgnoreShortcutEvent(event, activeElement, document.designMode)) return;
    if (!macroGameKeysNeedReassert || macroGameKeyReassertQueued) return;
    macroGameKeyReassertQueued = true;
    Promise.resolve().then(() => {
      macroGameKeyReassertQueued = false;
      if (isDisposed || getDeepActiveElement() !== activeElement) return;
      macroGameKeysNeedReassert = false;
      reassertForwardedMacroKeys();
    });
  }

  function handleMacroGameFocusOut(event) {
    const canvas = eventPathCanvas(event);
    if (!canvas) return;
    macroGameKeysNeedReassert = [...activeMacroGameKeys.values()].some(
      (active) => active.target === canvas
    );
  }

  function refreshIfStale() {
    if (Date.now() - state.lastRefreshAt > 1200) {
      void refresh();
    }
  }

  function handleKeyDown(event) {
    if (forwardedMacroGameEvents.has(event)) return;
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
      routeMacroGameKeyDown(event, ignoresShortcut);
      return;
    }
    if (ignoresShortcut) {
      return;
    }
    if (isReservedBrowserZoomShortcutEvent(event) || isReservedRuntimeTabSwitchShortcutEvent(event)) {
      return;
    }

    const matchesMacroShortcut = state.macros.some(
      (macro) =>
        isShortcutMacroId(macro.id) &&
        macro.enabled !== false &&
        matchesShortcut(event, macro.trigger)
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
      (macro) =>
        isShortcutMacroId(macro.id) &&
        macro.enabled !== false &&
        matchesShortcut(event, macro.trigger)
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
    if (forwardedMacroGameEvents.has(event)) return;
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
      const activeElement = gameInputContextActive ? undefined : document.activeElement;
      const editableContext = shouldIgnoreShortcutEvent(event, activeElement, document.designMode);
      routeMacroGameKeyUp(event, editableContext);
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
