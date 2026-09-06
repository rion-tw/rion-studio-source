import { describe, expect, it, vi } from "vitest";
import { sendChromiumClick, sendChromiumKey } from "../src/electron/main/chromiumWebContentsInput";

const key = { eventType: "keyDown", code: "KeyA", ctrl: false, alt: false,
  shift: false, meta: false, repeat: false } as const;

describe("Chromium engine input submission", () => {
  it.each(["win32", "darwin"] as const)("uses the same engine key mapping on %s", platform => {
    const contents = { sendInputEvent: vi.fn(), focus: vi.fn() };
    const receipt = sendChromiumKey(contents, { ...key, ctrl: platform === "win32",
      meta: platform === "darwin", shift: true });
    expect(contents.sendInputEvent).toHaveBeenCalledExactlyOnceWith({ type: "keyDown",
      keyCode: "A", modifiers: platform === "win32" ? ["control", "shift"] : ["shift", "meta"] });
    expect(contents.focus).not.toHaveBeenCalled();
    expect(receipt.submissionApi).toBe("webContents.sendInputEvent");
    expect(receipt).not.toHaveProperty("keyboardStateRestored");
  });

  it.each(["ControlLeft", "NumpadEnter", "constructor", "Keya"])("rejects unsupported %s before dispatch", code => {
    const contents = { sendInputEvent: vi.fn() };
    expect(() => sendChromiumKey(contents, { ...key, code })).toThrow("exact supported code");
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("converts CSS to local DIP once, including fractional zoom and middle clicks", () => {
    const contents = { sendInputEvent: vi.fn(), focus: vi.fn() };
    const receipt = sendChromiumClick(contents, { clientX: 81, clientY: 97,
      zoomFactor: 1.25, button: 1 }, { width: 400, height: 300 });
    expect(contents.sendInputEvent.mock.calls).toEqual([
      [{ type: "mouseDown", x: 101, y: 121, button: "middle", clickCount: 1, modifiers: ["middlebuttondown"] }],
      [{ type: "mouseUp", x: 101, y: 121, button: "middle", clickCount: 1, modifiers: [] }]
    ]);
    expect(receipt.expectedDomClientX).toBe(80);
    expect(receipt.expectedDomClientY).toBe(96);
    expect(contents.focus).not.toHaveBeenCalled();
  });

  it("rejects a point outside the actual view before any partial click", () => {
    const contents = { sendInputEvent: vi.fn() };
    expect(() => sendChromiumClick(contents, { clientX: 200, clientY: 1,
      zoomFactor: 2, button: 0 }, { width: 400, height: 300 })).toThrow("outside");
    expect(contents.sendInputEvent).not.toHaveBeenCalled();
  });

  it("does not return a complete submission when mouse-up dispatch throws", () => {
    const failure = new Error("surface retired");
    const contents = { sendInputEvent: vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw failure; }) };
    expect(() => sendChromiumClick(contents, { clientX: 1, clientY: 1,
      zoomFactor: 1, button: 0 }, { width: 400, height: 300 })).toThrow(failure);
    expect(contents.sendInputEvent).toHaveBeenCalledTimes(2);
  });
});
