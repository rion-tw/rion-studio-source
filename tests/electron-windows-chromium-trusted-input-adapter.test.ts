import type { ChromiumViewInputObservation } from "../src/electron/main/chromiumViewInputSubmission";
import type { BrowserAction } from "../src/shared/generated";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type {
  ChromiumRoleTrustedInputArmEnvelope,
  ChromiumRoleTrustedInputExpectedEvent
} from "../src/electron/ipc/chromiumRoleTrustedInputProtocol";
import type {
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest
} from "../src/electron/main/chromiumTrustedInputCoordinator";
import {
  WindowsChromiumTrustedInputAdapter,
  type WindowsChromiumTrustedInputIpcEventPort
} from "../src/electron/main/windowsChromiumTrustedInputAdapter";
import type {
  WindowsChromiumInputSurfaceIdentity,
  WindowsChromiumInputSurfaceProbeReceipt,
  WindowsNativeTrustedKeyRequest,
  WindowsNativeTrustedKeySubmissionReceipt,
  WindowsNativeTrustedMouseRequest,
  WindowsNativeTrustedMouseSubmissionReceipt
} from "../src/electron/main/windowsChromiumTrustedInputContract";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "../src/electron/main/chromiumRoleSurfaceRegistry";

const INPUT_SEQUENCE = "00000000-0000-4000-8000-000000000001";

function keyAction(
  phase: "tap" | "hold" | "release" = "tap",
  modifiers: Extract<BrowserAction, { type: "key" }>["modifiers"] = ["primary"]
): Extract<BrowserAction, { type: "key" }> {
  return {
    type: "key",
    phase,
    key: "a",
    code: "KeyA",
    modifiers,
    exactModifierCodes: null,
    modifierOwnership: "synthetic",
    ownerId: "macro-1",
    suppressOverlayShortcut: true
  };
}

function clickAction(
  button: "left" | "middle" | "right" = "left"
): Extract<BrowserAction, { type: "click" }> {
  return {
    type: "click",
    anchor: null,
    unit: "px",
    x: 100,
    y: 200,
    button
  };
}

function nativeRequest(
  requestId: string,
  action: BrowserAction,
  overrides: Partial<ChromiumNativeTrustedInputRequest> = {}
): ChromiumNativeTrustedInputRequest {
  return {
    requestId,
    roleId: "role-1",
    inputEpoch: 7,
    intent: "normal",
    scheduledAtMs: 1_000,
    deadlineMs: 2_000,
    surfaceGeneration: 3,
    expectedInputNeutralityBefore: true,
    expectedInputNeutralityAfter: action.type === "key" && action.phase === "hold"
      ? false
      : true,
    action,
    ...overrides
  };
}

function harness() {
  let nowMs = 1_100;
  let dispatchSequence = 0;
  let lifecycle: ((event: ChromiumRoleOverlayLifecycleEvent) => void) | null = null;
  let ipcListener: ((event: WindowsChromiumTrustedInputIpcEventPort, value: unknown) => void)
    | null = null;
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const frame = Object.freeze({ frameToken: "frame-token-1" });
  const sender = Object.freeze({ id: 91 });
  const frameIdentity: ChromiumRoleOverlayFrameIdentity = Object.freeze({
    roleId: "role-1",
    generation: 3,
    frame,
    frameToken: frame.frameToken,
    documentInstanceId: "document-1"
  });
  const identity: WindowsChromiumInputSurfaceIdentity = Object.freeze({
    ownerKind: "view", roleId: "role-1", surfaceGeneration: 3,
    nativeGeneration: 5, bindingRevision: "1", parentIdentity: "a".repeat(64), webContentsId: 91
  });
  const controls: Array<ChromiumRoleTrustedInputArmEnvelope | { readonly kind: "cancel" }> = [];
  const keyRequests: WindowsNativeTrustedKeyRequest[] = [];
  const mouseRequests: WindowsNativeTrustedMouseRequest[] = [];
  let liveBinding = true;
  let foregroundReady = true;
  let deliveryMode: "foreground" | "background" = "foreground";
  let probeRevision = "1";
  let preserveForeground = true;
  let exactParent = true;
  let nativePhysicalModifierCodes: readonly string[] = [];
  let nativePhysicalInputSequence = 0;
  let viewFocus: Partial<Pick<ChromiumViewInputObservation,
    "focusIdentity" | "parentForeground" | "contentsFocused" | "focusedWebContentsId">> = {};

  const observation = () => {
    if (identity.ownerKind !== "view") throw new Error("View observation requires View identity.");
    return { identity, focusIdentity: "b".repeat(64), physicalInputSequence: String(nativePhysicalInputSequence),
      parentForeground: true, parentVisible: true,
      parentMinimized: false, viewAttached: exactParent, viewVisible: deliveryMode === "foreground",
      contentsDestroyed: false, contentsFocused: deliveryMode === "foreground",
      focusedWebContentsId: deliveryMode === "foreground" ? 91 : 92,
      bounds: { x: 0, y: 0, width: 800, height: 560 }, zoomFactor: 1.25, ...viewFocus };
  };
  const probe = (): WindowsChromiumInputSurfaceProbeReceipt => ({
    ...identity, status: "verified", deliveryMode, probeRevision, observation: observation()
  });

  const baseReceipt = (requestId: string, requestDeliveryMode: "foreground" | "background") => ({
    ...identity, status: "submitted" as const,
    submissionApi: "webContents.sendInputEvent" as const, requestId, inputEpoch: "7",
    deliveryMode: requestDeliveryMode, dispatchSequence: String(dispatchSequence += 1),
    probeRevision, submittedAtMs: String(nowMs), observation: observation(),
    viewAttached: true as const, foregroundPreserved: preserveForeground as true
  });

  const native = {
    focusForeground: vi.fn(async (
      _expected: WindowsChromiumInputSurfaceIdentity,
      request: ChromiumNativeTrustedInputRequest
    ): Promise<ChromiumNativeTrustedInputReceipt> => ({
      requestId: request.requestId,
      roleId: request.roleId,
      inputEpoch: request.inputEpoch,
      surfaceGeneration: request.surfaceGeneration,
      status: foregroundReady ? "applied" : "failed",
      completedAtMs: nowMs,
      errorCode: foregroundReady ? null : "SYSTEM_TRUSTED_INPUT_FOREGROUND_REQUIRED",
      errorMessage: foregroundReady ? null : "foreground required",
      confirmedInputNeutrality: request.expectedInputNeutralityBefore
    })),
    currentInputDeliveryMode: vi.fn(() =>
      foregroundReady ? deliveryMode : null),
    isInputReady: vi.fn((_expected, expectedMode) =>
      foregroundReady && expectedMode === deliveryMode),
    probeExactInputSurface: vi.fn(probe),
    submitNativeBackgroundKey: vi.fn((
      _expected: WindowsChromiumInputSurfaceIdentity,
      request: WindowsNativeTrustedKeyRequest
    ): WindowsNativeTrustedKeySubmissionReceipt => {
      keyRequests.push(request);
      return {
        ...baseReceipt(request.requestId, request.deliveryMode),
        eventType: request.eventType,
        code: request.code,
        ctrl: request.ctrl,
        alt: request.alt,
        shift: request.shift,
        meta: request.meta,
        repeat: request.repeat,
        dispatchedEventCount: 1
      };
    }),
    submitNativeBackgroundMouse: vi.fn((
      _expected: WindowsChromiumInputSurfaceIdentity,
      request: WindowsNativeTrustedMouseRequest
    ): WindowsNativeTrustedMouseSubmissionReceipt => {
      mouseRequests.push(request);
      return {
        ...baseReceipt(request.requestId, request.deliveryMode),
        button: request.button,
        clientX: request.clientX,
        clientY: request.clientY,
        zoomFactor: request.zoomFactor,
        ctrl: request.ctrl,
        alt: request.alt,
        shift: request.shift,
        meta: request.meta,
        inputX: 125,
        inputY: 250,
        expectedDomClientX: 100,
        expectedDomClientY: 200,
        dispatchedEventCount: 2
      };
    })
  };
  const cdpTerminalListeners = new Set<(event: never) => void>();
  const cdp = {
    dispatchKey: async (_frame: unknown, effect: Readonly<{
      phase: "rawKeyDown" | "keyUp";
      code: string;
      activeCodes: readonly string[];
      autoRepeat: boolean;
    }>) => {
      const has = (prefix: string) =>
        effect.activeCodes.some((code) => code.startsWith(prefix));
      native.submitNativeBackgroundKey(identity, {
        requestId: `cdp-${keyRequests.length + 1}`,
        roleId: "role-1",
        surfaceGeneration: 3,
        inputEpoch: "7",
        deadlineMs: String(nowMs + 1_000),
        deliveryMode,
        eventType: effect.phase,
        code: effect.code,
        ctrl: has("Control"),
        alt: has("Alt"),
        shift: has("Shift"),
        meta: has("Meta"),
        repeat: effect.autoRepeat
      });
      return { roleId: "role-1", surfaceGeneration: 3,
        documentInstanceId: "document-1", acceptedCommandCount: 1,
        requiresTrustedDomReceipt: true as const };
    },
    dispatchMouse: async (_frame: unknown, input: Readonly<{
      x: number; y: number; button: "left" | "middle" | "right";
      modifierCodes: readonly string[];
    }>) => {
      const has = (prefix: string) =>
        input.modifierCodes.some((code) => code.startsWith(prefix));
      native.submitNativeBackgroundMouse(identity, {
        requestId: `cdp-mouse-${mouseRequests.length + 1}`,
        roleId: "role-1",
        surfaceGeneration: 3,
        inputEpoch: "7",
        deadlineMs: String(nowMs + 1_000),
        deliveryMode,
        clientX: input.x,
        clientY: input.y,
        zoomFactor: 1.25,
        button: input.button === "left" ? 0 : input.button === "middle" ? 1 : 2,
        ctrl: has("Control"), alt: has("Alt"), shift: has("Shift"), meta: has("Meta")
      });
      return { roleId: "role-1", surfaceGeneration: 3,
        documentInstanceId: "document-1", acceptedCommandCount: 2,
        requiresTrustedDomReceipt: true as const };
    },
    subscribeTerminal: (listener: (event: never) => void) => {
      cdpTerminalListeners.add(listener);
      return () => { cdpTerminalListeners.delete(listener); };
    }
  };
  const adapter = new WindowsChromiumTrustedInputAdapter({
    hosts: {
      resolve: () => liveBinding ? { identity, native } : null
    },
    surfaces: {
      authorizeTrustedInputFrame: (candidateSender, candidateFrame, token) => {
        if (candidateSender !== sender || candidateFrame !== frame ||
          token !== frame.frameToken) throw new Error("unauthorized frame");
        return frameIdentity;
      },
      currentTrustedInputFrame: () => frameIdentity,
      sendTrustedInputControl: (_expected, control) => {
        controls.push(control as ChromiumRoleTrustedInputArmEnvelope | { kind: "cancel" });
      },
      subscribeTrustedInputLifecycle: (listener) => {
        lifecycle = listener;
        return () => { lifecycle = null; };
      }
    },
    cdp,
    clicks: {
      resolve: () => ({ clientX: 100, clientY: 200, zoomFactor: 1.25 })
    },
    nowMs: () => nowMs,
    backgroundSupported: true,
    physicalModifierCodes: () => nativePhysicalModifierCodes,
    deadlines: {
      schedule: (callback) => {
        const id = timerId += 1;
        timers.set(id, callback);
        return id;
      },
      cancel: (handle) => {
        if (typeof handle === "number") timers.delete(handle);
      }
    },
    createInputSequence: () => INPUT_SEQUENCE
  });
  adapter.register({
    on: (_channel, listener) => { ipcListener = listener; },
    removeListener: (_channel, listener) => {
      if (ipcListener === listener) ipcListener = null;
    }
  });
  const event = { sender, senderFrame: frame };
  const receive = (receipt: unknown) => adapter.receive(event, receipt);
  const arm = () => controls.find((control): control is ChromiumRoleTrustedInputArmEnvelope =>
    control.kind === "arm")!;
  const armed = (physicalModifierCodes: readonly string[] = []) => {
    return receive({
      kind: "armed",
      roleId: "role-1",
      generation: 3,
      frameToken: frame.frameToken,
      inputSequence: INPUT_SEQUENCE,
      expectedEventCount: arm().expectedEvents.length,
      modifierDisposition: "dispatch",
      physicalModifierCodes
    });
  };
  const dom = (
    expected: ChromiumRoleTrustedInputExpectedEvent,
    observedIndex: number,
    overrides: Record<string, unknown> = {}
  ) => receive({
    kind: "input",
    roleId: "role-1",
    generation: 3,
    frameToken: frame.frameToken,
    inputSequence: INPUT_SEQUENCE,
    observationSequence: observedIndex + 1,
    isTrusted: true,
    ...expected,
    ...overrides
  });

  return {
    adapter,
    arm,
    armed,
    recordPhysicalInput: (projectedDomEvents = 1) => {
      nativePhysicalInputSequence += projectedDomEvents;
    },
    controls,
    cdp,
    dom,
    frameIdentity,
    keyRequests,
    mouseRequests,
    native,
    receive,
    fireDeadline: () => [...timers.values()][0]?.(),
    setExactParent: (value: boolean) => { exactParent = value; },
    setForegroundReady: (value: boolean) => { foregroundReady = value; },
    setDeliveryMode: (value: "foreground" | "background") => {
      deliveryMode = value;
    },
    setLiveBinding: (value: boolean) => { liveBinding = value; },
    setNativePhysicalModifierCodes: (value: readonly string[]) => {
      nativePhysicalModifierCodes = value;
    },
    setNow: (value: number) => { nowMs = value; },
    setPreserveForeground: (value: boolean) => { preserveForeground = value; },
    setProbeRevision: (value: string) => { probeRevision = value; },
    setViewFocus: (value: typeof viewFocus) => {
      viewFocus = value; probeRevision = String(BigInt(probeRevision) + 1n);
    },
    retire: (reason: ChromiumRoleOverlayLifecycleEvent["reason"]) => lifecycle?.({
      roleId: "role-1",
      generation: 3,
      reason
    })
  };
}

describe("Windows Chromium trusted-input adapter", () => {
  it("adopts an exact physical Shift without submitting a duplicate CDP keydown", async () => {
    const subject = harness();
    subject.setNativePhysicalModifierCodes(["ShiftLeft"]);
    const action = {
      ...keyAction("hold", []),
      key: "Shift",
      code: "ShiftLeft",
      exactModifierCodes: []
    } satisfies Extract<BrowserAction, { type: "key" }>;
    const completion = subject.adapter.dispatch(nativeRequest("adopt-shift", action, {
      keyEffect: {
        phase: "rawKeyDown",
        code: "ShiftLeft",
        activeCodesBefore: [],
        activeCodes: ["ShiftLeft"],
        autoRepeat: false,
        suppressShortcut: true
      }
    }));
    expect(subject.arm()).toEqual(expect.objectContaining({
      modifierTransition: { code: "ShiftLeft", phase: "rawKeyDown" }
    }));
    subject.receive({
      kind: "armed",
      roleId: "role-1",
      generation: 3,
      frameToken: "frame-token-1",
      inputSequence: INPUT_SEQUENCE,
      expectedEventCount: 0,
      modifierDisposition: "adoptPhysical",
      physicalModifierCodes: ["ShiftLeft"]
    });

    await expect(completion).resolves.toMatchObject({
      status: "applied",
      confirmedInputNeutrality: false
    });
    expect(subject.keyRequests).toEqual([]);
    expect(subject.controls.at(-1)).toEqual(expect.objectContaining({
      kind: "cancel",
      committed: true
    }));
  });

  it("passes physical KeyW and then accepts the pending CDP KeyJ sequence", async () => {
    const subject = harness();
    const completion = subject.adapter.dispatch(nativeRequest(
      "physical-key-interleave",
      { ...keyAction(), key: "j", code: "KeyJ", modifiers: [] }
    ));
    subject.armed();
    const expected = subject.arm().expectedEvents;
    subject.recordPhysicalInput();
    subject.dom(expected[0]!, 0, { type: "keydown", code: "KeyW" });
    subject.dom(expected[0]!, 1);
    subject.dom(expected[1]!, 2);

    await expect(completion).resolves.toMatchObject({
      status: "applied",
      confirmedInputNeutrality: true
    });
  });

  it("uses native provenance when physical and CDP events are both KeyJ", async () => {
    const subject = harness();
    const completion = subject.adapter.dispatch(nativeRequest(
      "same-key-interleave",
      { ...keyAction(), key: "j", code: "KeyJ", modifiers: [] }
    ));
    subject.armed();
    const expected = subject.arm().expectedEvents;
    subject.recordPhysicalInput();
    subject.dom(expected[0]!, 0);
    subject.dom(expected[0]!, 1);
    subject.dom(expected[1]!, 2);

    await expect(completion).resolves.toMatchObject({ status: "applied" });
  });

  it("keeps CDP inside the common production transport and Win32 read-only", () => {
    const adapter = readFileSync(new URL(
      "../src/electron/main/windowsChromiumTrustedInputAdapter.ts",
      import.meta.url
    ), "utf8");
    const nativeProbe = readFileSync(new URL(
      "../crates/rion-node/src/windows_runtime_foreground.rs",
      import.meta.url
    ), "utf8");
    const bootstrap = readFileSync(new URL(
      "../src/electron/main/chromiumRuntimeBootstrap.ts",
      import.meta.url
    ), "utf8");
    const runtime = readFileSync(new URL(
      "../src/electron/main/windowsChromiumTrustedInputRuntime.ts",
      import.meta.url
    ), "utf8");
    expect(adapter).not.toContain(".sendInputEvent(");
    expect(adapter).not.toContain("webContents.debugger");
    expect(adapter).not.toContain("remote-debugging");
    expect(runtime).toContain("new ChromiumCdpInputTransport");
    expect(runtime).not.toContain("ChromiumViewInputSubmission");
    for (const mutation of [
      "SetParent(", "SetWindowLong", "SetWindowPos(", "ShowWindow(",
      "PostMessage", "SendMessage", "EnumChildWindows", "FindWindow"
    ]) {
      expect(nativeProbe).not.toContain(mutation);
    }
    expect(bootstrap).toMatch(/trustedInput: "supported",\n\s+backgroundInput: "supported"/u);
    expect(nativeProbe).toContain("parent_was_foreground");
  });

  it("requires exact child-HWND proof and trusted DOM receipts before key success", async () => {
    const subject = harness();
    const result = subject.adapter.dispatch(nativeRequest("request-key", keyAction()));
    expect(subject.native.probeExactInputSurface).toHaveBeenCalledTimes(1);
    expect(subject.keyRequests).toEqual([]);

    expect(subject.armed()).toBe(true);
    await Promise.resolve();
    expect(subject.arm().shortcutSuppression).toEqual({
      code: "KeyA",
      phases: ["keydown", "keyup"],
      repeat: false
    });
    expect(subject.keyRequests).toEqual([
      expect.objectContaining({ eventType: "rawKeyDown", code: "KeyA", ctrl: true }),
      expect.objectContaining({ eventType: "keyUp", code: "KeyA", ctrl: true })
    ]);
    const expected = subject.arm().expectedEvents;
    subject.dom(expected[0]!, 0);
    subject.dom(expected[1]!, 1);

    await expect(result).resolves.toEqual(expect.objectContaining({
      requestId: "request-key",
      status: "applied",
      confirmedInputNeutrality: true
    }));
    expect(subject.native.probeExactInputSurface).toHaveBeenCalledTimes(6);
  });

  it.each(["hold", "release"] as const)(
    "classifies non-shortcut Macro %s as Macro-owned before native delivery",
    async (phase) => {
      const subject = harness();
      const action = { ...keyAction(phase, []), code: "Digit2", key: "2",
        suppressOverlayShortcut: false };
      const result = subject.adapter.dispatch(nativeRequest("ordinary-held-key", action));
      expect(subject.arm().shortcutSuppression).toEqual({
        code: "Digit2", phases: [phase === "hold" ? "keydown" : "keyup"],
        repeat: false
      });
      expect(subject.keyRequests).toEqual([]);
      subject.armed();
      subject.dom(subject.arm().expectedEvents[0]!, 0);
      await expect(result).resolves.toMatchObject({ status: "applied" });
    }
  );

  it("maps Windows primary to Ctrl and keeps Meta independent", async () => {
    const subject = harness();
    const result = subject.adapter.dispatch(nativeRequest(
      "request-modifiers",
      keyAction("tap", ["primary", "meta", "shift"])
    ));
    subject.armed();
    await Promise.resolve();
    expect(subject.keyRequests).toEqual([
      expect.objectContaining({ ctrl: true, meta: true, shift: true }),
      expect.objectContaining({ ctrl: true, meta: true, shift: true })
    ]);
    const expected = subject.arm().expectedEvents;
    subject.dom(expected[0]!, 0);
    subject.dom(expected[1]!, 1);
    await expect(result).resolves.toEqual(expect.objectContaining({ status: "applied" }));
  });

  it("preserves physical modifier flags on key and mouse submissions", async () => {
    const keySubject = harness();
    keySubject.setNativePhysicalModifierCodes(["AltRight"]);
    const keyResult = keySubject.adapter.dispatch(nativeRequest(
      "physical-key",
      keyAction("tap", [])
    ));
    keySubject.armed(["AltRight"]);
    await Promise.resolve();
    expect(keySubject.keyRequests).toEqual([
      expect.objectContaining({ alt: true }),
      expect.objectContaining({ alt: true })
    ]);
    keySubject.arm().expectedEvents.forEach((event, index) => {
      keySubject.dom({ ...event, altKey: true }, index);
    });
    await expect(keyResult).resolves.toMatchObject({ status: "applied" });

    const mouseSubject = harness();
    mouseSubject.setNativePhysicalModifierCodes(["ShiftLeft"]);
    const mouseResult = mouseSubject.adapter.dispatch(nativeRequest(
      "physical-mouse",
      clickAction("left")
    ));
    mouseSubject.armed(["ShiftLeft"]);
    expect(mouseSubject.mouseRequests).toEqual([
      expect.objectContaining({ shift: true })
    ]);
    mouseSubject.arm().expectedEvents.forEach((event, index) => {
      mouseSubject.dom({
        ...event,
        clientX: 100,
        clientY: 200,
        shiftKey: true
      }, index);
    });
    await expect(mouseResult).resolves.toMatchObject({ status: "applied" });
  });

  it("admits physical-pass-through release with the current modifier snapshot", async () => {
    const subject = harness();
    const action = {
      ...keyAction("release", []),
      exactModifierCodes: ["ShiftLeft"],
      modifierOwnership: "physical-pass-through" as const
    };
    const result = subject.adapter.dispatch(nativeRequest(
      "physical-release",
      action,
      {
        physicalModifierCodes: ["ShiftLeft"],
        keyEffect: {
          phase: "keyUp",
          code: "KeyA",
          activeCodesBefore: ["KeyA"],
          activeCodes: [],
          autoRepeat: false,
          suppressShortcut: true
        }
      }
    ));
    subject.armed([]);
    expect(subject.keyRequests).toEqual([
      expect.objectContaining({ shift: false, eventType: "keyUp" })
    ]);
    subject.dom(subject.arm().expectedEvents[0]!, 0);
    await expect(result).resolves.toMatchObject({ status: "applied" });
  });

  it.each([
    { button: "left" as const, domButton: 0, activations: ["click"] as const },
    { button: "middle" as const, domButton: 1, activations: ["auxclick"] as const },
    { button: "right" as const, domButton: 2,
      activations: ["auxclick", "contextmenu"] as const }
  ])("uses the native-canonical point and exact activation for $button", async ({
    activations,
    button,
    domButton
  }) => {
    const subject = harness();
    const result = subject.adapter.dispatch(nativeRequest(
      `request-mouse-${button}`,
      clickAction(button)
    ));
    const armedExpected = subject.arm().expectedEvents;
    expect(armedExpected.map((event) => event.clientX)).toEqual(
      Array.from({ length: 2 + activations.length }, () => null)
    );
    const chromiumSequence = ["mousedown", "mouseup", ...activations] as const;
    expect(armedExpected.map((event) => event.type)).toEqual(chromiumSequence);
    expect(armedExpected.map((event) => event.button)).toEqual(
      Array.from({ length: 2 + activations.length }, () => domButton)
    );
    subject.armed();
    expect(subject.mouseRequests).toEqual([
      expect.objectContaining({
        button: domButton,
        clientX: 100,
        clientY: 200,
        zoomFactor: 1.25
      })
    ]);
    for (const [index, type] of chromiumSequence.entries()) {
      subject.dom({
        ...armedExpected[index]!,
        type,
        clientX: 100,
        clientY: 200
      }, index);
    }
    await expect(result).resolves.toEqual(expect.objectContaining({ status: "applied" }));
  });

  it.each([undefined, "childHwnd"])("rejects retired owner %s before preload arming", async (ownerKind) => {
    const subject = harness();
    const probe = subject.native.probeExactInputSurface.getMockImplementation()!();
    subject.native.probeExactInputSurface.mockReturnValueOnce({
      ...probe, ownerKind
    } as unknown as WindowsChromiumInputSurfaceProbeReceipt);
    await expect(subject.adapter.dispatch(nativeRequest("request-retired-owner", keyAction())))
      .resolves.toEqual(expect.objectContaining({
        status: "failed", errorCode: "SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID"
      }));
    expect(subject.controls).toEqual([]);
    expect(subject.keyRequests).toEqual([]);
  });

  it("fails closed before arming when exact View attachment evidence is absent", async () => {
    const subject = harness();
    subject.setExactParent(false);
    await expect(subject.adapter.dispatch(
      nativeRequest("request-invalid-probe", keyAction())
    )).resolves.toEqual(expect.objectContaining({
      status: "failed",
      errorCode: "SYSTEM_TRUSTED_INPUT_NATIVE_PROBE_INVALID"
    }));
    expect(subject.controls).toEqual([]);
    expect(subject.keyRequests).toEqual([]);
  });

  it("supersedes a missing binding or regressed probe revision before native submission", async () => {
    const missing = harness();
    const missingResult = missing.adapter.dispatch(
      nativeRequest("request-missing-host", keyAction())
    );
    missing.setLiveBinding(false);
    missing.armed();
    await expect(missingResult).resolves.toEqual(expect.objectContaining({
      status: "superseded",
      errorCode: "BROWSER_ACTION_STALE"
    }));
    expect(missing.keyRequests).toEqual([]);

    const revised = harness();
    revised.setProbeRevision("2");
    const revisedResult = revised.adapter.dispatch(
      nativeRequest("request-revised-probe", keyAction())
    );
    revised.setProbeRevision("1");
    revised.armed();
    await expect(revisedResult).resolves.toEqual(expect.objectContaining({
      status: "superseded",
      errorCode: "BROWSER_ACTION_STALE"
    }));
    expect(revised.keyRequests).toEqual([]);
  });

  it("makes rejected CDP and untrusted DOM input indeterminate", async () => {
    const focus = harness();
    const focusResult = focus.adapter.dispatch(
      nativeRequest("request-focus-change", keyAction())
    );
    vi.spyOn(focus.cdp, "dispatchKey").mockRejectedValueOnce(
      new Error("foreground changed")
    );
    focus.armed();
    await expect(focusResult).resolves.toEqual(expect.objectContaining({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_PARTIAL_NATIVE_SUBMISSION",
      confirmedInputNeutrality: false
    }));
    expect(focus.controls.at(-1)).toEqual(expect.objectContaining({ kind: "cancel" }));

    const dom = harness();
    const domResult = dom.adapter.dispatch(nativeRequest("request-untrusted", keyAction()));
    dom.armed();
    dom.dom(dom.arm().expectedEvents[0]!, 0, { isTrusted: false });
    await expect(domResult).resolves.toEqual(expect.objectContaining({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_MISMATCH"
    }));
  });

  it("terminalizes deadline and native lifecycle without polling or inferred success", async () => {
    const deadline = harness();
    const deadlineResult = deadline.adapter.dispatch(
      nativeRequest("request-deadline", keyAction())
    );
    deadline.armed();
    deadline.setNow(2_000);
    deadline.fireDeadline();
    await expect(deadlineResult).resolves.toEqual(expect.objectContaining({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_DEADLINE"
    }));

    const armDeadline = harness();
    const armDeadlineResult = armDeadline.adapter.dispatch(
      nativeRequest("request-arm-deadline", keyAction())
    );
    armDeadline.setNow(2_000);
    armDeadline.fireDeadline();
    await expect(armDeadlineResult).resolves.toEqual(expect.objectContaining({
      status: "failed",
      errorCode: "ELECTRON_WINDOWS_CHROMIUM_INPUT_ARM_RECEIPT_DEADLINE",
      confirmedInputNeutrality: true
    }));

    const modifierArmDeadline = harness();
    modifierArmDeadline.setNativePhysicalModifierCodes(["ShiftLeft"]);
    const modifierAction = {
      ...keyAction("hold", []),
      key: "Shift",
      code: "ShiftLeft",
      exactModifierCodes: []
    } satisfies Extract<BrowserAction, { type: "key" }>;
    const modifierArmDeadlineResult = modifierArmDeadline.adapter.dispatch(
      nativeRequest("request-modifier-arm-deadline", modifierAction, {
        keyEffect: {
          phase: "rawKeyDown",
          code: "ShiftLeft",
          activeCodesBefore: [],
          activeCodes: ["ShiftLeft"],
          autoRepeat: false,
          suppressShortcut: true
        }
      })
    );
    modifierArmDeadline.fireDeadline();
    await expect(modifierArmDeadlineResult).resolves.toEqual(expect.objectContaining({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_MODIFIER_APPLICATION_RECEIPT_DEADLINE",
      confirmedInputNeutrality: false
    }));
    expect(modifierArmDeadline.keyRequests).toEqual([]);
    expect(modifierArmDeadline.controls.at(-1)).toEqual(expect.objectContaining({
      kind: "cancel",
      committed: false
    }));

    const lifecycle = harness();
    const lifecycleResult = lifecycle.adapter.dispatch(
      nativeRequest("request-retired", keyAction())
    );
    lifecycle.armed();
    lifecycle.retire("surface-retired");
    await expect(lifecycleResult).resolves.toEqual(expect.objectContaining({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_DOCUMENT_SUPERSEDED"
    }));
  });

  it("focuses the exact foreground host without forging key or mouse input", async () => {
    const subject = harness();
    await expect(subject.adapter.dispatch(nativeRequest("request-focus", { type: "focus" })))
      .resolves.toEqual(expect.objectContaining({
        status: "applied",
        errorCode: null
      }));
    expect(subject.native.focusForeground).toHaveBeenCalledTimes(1);
    expect(subject.controls).toEqual([]);
    expect(subject.keyRequests).toEqual([]);
    expect(subject.mouseRequests).toEqual([]);
  });

  it("accepts exact hidden delivery without changing the foreground owner", async () => {
    const subject = harness();
    subject.setDeliveryMode("background");
    const result = subject.adapter.dispatch(
      nativeRequest("request-background", keyAction("hold"))
    );
    subject.armed();
    expect(subject.keyRequests).toEqual([
      expect.objectContaining({ deliveryMode: "background", eventType: "rawKeyDown" })
    ]);
    subject.dom(subject.arm().expectedEvents[0]!, 0);
    await expect(result).resolves.toEqual(expect.objectContaining({
      status: "applied",
      confirmedInputNeutrality: false
    }));
  });

  it("fails an unavailable delivery mode before preload arm or native submission", async () => {
    const subject = harness();
    subject.setForegroundReady(false);
    await expect(subject.adapter.dispatch(nativeRequest("request-background", keyAction())))
      .resolves.toEqual(expect.objectContaining({
        status: "failed",
        errorCode: "SYSTEM_TRUSTED_INPUT_DELIVERY_MODE_UNAVAILABLE",
        confirmedInputNeutrality: true
      }));
    expect(subject.controls).toEqual([]);
    expect(subject.keyRequests).toEqual([]);
    expect(subject.mouseRequests).toEqual([]);
  });
});


describe("Windows adapter with exact View receipts", () => {
  it.each(["foreground", "background"] as const)("requires complete trusted DOM proof for %s View input", async mode => {
    const subject = harness();
    subject.setDeliveryMode(mode);
    const result = subject.adapter.dispatch(nativeRequest("view-key", keyAction()));
    const completed = vi.fn();
    void result.then(completed);
    subject.armed();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    expect(subject.keyRequests).toHaveLength(2);
    for (const [index, expected] of subject.arm().expectedEvents.entries()) subject.dom(expected, index);
    await expect(result).resolves.toMatchObject({ status: "applied", confirmedInputNeutrality: true });
  });

  it("accepts exact View mouse coordinates without child-HWND claims", async () => {
    const subject = harness();
    subject.setDeliveryMode("background");
    const result = subject.adapter.dispatch(nativeRequest("view-middle", clickAction("middle")));
    subject.armed();
    for (const [index, expected] of subject.arm().expectedEvents.entries()) {
      subject.dom({ ...expected, clientX: 100, clientY: 200 }, index);
    }
    await expect(result).resolves.toMatchObject({ status: "applied" });
  });

  it.each(["foreground", "background"] as const)("preserves a new user focus selected during %s View arming", async mode => {
    const subject = harness();
    subject.setDeliveryMode(mode);
    const result = subject.adapter.dispatch(nativeRequest("view-user-focus", keyAction()));
    subject.setViewFocus({ focusIdentity: "c".repeat(64), parentForeground: false,
      contentsFocused: false, focusedWebContentsId: 1 });
    subject.armed();
    await Promise.resolve();
    expect(subject.keyRequests).toHaveLength(2);
    for (const [index, expected] of subject.arm().expectedEvents.entries()) subject.dom(expected, index);
    await expect(result).resolves.toMatchObject({ status: "applied" });
  });
  it("rejects changed View geometry before sending even if the producer reuses its revision", async () => {
    const subject = harness();
    const result = subject.adapter.dispatch(nativeRequest("view-stale", keyAction()));
    const probe = subject.native.probeExactInputSurface.getMockImplementation()!;
    subject.native.probeExactInputSurface.mockImplementation(() => {
      const receipt = probe();
      if (receipt.ownerKind !== "view") throw new Error("Expected a View receipt.");
      return { ...receipt, observation: { ...receipt.observation,
        bounds: { ...receipt.observation.bounds, x: 99 } } };
    });
    subject.armed();
    await expect(result).resolves.toMatchObject({ status: "superseded" });
    expect(subject.keyRequests).toHaveLength(0);
  });

  it.each(["detach", "command rejection"])("terminalizes CDP %s after invocation as indeterminate", async () => {
    const subject = harness();
    vi.spyOn(subject.cdp, "dispatchKey").mockRejectedValueOnce(
      new Error("CDP terminal")
    );
    const result = subject.adapter.dispatch(nativeRequest("view-forged", keyAction()));
    subject.armed();
    await expect(result).resolves.toMatchObject({ status: "indeterminate" });
  });

  it("keeps CDP receipt correlation alive across a physical modifier edge", async () => {
    const subject = harness();
    const result = subject.adapter.dispatch(nativeRequest("physical-changed", keyAction()));
    subject.armed([]);
    const expected = subject.arm().expectedEvents;
    subject.recordPhysicalInput();
    subject.setNativePhysicalModifierCodes(["ControlRight"]);
    subject.dom(expected[0]!, 0, {
      type: "keydown", code: "ControlRight", ctrlKey: true
    });
    subject.dom(expected[0]!, 1);
    subject.dom(expected[1]!, 2);

    await expect(result).resolves.toMatchObject({
      status: "applied",
      confirmedInputNeutrality: true
    });
  });
});
