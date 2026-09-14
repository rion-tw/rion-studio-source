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
    const key = (code: string, phase: "rawKeyDown" | "keyUp", activeCodes: string[]) => dispatch({
      action: "key", key: chromiumCdpKeyDescriptor({ code, phase, activeCodesBefore: [], activeCodes,
        autoRepeat: false, suppressShortcut: true }, platform)
    });
    expect(dispatch({}).status).toBe("applied");
    return { canvas, dispatch, key, binding };
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
