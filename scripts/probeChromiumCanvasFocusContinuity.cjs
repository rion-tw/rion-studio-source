const assert = require("node:assert/strict");

// Real DOM event ordering with a controlled Core-facing observation sink.
// The caller separately authorizes each reassertion through the private endpoint.
module.exports = async function canvasFocusContinuity(contents, send) {
  await contents.executeJavaScript(`
    const focusInput = document.createElement('input'); focusInput.id = 'focus-input';
    const focusButton = document.createElement('button'); focusButton.id = 'focus-button';
    document.body.append(focusInput, focusButton);
    globalThis.resetOnCanvasBlur = true;
    document.querySelector('canvas').addEventListener('blur', () => {
      if (globalThis.resetOnCanvasBlur) pressed.clear();
    });
  `);
  const results = [];
  for (const destination of ["input", "button", "body", "redirected-control"]) {
    await contents.executeJavaScript("document.querySelector('canvas').focus(); received.length = 0;");
    await contents.executeJavaScriptInIsolatedWorld(999, [{ code: "focusLosses.length = 0" }]);
    const held = await send("Digit3", "rawKeyDown", [], []);
    assert.equal(held.status, "applied");
    await contents.executeJavaScript(`
      if (${JSON.stringify(destination)} === 'body') document.querySelector('canvas').blur();
      else if (${JSON.stringify(destination)} === 'button') focusButton.focus();
      else {
        if (${JSON.stringify(destination)} === 'redirected-control')
          focusInput.addEventListener('focusin', () => focusButton.focus(), { once: true });
        focusInput.focus();
      }
    `);
    const losses = await contents.executeJavaScriptInIsolatedWorld(999, [{
      code: "Promise.resolve().then(() => focusLosses.splice(0))"
    }]);
    assert.equal(losses.length, 1, destination);
    assert.equal(losses[0].reason, "blur");
    const cleared = await contents.executeJavaScript("({ pressed: [...pressed], activeId: document.activeElement.id })");
    assert.deepEqual(cleared.pressed, []);
    const restored = await send("Digit3", "rawKeyDown", [], []);
    assert.equal(restored.status, "applied");
    const after = await contents.executeJavaScript("({ pressed: [...pressed], activeId: document.activeElement.id })");
    assert.deepEqual(after.pressed, [51]);
    assert.equal(after.activeId, cleared.activeId);
    const released = await send("Digit3", "keyUp", [], []);
    assert.equal(released.status, "applied");
    assert.deepEqual(await contents.executeJavaScript("[...pressed]"), []);
    results.push({ destination, losses, cleared, after, receipts: [held, restored, released] });
  }
  await contents.executeJavaScript("globalThis.resetOnCanvasBlur = false; received.length = 0;");
  return results;
};
