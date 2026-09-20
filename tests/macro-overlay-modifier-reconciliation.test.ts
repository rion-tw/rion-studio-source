// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installMacroOverlayTestLifecycle, installOverlay, armShortcut, armModifierProjection } from "./helpers/macroOverlayKeyboardHarness";
import { chromiumCdpKeyDescriptor } from "../src/electron/main/chromiumCdpInputDescriptors";
import type { ChromiumCompatibleInputCommand, ChromiumCompatibleInputReceipt } from "../src/electron/ipc/chromiumCompatibleInputProtocol";

const modifiers = [
  ["Alt", "altKey", 18], ["Control", "ctrlKey", 17],
  ["Meta", "metaKey", 91], ["Shift", "shiftKey", 16]
] as const;

describe.each(["darwin", "win32"] as const)("%s physical modifier reconciliation", platform => {
  installMacroOverlayTestLifecycle();
  function setup() {
    vi.stubGlobal("__rionStudioDocumentInstanceId", "document-token");
    const controller = installOverlay() as ReturnType<typeof installOverlay> & {
      dispatchCompatibleInput: (command: ChromiumCompatibleInputCommand) => ChromiumCompatibleInputReceipt;
    };
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();
    const events: KeyboardEvent[] = [];
    const held = new Set<string>();
    for (const type of ["keydown", "keyup"]) canvas.addEventListener(type, raw => {
      const event = raw as KeyboardEvent;
      events.push(event);
      if (type === "keydown") held.add(event.code); else held.delete(event.code);
    });
    const physical = (type: string, code: string, flags: KeyboardEventInit = {}) => {
      const keyCode = modifiers.find(([family]) => code.startsWith(family))?.[2] ?? 79;
      const event = new KeyboardEvent(type, { code, key: code, keyCode, which: keyCode,
        location: code.endsWith("Right") ? 2 : 1, bubbles: true, cancelable: true, ...flags });
      canvas.dispatchEvent(event);
      return event;
    };
    let sequence = 0;
    let core: string[] = [];
    const key = (code = "Digit0", phase: "rawKeyDown" | "keyUp" = "rawKeyDown", after: string[] = []) => {
      const receipt = controller.dispatchCompatibleInput({
        requestId: `request-${++sequence}`, ownerId: "macro", roleId: "role", inputEpoch: 1,
        generation: 1, frameToken: "document-token", documentInstanceId: "document", sequence,
        deadlineMs: Date.now() + 10_000, intent: "normal", action: "key",
        modifierState: { coreCodesBefore: core, coreCodesAfter: after, nativePhysicalCodes: [] },
        key: { ...chromiumCdpKeyDescriptor({ code, phase, activeCodesBefore: core, activeCodes: after,
          autoRepeat: false, suppressShortcut: true }, platform), shiftedKey: ")" }
      });
      core = after;
      return receipt;
    };
    return { controller, canvas, events, held, physical, key };
  }

  it("releases missing Command/Shift before the next physical key and compatible output", () => {
    const { physical, key, events, held, controller } = setup();
    physical("keydown", "MetaLeft", { metaKey: true });
    physical("keydown", "ShiftLeft", { metaKey: true, shiftKey: true });
    physical("keydown", "KeyO");
    expect(events.map(e => `${e.type}:${e.code}`)).toEqual([
      "keydown:MetaLeft", "keydown:ShiftLeft", "keyup:ShiftLeft", "keyup:MetaLeft", "keydown:KeyO"
    ]);
    expect(controller.physicalModifierCodes()).toEqual([]);
    const receipt = key();
    expect(receipt).toMatchObject({ status: "applied", modifierEvidence: { eventModifierMask: 0 } });
    expect(events.at(-1)).toMatchObject({ key: "0", keyCode: 48, which: 48, metaKey: false, shiftKey: false });
    expect(receipt.modifierEvidence?.transitions.filter(t => t.source === "physical-reconcile")).toHaveLength(2);
    physical("keyup", "KeyO"); key("Digit0", "keyUp");
    expect([...held]).toEqual([]);
  });

  for (const [family, flag, keyCode] of modifiers) for (const side of ["Left", "Right"]) {
    const code = `${family}${side}`;
    it(`corrects missing ${code} on keyup and ignores its later release once`, () => {
      const { physical, events, controller } = setup();
      physical("keydown", code, { [flag]: true });
      physical("keyup", "KeyO");
      expect(controller.physicalModifierCodes()).toEqual([]);
      expect(events.filter(e => e.type === "keyup" && e.code === code)).toHaveLength(1);
      expect(physical("keyup", code).defaultPrevented).toBe(false);
      expect(events.filter(e => e.type === "keyup" && e.code === code)).toHaveLength(1);
      expect(events.find(e => e.type === "keyup" && e.code === code)).toMatchObject({ [flag]: false, keyCode, which: keyCode });
      expect(controller.physicalModifierCodes()).toEqual([]);
      physical("keydown", code, { [flag]: true });
      physical("keyup", code);
      expect(events.filter(e => e.type === "keyup" && e.code === code)).toHaveLength(2);
    });
    it(`retains Core-owned ${code} through correction and the delayed physical keyup`, () => {
      const { physical, key, held, events } = setup();
      physical("keydown", code, { [flag]: true });
      key(code, "rawKeyDown", [code]);
      physical("keydown", "KeyO");
      physical("keyup", code);
      expect(held.has(code)).toBe(true);
      expect(events.filter(e => e.type === "keyup" && e.code === code)).toHaveLength(0);
      key(code, "keyUp");
      expect(held.has(code)).toBe(false);
      expect(events.filter(e => e.type === "keyup" && e.code === code)).toHaveLength(1);
    });
  }

  it("does not infer side releases while the family flag remains set", () => {
    const { physical, controller, events } = setup();
    physical("keydown", "AltLeft", { altKey: true });
    physical("keydown", "AltRight", { altKey: true });
    physical("keydown", "KeyO", { altKey: true });
    expect(controller.physicalModifierCodes()).toEqual(["AltLeft", "AltRight"]);
    physical("keyup", "AltLeft", { altKey: true });
    physical("keyup", "AltRight");
    expect(events.filter(e => e.type === "keyup" && e.code.startsWith("Alt"))).toHaveLength(2);
  });

  it("lets the current modifier keyup release itself while correcting the opposite stale side", () => {
    const { physical, controller, events } = setup();
    physical("keydown", "AltLeft", { altKey: true });
    physical("keydown", "AltRight", { altKey: true });
    physical("keyup", "AltLeft");
    expect(controller.physicalModifierCodes()).toEqual([]);
    expect(events.filter(e => e.type === "keyup").map(e => e.code)).toEqual(["AltRight", "AltLeft"]);
    physical("keyup", "AltRight");
    expect(events.filter(e => e.type === "keyup")).toHaveLength(2);
  });

  it("disposal prevents a retired controller from dispatching or observing later input", () => {
    const { physical, controller, canvas, key } = setup();
    physical("keydown", "AltLeft", { altKey: true });
    controller.dispose();
    const release = vi.fn(); canvas.addEventListener("keyup", release);
    physical("keydown", "KeyO");
    expect(release).not.toHaveBeenCalled();
    expect(key()).toMatchObject({ status: "failed", errorCode: "SYSTEM_COMPATIBLE_INPUT_STALE" });
  });

  it("keeps Core flags on corrective releases of a different physical family", () => {
    const { physical, key, events } = setup();
    key("AltLeft", "rawKeyDown", ["AltLeft"]);
    physical("keydown", "ShiftLeft", { shiftKey: true });
    physical("keydown", "KeyO");
    expect(events.find(e => e.type === "keyup" && e.code === "ShiftLeft")).toMatchObject({ altKey: true, shiftKey: false });
  });

  it("does not treat forwarded compatible events or armed macro/projection input as physical truth", () => {
    const { physical, key, controller } = setup();
    physical("keydown", "AltLeft", { altKey: true });
    key();
    armShortcut(controller, "KeyO"); physical("keydown", "KeyO");
    armShortcut(controller, "KeyO", "keyup"); physical("keyup", "KeyO");
    armModifierProjection(controller, "ShiftLeft"); physical("keydown", "ShiftLeft");
    expect(controller.physicalModifierCodes()).toEqual(["AltLeft"]);
  });

  it("does not redirect releases from a detached original target to its replacement", () => {
    const { physical, canvas, events, controller } = setup();
    physical("keydown", "AltLeft", { altKey: true });
    canvas.remove();
    const replacement = document.createElement("canvas");
    document.body.append(replacement);
    const seen = vi.fn(); replacement.addEventListener("keyup", seen);
    replacement.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyO", bubbles: true }));
    expect(events.filter(e => e.type === "keyup")).toHaveLength(0);
    expect(seen).not.toHaveBeenCalled();
    expect(controller.physicalModifierCodes()).toEqual([]);
  });
});
