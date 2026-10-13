const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");

// Opt-in endurance evidence for the real isolated-world endpoint. The test owns
// its physical preconditions; this does not install a production input timer.
module.exports = async function compatibleInputSoak(contents, { durationMs, cycle }) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 12 * 60 * 60_000)
    throw new Error("Compatible-input soak duration must be 0..12 hours in milliseconds.");
  if (durationMs === 0) return null;
  await contents.executeJavaScript(`
    received.length = 0;
    const soakInput = document.createElement('input'); soakInput.id = 'soak-input';
    document.body.append(soakInput); soakInput.focus();
    // Establish focus before the simulated physical ownership precondition;
    // otherwise that focus transfer legitimately cleans up the physical key.
    document.querySelector('canvas').dispatchEvent(new KeyboardEvent('keydown', {
      code: 'AltLeft', key: 'Alt', keyCode: 18, which: 18, altKey: true, bubbles: true }));
    received.length = 0;
  `);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let cycles = 0, checkpoint = 0;
  while (performance.now() - start < durationMs) {
    const receipts = await cycle();
    assert.deepEqual(receipts.map(receipt => [receipt.status, receipt.eventCount]),
      [["applied", 0], ["applied", 1], ["applied", 1], ["applied", 0]],
      JSON.stringify({ physicalCodes: receipts[0].modifierEvidence?.physicalCodesBefore,
        transitions: receipts[0].modifierEvidence?.transitions?.slice(-3) }));
    const observed = await contents.executeJavaScript(`({
      activeElement: document.activeElement.id, events: received.splice(0)
    })`);
    assert.equal(observed.activeElement, "soak-input");
    assert.deepEqual(observed.events.map(event => [event.type, event.code, event.pressed]),
      [["keydown", "Digit3", [18, 51]], ["keydown", "Digit3", [18, 51]], ["keyup", "Digit3", [18]]]);
    assert(observed.events.every(event => event.altKey && !event.isTrusted && event.keyCode === 51));
    cycles++;
    if (performance.now() - checkpoint > 60_000) {
      checkpoint = performance.now();
      console.log(JSON.stringify({ probe: "compatible-input-soak", cycles,
        elapsedMs: Math.round(performance.now() - start), lastReceiptSequence: receipts.at(-1).sequence }));
    }
    await delay(100);
  }
  await contents.executeJavaScript(`document.querySelector('canvas').dispatchEvent(new KeyboardEvent('keyup', {
    code: 'AltLeft', key: 'Alt', keyCode: 18, which: 18, bubbles: true }));`);
  const final = await contents.executeJavaScript("received.splice(0)");
  assert.deepEqual(final.map(event => [event.type, event.code, event.pressed]), [["keyup", "AltLeft", []]]);
  return { startedAt, finishedAt: new Date().toISOString(), durationMs,
    elapsedMs: Math.round(performance.now() - start), cycles, final };
};
