  // Delivery metadata only. Core remains the sole owner of logical pressed keys.
  let compatibleGameTarget = null;
  let compatibleTargetToken = null;
  let compatibleInputSequence = 0;
  let compatibleInputEpoch = 0;
  let compatibleInputIdentity = null;

  function dispatchCompatibleInput(command) {
    let eventCount = 0;
    let submitted = false;
    let modifierEvidence;
    const receipt = (status, errorCode = null) => ({
      requestId: command.requestId, ownerId: command.ownerId, roleId: command.roleId,
      inputEpoch: command.inputEpoch, generation: command.generation,
      frameToken: command.frameToken, documentInstanceId: command.documentInstanceId,
      sequence: command.sequence, targetToken: compatibleTargetToken,
      isTrusted: false, eventCount, status, errorCode,
      ...(modifierEvidence ? { modifierEvidence } : {})
    });
    if (isDisposed || command.frameToken !== String(globalThis.__rionStudioDocumentInstanceId ?? "") ||
        !Number.isSafeInteger(command.sequence) || command.sequence <= compatibleInputSequence ||
        !Number.isSafeInteger(command.inputEpoch) || command.inputEpoch < compatibleInputEpoch ||
        !Number.isFinite(command.deadlineMs) || Date.now() >= command.deadlineMs ||
        !["normal", "cleanup"].includes(command.intent) ||
        !["focus", "key", "click"].includes(command.action)) {
      return receipt("failed", "SYSTEM_COMPATIBLE_INPUT_STALE");
    }
    const identity = JSON.stringify([command.roleId, command.generation, command.documentInstanceId]);
    if (compatibleInputIdentity !== null && compatibleInputIdentity !== identity)
      return receipt("failed", "SYSTEM_COMPATIBLE_INPUT_STALE");
    compatibleInputIdentity = identity;
    compatibleInputSequence = command.sequence;
    compatibleInputEpoch = command.inputEpoch;
    if (!compatibleGameTarget) {
      compatibleGameTarget = resolveMacroGameCanvas();
      if (compatibleGameTarget) compatibleTargetToken = crypto.randomUUID();
    }
    if (!isConnectedGameCanvas(compatibleGameTarget))
      return receipt("failed", "SYSTEM_COMPATIBLE_INPUT_TARGET_UNAVAILABLE");
    const target = compatibleGameTarget;
    const deliver = event => {
      if (isDisposed || !isConnectedGameCanvas(target)) throw new Error("Original game target retired.");
      // Skip shortcut/physical ownership handlers without suppressing page propagation.
      forwardedMacroGameEvents.add(event);
      submitted = true;
      target.dispatchEvent(event);
      eventCount += 1;
      if (isDisposed || !isConnectedGameCanvas(target)) throw new Error("Original game target retired.");
    };
    try {
      if (command.action === "key") {
        const key = command.key;
        if (!key || !["rawKeyDown", "keyUp"].includes(key.type) ||
            !validCompatibleModifierState(command.modifierState) ||
            (command.intent === "cleanup" && key.type !== "keyUp"))
          return receipt("failed", "SYSTEM_COMPATIBLE_INPUT_INVALID");
        // Native observation can lead Chromium's queued physical keyup. Keep
        // the page's still-held physical side until its exact DOM release.
        const modifiers = key.modifiers | compatibleObservedModifierMask();
        const event = new window.KeyboardEvent(key.type === "keyUp" ? "keyup" : "keydown", {
          code: key.code, key: (modifiers & 8) !== 0 ? key.shiftedKey ?? key.key : key.key,
          location: key.location, repeat: key.autoRepeat,
          altKey: (modifiers & 1) !== 0, ctrlKey: (modifiers & 2) !== 0,
          metaKey: (modifiers & 4) !== 0, shiftKey: (modifiers & 8) !== 0,
          bubbles: true, cancelable: true, composed: true
        });
        for (const property of ["keyCode", "which"])
          Object.defineProperty(event, property, { value: key.windowsVirtualKeyCode });
        const physicalBefore = physicalModifierCodes();
        // Apply the same Core-following overlap rules as trusted delivery before
        // marking the event forwarded. Physical key handlers see this ownership
        // synchronously, including an Alt-up between this effect and the next.
        const retained = key.type === "keyUp"
          ? consumeOverlappingMacroModifierKeyUp(event)
          : consumeOverlappingMacroModifierKeyDown(event);
        const disposition = retained
          ? key.type === "keyUp" ? "releaseOwnership" : "adoptPhysical" : "dispatch";
        recordCompatibleModifierTransition("compatible", key.code, key.type, disposition, retained ? null : event);
        modifierEvidence = compatibleModifierEvidence(command.modifierState, physicalBefore, disposition, retained ? null : event);
        if (retained) return receipt("applied");
        deliver(event);
        modifierEvidence = compatibleModifierEvidence(command.modifierState, physicalBefore, disposition, event);
      } else if (command.action === "click") {
        const pointer = command.pointer;
        if (!pointer || ![0, 1, 2].includes(pointer.button) ||
            ![pointer.clientX, pointer.clientY].every(Number.isFinite) ||
            (command.intent === "cleanup" && !pointer.releaseOnly))
          return receipt("failed", "SYSTEM_COMPATIBLE_INPUT_INVALID");
        const rect = target.getBoundingClientRect();
        if (!pointer.releaseOnly && (pointer.clientX < rect.left || pointer.clientX >= rect.right ||
            pointer.clientY < rect.top || pointer.clientY >= rect.bottom))
          return receipt("failed", "SYSTEM_COMPATIBLE_INPUT_OUTSIDE_GAME");
        const options = { clientX: pointer.clientX, clientY: pointer.clientY,
          button: pointer.button, bubbles: true, cancelable: true, composed: true,
          altKey: (pointer.modifiers & 1) !== 0, ctrlKey: (pointer.modifiers & 2) !== 0,
          metaKey: (pointer.modifiers & 4) !== 0, shiftKey: (pointer.modifiers & 8) !== 0,
          detail: 1 };
        if (!pointer.releaseOnly) {
          const buttons = pointer.button === 0 ? 1 : pointer.button === 1 ? 4 : 2;
          deliver(new window.PointerEvent("pointerdown", { ...options, buttons, pointerId: 1, pointerType: "mouse", isPrimary: true }));
          deliver(new window.MouseEvent("mousedown", { ...options, buttons }));
        }
        deliver(new window.PointerEvent("pointerup", { ...options, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        deliver(new window.MouseEvent("mouseup", { ...options, buttons: 0 }));
        if (!pointer.releaseOnly) {
          deliver(new window.PointerEvent(pointer.button === 0 ? "click" : "auxclick", {
            ...options, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true
          }));
          if (pointer.button === 2) deliver(new window.PointerEvent("contextmenu", {
            ...options, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true
          }));
        }
      }
      return receipt("applied");
    } catch {
      return receipt(submitted ? "indeterminate" : "failed", "SYSTEM_COMPATIBLE_INPUT_DELIVERY_FAILED");
    }
  }
