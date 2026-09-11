import { describe, expect, it, vi } from "vitest";
import { commonMacroKeyCodes } from
  "../src/renderer/src/features/macros/macroUtils";
import { ChromiumCdpInputCandidateSession } from
  "../src/electron/main/chromiumCdpInputCandidate";
import {
  chromiumCdpKeyDescriptor,
  chromiumCdpMouseDescriptors
} from "../src/electron/main/chromiumCdpInputDescriptors";

const identity = Object.freeze({
  roleId: "role-1",
  surfaceGeneration: 4,
  documentInstanceId: "document-4",
  frameToken: "frame-4",
  webContentsId: 91
});

function effect(code: string, overrides = {}) {
  return {
    phase: "rawKeyDown" as const,
    code,
    activeCodesBefore: [],
    activeCodes: [code],
    autoRepeat: false,
    suppressShortcut: true,
    ...overrides
  };
}

function harness(send: (
  method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent",
  params: object
) => Promise<unknown> = async () => Object.freeze({})) {
  let attached = false;
  let detachListener: ((_event: unknown, reason: string) => void) | null = null;
  const sendCommand = vi.fn(send);
  const terminal = vi.fn();
  const debuggerPort = {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; }),
    sendCommand,
    on: vi.fn((_event, listener) => { detachListener = listener; }),
    removeListener: vi.fn((_event, listener) => {
      if (detachListener === listener) detachListener = null;
    })
  };
  const session = ChromiumCdpInputCandidateSession.attach({
    identity,
    domReady: true,
    roleOwnershipVerified: true,
    preloadFrameToken: identity.frameToken,
    debugger: debuggerPort,
    platform: "darwin",
    onTerminal: terminal
  });
  return {
    debuggerPort,
    detachFromDevTools: () => {
      attached = false;
      detachListener?.({}, "target closed");
    },
    sendCommand,
    session,
    terminal
  };
}

describe("isolated in-process CDP Input candidate", () => {
  it("has an explicit descriptor for every UI key and all modifier sides", () => {
    const codes = [
      ...commonMacroKeyCodes,
      "ControlLeft", "ControlRight", "AltLeft", "AltRight",
      "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"
    ];
    for (const platform of ["darwin", "win32"] as const) {
      for (const code of codes) {
        expect(chromiumCdpKeyDescriptor(effect(code), platform)).toMatchObject({
          code,
          type: "rawKeyDown",
          autoRepeat: false
        });
      }
    }
    expect(() => chromiumCdpKeyDescriptor(effect("Numpad0"), "win32"))
      .toThrow("Unsupported Chromium CDP key code");
  });

  it("derives side, repeat, shifted key and modifier mask from active codes", () => {
    expect(chromiumCdpKeyDescriptor(effect("ShiftRight", {
      activeCodes: ["ControlLeft", "ShiftRight"]
    }), "darwin")).toMatchObject({
      key: "Shift",
      location: 2,
      modifiers: 10,
      nativeVirtualKeyCode: 0x3c
    });
    expect(chromiumCdpKeyDescriptor(effect("Digit1", {
      activeCodes: ["ShiftLeft", "Digit1"],
      autoRepeat: true
    }), "win32")).toMatchObject({ key: "!", modifiers: 8, autoRepeat: true });
  });

  it.each(["left", "middle", "right"] as const)(
    "uses CSS viewport coordinates and exact buttons for %s",
    (button) => {
      const descriptors = chromiumCdpMouseDescriptors({
        x: 125.5,
        y: 63.25,
        button,
        modifierCodes: ["ControlRight", "AltLeft"]
      });
      expect(descriptors).toEqual([
        expect.objectContaining({
          type: "mousePressed", x: 125.5, y: 63.25, button,
          buttons: button === "left" ? 1 : button === "right" ? 2 : 4,
          clickCount: 1, modifiers: 3
        }),
        expect.objectContaining({ type: "mouseReleased", buttons: 0 })
      ]);
    }
  );

  it("attaches protocol 1.3 and exposes only fixed Input commands", async () => {
    const subject = harness();
    expect(subject.debuggerPort.attach).toHaveBeenCalledWith("1.3");
    await expect(subject.session.dispatchKey(identity, effect("KeyA")))
      .resolves.toMatchObject({ acceptedCommandCount: 1, requiresTrustedDomReceipt: true });
    await expect(subject.session.dispatchMouse(identity, {
      x: 10, y: 20, button: "right", modifierCodes: []
    })).resolves.toMatchObject({ acceptedCommandCount: 2 });
    expect(subject.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent"
    ]);
  });

  it("terminalizes detach and never reconnects the same document", async () => {
    const subject = harness();
    subject.detachFromDevTools();
    expect(subject.terminal).toHaveBeenCalledWith(identity, "debugger-detached");
    expect(subject.debuggerPort.attach).toHaveBeenCalledOnce();
    await expect(subject.session.dispatchKey(identity, effect("KeyA")))
      .rejects.toThrow("detached or generation-stale");
  });

  it("rejects an in-flight command immediately when the debugger detaches", async () => {
    const subject = harness(async () => new Promise(() => undefined));
    const pending = subject.session.dispatchKey(identity, effect("KeyA"));
    await Promise.resolve();
    subject.detachFromDevTools();

    await expect(pending).rejects.toThrow("terminalized: debugger-detached");
    expect(subject.terminal).toHaveBeenCalledOnce();
  });

  it.each(["navigation", "crash", "close"] as const)(
    "detaches and terminalizes exact %s lifecycle",
    (reason) => {
      const subject = harness();
      if (reason === "navigation") subject.session.beginMainFrameNavigation(identity);
      if (reason === "crash") subject.session.crash(identity);
      if (reason === "close") subject.session.close(identity);
      expect(subject.debuggerPort.detach).toHaveBeenCalledOnce();
      expect(subject.terminal).toHaveBeenCalledWith(
        identity,
        reason === "navigation" ? "document-replacing"
          : reason === "crash" ? "crashed" : "closed"
      );
    }
  );

  it("rejects stale Role generation and frame-token admission", async () => {
    const subject = harness();
    await expect(subject.session.dispatchKey({ ...identity, surfaceGeneration: 5 },
      effect("KeyA"))).rejects.toThrow("generation-stale");
    expect(() => ChromiumCdpInputCandidateSession.attach({
      identity,
      domReady: true,
      roleOwnershipVerified: true,
      preloadFrameToken: "stale-frame",
      debugger: subject.debuggerPort,
      platform: "win32",
      onTerminal: vi.fn()
    })).toThrow("stale Role or preload identity");
  });
});
