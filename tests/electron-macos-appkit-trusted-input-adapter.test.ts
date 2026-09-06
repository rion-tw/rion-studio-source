import { readFileSync } from "node:fs";

import type { BrowserAction } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import { commonMacroKeyCodes } from
  "../src/renderer/src/features/macros/macroUtils";
import type {
  ChromiumRoleTrustedInputArmEnvelope,
  ChromiumRoleTrustedInputDomReceipt
} from "../src/electron/ipc/chromiumRoleTrustedInputProtocol";
import type { ChromiumNativeTrustedInputRequest } from
  "../src/electron/main/chromiumTrustedInputCoordinator";
import {
  MACOS_APPKIT_TRUSTED_KEY_CODES,
  MacosAppKitTrustedInputAdapter,
  type AppKitNativeKeySubmissionReceipt,
  type AppKitNativeMouseSubmissionReceipt,
  type MacosAppKitTrustedInputIpcEventPort,
  type MacosAppKitTrustedInputIpcMainPort,
  type RawNativeAppKitTrustedInputHost
} from "../src/electron/main/macosAppKitTrustedInputAdapter";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "../src/electron/main/chromiumRoleSurfaceRegistry";

const INPUT_SEQUENCE_1 = "00000000-0000-4000-8000-000000000001";
const INPUT_SEQUENCE_2 = "00000000-0000-4000-8000-000000000002";

function nativeRequest(
  requestId: string,
  action: BrowserAction,
  overrides: Partial<ChromiumNativeTrustedInputRequest> = {}
): ChromiumNativeTrustedInputRequest {
  return {
    requestId,
    roleId: "role-1",
    inputEpoch: 1,
    intent: "normal",
    scheduledAtMs: 1_000,
    deadlineMs: 2_000,
    surfaceGeneration: 1,
    expectedInputNeutralityBefore: true,
    expectedInputNeutralityAfter: action.type === "key" && action.phase === "hold"
      ? false
      : true,
    action,
    ...overrides
  };
}

function keyAction(
  phase: "tap" | "hold" | "release" = "tap"
): Extract<BrowserAction, { type: "key" }> {
  return {
    type: "key",
    phase,
    key: "a",
    code: "KeyA",
    modifiers: ["primary"],
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
    x: 100.25,
    y: 200.75,
    button
  };
}

function harness(options: Readonly<{
  resolvedClick?: Readonly<{
    clientX: number;
    clientY: number;
    zoomFactor: number;
  }>;
  zoomFactor?: number;
  slotOffset?: Readonly<{ x: number; y: number }>;
  targetFlipped?: boolean;
}> = {}) {
  let nowMs = 1_100;
  let nextSequence = 0;
  let dispatchSequence = 0;
  const controls: Array<ChromiumRoleTrustedInputArmEnvelope | { readonly kind: "cancel" }> = [];
  const frame = Object.freeze({ frameToken: "frame-token-1" });
  const frameIdentity: ChromiumRoleOverlayFrameIdentity = Object.freeze({
    roleId: "role-1",
    generation: 1,
    frame,
    frameToken: frame.frameToken,
    documentInstanceId: "document-1"
  });
  const sender = Object.freeze({ id: 9 });
  const event: MacosAppKitTrustedInputIpcEventPort = {
    sender,
    senderFrame: frame
  };
  let lifecycle: ((event: ChromiumRoleOverlayLifecycleEvent) => void) | null = null;
  const timerCallbacks = new Map<number, () => void>();
  let timerId = 0;
  const cancelTimer = vi.fn((handle: unknown) => {
    if (typeof handle === "number") timerCallbacks.delete(handle);
  });
  const identity = {
    logicalWindowId: "window-1",
    launchGeneration: "launch-1",
    nativeGeneration: 1
  };
  const keySubmissions: unknown[] = [];
  const mouseSubmissions: unknown[] = [];
  const mouseReceipts: AppKitNativeMouseSubmissionReceipt[] = [];
  let nativeFocusNeutral = true;
  let nativeMouseOffset = { x: 0, y: 0 };
  let nativeAppKitPointOffset = { x: 0, y: 0 };
  const zoomFactor = options.zoomFactor ?? 1.25;
  const resolvedClick = options.resolvedClick ?? {
    clientX: 100,
    clientY: 200,
    zoomFactor
  };
  const slotOffset = options.slotOffset ?? { x: 73, y: 57 };
  const targetFlipped = options.targetFlipped ?? true;
  const native = {
    submitNativeBackgroundKey: (
      _expected: typeof identity,
      request: Parameters<RawNativeAppKitTrustedInputHost[
        "submitNativeBackgroundKey"
      ]>[1]
    ): AppKitNativeKeySubmissionReceipt => {
      keySubmissions.push(request);
      dispatchSequence += 1;
      return {
        status: "submitted",
        requestId: String(request.requestId),
        roleId: String(request.roleId),
        surfaceGeneration: Number(request.surfaceGeneration),
        inputEpoch: String(request.inputEpoch),
        nativeGeneration: 1,
        dispatchSequence: String(dispatchSequence),
        submittedAtMs: String(nowMs),
        withinDeadline: true,
        dispatchedEventCount: 1,
        modifierFlags: /^F(?:[1-9]|1[0-9]|20)$/u.test(request.code) ||
          request.code.startsWith("Arrow") ||
          ["Insert", "Delete", "Home", "End", "PageUp", "PageDown"]
            .includes(request.code)
          ? request.modifierFlags | (1 << 23)
          : request.modifierFlags,
        targetAttached: true,
        focusNeutral: nativeFocusNeutral,
        keyWindowPreserved: true,
        keyWindowFirstResponderPreserved: true,
        targetFirstResponderPreserved: true,
        targetX: 0,
        targetY: 0,
        targetWidth: 800,
        targetHeight: 560,
        eventType: request.eventType as "keyDown" | "keyUp",
        code: String(request.code),
        virtualKeyCode: 0
      };
    },
    submitNativeBackgroundMouse: (
      _expected: typeof identity,
      request: Parameters<RawNativeAppKitTrustedInputHost[
        "submitNativeBackgroundMouse"
      ]>[1]
    ): AppKitNativeMouseSubmissionReceipt => {
      mouseSubmissions.push(request);
      dispatchSequence += 1;
      const targetX = 0;
      const targetY = 0;
      const targetWidth = 800;
      const targetHeight = 560;
      const appKitPointX = targetX + request.clientX * request.zoomFactor +
        nativeAppKitPointOffset.x;
      const appKitPointY = (targetFlipped
        ? targetY + request.clientY * request.zoomFactor
        : targetY + targetHeight - request.clientY * request.zoomFactor) +
        nativeAppKitPointOffset.y;
      const receipt: AppKitNativeMouseSubmissionReceipt = {
        status: "submitted",
        requestId: String(request.requestId),
        roleId: String(request.roleId),
        surfaceGeneration: Number(request.surfaceGeneration),
        inputEpoch: String(request.inputEpoch),
        nativeGeneration: 1,
        dispatchSequence: String(dispatchSequence),
        submittedAtMs: String(nowMs),
        withinDeadline: true,
        dispatchedEventCount: 2,
        modifierFlags: 0,
        targetAttached: true,
        focusNeutral: nativeFocusNeutral,
        keyWindowPreserved: true,
        keyWindowFirstResponderPreserved: true,
        targetFirstResponderPreserved: true,
        targetX,
        targetY,
        targetWidth,
        targetHeight,
        button: Number(request.button),
        clientX: request.clientX + nativeMouseOffset.x,
        clientY: request.clientY + nativeMouseOffset.y,
        zoomFactor: request.zoomFactor,
        appKitPointX,
        appKitPointY,
        windowPointX: slotOffset.x + appKitPointX,
        windowPointY: slotOffset.y + appKitPointY,
        targetFlipped
      };
      mouseReceipts.push(receipt);
      return receipt;
    }
  };
  let ipcListener: ((event: MacosAppKitTrustedInputIpcEventPort, value: unknown) => void)
    | null = null;
  const ipcMain: MacosAppKitTrustedInputIpcMainPort = {
    on: (_channel, listener) => { ipcListener = listener; },
    removeListener: vi.fn((_channel, listener) => {
      if (ipcListener === listener) ipcListener = null;
    })
  };
  const adapter = new MacosAppKitTrustedInputAdapter({
    hosts: { resolve: () => ({ identity, native }) },
    surfaces: {
      authorizeTrustedInputFrame: (candidateSender, candidateFrame, token) => {
        if (candidateSender !== sender || candidateFrame !== frame || token !== frame.frameToken) {
          throw new Error("unauthorized frame");
        }
        return frameIdentity;
      },
      currentTrustedInputFrame: () => frameIdentity,
      sendTrustedInputControl: (_expected, control) => {
        controls.push(control as ChromiumRoleTrustedInputArmEnvelope);
      },
      subscribeTrustedInputLifecycle: (listener) => {
        lifecycle = listener;
        return () => { lifecycle = null; };
      }
    },
    clicks: { resolve: () => resolvedClick },
    nowMs: () => nowMs,
    timers: {
      schedule: (callback) => {
        timerId += 1;
        timerCallbacks.set(timerId, callback);
        return timerId;
      },
      cancel: cancelTimer
    },
    createInputSequence: () => {
      nextSequence += 1;
      return nextSequence === 1 ? INPUT_SEQUENCE_1 : INPUT_SEQUENCE_2;
    }
  });
  adapter.register(ipcMain);

  const arm = (): ChromiumRoleTrustedInputArmEnvelope => {
    const control = controls.find((candidate) => candidate.kind === "arm");
    if (!control || control.kind !== "arm") throw new Error("missing arm");
    adapter.receive(event, {
      kind: "armed",
      roleId: control.roleId,
      generation: control.generation,
      frameToken: control.frameToken,
      inputSequence: control.inputSequence,
      expectedEventCount: control.expectedEvents.length
    });
    return control;
  };
  const domReceipt = (
    control: ChromiumRoleTrustedInputArmEnvelope,
    index: number,
    overrides: Partial<ChromiumRoleTrustedInputDomReceipt> = {}
  ): ChromiumRoleTrustedInputDomReceipt => {
    const expected = control.expectedEvents[index]!;
    return {
      kind: "input",
      roleId: control.roleId,
      generation: control.generation,
      frameToken: control.frameToken,
      inputSequence: control.inputSequence,
      observedIndex: index,
      isTrusted: true,
      matches: true,
      ...expected,
      ...(expected.type === "mousedown" || expected.type === "mouseup" ||
        expected.type === "click" || expected.type === "auxclick"
        ? { clientX: 100, clientY: 200 }
        : {}),
      ...overrides
    };
  };
  const receiptAll = (control: ChromiumRoleTrustedInputArmEnvelope): void => {
    control.expectedEvents.forEach((_expected, index) => {
      adapter.receive(event, domReceipt(control, index));
    });
  };
  return {
    adapter,
    arm,
    cancelTimer,
    controls,
    domReceipt,
    event,
    fireDeadline: () => {
      nowMs = 2_000;
      [...timerCallbacks.values()][0]?.();
    },
    ipcListener: () => ipcListener,
    keySubmissions,
    mouseReceipts,
    mouseSubmissions,
    setNativeFocusNeutral: (value: boolean) => { nativeFocusNeutral = value; },
    setNativeMouseOffset: (x: number, y: number) => {
      nativeMouseOffset = { x, y };
    },
    setNativeAppKitPointOffset: (x: number, y: number) => {
      nativeAppKitPointOffset = { x, y };
    },
    receiptAll,
    emitLifecycle: (reason: ChromiumRoleOverlayLifecycleEvent["reason"]) =>
      lifecycle?.({ roleId: "role-1", generation: 1, reason }),
    setNow: (value: number) => { nowMs = value; }
  };
}

describe("macOS AppKit trusted-input adapter", () => {
  it("accepts exactly the UI key codes with stable macOS virtual keys", async () => {
    const supported = new Set<string>(MACOS_APPKIT_TRUSTED_KEY_CODES);
    const nativeSource = readFileSync(new URL(
      "../crates/rion-appkit/native/macos/RionRuntimeTabsController/09_chromium_surface_probe.mm",
      import.meta.url
    ), "utf8");
    const matrixStart = nativeSource.indexOf("codes = @{");
    const matrixEnd = nativeSource.indexOf("\n    };", matrixStart);
    const nativeCodes = [...nativeSource.slice(matrixStart, matrixEnd)
      .matchAll(/@"([A-Za-z0-9]+)":/gu)]
      .map((match) => match[1]!);

    expect(matrixStart).toBeGreaterThanOrEqual(0);
    expect(matrixEnd).toBeGreaterThan(matrixStart);
    expect([...nativeCodes].sort()).toEqual([...supported].sort());
    expect(commonMacroKeyCodes.filter((code) => !supported.has(code))).toEqual([
      "F21",
      "F22",
      "F23",
      "F24"
    ]);
    const targetCollector = nativeSource.slice(
      nativeSource.indexOf("static void RionCollectChromiumRendererTargets"),
      nativeSource.indexOf("extern \"C\" int32_t rion_appkit_dispatch_chromium_key")
    );
    expect(targetCollector).toContain(
      'isEqualToString:@"RenderWidgetHostViewCocoa"] &&'
    );
    expect(targetCollector).toContain("view.acceptsFirstResponder && view.window");
    expect(targetCollector).not.toContain("!view.hidden");
    expect(MACOS_APPKIT_TRUSTED_KEY_CODES).toEqual(
      commonMacroKeyCodes.filter((code) => !/^F2[1-4]$/u.test(code))
    );

    for (const [index, code] of MACOS_APPKIT_TRUSTED_KEY_CODES.entries()) {
      const subject = harness();
      const action: BrowserAction = {
        ...keyAction(),
        key: code,
        code,
        modifiers: []
      };
      const completion = subject.adapter.dispatch(
        nativeRequest(`supported-${index}`, action)
      );
      const control = subject.arm();
      subject.receiptAll(control);
      await expect(completion).resolves.toMatchObject({ status: "applied" });
    }
  });

  it.each(["F21", "F22", "F23", "F24", "Numpad0"])(
    "rejects unsupported Core DOM code %s before preload arming or native submission",
    async (code) => {
      const subject = harness();
      const action: BrowserAction = { ...keyAction(), key: code, code };

      await expect(subject.adapter.dispatch(nativeRequest(`unsupported-${code}`, action)))
        .resolves.toMatchObject({
          status: "failed",
          errorCode: "SYSTEM_TRUSTED_INPUT_CODE_UNSUPPORTED",
          confirmedInputNeutrality: true
        });
      expect(subject.controls).toHaveLength(0);
      expect(subject.keySubmissions).toHaveLength(0);
    }
  );

  it.each(["hold", "release"] as const)(
    "keeps non-shortcut Macro %s out of physical-key focus cleanup",
    async (phase) => {
      const subject = harness();
      const action = { ...keyAction(), phase, code: "Digit2", key: "2",
        modifiers: [], suppressOverlayShortcut: false };
      const completion = subject.adapter.dispatch(nativeRequest("ordinary-key", action));
      const control = subject.arm();
      expect(control.shortcutSuppression).toEqual({
        code: "Digit2", phases: [phase === "hold" ? "keydown" : "keyup"]
      });
      subject.adapter.receive(subject.event, subject.domReceipt(control, 0));
      await expect(completion).resolves.toMatchObject({ status: "applied" });
    }
  );

  it("applies a tap only after exact native submitted and trusted key down/up receipts", async () => {
    const subject = harness();
    const completion = subject.adapter.dispatch(nativeRequest("tap-1", keyAction()));
    const control = subject.arm();
    expect(control.shortcutSuppression).toEqual({
      code: "KeyA",
      phases: ["keydown", "keyup"]
    });
    expect(subject.keySubmissions).toHaveLength(2);
    let settled = false;
    void completion.then(() => { settled = true; });
    subject.adapter.receive(subject.event, subject.domReceipt(control, 0));
    await Promise.resolve();
    expect(settled).toBe(false);
    subject.adapter.receive(subject.event, subject.domReceipt(control, 1));
    await expect(completion).resolves.toMatchObject({
      status: "applied",
      confirmedInputNeutrality: true
    });
  });

  it.each([1, 1.25, 2])(
    "converts canonical CSS clicks at zoom %s without applying Retina scale twice",
    async (zoomFactor) => {
      const subject = harness({ zoomFactor, slotOffset: { x: 73, y: 57 } });
      const completion = subject.adapter.dispatch(nativeRequest("click-1", clickAction()));
      const control = subject.arm();
      expect(control.shortcutSuppression).toBeNull();
      expect(subject.mouseSubmissions).toEqual([expect.objectContaining({
        clientX: 100,
        clientY: 200,
        zoomFactor,
        button: 0
      })]);
      expect(subject.mouseReceipts).toEqual([expect.objectContaining({
        clientX: 100,
        clientY: 200,
        zoomFactor,
        appKitPointX: 100 * zoomFactor,
        appKitPointY: 200 * zoomFactor,
        windowPointX: 73 + 100 * zoomFactor,
        windowPointY: 57 + 200 * zoomFactor
      })]);
      subject.receiptAll(control);
      await expect(completion).resolves.toMatchObject({
        status: "applied",
        confirmedInputNeutrality: true
      });
    }
  );

  it.each([
    { button: "middle" as const, domButton: 1 },
    { button: "right" as const, domButton: 2 }
  ])("requires trusted auxclick for the $button AppKit mouse action", async ({
    button,
    domButton
  }) => {
    const subject = harness();
    const completion = subject.adapter.dispatch(nativeRequest(
      `auxiliary-${button}`,
      clickAction(button)
    ));
    const control = subject.arm();
    expect(control.expectedEvents.map((event) => event.type)).toEqual([
      "mousedown", "mouseup", "auxclick"
    ]);
    expect(control.expectedEvents.map((event) => event.button)).toEqual([
      domButton, domButton, domButton
    ]);
    subject.receiptAll(control);
    await expect(completion).resolves.toMatchObject({ status: "applied" });
  });

  it("validates the non-flipped AppKit Y conversion exactly", async () => {
    const subject = harness({ zoomFactor: 1.25, targetFlipped: false });
    const completion = subject.adapter.dispatch(
      nativeRequest("non-flipped-click", clickAction())
    );
    const control = subject.arm();
    expect(subject.mouseReceipts).toEqual([expect.objectContaining({
      appKitPointX: 125,
      appKitPointY: 310,
      targetFlipped: false
    })]);
    subject.receiptAll(control);
    await expect(completion).resolves.toMatchObject({ status: "applied" });
  });

  it.each([
    { clientX: 100.5, clientY: 200, zoomFactor: 1.25 },
    { clientX: 100, clientY: 200.5, zoomFactor: 1.25 },
    { clientX: 100, clientY: 200, zoomFactor: 0.24 },
    { clientX: 100, clientY: 200, zoomFactor: Number.POSITIVE_INFINITY }
  ])("rejects non-canonical resolved click $clientX,$clientY@$zoomFactor", async (
    resolvedClick
  ) => {
    const subject = harness({ resolvedClick });

    await expect(subject.adapter.dispatch(
      nativeRequest("invalid-resolved-click", clickAction())
    )).resolves.toMatchObject({
      status: "failed",
      errorCode: "SYSTEM_TRUSTED_INPUT_COORDINATE_INVALID",
      confirmedInputNeutrality: true
    });
    expect(subject.controls).toHaveLength(0);
    expect(subject.mouseSubmissions).toHaveLength(0);
  });

  it("quarantines a native mouse receipt for any CSS point other than the submission", async () => {
    const subject = harness();
    subject.setNativeMouseOffset(1, 0);
    const completion = subject.adapter.dispatch(
      nativeRequest("wrong-click-point", clickAction())
    );
    subject.arm();

    await expect(completion).resolves.toMatchObject({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_PARTIAL_NATIVE_SUBMISSION",
      confirmedInputNeutrality: false
    });
  });

  it("quarantines a native mouse receipt with the wrong CSS-to-AppKit scaling", async () => {
    const subject = harness({ zoomFactor: 1.25 });
    subject.setNativeAppKitPointOffset(1, 0);
    const completion = subject.adapter.dispatch(
      nativeRequest("wrong-native-point", clickAction())
    );
    subject.arm();

    await expect(completion).resolves.toMatchObject({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_PARTIAL_NATIVE_SUBMISSION",
      confirmedInputNeutrality: false
    });
  });

  it("retains non-neutral held state for hold and accepts exact cleanup release evidence", async () => {
    const hold = harness();
    const held = hold.adapter.dispatch(nativeRequest("hold-1", keyAction("hold"), {
      expectedInputNeutralityAfter: false
    }));
    hold.receiptAll(hold.arm());
    await expect(held).resolves.toMatchObject({
      status: "applied",
      confirmedInputNeutrality: false
    });

    const release = harness();
    const cleaned = release.adapter.dispatch(nativeRequest("release-1", keyAction("release"), {
      intent: "cleanup",
      expectedInputNeutralityBefore: false,
      expectedInputNeutralityAfter: true
    }));
    release.receiptAll(release.arm());
    await expect(cleaned).resolves.toMatchObject({
      status: "applied",
      confirmedInputNeutrality: true
    });
  });

  it("rejects forged page IPC, stale sequence, and partial trusted sequences", async () => {
    const subject = harness();
    const completion = subject.adapter.dispatch(nativeRequest("forgery-1", keyAction()));
    const control = subject.arm();
    subject.ipcListener()?.({
      sender: Object.freeze({ id: 10 }),
      senderFrame: subject.event.senderFrame
    }, subject.domReceipt(control, 0));
    subject.ipcListener()?.({
      sender: subject.event.sender,
      senderFrame: Object.freeze({ frameToken: "stale-frame-token" })
    }, subject.domReceipt(control, 0));
    expect(subject.adapter.receive(subject.event, subject.domReceipt(control, 0, {
      inputSequence: INPUT_SEQUENCE_2
    }))).toBe(false);
    subject.adapter.receive(subject.event, subject.domReceipt(control, 0));
    subject.emitLifecycle("document-superseded");
    await expect(completion).resolves.toMatchObject({
      status: "indeterminate",
      confirmedInputNeutrality: false
    });
    expect(subject.adapter.receive(subject.event, subject.domReceipt(control, 1))).toBe(false);
  });

  it("quarantines a native invocation without exact focus-neutral evidence", async () => {
    const subject = harness();
    subject.setNativeFocusNeutral(false);
    const completion = subject.adapter.dispatch(nativeRequest("neutrality-1", keyAction()));
    subject.arm();
    await expect(completion).resolves.toMatchObject({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_PARTIAL_NATIVE_SUBMISSION",
      confirmedInputNeutrality: false
    });
  });

  it("terminalizes navigation before submission and surface close after submission", async () => {
    const before = harness();
    const cancelled = before.adapter.dispatch(nativeRequest("before-1", keyAction()));
    before.emitLifecycle("document-superseded");
    await expect(cancelled).resolves.toMatchObject({
      status: "superseded",
      confirmedInputNeutrality: true
    });
    expect(before.keySubmissions).toHaveLength(0);

    const after = harness();
    const uncertain = after.adapter.dispatch(nativeRequest("after-1", keyAction()));
    after.arm();
    after.emitLifecycle("surface-retired");
    await expect(uncertain).resolves.toMatchObject({
      status: "indeterminate",
      confirmedInputNeutrality: false
    });
  });

  it("uses the Core deadline only for indeterminate liveness and ignores late receipts", async () => {
    const subject = harness();
    const lost = subject.adapter.dispatch(nativeRequest("lost-1", keyAction()));
    const oldControl = subject.arm();
    subject.fireDeadline();
    await expect(lost).resolves.toMatchObject({
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_DOM_RECEIPT_DEADLINE"
    });
    expect(subject.adapter.receive(subject.event, subject.domReceipt(oldControl, 0))).toBe(false);

    subject.setNow(2_100);
    const next = subject.adapter.dispatch(nativeRequest("next-1", keyAction(), {
      scheduledAtMs: 2_000,
      deadlineMs: 3_000,
      inputEpoch: 2
    }));
    const nextControl = subject.controls.find((control) =>
      control.kind === "arm" && control.inputSequence === INPUT_SEQUENCE_2
    ) as ChromiumRoleTrustedInputArmEnvelope;
    subject.adapter.receive(subject.event, {
      kind: "armed",
      roleId: nextControl.roleId,
      generation: nextControl.generation,
      frameToken: nextControl.frameToken,
      inputSequence: nextControl.inputSequence,
      expectedEventCount: nextControl.expectedEvents.length
    });
    subject.receiptAll(nextControl);
    await expect(next).resolves.toMatchObject({ status: "applied" });
  });

  it("proves focus readiness without changing native focus or forging input", async () => {
    const subject = harness();
    await expect(subject.adapter.dispatch(nativeRequest("focus-1", { type: "focus" })))
      .resolves.toMatchObject({
        status: "applied",
        errorCode: null,
        confirmedInputNeutrality: true
      });
    expect(subject.controls).toHaveLength(0);
    expect(subject.keySubmissions).toHaveLength(0);
    expect(subject.mouseSubmissions).toHaveLength(0);
  });

  it("disposal terminalizes pending work and removes the private IPC listener", async () => {
    const subject = harness();
    const completion = subject.adapter.dispatch(nativeRequest("dispose-1", keyAction()));
    subject.adapter.dispose();
    await expect(completion).resolves.toMatchObject({ status: "superseded" });
    expect(subject.ipcListener()).toBeNull();
    expect(subject.cancelTimer).toHaveBeenCalled();
  });
});
