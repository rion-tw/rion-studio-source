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
const SURFACE_TOKEN = "11111111111111111111111111111111";
const PARENT_TOKEN = "22222222222222222222222222222222";

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
    roleId: "role-1",
    surfaceGeneration: 3,
    nativeGeneration: 5,
    bindingRevision: "1",
    surfaceHandleToken: SURFACE_TOKEN,
    parentHandleToken: PARENT_TOKEN
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

  const probe = (): WindowsChromiumInputSurfaceProbeReceipt => ({
    ...identity,
    status: "verified",
    abiVersion: 5,
    deliveryMode,
    probeRevision,
    processId: 100,
    uiThreadId: 200,
    currentProcessOwned: true,
    exactParent: exactParent as true,
    childWindowStyle: true,
    popupWindowStyleAbsent: true,
    noActivateStyle: true,
    parentWasForeground: true,
    parentVisible: true,
    surfaceVisible: deliveryMode === "foreground",
    targetWasForeground: false,
    targetHadThreadFocus: false,
    singleWebContentsSurface: true,
    clientWidth: 1_600,
    clientHeight: 1_120,
    dpi: 192
  });

  const baseReceipt = (
    requestId: string,
    requestDeliveryMode: "foreground" | "background"
  ) => ({
    ...identity,
    status: "submitted" as const,
    requestId,
    inputEpoch: "7",
    deliveryMode: requestDeliveryMode,
    dispatchSequence: String(dispatchSequence += 1),
    probeRevision,
    submittedAtMs: String(nowMs),
    withinDeadline: true as const,
    currentProcessOwned: true as const,
    exactParent: true as const,
    childWindowStyle: true as const,
    popupWindowStyleAbsent: true as const,
    noActivateStyle: true as const,
    targetAttached: true as const,
    noActivationApiCalled: true as const,
    foregroundWindowPreserved: preserveForeground as true,
    activeWindowPreserved: true as const,
    focusWindowPreserved: true as const,
    parentWasForeground: true as const,
    parentVisible: true as const,
    surfaceVisible: requestDeliveryMode === "foreground",
    targetWasForeground: false,
    targetHadThreadFocus: false,
    clientWidth: 1_600,
    clientHeight: 1_120,
    dpi: 192
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
        virtualKeyCode: 0x41,
        scanCode: 0x1e,
        extendedKey: false,
        ctrl: request.ctrl,
        alt: request.alt,
        shift: request.shift,
        meta: request.meta,
        keyboardStateRestored: true,
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
        nativeClientX: 250,
        nativeClientY: 500,
        expectedDomClientX: 100,
        expectedDomClientY: 200,
        dispatchedEventCount: 2
      };
    })
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
    clicks: {
      resolve: () => ({ clientX: 100, clientY: 200, zoomFactor: 1.25 })
    },
    nowMs: () => nowMs,
    backgroundSupported: true,
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
  const armed = () => receive({
    kind: "armed",
    roleId: "role-1",
    generation: 3,
    frameToken: frame.frameToken,
    inputSequence: INPUT_SEQUENCE,
    expectedEventCount: arm().expectedEvents.length
  });
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
    observedIndex,
    isTrusted: true,
    matches: true,
    ...expected,
    ...overrides
  });

  return {
    adapter,
    arm,
    armed,
    controls,
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
    setNow: (value: number) => { nowMs = value; },
    setPreserveForeground: (value: boolean) => { preserveForeground = value; },
    setProbeRevision: (value: string) => { probeRevision = value; },
    retire: (reason: ChromiumRoleOverlayLifecycleEvent["reason"]) => lifecycle?.({
      roleId: "role-1",
      generation: 3,
      reason
    })
  };
}

describe("Windows Chromium trusted-input adapter", () => {
  it("keeps foreground and hidden delivery native and non-CDP", () => {
    const adapter = readFileSync(new URL(
      "../src/electron/main/windowsChromiumTrustedInputAdapter.ts",
      import.meta.url
    ), "utf8");
    const nativeProbe = readFileSync(new URL(
      "../crates/rion-node/src/windows_chromium_input_probe.rs",
      import.meta.url
    ), "utf8");
    const bootstrap = readFileSync(new URL(
      "../src/electron/main/chromiumRuntimeBootstrap.ts",
      import.meta.url
    ), "utf8");
    expect(adapter).not.toContain(".sendInputEvent(");
    expect(adapter).not.toContain("webContents.debugger");
    expect(adapter).not.toContain("remote-debugging");
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
    expect(subject.arm().shortcutSuppression).toEqual({
      code: "KeyA",
      phases: ["keydown", "keyup"]
    });
    expect(subject.keyRequests).toEqual([
      expect.objectContaining({ eventType: "keyDown", code: "KeyA", ctrl: true }),
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
    expect(subject.native.probeExactInputSurface).toHaveBeenCalledTimes(2);
  });

  it("maps Windows primary to Ctrl and keeps Meta independent", async () => {
    const subject = harness();
    const result = subject.adapter.dispatch(nativeRequest(
      "request-modifiers",
      keyAction("tap", ["primary", "meta", "shift"])
    ));
    subject.armed();
    expect(subject.keyRequests).toEqual([
      expect.objectContaining({ ctrl: true, meta: true, shift: true }),
      expect.objectContaining({ ctrl: true, meta: true, shift: true })
    ]);
    const expected = subject.arm().expectedEvents;
    subject.dom(expected[0]!, 0);
    subject.dom(expected[1]!, 1);
    await expect(result).resolves.toEqual(expect.objectContaining({ status: "applied" }));
  });

  it.each([
    { button: "left" as const, domButton: 0, activation: "click" as const },
    { button: "middle" as const, domButton: 1, activation: "auxclick" as const },
    { button: "right" as const, domButton: 2, activation: "auxclick" as const }
  ])("uses the native-canonical point and exact $activation for $button", async ({
    activation,
    button,
    domButton
  }) => {
    const subject = harness();
    const result = subject.adapter.dispatch(nativeRequest(
      `request-mouse-${button}`,
      clickAction(button)
    ));
    const armedExpected = subject.arm().expectedEvents;
    expect(armedExpected.map((event) => event.clientX)).toEqual([null, null, null]);
    expect(armedExpected.map((event) => event.type)).toEqual([
      "mousedown", "mouseup", activation
    ]);
    expect(armedExpected.map((event) => event.button)).toEqual([
      domButton, domButton, domButton
    ]);
    subject.armed();
    expect(subject.mouseRequests).toEqual([
      expect.objectContaining({
        button: domButton,
        clientX: 100,
        clientY: 200,
        zoomFactor: 1.25
      })
    ]);
    for (const [index] of ["mousedown", "mouseup", activation].entries()) {
      subject.dom({
        ...armedExpected[index]!,
        clientX: 100,
        clientY: 200
      }, index);
    }
    await expect(result).resolves.toEqual(expect.objectContaining({ status: "applied" }));
  });

  it("fails closed before arming when exact parent/style evidence is absent", async () => {
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

  it("supersedes a binding or probe revision change before native submission", async () => {
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
    const revisedResult = revised.adapter.dispatch(
      nativeRequest("request-revised-probe", keyAction())
    );
    revised.setProbeRevision("2");
    revised.armed();
    await expect(revisedResult).resolves.toEqual(expect.objectContaining({
      status: "superseded",
      errorCode: "BROWSER_ACTION_STALE"
    }));
    expect(revised.keyRequests).toEqual([]);
  });

  it("makes changed focus evidence and untrusted DOM input indeterminate", async () => {
    const focus = harness();
    const focusResult = focus.adapter.dispatch(
      nativeRequest("request-focus-change", keyAction())
    );
    focus.setPreserveForeground(false);
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
    dom.dom(dom.arm().expectedEvents[0]!, 0, { isTrusted: false, matches: false });
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
      expect.objectContaining({ deliveryMode: "background", eventType: "keyDown" })
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
