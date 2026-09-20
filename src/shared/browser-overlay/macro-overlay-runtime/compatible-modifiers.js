  // Bounded evidence only. Logical macro ownership remains in Core; the existing
  // modifier ownership map is its page-delivery follower, shared with trusted input.
  const compatibleModifierTransitions = [];
  let compatibleModifierTransitionSequence = 0;
  let compatibleDroppedModifierTransitions = 0;

  function compatibleModifierMask(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }

  function compatibleObservedModifierMask() {
    const codes = physicalModifierCodes();
    return (codes.some(code => code.startsWith("Alt")) ? 1 : 0) |
      (codes.some(code => code.startsWith("Control")) ? 2 : 0) |
      (codes.some(code => code.startsWith("Meta")) ? 4 : 0) |
      (codes.some(code => code.startsWith("Shift")) ? 8 : 0);
  }

  function recordCompatibleModifierTransition(source, code, phase, disposition, event = null) {
    if (!physicalModifierCodeSet.has(code)) return;
    compatibleModifierTransitions.push({
      sequence: ++compatibleModifierTransitionSequence, source, code, phase, disposition,
      physicalCodes: physicalModifierCodes(), coreCodes: [...macroModifierOwnership.keys()],
      eventModifierMask: event ? compatibleModifierMask(event) : null
    });
    if (compatibleModifierTransitions.length > 64) {
      compatibleModifierTransitions.shift();
      compatibleDroppedModifierTransitions += 1;
    }
  }

  function validCompatibleModifierState(state) {
    return state && [state.coreCodesBefore, state.coreCodesAfter, state.nativePhysicalCodes]
      .every(codes => Array.isArray(codes) && codes.length <= 8 &&
        new Set(codes).size === codes.length && codes.every(code => physicalModifierCodeSet.has(code)));
  }

  function compatibleModifierEvidence(state, before, disposition, event) {
    return {
      coreCodesBefore: [...state.coreCodesBefore], coreCodesAfter: [...state.coreCodesAfter],
      nativePhysicalCodes: [...state.nativePhysicalCodes], physicalCodesBefore: before,
      physicalCodesAfter: physicalModifierCodes(), disposition,
      eventModifierMask: event ? compatibleModifierMask(event) : null,
      transitions: compatibleModifierTransitions.map(entry => ({ ...entry,
        physicalCodes: [...entry.physicalCodes], coreCodes: [...entry.coreCodes] })),
      droppedTransitionCount: compatibleDroppedModifierTransitions
    };
  }

  // A later trusted physical event can prove a missed release without racing
  // the native snapshot against Chromium's queued DOM events. This is page
  // delivery metadata only; Core's logical modifier ownership is unchanged.
  const reconciledPhysicalModifierCodes = new Set();

  function reconcilePhysicalModifiers(event) {
    if (isDisposed) return;
    const families = [["Alt", "altKey"], ["Control", "ctrlKey"],
      ["Meta", "metaKey"], ["Shift", "shiftKey"]];
    for (const code of physicalModifierCodes().reverse()) {
      if (code === event.code) continue;
      if (!families.some(([prefix, flag]) => code.startsWith(prefix) && event[flag] === false)) continue;
      reconciledPhysicalModifierCodes.add(code);
      runtimeTabShortcutModifierCodes.delete(code);
      releasePhysicalGameKey(code, "physical-reconcile");
    }
  }

  function consumeReconciledPhysicalModifierKeyUp(event) {
    if (!reconciledPhysicalModifierCodes.delete(event.code)) return false;
    // Let Chromium update its native flags, but do not deliver a second release
    // to the page (which may now have a Core-owned holder of the same side).
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    return true;
  }
