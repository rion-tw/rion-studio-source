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
