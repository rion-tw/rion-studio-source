import { describe, expect, it, vi } from "vitest";

import {
  CHROMIUM_ROLE_TRUSTED_INPUT_ARM_CHANNEL,
  CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
  type ChromiumRoleTrustedInputArmEnvelope,
  type ChromiumRoleTrustedInputExpectedEvent
} from "../src/electron/ipc/chromiumRoleTrustedInputProtocol";
import {
  createChromiumRoleTrustedInputOverlayGuard,
  installChromiumRoleTrustedInput,
  type ChromiumRoleTrustedInputEventPort,
  type ChromiumRoleTrustedInputOverlayGuardPort
} from "../src/electron/preload/installChromiumRoleTrustedInput";

const INPUT_SEQUENCE = "00000000-0000-4000-8000-000000000001";

function keyEvent(type: "keydown" | "keyup"): ChromiumRoleTrustedInputExpectedEvent {
  return {
    type,
    code: "KeyA",
    button: null,
    clientX: null,
    clientY: null,
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    repeat: false
  };
}

function mouseEvent(
  type: "mousedown" | "mouseup" | "click" | "auxclick",
  button: 0 | 1 | 2 = 0
): ChromiumRoleTrustedInputExpectedEvent {
  return {
    type,
    code: null,
    button,
    clientX: 100.25,
    clientY: 200.75,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false
  };
}

function deferredMouseEvent(
  type: "mousedown" | "mouseup" | "click" | "auxclick",
  button: 0 | 1 | 2 = 0
): ChromiumRoleTrustedInputExpectedEvent {
  return { ...mouseEvent(type, button), clientX: null, clientY: null };
}

function observedKey(
  type: "keydown" | "keyup",
  isTrusted: boolean
): ChromiumRoleTrustedInputEventPort {
  return {
    type,
    code: "KeyA",
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    repeat: false,
    isTrusted
  };
}

function observedMouse(
  type: "mousedown" | "mouseup" | "click" | "auxclick",
  button: 0 | 1 | 2 = 0
): ChromiumRoleTrustedInputEventPort {
  return {
    type,
    button,
    clientX: 100.25,
    clientY: 200.75,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isTrusted: true
  };
}

function harness(overlayGuards?: ChromiumRoleTrustedInputOverlayGuardPort) {
  let controlListener: ((event: unknown, envelope: unknown) => void) | null = null;
  const listeners = new Map<string, (event: ChromiumRoleTrustedInputEventPort) => void>();
  const send = vi.fn();
  const installed = installChromiumRoleTrustedInput({
    on: (channel, listener) => {
      expect(channel).toBe(CHROMIUM_ROLE_TRUSTED_INPUT_ARM_CHANNEL);
      controlListener = listener;
    },
    send
  }, "frame-token-1", true, {
    addEventListener: (type, listener, options) => {
      expect(options).toEqual({ capture: true });
      listeners.set(type, listener);
    }
  }, overlayGuards);
  const arm = (events: readonly ChromiumRoleTrustedInputExpectedEvent[], overrides = {}) => {
    const envelope: ChromiumRoleTrustedInputArmEnvelope = {
      kind: "arm",
      roleId: "role-1",
      generation: 3,
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE,
      expectedEvents: events,
      shortcutSuppression: null,
      ...overrides
    };
    controlListener?.({}, envelope);
    return envelope;
  };
  const emit = (event: ChromiumRoleTrustedInputEventPort) => {
    listeners.get(event.type)?.(event);
  };
  return { arm, control: (value: unknown) => controlListener?.({}, value), emit,
    installed, listeners, send };
}

describe("Chromium role trusted-input preload", () => {
  it("acknowledges guarded key arming only after the exact overlay sequence is ready", async () => {
    let finishArm!: (armed: boolean) => void;
    const arm = vi.fn(() => new Promise<boolean>((resolve) => {
      finishArm = resolve;
    }));
    const clear = vi.fn(async () => true);
    const subject = harness({ arm, clear });

    subject.arm([keyEvent("keydown"), keyEvent("keyup")], {
      shortcutSuppression: {
        code: "KeyA",
        phases: ["keydown", "keyup"]
      }
    });
    expect(arm).toHaveBeenCalledWith({
      code: "KeyA",
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE,
      phases: ["keydown", "keyup"]
    });
    expect(subject.send).not.toHaveBeenCalled();

    finishArm(true);
    await Promise.resolve();
    expect(subject.send).toHaveBeenCalledWith(
      CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
      expect.objectContaining({ kind: "armed", expectedEventCount: 2 })
    );

    subject.control({
      kind: "cancel",
      roleId: "role-1",
      generation: 3,
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE
    });
    expect(clear).toHaveBeenCalledWith({
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE
    });
  });

  it("executes the guard only in the locked overlay world with an exact receipt", async () => {
    const execute = vi.fn(async (_worldId: number, scripts: Array<{ code: string }>) => {
      expect(scripts[0]!.code).toContain("suppressShortcutSequence");
      return {
        armed: true,
        frameToken: "frame-token-1",
        inputSequence: INPUT_SEQUENCE
      };
    });
    const guards = createChromiumRoleTrustedInputOverlayGuard({
      executeJavaScriptInIsolatedWorld: execute
    });
    await expect(guards.arm({
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE,
      code: "Digit4",
      phases: ["keydown", "keyup"]
    })).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(1004, [expect.objectContaining({
      url: "rion-studio://chromium-trusted-input-guard-arm.js"
    })], false);
  });

  it("exposes no page API and receipts only the exact trusted key sequence", () => {
    const subject = harness();
    expect(subject.installed).toBe(true);
    expect([...subject.listeners.keys()].sort()).toEqual([
      "auxclick", "click", "keydown", "keyup", "mousedown", "mouseup"
    ]);
    subject.arm([keyEvent("keydown"), keyEvent("keyup")]);
    subject.emit(observedKey("keydown", true));
    subject.emit(observedKey("keyup", true));

    expect(subject.send.mock.calls.map(([channel]) => channel)).toEqual([
      CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
      CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL,
      CHROMIUM_ROLE_TRUSTED_INPUT_RECEIPT_CHANNEL
    ]);
    expect(subject.send.mock.calls[0]?.[1]).toEqual({
      kind: "armed",
      roleId: "role-1",
      generation: 3,
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE,
      expectedEventCount: 2
    });
    expect(subject.send.mock.calls.slice(1).map(([, receipt]) => receipt)).toEqual([
      expect.objectContaining({ kind: "input", observedIndex: 0, type: "keydown",
        code: "KeyA", isTrusted: true, matches: true }),
      expect.objectContaining({ kind: "input", observedIndex: 1, type: "keyup",
        code: "KeyA", isTrusted: true, matches: true })
    ]);
  });

  it("preserves exact fractional Retina/zoom coordinates without rounding", () => {
    const subject = harness();
    subject.arm([
      deferredMouseEvent("mousedown"),
      deferredMouseEvent("mouseup"),
      deferredMouseEvent("click")
    ]);
    for (const type of ["mousedown", "mouseup", "click"] as const) {
      subject.emit(observedMouse(type));
    }
    expect(subject.send.mock.calls.slice(1).map(([, receipt]) => receipt)).toEqual([
      expect.objectContaining({ clientX: 100.25, clientY: 200.75, matches: true }),
      expect.objectContaining({ clientX: 100.25, clientY: 200.75, matches: true }),
      expect.objectContaining({ clientX: 100.25, clientY: 200.75, matches: true })
    ]);
  });

  it.each([
    { button: 1 as const, activation: "auxclick" as const },
    { button: 2 as const, activation: "auxclick" as const }
  ])("receipts Chromium $activation activation for auxiliary button $button", ({
    activation,
    button
  }) => {
    const subject = harness();
    subject.arm([
      deferredMouseEvent("mousedown", button),
      deferredMouseEvent("mouseup", button),
      deferredMouseEvent(activation, button)
    ]);
    subject.emit(observedMouse("mousedown", button));
    subject.emit(observedMouse("mouseup", button));
    subject.emit(observedMouse(activation, button));
    expect(subject.send.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      button,
      isTrusted: true,
      matches: true,
      type: activation
    }));
  });

  it("fails closed for untrusted page events, stale frames, and guessed sequences", () => {
    const subject = harness();
    subject.arm([keyEvent("keydown")]);
    subject.emit(observedKey("keydown", false));
    expect(subject.send.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      kind: "input",
      isTrusted: false,
      matches: false
    }));

    subject.arm([keyEvent("keydown")], { frameToken: "stale-frame" });
    expect(subject.send.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      kind: "rejected",
      reason: "stale-frame"
    }));
    const count = subject.send.mock.calls.length;
    subject.control({
      kind: "arm",
      roleId: "role-1",
      generation: 3,
      frameToken: "frame-token-1",
      inputSequence: "guessed",
      expectedEvents: [keyEvent("keydown")],
      shortcutSuppression: null
    });
    expect(subject.send).toHaveBeenCalledTimes(count);
  });

  it("clears only an exact private cancel identity and skips child frames", () => {
    const subject = harness();
    subject.arm([keyEvent("keydown")]);
    subject.control({
      kind: "cancel",
      roleId: "role-1",
      generation: 3,
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE
    });
    expect(subject.send.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      kind: "cancelled"
    }));

    const on = vi.fn();
    const addEventListener = vi.fn();
    expect(installChromiumRoleTrustedInput(
      { on, send: vi.fn() },
      "child-frame-token",
      false,
      { addEventListener }
    )).toBe(false);
    expect(on).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });
});
