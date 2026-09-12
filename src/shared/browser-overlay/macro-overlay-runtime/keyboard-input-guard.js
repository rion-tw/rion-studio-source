  const activeMacroGameKeys = new Map();
  const consumedPhysicalShortcutCodes = new Set();
  const forwardedMacroGameEvents = new WeakSet();
  const macroModifierOwnership = new Map();
  const pendingMacroModifierTransitions = new Map();
  const pendingMacroObservationListeners = new Map();
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
      inFlightMacroKeyGuards.length !== 0 ||
      normalizedDispatchId.length === 0 ||
      normalizedCode.length === 0 ||
      (phase !== "keydown" && phase !== "keyup") ||
      (disposition !== "macro-key" && disposition !== "modifier-projection")
    ) {
      return false;
    }
    inFlightMacroKeyGuards.push({
      code: normalizedCode,
      dispatchId: normalizedDispatchId,
      disposition,
      phase,
      repeat: false
    });
    return true;
  }

  function suppressNextShortcut(dispatchId, code, phase = "keydown") {
    return armMacroKeyGuard(dispatchId, code, phase, "macro-key");
  }

  function suppressShortcutSequence(dispatchId, code, phases, repeat = false) {
    const normalizedDispatchId = String(dispatchId);
    const normalizedCode = String(code);
    if (
      isDisposed ||
      inFlightMacroKeyGuards.length !== 0 ||
      normalizedDispatchId.length === 0 ||
      normalizedCode.length === 0 ||
      !Array.isArray(phases) ||
      typeof repeat !== "boolean" ||
      phases.length < 1 ||
      phases.length > 2 ||
      phases.some((phase, index) =>
        (phase !== "keydown" && phase !== "keyup") ||
        (index > 0 && phases[index - 1] === phase)
      )
    ) {
      return false;
    }
    for (const phase of phases) {
      inFlightMacroKeyGuards.push({
        code: normalizedCode,
        dispatchId: normalizedDispatchId,
        disposition: "macro-key",
        phase,
        repeat
      });
    }
    return true;
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

  function prepareMacroModifierTransition(dispatchId, code, phase) {
    const normalizedDispatchId = String(dispatchId);
    const normalizedCode = String(code);
    if (
      isDisposed ||
      !normalizedDispatchId ||
      !physicalModifierCodeSet.has(normalizedCode) ||
      (phase !== "rawKeyDown" && phase !== "keyUp") ||
      pendingMacroModifierTransitions.has(normalizedDispatchId)
    ) {
      return null;
    }
    const physical = physicalGameKeys.get(normalizedCode);
    const ownership = macroModifierOwnership.get(normalizedCode);
    if (phase === "rawKeyDown" && physical && !ownership) {
      macroModifierOwnership.set(normalizedCode, {
        acquisitionSequence: normalizedDispatchId,
        delivered: false
      });
      pendingMacroModifierTransitions.set(normalizedDispatchId, {
        code: normalizedCode,
        disposition: "adoptPhysical",
        physical
      });
      return "adoptPhysical";
    }
    if (phase === "keyUp" && physical && ownership) {
      macroModifierOwnership.delete(normalizedCode);
      pendingMacroModifierTransitions.set(normalizedDispatchId, {
        code: normalizedCode,
        disposition: "releaseOwnership",
        ownership,
        physical
      });
      return "releaseOwnership";
    }
    return "dispatch";
  }

  function completeMacroModifierTransition(dispatchId, committed) {
    const normalizedDispatchId = String(dispatchId);
    const transition = pendingMacroModifierTransitions.get(normalizedDispatchId);
    if (!transition) return false;
    pendingMacroModifierTransitions.delete(normalizedDispatchId);
    if (committed) return true;
    // Roll back only while the exact physical owner is unchanged. A native
    // key transition during the lane makes ownership indeterminate and Core
    // recovery remains responsible for neutralization.
    const physical = physicalGameKeys.get(transition.code);
    if (physical !== transition.physical) return true;
    if (transition.disposition === "adoptPhysical") {
      const ownership = macroModifierOwnership.get(transition.code);
      if (ownership?.acquisitionSequence === normalizedDispatchId) {
        macroModifierOwnership.delete(transition.code);
      }
    } else if (!macroModifierOwnership.has(transition.code)) {
      macroModifierOwnership.set(transition.code, transition.ownership);
    }
    return true;
  }

  function clearSuppressedShortcut(dispatchId) {
    const normalizedDispatchId = String(dispatchId);
    const observation = pendingMacroObservationListeners.get(normalizedDispatchId);
    if (observation) {
      observation.target.removeEventListener(observation.type, observation.listener);
      pendingMacroObservationListeners.delete(normalizedDispatchId);
    }
    let cleared = Boolean(observation);
    for (let index = inFlightMacroKeyGuards.length - 1; index >= 0; index -= 1) {
      if (inFlightMacroKeyGuards[index].dispatchId !== normalizedDispatchId) continue;
      inFlightMacroKeyGuards.splice(index, 1);
      cleared = true;
    }
    return cleared;
  }

  function consumeSuppressedShortcut(event, disposition) {
    const guard = inFlightMacroKeyGuards[0];
    const phase = event.type === "keydown" ? "keydown" : "keyup";
    if (
      !guard ||
      guard.disposition !== disposition ||
      guard.code !== event.code ||
      guard.phase !== phase ||
      Boolean(event.repeat) !== guard.repeat
    ) {
      return null;
    }
    inFlightMacroKeyGuards.shift();
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

  function reportObservedMiddleButton(guard, event) {
    const report = () => {
      void binding.macroKeyObserved?.({
        code: "MouseMiddle",
        dispatchId: guard.dispatchId,
        phase: "auxclick"
      }).catch(() => undefined);
    };
    if (!event.bubbles) {
      report();
      return;
    }
    const observeBubbleCompletion = (candidate) => {
      if (candidate !== event) return;
      window.removeEventListener(event.type, observeBubbleCompletion);
      pendingMacroObservationListeners.delete(guard.dispatchId);
      report();
    };
    window.addEventListener(event.type, observeBubbleCompletion);
    pendingMacroObservationListeners.set(guard.dispatchId, {
      listener: observeBubbleCompletion,
      target: window,
      type: event.type
    });
  }

  function clearAllSuppressedShortcuts() {
    inFlightMacroKeyGuards.length = 0;
    for (const observation of pendingMacroObservationListeners.values()) {
      observation.target.removeEventListener(observation.type, observation.listener);
    }
    pendingMacroObservationListeners.clear();
    pendingMacroModifierTransitions.clear();
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

  function managedShortcutModifierCodes(trigger) {
    const required = [
      ["Alt", trigger.alt],
      ["Control", trigger.ctrl],
      ["Meta", trigger.meta],
      ["Shift", trigger.shift]
    ];
    return physicalModifierCodes().filter((code) =>
      required.some(([prefix, enabled]) => enabled && code.startsWith(prefix))
    );
  }

  function dispatchManagedShortcutPhase(active, phase) {
    if (typeof binding.managedShortcutKeyPhase !== "function") {
      return Promise.reject(new Error("Rion Studio managed shortcut IPC is unavailable."));
    }
    return Promise.resolve(binding.managedShortcutKeyPhase({
      code: active.code,
      macroId: active.macroId,
      modifierCodes: active.modifierCodes,
      phase,
      shortcutCycleId: active.shortcutCycleId
    })).then(() => {
      return reportMacroShortcutLifecycle(
        active.macroId,
        active.code,
        phase === "keyDown"
          ? "managed-keydown-acknowledged"
          : "managed-keyup-acknowledged"
      );
    });
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

  function releasePhysicalGameKey(code) {
    const active = physicalGameKeys.get(code);
    if (!active) return;
    physicalGameKeys.delete(code);
    const macroOwnership = macroModifierOwnership.get(code);
    if (macroOwnership) {
      macroOwnership.delivered = true;
      return;
    }
    dispatchPhysicalGameKeyUp(active);
  }

  function releasePhysicalGameKeys({ deferModifiers = false } = {}) {
    const deferredModifierCodes = [];
    for (const code of [...physicalGameKeys.keys()].reverse()) {
      if (deferModifiers && physicalModifierCodeSet.has(code)) {
        deferredModifierCodes.push(code);
        continue;
      }
      releasePhysicalGameKey(code);
    }
    if (deferredModifierCodes.length === 0) return Promise.resolve();
    // Presentation-only microtask: AppKit gets the rest of this focus-loss
    // event turn to deliver trusted flagsChanged releases. Any modifier still
    // present afterward did not receive the native handoff and needs the page
    // fallback exactly once.
    return Promise.resolve().then(() => {
      for (const code of deferredModifierCodes) releasePhysicalGameKey(code);
    });
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
    return Promise.resolve(binding.shortcutLifecycle?.({
      code,
      macroId,
      phase
    })).catch(() => undefined);
  }

  function beginManagedShortcutKeyUp(active) {
    if (active.keyUpPromise) return active.keyUpPromise;
    active.keyUpPromise = active.keyDownPromise
      .then(() => active.activationDispatchedPromise)
      .then(() => dispatchManagedShortcutPhase(active, "keyUp"))
      .then(() => {
        // EventBound fallback: an exact native receipt may terminalize after
        // Chromium has already hidden the old WebContents. If its suppressed
        // DOM keyup was observed, the active key is already absent; otherwise
        // release the page-owned key exactly once before completing cleanup.
        releaseForwardedMacroKey(active.code);
        return true;
      })
      .catch((error) => {
        active.failed = true;
        releaseForwardedMacroKey(active.code);
        console.warn("Unable to complete a managed Rion Studio shortcut.", error);
        return false;
      });
    return active.keyUpPromise;
  }

  function finishManagedKeyboardShortcut(macroId, active) {
    if (active.releasePromise) return active.releasePromise;
    active.mainReleased = true;
    activeKeyboardShortcuts.delete(macroId);
    const keyUpPromise = beginManagedShortcutKeyUp(active);
    if (active.activationMode !== "hold") {
      active.releasePromise = keyUpPromise;
      return active.releasePromise;
    }
    const holdReleasePromise = runAction("hold-release", macroId, {
      shortcutCycleId: active.shortcutCycleId
    }, true, true);
    active.releasePromise = Promise.all([keyUpPromise, holdReleasePromise]);
    return active.releasePromise;
  }

  function releaseActiveKeyboardShortcuts() {
    physicalShortcutEpoch += 1;
    const releases = [...activeKeyboardShortcuts.entries()].map(([macroId, active]) => {
      consumedPhysicalShortcutCodes.add(active.code);
      return finishManagedKeyboardShortcut(macroId, active);
    });
    releases.push(cancelMiddleButtonShortcut());
    suppressedMiddleButtonShortcutPhase = null;
    return Promise.all(releases);
  }

  function cancelMiddleButtonShortcut() {
    consumeNextMiddleButtonAuxClick = false;
    const active = activeMiddleButtonShortcut;
    activeMiddleButtonShortcut = null;
    if (!active || active.activationMode !== "hold") return Promise.resolve();
    return runAction("hold-release", active.macroId, {
      shortcutCycleId: active.shortcutCycleId
    }, true, true);
  }

  function middleButtonShortcutMatches(event, trigger) {
    return Boolean(
      trigger &&
      trigger.button === "middle" &&
      Boolean(event.ctrlKey) === Boolean(trigger.ctrl) &&
      Boolean(event.altKey) === Boolean(trigger.alt) &&
      Boolean(event.shiftKey) === Boolean(trigger.shift) &&
      Boolean(event.metaKey) === Boolean(trigger.meta)
    );
  }

  function mouseEventButton(event) {
    if (typeof event.button === "number") return event.button;
    if (event.which === 1) return 0;
    if (event.which === 2) return 1;
    if (event.which === 3) return 2;
    if (event.type === "mousedown" && (Number(event.buttons) & 4) !== 0) return 1;
    return -1;
  }

  function handleMiddleButtonDown(event) {
    if (!isTrustedUserEvent(event)) return;
    if (suppressedMiddleButtonShortcutPhase?.phase === "down") {
      suppressedMiddleButtonShortcutPhase.phase = "up";
      return;
    }
    if (suppressedMiddleButtonShortcutPhase?.phase === "aux") {
      suppressedMiddleButtonShortcutPhase = null;
    }
    if (mouseEventButton(event) !== 1) return;
    consumeNextMiddleButtonAuxClick = false;
    const activeElement = gameInputContextActive ? undefined : document.activeElement;
    if (
      (!gameInputContextActive && !eventPathIncludesCanvas(event)) ||
      shouldIgnoreShortcutEvent(event, activeElement, document.designMode)
    ) {
      return;
    }
    refreshIfStale();
    const matchingMacros = state.macros.filter(
      (macro) =>
        isShortcutMacroId(macro.id) &&
        macro.enabled !== false &&
        middleButtonShortcutMatches(event, macro.trigger)
    );
    if (matchingMacros.length === 0) return;
    if (matchingMacros.length !== 1) {
      console.warn("Multiple Rion Studio macros use the same middle-button shortcut for this role.");
      return;
    }
    consumeShortcutEvent(event);
    consumeNextMiddleButtonAuxClick = true;
    if (activeMiddleButtonShortcut) return;
    const macro = matchingMacros[0];
    const activationMode = macro.activationMode ?? "press";
    const active = {
      activationMode,
      epoch: physicalShortcutEpoch,
      macroId: macro.id,
      mainReleased: false,
      modifiers: physicalShortcutTriggerSnapshot(macro.trigger),
      shortcutCycleId: `${Date.now()}-${nextShortcutCycleId++}`
    };
    reportMacroShortcutLifecycle(macro.id, "MouseMiddle", "physical-keydown-managed");
    activeMiddleButtonShortcut = active;
    reportMacroShortcutLifecycle(macro.id, "MouseMiddle", "macro-dispatched");
    active.actionPromise = runAction(
      activationMode === "hold" ? "hold-start" : "press",
      macro.id,
      { shortcutCycleId: active.shortcutCycleId },
      true
    );
  }

  function handleMiddleButtonUp(event) {
    if (!isTrustedUserEvent(event)) return;
    if (suppressedMiddleButtonShortcutPhase?.phase === "up") {
      suppressedMiddleButtonShortcutPhase.phase = "aux";
      return;
    }
    const active = activeMiddleButtonShortcut;
    if (mouseEventButton(event) !== 1 && !active) return;
    if (!active) return;
    consumeShortcutEvent(event);
    consumeNextMiddleButtonAuxClick = true;
    activeMiddleButtonShortcut = null;
    active.mainReleased = true;
    if (active.activationMode === "hold") {
      void runAction("hold-release", active.macroId, {
        shortcutCycleId: active.shortcutCycleId
      }, true, true);
    }
  }

  function handleMiddleButtonAuxClick(event) {
    if (suppressedMiddleButtonShortcutPhase?.phase === "aux" && isTrustedUserEvent(event)) {
      const guard = suppressedMiddleButtonShortcutPhase;
      suppressedMiddleButtonShortcutPhase = null;
      reportObservedMiddleButton(guard, event);
      return;
    }
    if (!consumeNextMiddleButtonAuxClick) return;
    const button = mouseEventButton(event);
    if (button !== 1 && button !== -1) return;
    consumeNextMiddleButtonAuxClick = false;
    consumeShortcutEvent(event);
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
      const managedRepeat = [...activeKeyboardShortcuts.values()].some(
        (active) => active.code === event.code && !active.mainReleased
      );
      if (matchesOpenShortcut(event) || managedRepeat) {
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

    if (matchingMacros.length !== 1) {
      rememberPhysicalGameKey(event);
      console.warn("Multiple Rion Studio macros use the same shortcut for this role.");
      return;
    }

    const macro = matchingMacros[0];
    consumeShortcutEvent(event);
    if (activeKeyboardShortcuts.has(macro.id)) return;
    const activationMode = macro.activationMode ?? "press";
    let markActivationDispatched;
    const activationDispatchedPromise = new Promise((resolve) => {
      markActivationDispatched = resolve;
    });
    reportMacroShortcutLifecycle(
      macro.id,
      event.code,
      "physical-keydown-managed"
    );
    const active = {
      activationMode,
      activationDispatchedPromise,
      actionPromise: null,
      code: event.code,
      epoch: physicalShortcutEpoch,
      failed: false,
      keyUpPromise: null,
      macroId: macro.id,
      mainReleased: false,
      modifierCodes: managedShortcutModifierCodes(macro.trigger),
      modifiers: physicalShortcutTriggerSnapshot(macro.trigger),
      releasePromise: null,
      shortcutCycleId: `${Date.now()}-${nextShortcutCycleId++}`
    };
    activeKeyboardShortcuts.set(macro.id, active);
    active.keyDownPromise = dispatchManagedShortcutPhase(active, "keyDown").catch((error) => {
      active.failed = true;
      console.warn("Unable to begin a managed Rion Studio shortcut.", error);
      throw error;
    });
    active.actionPromise = active.keyDownPromise.then(() => {
      reportMacroShortcutLifecycle(macro.id, event.code, "macro-dispatched");
      return runAction(
        activationMode === "hold" ? "hold-start" : "press",
        macro.id,
        { shortcutCycleId: active.shortcutCycleId },
        true,
        false,
        markActivationDispatched
      );
    }).catch(() => undefined);
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
    const managedShortcuts = [...activeKeyboardShortcuts.entries()].filter(
      ([, active]) => active.code === event.code && !active.mainReleased
    );
    if (managedShortcuts.length > 0) {
      consumeShortcutEvent(event);
      for (const [macroId, active] of managedShortcuts) {
        void finishManagedKeyboardShortcut(macroId, active);
      }
      return;
    }
    const consumedShortcutKeyUp = consumedPhysicalShortcutCodes.delete(event.code);
    updateRuntimeTabShortcutModifier(event, false);
    const consumedModifierKeyUp = consumeOverlappingPhysicalModifierKeyUp(event);
    if (consumedShortcutKeyUp && !consumedModifierKeyUp) consumeShortcutEvent(event);
    if (!consumedModifierKeyUp) forgetPhysicalGameKey(event.code);
    if (coordinateMeasurementController?.handleKeyUp(event)) {
      return;
    }
    if (coordinateMeasurementPending) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  function suppressNextMiddleButtonShortcut(dispatchId) {
    const normalizedDispatchId = String(dispatchId);
    if (isDisposed || suppressedMiddleButtonShortcutPhase !== null) return false;
    if (!normalizedDispatchId) return false;
    suppressedMiddleButtonShortcutPhase = {
      dispatchId: normalizedDispatchId,
      phase: "down"
    };
    return true;
  }

  function clearSuppressedMiddleButtonShortcut(dispatchId) {
    const normalizedDispatchId = String(dispatchId);
    const observation = pendingMacroObservationListeners.get(normalizedDispatchId);
    if (observation) {
      observation.target.removeEventListener(observation.type, observation.listener);
      pendingMacroObservationListeners.delete(normalizedDispatchId);
    }
    if (suppressedMiddleButtonShortcutPhase?.dispatchId !== normalizedDispatchId) {
      return Boolean(observation);
    }
    suppressedMiddleButtonShortcutPhase = null;
    return true;
  }
