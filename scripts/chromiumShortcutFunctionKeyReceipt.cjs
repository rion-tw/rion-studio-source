// Native compatibility probe only. This function is serialized into the exact
// test document; it has no Node or product-runtime dependencies.
function armFunctionKeyReceipt(target, caseId, deadlineMs) {
  const previous = target.functionKeyProbe;
  if (previous && previous.status !== "received") {
    throw new Error("The previous function-key observation did not complete successfully.");
  }
  const events = [];
  let deadline;
  let resolveReceipt;
  const state = { caseId, status: "pending", promise: new Promise(resolve => { resolveReceipt = resolve; }) };
  const finish = status => {
    if (state.status !== "pending") return state.receipt;
    state.status = status;
    target.clearTimeout(deadline);
    target.document.removeEventListener("keydown", receive, true);
    target.document.removeEventListener("keyup", receive, true);
    state.receipt = Object.freeze({ caseId, status,
      events: Object.freeze(events.map(event => Object.freeze({ ...event }))) });
    resolveReceipt(state.receipt);
    return state.receipt;
  };
  const receive = event => {
    if (!/^F[0-9]+$/.test(event.code) && event.code !== "Digit3") return;
    events.push({ type: event.type, code: event.code, trusted: event.isTrusted,
      repeat: event.repeat, shift: event.shiftKey, control: event.ctrlKey });
    if (event.type === "keyup" && event.code === "Digit3") finish("received");
  };
  state.cancelSubmission = () => finish("submission-failed");
  target.functionKeyProbe = state;
  target.shortcutEvents = [];
  target.document.addEventListener("keydown", receive, true);
  target.document.addEventListener("keyup", receive, true);
  // Test-only external DOM acknowledgement deadline. Expiry records partial
  // evidence and cannot authorize another case or successful delivery.
  deadline = target.setTimeout(() => finish("indeterminate"), deadlineMs);
}

async function sampleFunctionKeyCase(contents, caseId, submit, deadlineMs = 1500) {
  if (typeof caseId !== "string" || !caseId || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("The function-key observation identity or deadline is invalid.");
  }
  await contents.executeJavaScript(
    `(${armFunctionKeyReceipt.toString()})(window, ${JSON.stringify(caseId)}, ${deadlineMs});`
  );
  let submission;
  try {
    submission = await submit();
  } catch (cause) {
    const error = new Error("The native function-key submission failed.", { cause });
    error.code = "CHROMIUM_SHORTCUT_PROBE_SUBMISSION_FAILED";
    try {
      error.receipt = await contents.executeJavaScript("window.functionKeyProbe.cancelSubmission()");
    } catch (cleanupError) {
      error.cleanupError = Object.freeze({
        name: String(cleanupError?.name ?? "Error").slice(0, 128),
        message: String(cleanupError?.message ?? cleanupError).slice(0, 2048)
      });
    }
    throw error;
  }
  const receipt = await contents.executeJavaScript("window.functionKeyProbe.promise");
  if (receipt.caseId !== caseId || receipt.status !== "received") {
    const error = new Error(`The function-key DOM acknowledgement did not complete: ${JSON.stringify(receipt)}`);
    error.code = "CHROMIUM_SHORTCUT_PROBE_ACKNOWLEDGEMENT_FAILED";
    error.receipt = receipt;
    error.submission = submission;
    throw error;
  }
  return Object.freeze({ receipt, submission });
}

module.exports = { sampleFunctionKeyCase };
