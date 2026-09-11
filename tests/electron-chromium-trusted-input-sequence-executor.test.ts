import { describe, expect, it, vi } from "vitest";

import type {
  BrowserActionRequest,
  EmbeddedKeyEffectRecord,
  EmbeddedKeyTransitionRecord
} from "../src/shared/generated";
import {
  executeChromiumTrustedKeySequence,
  type ChromiumEmbeddedInputCorePort
} from "../src/electron/main/chromiumTrustedInputSequenceExecutor";
import type {
  ChromiumNativeTrustedInputReceipt,
  ChromiumNativeTrustedInputRequest
} from "../src/electron/main/chromiumTrustedInputCoordinator";

function effect(
  phase: "rawKeyDown" | "keyUp",
  code: string,
  activeCodesBefore: string[],
  activeCodes: string[],
  autoRepeat = false
): EmbeddedKeyEffectRecord {
  return {
    phase,
    code,
    activeCodesBefore,
    activeCodes,
    autoRepeat,
    suppressShortcut: code === "KeyK"
  };
}

function request(
  action: BrowserActionRequest["action"],
  intent: BrowserActionRequest["intent"] = "normal"
): BrowserActionRequest {
  return {
    requestId: "request-1",
    roleId: "role-1",
    origin: "macro",
    inputEpoch: 3,
    intent,
    scheduledAtMs: 1_000,
    deadlineMs: 2_000,
    action
  };
}

function keyAction(overrides: Partial<Extract<
  BrowserActionRequest["action"],
  { type: "key" }
>> = {}): Extract<BrowserActionRequest["action"], { type: "key" }> {
  return {
    type: "key",
    phase: "tap",
    key: "k",
    code: "KeyK",
    modifiers: ["primary", "shift"],
    exactModifierCodes: null,
    modifierOwnership: "synthetic",
    ownerId: "macro-1",
    suppressOverlayShortcut: true,
    ...overrides
  };
}

function applied(nativeRequest: ChromiumNativeTrustedInputRequest):
ChromiumNativeTrustedInputReceipt {
  return {
    requestId: nativeRequest.requestId,
    roleId: nativeRequest.roleId,
    inputEpoch: nativeRequest.inputEpoch,
    surfaceGeneration: nativeRequest.surfaceGeneration,
    status: "applied",
    completedAtMs: 1_100,
    errorCode: null,
    errorMessage: null,
    confirmedInputNeutrality: nativeRequest.expectedInputNeutralityAfter
  };
}

function coreWithTransition(transition: EmbeddedKeyTransitionRecord):
ChromiumEmbeddedInputCorePort & {
  prepare: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  reassert: ReturnType<typeof vi.fn>;
} {
  return {
    prepare: vi.fn(async () => transition),
    complete: vi.fn(async () => undefined),
    reassert: vi.fn(async () => transition),
    clear: vi.fn(async () => undefined)
  };
}

describe("Chromium trusted-input key sequence executor", () => {
  it("submits every Rust-owned chord effect in exact order before committing", async () => {
    const effects = [
      effect("rawKeyDown", "ControlLeft", [], ["ControlLeft"]),
      effect("rawKeyDown", "ShiftLeft", ["ControlLeft"], ["ControlLeft", "ShiftLeft"]),
      effect("rawKeyDown", "KeyK", ["ControlLeft", "ShiftLeft"], ["ControlLeft", "KeyK", "ShiftLeft"]),
      effect("keyUp", "KeyK", ["ControlLeft", "KeyK", "ShiftLeft"], ["ControlLeft", "ShiftLeft"]),
      effect("keyUp", "ShiftLeft", ["ControlLeft", "ShiftLeft"], ["ControlLeft"]),
      effect("keyUp", "ControlLeft", ["ControlLeft"], [])
    ];
    const core = coreWithTransition({
      transitionId: "transition-1",
      effects,
      hasHeldKeys: false
    });
    const submissions: ChromiumNativeTrustedInputRequest[] = [];

    const result = await executeChromiumTrustedKeySequence({
      request: request(keyAction()),
      surfaceGeneration: 9,
      platform: "win32",
      core,
      dispatch: vi.fn(async nativeRequest => {
        submissions.push(nativeRequest);
        expect(core.complete).not.toHaveBeenCalled();
        return applied(nativeRequest);
      }),
      nowMs: () => 1_100
    });

    expect(core.prepare).toHaveBeenCalledWith({
      roleId: "role-1",
      phase: "tap",
      code: "KeyK",
      modifierCodes: ["ControlLeft", "ShiftLeft"],
      ownerId: "macro-1"
    });
    expect(submissions.map(({ keyEffect }) => [keyEffect?.phase, keyEffect?.code]))
      .toEqual(effects.map(({ phase, code }) => [phase, code]));
    expect(submissions.every(({ intent }) => intent === "normal")).toBe(true);
    expect(core.complete).toHaveBeenCalledOnce();
    expect(core.complete).toHaveBeenCalledWith("transition-1", true);
    expect(result).toMatchObject({ hasHeldKeys: false, receipt: { status: "applied" } });
  });

  it("passes physical sides through without adding synthetic modifier owners", async () => {
    const core = coreWithTransition({
      transitionId: "transition-2",
      effects: [effect("rawKeyDown", "KeyK", [], ["KeyK"], true)],
      hasHeldKeys: true
    });
    const dispatch = vi.fn(async (nativeRequest: ChromiumNativeTrustedInputRequest) =>
      applied(nativeRequest));

    await executeChromiumTrustedKeySequence({
      request: request(keyAction({
        phase: "hold",
        modifiers: [],
        exactModifierCodes: ["ControlRight", "AltLeft"],
        modifierOwnership: "physical-pass-through"
      })),
      surfaceGeneration: 2,
      platform: "darwin",
      core,
      dispatch,
      nowMs: () => 1_100
    });

    expect(core.prepare).toHaveBeenCalledWith(expect.objectContaining({ modifierCodes: [] }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      physicalModifierCodes: ["ControlRight", "AltLeft"],
      keyEffect: expect.objectContaining({
        code: "KeyK",
        activeCodesBefore: [],
        activeCodes: ["KeyK"]
      })
    }));
  });

  it("reverses only the confirmed prefix and rolls Core back after a failed effect", async () => {
    const core = coreWithTransition({
      transitionId: "transition-3",
      effects: [
        effect("rawKeyDown", "ShiftLeft", [], ["ShiftLeft"]),
        effect("rawKeyDown", "KeyK", ["ShiftLeft"], ["KeyK", "ShiftLeft"])
      ],
      hasHeldKeys: true
    });
    const submitted: ChromiumNativeTrustedInputRequest[] = [];
    const dispatch = vi.fn(async (nativeRequest: ChromiumNativeTrustedInputRequest) => {
      submitted.push(nativeRequest);
      if (submitted.length !== 2) return applied(nativeRequest);
      return {
        ...applied(nativeRequest),
        status: "failed" as const,
        errorCode: "SYSTEM_TRUSTED_INPUT_REJECTED",
        errorMessage: "The main key was rejected.",
        confirmedInputNeutrality: false
      };
    });

    await expect(executeChromiumTrustedKeySequence({
      request: request(keyAction({ modifiers: ["shift"] })),
      surfaceGeneration: 4,
      platform: "win32",
      core,
      dispatch,
      nowMs: () => 1_100
    })).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_REJECTED",
      quarantine: false
    });

    expect(submitted.map(({ intent, keyEffect }) =>
      [intent, keyEffect?.phase, keyEffect?.code]))
      .toEqual([
        ["normal", "rawKeyDown", "ShiftLeft"],
        ["normal", "rawKeyDown", "KeyK"],
        ["cleanup", "keyUp", "ShiftLeft"]
      ]);
    expect(core.complete).toHaveBeenCalledOnce();
    expect(core.complete).toHaveBeenCalledWith("transition-3", false);
  });

  it("quarantines an unknown submission without retrying another transport", async () => {
    const core = coreWithTransition({
      transitionId: "transition-4",
      effects: [effect("rawKeyDown", "KeyK", [], ["KeyK"])],
      hasHeldKeys: true
    });
    const dispatch = vi.fn(async () => {
      throw new Error("detached");
    });

    await expect(executeChromiumTrustedKeySequence({
      request: request(keyAction({ phase: "hold", modifiers: [] })),
      surfaceGeneration: 5,
      platform: "win32",
      core,
      dispatch,
      nowMs: () => 1_100
    })).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
      quarantine: true
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(core.complete).toHaveBeenCalledWith("transition-4", false);
  });

  it("gets the complete held-key reassertion from Core once", async () => {
    const core = coreWithTransition({
      effects: [
        effect("rawKeyDown", "AltRight", ["AltRight", "KeyK"], ["AltRight", "KeyK"]),
        effect("rawKeyDown", "KeyK", ["AltRight", "KeyK"], ["AltRight", "KeyK"])
      ],
      hasHeldKeys: true
    });
    const dispatch = vi.fn(async (nativeRequest: ChromiumNativeTrustedInputRequest) =>
      applied(nativeRequest));

    await executeChromiumTrustedKeySequence({
      request: request({ type: "reassertHeldKeys" }, "cleanup"),
      surfaceGeneration: 6,
      platform: "darwin",
      core,
      dispatch,
      nowMs: () => 1_100
    });

    expect(core.reassert).toHaveBeenCalledOnce();
    expect(core.reassert).toHaveBeenCalledWith("role-1");
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.complete).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("quarantines a partially failed reassertion even after exact compensation", async () => {
    const core = coreWithTransition({
      effects: [
        effect("rawKeyDown", "AltRight", ["AltRight", "KeyK"], ["AltRight", "KeyK"]),
        effect("rawKeyDown", "KeyK", ["AltRight", "KeyK"], ["AltRight", "KeyK"])
      ],
      hasHeldKeys: true
    });
    let submission = 0;
    const dispatch = vi.fn(async (nativeRequest: ChromiumNativeTrustedInputRequest) => {
      submission += 1;
      if (submission !== 2) return applied(nativeRequest);
      return {
        ...applied(nativeRequest),
        status: "failed" as const,
        errorCode: "SYSTEM_TRUSTED_INPUT_REJECTED",
        errorMessage: "The reassertion was rejected.",
        confirmedInputNeutrality: false
      };
    });

    await expect(executeChromiumTrustedKeySequence({
      request: request({ type: "reassertHeldKeys" }, "cleanup"),
      surfaceGeneration: 7,
      platform: "darwin",
      core,
      dispatch,
      nowMs: () => 1_100
    })).rejects.toMatchObject({ quarantine: true });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(core.complete).not.toHaveBeenCalled();
  });
});
