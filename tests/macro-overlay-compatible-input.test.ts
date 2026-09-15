// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installMacroOverlayTestLifecycle, installOverlay } from "./helpers/macroOverlayKeyboardHarness";
import type { ChromiumCompatibleInputCommand as Command, ChromiumCompatibleInputReceipt as Receipt } from "../src/electron/ipc/chromiumCompatibleInputProtocol";
import { chromiumCdpKeyDescriptor } from "../src/electron/main/chromiumCdpInputDescriptors";

describe.each(["darwin", "win32"] as const)("%s compatible game input", platform => {
  installMacroOverlayTestLifecycle();
  function setup() {
    vi.stubGlobal("__rionStudioDocumentInstanceId", "document-token");
    const binding = vi.fn(async (_request: unknown) => ({ macros: [], statuses: [] }));
    const controller = installOverlay(binding) as ReturnType<typeof installOverlay> & {
      dispatchCompatibleInput: (command: Command) => Receipt;
    };
    const canvas = document.createElement("canvas");
    canvas.tabIndex = 0;
    document.body.append(canvas);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 480));
    canvas.focus();
    let sequence = 0;
    const dispatch = (fields: Partial<Command>) => controller.dispatchCompatibleInput({
      requestId: `request-${sequence + 1}`, ownerId: "macro-owner", roleId: "role", inputEpoch: 1,
      generation: 1, frameToken: "document-token", documentInstanceId: "document-id",
      sequence: ++sequence, deadlineMs: Date.now() + 60_000, intent: "normal", action: "focus", ...fields
    });
    let coreCodes: string[] = [];
    const key = (code: string, phase: "rawKeyDown" | "keyUp", activeCodes: string[]) => {
      const physical = controller.physicalModifierCodes();
      const after = activeCodes.filter(code => /^(Alt|Shift|Control|Meta)(Left|Right)$/.test(code));
      const result = dispatch({
        modifierState: { coreCodesBefore: coreCodes, coreCodesAfter: after, nativePhysicalCodes: physical },
        action: "key", key: chromiumCdpKeyDescriptor({ code, phase, activeCodesBefore: coreCodes,
          activeCodes: [...new Set([...activeCodes, ...physical])], autoRepeat: false, suppressShortcut: true }, platform)
      });
      if (result.status === "applied") coreCodes = after;
      return result;
    };
    expect(dispatch({}).status).toBe("applied");
    return { canvas, dispatch, key, binding, controller };
  }

  for (const modifier of ["Alt", "Shift", "Control", "Meta"]) {
    for (const side of ["Left", "Right"]) {
      const code = `${modifier}${side}`;
      const flag = `${modifier === "Control" ? "ctrl" : modifier.toLowerCase()}Key`;
      it(`retains physical ${code} across 100 compatible macro cycles`, () => {
        const { canvas, key, controller } = setup();
        const held = new Set<string>();
        const edges: string[] = [];
        canvas.addEventListener("keydown", event => { held.add(event.code); edges.push(`down:${event.code}`); });
        canvas.addEventListener("keyup", event => { held.delete(event.code); edges.push(`up:${event.code}`); });
        canvas.dispatchEvent(new KeyboardEvent("keydown", { code, key: modifier, [flag]: true, bubbles: true }));
        for (let cycle = 0; cycle < 100; cycle++) {
          expect(key("Digit1", "rawKeyDown", ["Digit1"]).status).toBe("applied");
          expect(held.has(code)).toBe(true);
          key("Digit1", "keyUp", []);
          expect(key(code, "rawKeyDown", [code])).toMatchObject({ status: "applied", eventCount: 0 });
          key("Digit3", "rawKeyDown", [code, "Digit3"]);
          expect(held.has(code)).toBe(true);
          key("Digit3", "keyUp", [code]);
          expect(key(code, "keyUp", [])).toMatchObject({ status: "applied", eventCount: 0 });
          expect(held.has(code)).toBe(true);
        }
        expect(controller.physicalModifierCodes()).toEqual([code]);
        expect(edges.filter(edge => edge.endsWith(`:${code}`))).toEqual([`down:${code}`]);
        canvas.dispatchEvent(new KeyboardEvent("keyup", { code, key: modifier, bubbles: true }));
        expect([...held]).toEqual([]);
      });

      it.each(["before", "between", "after-main", "after-cleanup"])(
        `preserves ${code} ownership when physical release occurs %s`, releaseAt => {
          const { canvas, key } = setup();
          const held = new Set<string>();
          const mainStates: boolean[] = [];
          const flags: boolean[] = [];
          canvas.addEventListener("keydown", event => {
            held.add(event.code);
            if (event.code === "Digit3") {
              mainStates.push(held.has(code));
              flags.push(Boolean(event[flag as keyof KeyboardEvent]));
            }
          });
          canvas.addEventListener("keyup", event => {
            held.delete(event.code);
            if (event.code === "Digit3") {
              mainStates.push(held.has(code));
              flags.push(Boolean(event[flag as keyof KeyboardEvent]));
            }
          });
          const release = () => canvas.dispatchEvent(new KeyboardEvent("keyup", { code, key: modifier, bubbles: true }));
          canvas.dispatchEvent(new KeyboardEvent("keydown", { code, key: modifier, [flag]: true, bubbles: true }));
          if (releaseAt === "before") release();
          key(code, "rawKeyDown", [code]);
          if (releaseAt === "between") release();
          key("Digit3", "rawKeyDown", [code, "Digit3"]);
          if (releaseAt === "after-main") { release(); expect(held.has(code)).toBe(true); }
          key("Digit3", "keyUp", [code]);
          key(code, "keyUp", []);
          if (releaseAt === "after-cleanup") release();
          expect(mainStates).toEqual([true, true]);
          expect(flags).toEqual([true, true]);
          expect([...held]).toEqual([]);
        }
      );

      it(`hands ${code} from Core to physical ownership with one final release`, () => {
        const { canvas, key } = setup();
        const edges: string[] = [];
        for (const type of ["keydown", "keyup"]) {
          canvas.addEventListener(type, event => edges.push(`${type}:${(event as KeyboardEvent).code}`));
        }
        key(code, "rawKeyDown", [code]);
        canvas.dispatchEvent(new KeyboardEvent("keydown", { code, key: modifier, [flag]: true, bubbles: true }));
        expect(key(code, "keyUp", [])).toMatchObject({
          status: "applied", eventCount: 0, modifierEvidence: { disposition: "releaseOwnership" }
        });
        canvas.dispatchEvent(new KeyboardEvent("keyup", { code, key: modifier, bubbles: true }));
        expect(edges).toEqual([`keydown:${code}`, `keyup:${code}`]);
      });
    }
  }

  it("delivers 100 paired key/click cycles behind a focused iframe without activating it or losing progress", () => {
    const { canvas, dispatch, key, binding } = setup();
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    iframe.focus();
    const challengeEvents = vi.fn();
    for (const type of ["keydown", "keyup", "mousedown", "mouseup", "click", "auxclick"])
      iframe.contentWindow!.addEventListener(type, challengeEvents);
    const held = new Set<string>();
    const downs: KeyboardEvent[] = [];
    const clicks: MouseEvent[] = [];
    canvas.addEventListener("keydown", event => { held.add(event.code); downs.push(event); });
    canvas.addEventListener("keyup", event => held.delete(event.code));
    canvas.addEventListener("click", event => clicks.push(event));
    canvas.addEventListener("auxclick", event => clicks.push(event));
    const activationCount = binding.mock.calls.filter(call => (call[0] as { type?: string })?.type === "activate").length;
    for (let cycle = 0; cycle < 100; cycle++) {
      expect(key("ShiftLeft", "rawKeyDown", ["ShiftLeft"]).status).toBe("applied");
      expect(key("Digit2", "rawKeyDown", ["ShiftLeft", "Digit2"]).status).toBe("applied");
      expect(key("Digit2", "keyUp", ["ShiftLeft"]).status).toBe("applied");
      expect(key("ShiftLeft", "keyUp", []).status).toBe("applied");
      for (const button of [0, 1, 2] as const) {
        expect(dispatch({ action: "click", pointer: { clientX: 40, clientY: 50,
          button, modifiers: 0, releaseOnly: false } })).toMatchObject({
          status: "applied", isTrusted: false, eventCount: button === 2 ? 6 : 5
        });
      }
      expect([...held]).toEqual([]);
      expect(document.activeElement).toBe(iframe);
    }
    expect(downs).toHaveLength(200);
    expect(downs.filter(event => event.code === "Digit2").every(event => event.key === "@" && event.keyCode === 50)).toBe(true);
    expect(clicks).toHaveLength(300);
    expect(clicks.every(event => !event.isTrusted)).toBe(true);
    expect(challengeEvents).not.toHaveBeenCalled();
    expect(binding.mock.calls.filter(call => (call[0] as { type?: string })?.type === "activate")).toHaveLength(activationCount);
    iframe.remove();
    expect(key("KeyJ", "rawKeyDown", ["KeyJ"]).status).toBe("applied");
    expect(key("KeyJ", "keyUp", []).status).toBe("applied");
  });

  it("rejects replay, expiry and old epochs without dispatching", () => {
    const { canvas, dispatch, key } = setup();
    const down = vi.fn();
    canvas.addEventListener("keydown", down);
    expect(key("KeyJ", "rawKeyDown", ["KeyJ"]).status).toBe("applied");
    for (const fields of [{ sequence: 1 }, { inputEpoch: 0 }, { deadlineMs: Date.now() - 1 },
      { frameToken: "other" }, { documentInstanceId: "other" }])
      expect(dispatch(fields).status).toBe("failed");
    expect(down).toHaveBeenCalledOnce();
  });

  it("keeps Core Alt held across physical press/release, blur, reassert and final cleanup", async () => {
    const { canvas, key, controller } = setup();
    const held = new Set<string>();
    canvas.addEventListener("keydown", event => held.add(event.code));
    canvas.addEventListener("keyup", event => held.delete(event.code));
    key("AltLeft", "rawKeyDown", ["AltLeft"]);
    canvas.dispatchEvent(new KeyboardEvent("keydown", { code: "AltLeft", key: "Alt", altKey: true, bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    await Promise.resolve();
    expect(controller.physicalModifierCodes()).toEqual([]);
    expect([...held]).toEqual(["AltLeft"]);
    // An authoritative Core reassert can restore a consumer cleared by focus loss.
    held.clear();
    key("AltLeft", "rawKeyDown", ["AltLeft"]);
    expect([...held]).toEqual(["AltLeft"]);
    key("AltLeft", "keyUp", []);
    expect([...held]).toEqual([]);
  });

  it("does not acquire ownership on rejected input and bounds document modifier evidence", () => {
    const { canvas, dispatch, key } = setup();
    const down = vi.fn();
    canvas.addEventListener("keydown", down);
    expect(dispatch({ action: "key", modifierState: { coreCodesBefore: [], coreCodesAfter: ["Bogus"], nativePhysicalCodes: [] },
      key: chromiumCdpKeyDescriptor({ code: "AltLeft", phase: "rawKeyDown", activeCodes: ["AltLeft"],
        activeCodesBefore: [], autoRepeat: false, suppressShortcut: false }, platform) }).status).toBe("failed");
    expect(down).not.toHaveBeenCalled();
    for (let index = 0; index < 40; index++) {
      key("AltLeft", "rawKeyDown", ["AltLeft"]);
      key("AltLeft", "keyUp", []);
    }
    const evidence = key("Digit3", "rawKeyDown", ["Digit3"]).modifierEvidence!;
    expect(evidence.transitions).toHaveLength(64);
    expect(evidence.droppedTransitionCount).toBe(16);
    expect(evidence.transitions[0]?.sequence).toBe(17);
    expect(evidence.transitions.at(-1)?.sequence).toBe(80);
    expect(evidence.coreCodesAfter).toEqual([]);
    expect(evidence.eventModifierMask).toBe(0);
  });

  it.each([
    ["AltLeft", "altKey", 1], ["AltRight", "altKey", 1],
    ["ControlLeft", "ctrlKey", 2], ["ControlRight", "ctrlKey", 2],
    ["MetaLeft", "metaKey", 4], ["MetaRight", "metaKey", 4],
    ["ShiftLeft", "shiftKey", 8], ["ShiftRight", "shiftKey", 8]
  ] as const)("keeps %s flags aligned when native release precedes DOM release", (code, flag, mask) => {
    const { canvas, dispatch } = setup();
    const seen: KeyboardEvent[] = [];
    canvas.addEventListener("keyup", event => seen.push(event));
    canvas.dispatchEvent(new KeyboardEvent("keydown", { code, [flag]: true, bubbles: true }));
    const receipt = dispatch({ action: "key",
      modifierState: { coreCodesBefore: [], coreCodesAfter: [], nativePhysicalCodes: [] },
      key: { ...chromiumCdpKeyDescriptor({ code: "Digit1", phase: "keyUp", activeCodes: [],
        activeCodesBefore: ["Digit1"], autoRepeat: false, suppressShortcut: true }, platform), shiftedKey: "!" } });
    expect(seen[0]?.[flag]).toBe(true);
    expect(seen[0]?.key).toBe(mask === 8 ? "!" : "1");
    expect(receipt.modifierEvidence?.eventModifierMask).toBe(mask);
  });

  it("never redirects a release to a replacement canvas", () => {
    const { canvas, key } = setup();
    expect(key("KeyJ", "rawKeyDown", ["KeyJ"]).status).toBe("applied");
    canvas.remove();
    const replacement = document.createElement("canvas");
    replacement.tabIndex = 0;
    document.body.append(replacement);
    replacement.focus();
    const up = vi.fn();
    replacement.addEventListener("keyup", up);
    expect(key("KeyJ", "keyUp", []).errorCode).toBe("SYSTEM_COMPATIBLE_INPUT_TARGET_UNAVAILABLE");
    expect(up).not.toHaveBeenCalled();
  });

  it("cleanup sends releases only and clicks outside the original game fail before submission", () => {
    const { canvas, dispatch } = setup();
    const events: string[] = [];
    for (const type of ["mousedown", "mouseup", "click"])
      canvas.addEventListener(type, () => events.push(type));
    expect(dispatch({ action: "click", pointer: { clientX: 700, clientY: 50,
      button: 0, modifiers: 0, releaseOnly: false } }).status).toBe("failed");
    expect(dispatch({ action: "click", intent: "cleanup", pointer: { clientX: 700, clientY: 50,
      button: 0, modifiers: 0, releaseOnly: true } }).status).toBe("applied");
    expect(events).toEqual(["mouseup"]);
  });
});
