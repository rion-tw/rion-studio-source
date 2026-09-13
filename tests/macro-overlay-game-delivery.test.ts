// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installMacroOverlayTestLifecycle, installOverlay, keyEvent, armShortcut, type OverlayBinding } from "./helpers/macroOverlayKeyboardHarness";

describe("macro game target delivery", () => {
  installMacroOverlayTestLifecycle();
  it.each(["canvas", "chat", "chat-switch"])("pairs 100 Shift+1 taps with %s focus and never replays after release", async (focus) => {
    const observed = vi.fn(async () => undefined);
    const binding = vi.fn(async () => ({ macros: [], statuses: [] }));
    Object.assign(binding, { macroKeyObserved: observed });
    const controller = installOverlay(binding as OverlayBinding);
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    const input = document.createElement("input");
    const otherInput = document.createElement("input");
    input.value = "chat remains intact";
    document.body.append(canvas, input, otherInput);
    const held = new Set<string>();
    let downs = 0;
    let ups = 0;
    canvas.addEventListener("keydown", event => { held.add(event.code); downs++; });
    canvas.addEventListener("keyup", event => { held.delete(event.code); ups++; });
    for (let cycle = 0; cycle < 100; cycle++) {
      const target = focus === "canvas" ? canvas : input;
      target.focus();
      input.setSelectionRange(2, 5);
      for (const code of ["ShiftLeft", "Digit1"]) {
        armShortcut(controller, code);
        target.dispatchEvent(keyEvent("keydown", code, code === "Digit1" ? "!" : "Shift", { shiftKey: true }));
      }
      if (focus === "chat-switch") otherInput.focus();
      const releaseTarget = focus === "chat-switch" ? otherInput : target;
      for (const code of ["Digit1", "ShiftLeft"]) {
        armShortcut(controller, code, "keyup");
        releaseTarget.dispatchEvent(keyEvent("keyup", code, code === "Digit1" ? "!" : "Shift", { shiftKey: code === "Digit1" }));
      }
      await Promise.resolve();
      expect([...held]).toEqual([]);
      expect(input.value).toBe("chat remains intact");
      expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
      expect(document.activeElement).toBe(releaseTarget);
    }
    canvas.focus();
    input.focus();
    await Promise.resolve();
    expect([downs, ups]).toEqual([200, 200]);
    expect(observed).toHaveBeenCalledTimes(400);
  });

  it("retains the original target after unconfirmed keyup for Core-authorized cleanup", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    const otherCanvas = document.createElement("canvas");
    const input = document.createElement("input");
    document.body.append(canvas, otherCanvas, input);
    canvas.tabIndex = otherCanvas.tabIndex = 0;
    const owner = { ownerId: "run", requestId: "request", inputEpoch: 1, surfaceGeneration: 1 };
    const arm = (id: string, phase: "keydown" | "keyup") =>
      controller.suppressShortcutSequence(id, "Digit1", [phase], false, [], owner);
    canvas.focus();
    expect(arm("down", "keydown")).toBe(true);
    canvas.dispatchEvent(keyEvent("keydown", "Digit1", "1"));
    controller.clearSuppressedShortcut("down", true);
    input.focus();
    expect(arm("up", "keyup")).toBe(true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = vi.spyOn(canvas, "dispatchEvent").mockImplementationOnce(() => { throw new Error("target dispatch unknown"); });
    input.dispatchEvent(keyEvent("keyup", "Digit1", "1"));
    broken.mockRestore();
    controller.clearSuppressedShortcut("up", false);
    expect(controller.releaseForwardedMacroKey("Digit1")).toBe(false);
    const originalReleased = vi.fn();
    const wrongReleased = vi.fn();
    canvas.addEventListener("keyup", originalReleased);
    otherCanvas.addEventListener("keyup", wrongReleased);
    otherCanvas.focus();
    expect(arm("recovery", "keyup")).toBe(true);
    otherCanvas.dispatchEvent(keyEvent("keyup", "Digit1", "1"));
    expect(originalReleased).toHaveBeenCalledOnce();
    expect(wrongReleased).not.toHaveBeenCalled();
    controller.clearSuppressedShortcut("recovery", true);
    warning.mockRestore();
  });

  it("releases the original canvas and never a replacement target", () => {
    const controller = installOverlay();
    const canvas = document.createElement("canvas");
    const replacement = document.createElement("canvas");
    const input = document.createElement("input");
    document.body.append(canvas, input);
    input.focus();
    armShortcut(controller, "Digit1");
    input.dispatchEvent(keyEvent("keydown", "Digit1", "!", { shiftKey: true }));
    canvas.remove();
    document.body.append(replacement);
    const release = vi.fn();
    replacement.addEventListener("keyup", release);
    armShortcut(controller, "Digit1", "keyup");
    input.dispatchEvent(keyEvent("keyup", "Digit1", "1"));
    expect(release).not.toHaveBeenCalled();
  });


});
