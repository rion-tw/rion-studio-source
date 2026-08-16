  const activeMacroGameKeys = new Map();
  const consumedPhysicalShortcutCodes = new Set();
  const forwardedMacroGameEvents = new WeakSet();
  const macroModifierOwnership = new Map();
  const pendingMacroObservationListeners = new Map();
  const pendingPhysicalToggleShortcuts = [];
  const physicalGameKeys = new Map();
  const physicalModifierCodeSet = new Set([
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
    "MetaLeft",
    "MetaRight",
    "ShiftLeft",
    "ShiftRight"
  ]);
  let lastMacroGameCanvas = null;
  let macroGameKeyReassertQueued = false;
  let macroGameKeysNeedReassert = false;
  let physicalShortcutEpoch = 0;

  function consumeShortcutEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  }

  function armMacroKeyGuard(dispatchId, code, phase, disposition) {
    const normalizedDispatchId = String(dispatchId);
    const normalizedCode = String(code);
    if (
      isDisposed ||
      inFlightMacroKeyGuard !== null ||
      normalizedDispatchId.length === 0 ||
      normalizedCode.length === 0 ||
      (phase !== "keydown" && phase !== "keyup") ||
      (disposition !== "macro-key" && disposition !== "modifier-projection")
    ) {
      return false;
    }
    inFlightMacroKeyGuard = {
      code: normalizedCode,
      dispatchId: normalizedDispatchId,
      disposition,
      phase
    };
    return true;
  }

  function suppressNextShortcut(dispatchId, code, phase = "keydown") {
    return armMacroKeyGuard(dispatchId, code, phase, "macro-key");
  }

  function suppressNextModifierProjection(dispatchId, code) {
    const normalizedCode = String(code);
    if (!physicalModifierCodeSet.has(normalizedCode)) return false;
    return armMacroKeyGuard(
      dispatchId,
      normalizedCode,
      "keydown",
      "modifier-projection"
    );
  }

  function clearSuppressedShortcut(dispatchId) {
    const observation = pendingMacroObservationListeners.get(String(dispatchId));
    if (observation) {
      observation.target.removeEventListener(observation.type, observation.listener);
      pendingMacroObservationListeners.delete(String(dispatchId));
    }
    if (inFlightMacroKeyGuard?.dispatchId !== String(dispatchId)) return Boolean(observation);
    inFlightMacroKeyGuard = null;
    return true;
  }

  function consumeSuppressedShortcut(event, disposition) {
    const guard = inFlightMacroKeyGuard;
    const phase = event.type === "keydown" ? "keydown" : "keyup";
    if (
      !guard ||
      guard.disposition !== disposition ||
      guard.code !== event.code ||
      guard.phase !== phase ||
      event.repeat
    ) {
      return null;
    }
    inFlightMacroKeyGuard = null;
    return guard;
  }

  function reportObservedMacroKey(guard, event, afterPropagation = true) {
    const report = () => {
      void binding.macroKeyObserved?.({
        code: guard.code,
        dispatchId: guard.dispatchId,
        phase: guard.phase
      }).catch(() => undefined);
    };
    if (!afterPropagation || !event.bubbles) {
      report();
      return;
    }
    const observeBubbleCompletion = (candidate) => {
      if (candidate !== event) return;
      window.removeEventListener(event.type, observeBubbleCompletion);
      pendingMacroObservationListeners.delete(guard.dispatchId);
      report();
    };
    // Register while the event is in window capture. The listener is appended
    // after page listeners that already exist and therefore acknowledges this
    // exact event only after its target/bubble consumers have run.
    window.addEventListener(event.type, observeBubbleCompletion);
    pendingMacroObservationListeners.set(guard.dispatchId, {
      listener: observeBubbleCompletion,
      target: window,
      type: event.type
    });
  }

  function clearAllSuppressedShortcuts() {
    inFlightMacroKeyGuard = null;
    for (const observation of pendingMacroObservationListeners.values()) {
      observation.target.removeEventListener(observation.type, observation.listener);
    }
    pendingMacroObservationListeners.clear();
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

  function rememberPhysicalGameKey(event, delivered = true) {
    if (!event.code || physicalGameKeys.has(event.code)) return;
    const target = event.target;
    if (!target || typeof target.dispatchEvent !== "function") return;
    physicalGameKeys.set(event.code, {
      delivered,
      snapshot: snapshotMacroKeyboardEvent(event, false),
      target
    });
  }

  function forgetPhysicalGameKey(code) {
    physicalGameKeys.delete(String(code));
  }

  function physicalModifierCodes() {
    return [...physicalGameKeys.keys()].filter((code) => physicalModifierCodeSet.has(code));
  }

  function currentPhysicalModifierSnapshot(snapshot) {
    const codes = physicalModifierCodes();
    return {
      ...snapshot,
      altKey: codes.some((code) => code.startsWith("Alt")),
      ctrlKey: codes.some((code) => code.startsWith("Control")),
      metaKey: codes.some((code) => code.startsWith("Meta")),
      repeat: false,
      shiftKey: codes.some((code) => code.startsWith("Shift"))
    };
  }

  function dispatchPhysicalGameKeyUp(active) {
    if (active.delivered === false) return;
    if (typeof window.KeyboardEvent !== "function") return;
    try {
      const snapshot = currentPhysicalModifierSnapshot(active.snapshot);
      const event = new window.KeyboardEvent("keyup", {
        altKey: snapshot.altKey,
        bubbles: true,
        cancelable: true,
        code: snapshot.code,
        composed: true,
        ctrlKey: snapshot.ctrlKey,
        isComposing: snapshot.isComposing,
        key: snapshot.key,
        location: snapshot.location,
        metaKey: snapshot.metaKey,
        repeat: false,
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
      active.target.dispatchEvent(event);
    } catch (error) {
      console.warn("Unable to release a physical game key after focus loss.", error);
    }
  }

  function releasePhysicalGameKeys() {
    for (const code of [...physicalGameKeys.keys()].reverse()) {
      const active = physicalGameKeys.get(code);
      physicalGameKeys.delete(code);
      const macroOwnership = macroModifierOwnership.get(code);
      if (macroOwnership) {
        macroOwnership.delivered = true;
        continue;
      }
      if (active) dispatchPhysicalGameKeyUp(active);
    }
  }

  function discardForwardedMacroKey(code) {
    activeMacroGameKeys.delete(code);
    if (activeMacroGameKeys.size === 0) macroGameKeysNeedReassert = false;
  }

  function consumeOverlappingMacroModifierKeyDown(event) {
    if (!physicalModifierCodeSet.has(event.code)) return false;
    const delivered = !physicalGameKeys.has(event.code);
    macroModifierOwnership.set(event.code, { delivered });
    if (delivered) return false;
    consumeShortcutEvent(event);
    return true;
  }

  function consumeOverlappingMacroModifierKeyUp(event) {
    if (!physicalModifierCodeSet.has(event.code)) return false;
    const ownership = macroModifierOwnership.get(event.code);
    macroModifierOwnership.delete(event.code);
    const physical = physicalGameKeys.get(event.code);
    if (physical) {
      physical.delivered = true;
      discardForwardedMacroKey(event.code);
      consumeShortcutEvent(event);
      return true;
    }
    if (ownership?.delivered !== false) return false;
    discardForwardedMacroKey(event.code);
    consumeShortcutEvent(event);
    return true;
  }

  function consumeOverlappingPhysicalModifierKeyDown(event) {
    if (
      !physicalModifierCodeSet.has(event.code) ||
      !macroModifierOwnership.has(event.code)
    ) {
      return false;
    }
    rememberPhysicalGameKey(event, false);
    consumeShortcutEvent(event);
    return true;
  }

  function consumeOverlappingPhysicalModifierKeyUp(event) {
    if (!physicalModifierCodeSet.has(event.code)) return false;
    const physical = physicalGameKeys.get(event.code);
    const macroOwnership = macroModifierOwnership.get(event.code);
    if (!physical || !macroOwnership) return false;
    physicalGameKeys.delete(event.code);
    macroOwnership.delivered = true;
    consumeShortcutEvent(event);
    return true;
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
    const modifierOwnership = macroModifierOwnership.get(normalizedCode);
    if (modifierOwnership) {
      macroModifierOwnership.delete(normalizedCode);
      const physical = physicalGameKeys.get(normalizedCode);
      if (physical) {
        physical.delivered = true;
        discardForwardedMacroKey(normalizedCode);
        return true;
      }
      if (modifierOwnership.delivered === false) {
        discardForwardedMacroKey(normalizedCode);
        return true;
      }
    }
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
    const codes = new Set([
      ...activeMacroGameKeys.keys(),
      ...macroModifierOwnership.keys()
    ]);
    for (const code of [...codes].reverse()) {
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

  function physicalShortcutTriggerSnapshot(trigger) {
    return {
      alt: Boolean(trigger.alt),
      ctrl: Boolean(trigger.ctrl),
      meta: Boolean(trigger.meta),
      shift: Boolean(trigger.shift)
    };
  }

  function reportMacroShortcutLifecycle(macroId, code, phase) {
    void binding.shortcutLifecycle?.({
      code,
      macroId,
      phase
    }).catch(() => undefined);
  }

  function modifierIsReleased(event, required, property) {
    return !required || event[property] === false;
  }

  function finishReleasedPhysicalToggleShortcuts(event) {
    const ready = [];
    for (let index = pendingPhysicalToggleShortcuts.length - 1; index >= 0; index -= 1) {
      const pending = pendingPhysicalToggleShortcuts[index];
      if (pending.code === event.code) pending.mainReleased = true;
      if (
        !pending.mainReleased ||
        !modifierIsReleased(event, pending.modifiers.alt, "altKey") ||
        !modifierIsReleased(event, pending.modifiers.ctrl, "ctrlKey") ||
        !modifierIsReleased(event, pending.modifiers.meta, "metaKey") ||
        !modifierIsReleased(event, pending.modifiers.shift, "shiftKey")
      ) {
        continue;
      }
      pendingPhysicalToggleShortcuts.splice(index, 1);
      reportMacroShortcutLifecycle(pending.macroId, pending.code, "chord-released");
      ready.unshift(pending);
    }
    if (ready.length === 0) return;
    const epoch = physicalShortcutEpoch;
    queueMicrotask(() => {
      if (isDisposed || epoch !== physicalShortcutEpoch) return;
      ready.forEach((pending) => {
        reportMacroShortcutLifecycle(pending.macroId, pending.code, "macro-dispatched");
        runAction("toggle", pending.macroId, undefined, true);
      });
    });
  }

  function cancelPendingPhysicalToggleShortcuts() {
    physicalShortcutEpoch += 1;
    pendingPhysicalToggleShortcuts.length = 0;
  }

  function handleKeyDown(event) {
    if (forwardedMacroGameEvents.has(event)) return;
    if (!isTrustedUserEvent(event)) {
      return;
    }
    // Native adapters may need to restore WebView modifier flags after a
    // guarded macro keyup. The physical DOM owner already keeps the aggregate
    // modifier down, so this projection updates only native state and must not
    // become a second page-visible keydown or a new macro ownership cycle.
    const modifierProjectionGuard = consumeSuppressedShortcut(
      event,
      "modifier-projection"
    );
    if (modifierProjectionGuard) {
      // Keep WebKit/WebView2's native default modifier update. Only isolate the
      // projection from page listeners; preventing its default would make the
      // next physical key lose the still-held modifier flags.
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      reportObservedMacroKey(modifierProjectionGuard, event, false);
      return;
    }
    const macroKeyGuard = consumeSuppressedShortcut(event, "macro-key");
    if (macroKeyGuard) {
      if (consumeOverlappingMacroModifierKeyDown(event)) {
        reportObservedMacroKey(macroKeyGuard, event, false);
        return;
      }
      const activeElement = gameInputContextActive ? undefined : document.activeElement;
      const editableContext = shouldIgnoreShortcutEvent(event, activeElement, document.designMode);
      if (editableContext && event.cancelable) {
        event.preventDefault();
      }
      routeMacroGameKeyDown(event, editableContext);
      reportObservedMacroKey(macroKeyGuard, event);
      return;
    }
    // A non-repeat keydown starts a new physical ownership cycle. This also
    // retires ownership left behind when a prior keyup occurred after blur and
    // never reached this document.
    if (!event.repeat) consumedPhysicalShortcutCodes.delete(event.code);
    updateRuntimeTabShortcutModifier(event, true);
    if (consumeOverlappingPhysicalModifierKeyDown(event)) return;
    if (isReservedRuntimeTabSwitchShortcutEvent(event)) {
      consumeShortcutEvent(event);
      if (!event.repeat) {
        void binding({
          type: "runtime-tab-shortcut",
          direction: event.shiftKey ? "previous" : "next",
          modifierCodes: currentRuntimeTabShortcutModifierCodes(event)
        }).catch(() => undefined);
      }
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
    if (ignoresShortcut) {
      rememberPhysicalGameKey(event);
      return;
    }
    if (isReservedBrowserZoomShortcutEvent(event)) {
      rememberPhysicalGameKey(event);
      return;
    }

    if (event.repeat) {
      if (matchesOpenShortcut(event)) {
        consumedPhysicalShortcutCodes.add(event.code);
        consumeShortcutEvent(event);
      } else {
        rememberPhysicalGameKey(event);
      }
      return;
    }

    refreshIfStale();
    if (matchesOpenShortcut(event)) {
      consumedPhysicalShortcutCodes.add(event.code);
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
      rememberPhysicalGameKey(event);
      return;
    }

    rememberPhysicalGameKey(event);
    if (matchingMacros.length !== 1) {
      console.warn("Multiple Rion Studio macros use the same shortcut for this role.");
      return;
    }

    const macro = matchingMacros[0];
    reportMacroShortcutLifecycle(
      macro.id,
      event.code,
      "physical-keydown-allowed"
    );
    if ((macro.activationMode ?? "toggle") === "while_held") {
      if (activeHeldShortcuts.has(macro.id)) return;
      const pressId = `${Date.now()}-${nextPressId++}`;
      activeHeldShortcuts.set(macro.id, { code: event.code, pressId });
      runAction("press", macro.id, { pressId }, true);
      return;
    }
    pendingPhysicalToggleShortcuts.push({
      code: event.code,
      macroId: macro.id,
      mainReleased: false,
      modifiers: physicalShortcutTriggerSnapshot(macro.trigger)
    });
  }

  function handleKeyUp(event) {
    if (forwardedMacroGameEvents.has(event)) return;
    if (!isTrustedUserEvent(event)) {
      return;
    }
    const macroKeyGuard = consumeSuppressedShortcut(event, "macro-key");
    if (macroKeyGuard) {
      if (consumeOverlappingMacroModifierKeyUp(event)) {
        reportObservedMacroKey(macroKeyGuard, event, false);
        return;
      }
      const activeElement = gameInputContextActive ? undefined : document.activeElement;
      const editableContext = shouldIgnoreShortcutEvent(event, activeElement, document.designMode);
      routeMacroGameKeyUp(event, editableContext);
      reportObservedMacroKey(macroKeyGuard, event);
      return;
    }
    const consumedShortcutKeyUp = consumedPhysicalShortcutCodes.delete(event.code);
    updateRuntimeTabShortcutModifier(event, false);
    const consumedModifierKeyUp = consumeOverlappingPhysicalModifierKeyUp(event);
    if (consumedShortcutKeyUp && !consumedModifierKeyUp) consumeShortcutEvent(event);
    if (!consumedModifierKeyUp) forgetPhysicalGameKey(event.code);
    finishReleasedPhysicalToggleShortcuts(event);
    if (coordinateMeasurementController?.handleKeyUp(event)) {
      return;
    }
    if (coordinateMeasurementPending) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const matches = [...activeHeldShortcuts.entries()].filter(
      ([, active]) => active.code === event.code
    );
    if (matches.length === 0) return;
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
