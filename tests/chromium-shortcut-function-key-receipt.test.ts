import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sampleFunctionKeyCase } from "../scripts/chromiumShortcutFunctionKeyReceipt.cjs";

function renderer() {
  const document = new EventTarget();
  const context = createContext({ window: { document, setTimeout, clearTimeout, shortcutEvents: [] } });
  const contents = { executeJavaScript: vi.fn(async (script: string): Promise<unknown> =>
    runInContext(script, context) as unknown) };
  const emit = (type: "keydown" | "keyup", code: string, control = false) => {
    const event = new Event(type);
    Object.defineProperties(event, { code: { value: code }, repeat: { value: false },
      shiftKey: { value: false }, ctrlKey: { value: control } });
    document.dispatchEvent(event);
  };
  const functionPair = () => { emit("keydown", "F4", true); emit("keyup", "F4", true); };
  const sentinelPair = () => { emit("keydown", "Digit3"); emit("keyup", "Digit3"); };
  let submitted!: () => void;
  const entered = new Promise<void>(resolve => { submitted = resolve; });
  const submit = vi.fn(async () => { submitted(); return { id: 7, inserted: 6 }; });
  return { contents, emit, functionPair, sentinelPair, entered, submit };
}

describe("positive native function-key DOM acknowledgement", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits beyond the old 150ms sample and freezes the actual terminal Digit3 keyup receipt", async () => {
    const state = renderer();
    const settled = vi.fn();
    const sample = sampleFunctionKeyCase(state.contents, "main:F4:control", state.submit);
    void sample.then(settled);
    await state.entered;
    state.functionPair();

    await vi.advanceTimersByTimeAsync(250);
    expect(settled).not.toHaveBeenCalled();
    state.emit("keydown", "Digit3");
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    state.emit("keyup", "Digit3");

    const { receipt, submission } = await sample;
    expect(receipt).toEqual({ caseId: "main:F4:control", status: "received", events: [
      { type: "keydown", code: "F4", trusted: false, repeat: false, shift: false, control: true },
      { type: "keyup", code: "F4", trusted: false, repeat: false, shift: false, control: true },
      { type: "keydown", code: "Digit3", trusted: false, repeat: false, shift: false, control: false },
      { type: "keyup", code: "Digit3", trusted: false, repeat: false, shift: false, control: false }
    ] });
    expect(submission).toEqual({ id: 7, inserted: 6 });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.events)).toBe(true);
    expect(receipt.events.every(Object.isFrozen)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    state.emit("keydown", "F5");
    state.sentinelPair();
    expect(receipt.events).toHaveLength(4);
    expect(state.submit).toHaveBeenCalledTimes(1);
  });

  it("retains a terminal receipt that arrives before the SendInput insertion promise returns", async () => {
    const state = renderer();
    const sample = await sampleFunctionKeyCase(state.contents, "main:F4:control", async () => {
      state.functionPair();
      state.sentinelPair();
      return { id: 1, inserted: 6 };
    });
    expect(sample.receipt.status).toBe("received");
    expect(sample.receipt.events.map(event => event.code)).toEqual(["F4", "F4", "Digit3", "Digit3"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with partial events at the deadline and never submits or clears the next case", async () => {
    const state = renderer();
    const sequence = (async () => {
      for (const caseId of ["main:F4:control", "main:F5:plain"]) {
        await sampleFunctionKeyCase(state.contents, caseId, state.submit, 500);
      }
    })();
    const failed = expect(sequence).rejects.toMatchObject({
      code: "CHROMIUM_SHORTCUT_PROBE_ACKNOWLEDGEMENT_FAILED",
      receipt: { caseId: "main:F4:control", status: "indeterminate",
        events: [expect.objectContaining({ code: "F4", type: "keydown" }),
          expect.objectContaining({ code: "F4", type: "keyup" })] },
      submission: { inserted: 6 }
    });
    await state.entered;
    state.functionPair();
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    expect(state.submit).toHaveBeenCalledTimes(1);
    const partial = await state.contents.executeJavaScript("window.functionKeyProbe.promise");
    state.sentinelPair();
    expect(await state.contents.executeJavaScript("window.functionKeyProbe.promise")).toBe(partial);
    await expect(sampleFunctionKeyCase(state.contents, "main:F5:plain", state.submit))
      .rejects.toThrow("The previous function-key observation did not complete successfully.");
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminalizes a failed native submission with its original cause and partial DOM evidence", async () => {
    const state = renderer();
    const failure = new Error("Exact HWND lost foreground before SendInput");
    await expect(sampleFunctionKeyCase(state.contents, "main:F4:control", async () => {
      state.emit("keydown", "F4", true);
      throw failure;
    })).rejects.toMatchObject({ code: "CHROMIUM_SHORTCUT_PROBE_SUBMISSION_FAILED", cause: failure,
      receipt: { status: "submission-failed", events: [expect.objectContaining({ code: "F4" })] } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the original submission failure when the renderer cleanup RPC fails", async () => {
    const state = renderer();
    const execute = state.contents.executeJavaScript.getMockImplementation()!;
    state.contents.executeJavaScript.mockImplementation(async script => {
      if (script === "window.functionKeyProbe.cancelSubmission()") {
        throw new Error("The exact test WebContents was destroyed");
      }
      return execute(script);
    });
    const failure = new Error("Exact HWND lost foreground before SendInput");
    const submitted = vi.fn(async () => { throw failure; });
    await expect(sampleFunctionKeyCase(state.contents, "main:F4:control", submitted, 500))
      .rejects.toMatchObject({ code: "CHROMIUM_SHORTCUT_PROBE_SUBMISSION_FAILED", cause: failure,
        cleanupError: { name: "Error", message: "The exact test WebContents was destroyed" } });
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(state.contents.executeJavaScript).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
  });
});
