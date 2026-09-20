// Deterministic missing-keyup precondition in the existing isolated-world probe.
// The production endpoint and main-world consumer remain unchanged.
module.exports = async function probeModifierReconciliation(contents) {
  const start = await contents.executeJavaScript("received.length");
  const receipts = await contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
    const canvas = document.querySelector('canvas');
    const controller = globalThis.__rionStudioMacroOverlay;
    let sequence = 1000;
    const receipts = [];
    const physical = (type, code, keyCode, flags = {}) => canvas.dispatchEvent(new KeyboardEvent(type, {
      code, key: code, keyCode, which: keyCode, bubbles: true, ...flags
    }));
    const digit = (type) => receipts.push(controller.dispatchCompatibleInput({
      requestId: 'reconcile-' + ++sequence, ownerId: 'macro', roleId: 'role', generation: 1,
      inputEpoch: 1, frameToken: 'document', documentInstanceId: 'document', sequence,
      deadlineMs: Date.now() + 30000, intent: 'normal', action: 'key',
      modifierState: { coreCodesBefore: [], coreCodesAfter: [], nativePhysicalCodes: [] },
      key: { type, code: 'Digit0', key: '0', shiftedKey: ')', location: 0,
        windowsVirtualKeyCode: 48, modifiers: 0, autoRepeat: false }
    }));
    physical('keydown', 'MetaLeft', 91, { metaKey: true });
    physical('keydown', 'ShiftLeft', 16, { metaKey: true, shiftKey: true });
    // Both modifier keyups are deliberately absent; the next physical event
    // explicitly carries no modifiers, as in the diagnostic sequence.
    physical('keydown', 'KeyO', 79);
    digit('rawKeyDown'); digit('keyUp');
    physical('keyup', 'KeyO', 79);
    physical('keyup', 'ShiftLeft', 16); physical('keyup', 'MetaLeft', 91);
    return receipts;
  })()` }]);
  const events = await contents.executeJavaScript(`received.slice(${start})`);
  return { receipts, events };
};
