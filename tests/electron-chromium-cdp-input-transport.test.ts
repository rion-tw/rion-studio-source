import { describe, expect, it, vi } from "vitest";
import { commonMacroKeyCodes } from
  "../src/renderer/src/features/macros/macroUtils";
import { ChromiumCdpInputSession } from
  "../src/electron/main/chromiumCdpInputSession";
import type { ChromiumCdpInputIdentity } from
  "../src/electron/main/chromiumCdpInputSession";
import {
  chromiumCdpKeyDescriptor,
  chromiumCdpMouseDescriptors
} from "../src/electron/main/chromiumCdpInputDescriptors";
import { ChromiumCdpInputTransport } from
  "../src/electron/main/chromiumCdpInputTransport";

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
  const session = ChromiumCdpInputSession.attach({
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

describe("in-process CDP Input session", () => {
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
    expect(() => ChromiumCdpInputSession.attach({
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

function transportHarness() {
  let currentIdentity: ChromiumCdpInputIdentity = identity;
  let attached = false;
  let detachListener: ((_event: unknown, reason: string) => void) | null = null;
  let lifecycle: ((event: Readonly<{
    roleId: string;
    generation: number;
    reason: "document-superseded" | "surface-retired";
  }>) => void) | null = null;
  const sendCommand = vi.fn(async (
    _method: "Input.dispatchKeyEvent" | "Input.dispatchMouseEvent",
    _params: object
  ) => Object.freeze({}));
  const attach = vi.fn(() => { attached = true; });
  const detach = vi.fn(() => { attached = false; });
  const debuggerPort = {
    isAttached: () => attached,
    attach,
    detach,
    sendCommand,
    on: vi.fn((_event: "detach", listener: typeof detachListener) => {
      detachListener = listener;
    }),
    removeListener: vi.fn((_event: "detach", listener: typeof detachListener) => {
      if (detachListener === listener) detachListener = null;
    })
  };
  const transport = new ChromiumCdpInputTransport({
    platform: "darwin",
    surfaces: {
      currentCdpInputBinding: () => ({ identity: currentIdentity, debugger: debuggerPort }),
      subscribeTrustedInputLifecycle: (listener) => {
        lifecycle = listener;
        return () => { lifecycle = null; };
      }
    }
  });
  const frame = () => ({
    roleId: currentIdentity.roleId,
    generation: currentIdentity.surfaceGeneration,
    documentInstanceId: currentIdentity.documentInstanceId,
    frameToken: currentIdentity.frameToken,
    frame: Object.freeze({})
  });
  return {
    attach,
    debuggerPort,
    detach,
    frame,
    sendCommand,
    transport,
    replaceDocument: () => {
      lifecycle?.({ roleId: identity.roleId, generation: identity.surfaceGeneration,
        reason: "document-superseded" });
      currentIdentity = Object.freeze({ ...identity,
        documentInstanceId: "document-5", frameToken: "frame-5" });
    },
    detachFromDevTools: () => {
      attached = false;
      detachListener?.({}, "target closed");
    }
  };
}

describe("production CDP Input transport", () => {
  it("reuses one exact document session and dispatches only allowlisted Input methods", async () => {
    const subject = transportHarness();
    await subject.transport.dispatchKey(subject.frame(), effect("KeyA"));
    await subject.transport.dispatchMouse(subject.frame(), {
      x: 10, y: 20, button: "middle", modifierCodes: []
    });
    expect(subject.attach).toHaveBeenCalledOnce();
    expect(subject.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent"
    ]);
    subject.transport.dispose();
  });

  it("blocks same-document reconnect after lifecycle or debugger detach", async () => {
    const lifecycle = transportHarness();
    await lifecycle.transport.dispatchKey(lifecycle.frame(), effect("KeyA"));
    const staleFrame = lifecycle.frame();
    lifecycle.replaceDocument();
    await expect(lifecycle.transport.dispatchKey(staleFrame, effect("KeyA")))
      .rejects.toThrow("no longer owns");
    await lifecycle.transport.dispatchKey(lifecycle.frame(), effect("KeyB"));
    expect(lifecycle.attach).toHaveBeenCalledTimes(2);

    const detached = transportHarness();
    await detached.transport.dispatchKey(detached.frame(), effect("KeyA"));
    detached.detachFromDevTools();
    await expect(detached.transport.dispatchKey(detached.frame(), effect("KeyB")))
      .rejects.toThrow("terminal CDP Input session");
  });

  it("publishes detach as an exact terminal event", async () => {
    const subject = transportHarness();
    const terminal = vi.fn();
    subject.transport.subscribeTerminal(terminal);
    await subject.transport.dispatchKey(subject.frame(), effect("KeyA"));
    subject.detachFromDevTools();
    expect(terminal).toHaveBeenCalledWith({
      identity,
      reason: "debugger-detached"
    });
  });

  it("terminalizes a rejected command and never retries that document", async () => {
    const subject = transportHarness();
    subject.sendCommand.mockRejectedValueOnce(new Error("CDP rejected input"));
    const terminal = vi.fn();
    subject.transport.subscribeTerminal(terminal);

    await expect(subject.transport.dispatchKey(subject.frame(), effect("KeyA")))
      .rejects.toThrow("CDP rejected input");
    expect(subject.detach).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith({ identity, reason: "command-rejected" });
    await expect(subject.transport.dispatchKey(subject.frame(), effect("KeyB")))
      .rejects.toThrow("terminal CDP Input session");
    expect(subject.sendCommand).toHaveBeenCalledOnce();
  });
});
