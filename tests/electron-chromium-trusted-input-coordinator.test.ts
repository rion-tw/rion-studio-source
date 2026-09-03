import type { BrowserActionRequest } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  ChromiumTrustedInputCoordinator,
  type ChromiumNativeTrustedInputReceipt,
  type ChromiumNativeTrustedInputRequest,
  type ChromiumTrustedInputSurfaceIdentity
} from "../src/electron/main/chromiumTrustedInputCoordinator";

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function request(
  requestId: string,
  overrides: Partial<BrowserActionRequest> = {}
): BrowserActionRequest {
  return {
    requestId,
    roleId: "role-1",
    origin: "macro",
    inputEpoch: 1,
    intent: "normal",
    scheduledAtMs: 1_000,
    deadlineMs: 2_000,
    action: { type: "focus" },
    ...overrides
  };
}

function receipt(
  nativeRequest: ChromiumNativeTrustedInputRequest,
  completedAtMs: number,
  overrides: Partial<ChromiumNativeTrustedInputReceipt> = {}
): ChromiumNativeTrustedInputReceipt {
  return {
    requestId: nativeRequest.requestId,
    roleId: nativeRequest.roleId,
    inputEpoch: nativeRequest.inputEpoch,
    surfaceGeneration: nativeRequest.surfaceGeneration,
    status: "applied",
    completedAtMs,
    errorCode: null,
    errorMessage: null,
    confirmedInputNeutrality: nativeRequest.expectedInputNeutralityAfter,
    ...overrides
  };
}

function subject(
  dispatchImplementation?: (
    nativeRequest: ChromiumNativeTrustedInputRequest
  ) => Promise<ChromiumNativeTrustedInputReceipt>,
  preflightAutomaticInputContext?: (
    roleId: string,
    surfaceGeneration: number
  ) => void | Promise<void>,
  onRecoveryProof?: ConstructorParameters<typeof ChromiumTrustedInputCoordinator>[0]["onRecoveryProof"]
) {
  let nowMs = 1_100;
  const surfaces = new Map<string, ChromiumTrustedInputSurfaceIdentity>([[
    "role-1",
    {
      roleId: "role-1",
      surfaceGeneration: 1,
      documentInstanceId: "document-1",
      state: "active"
    }
  ]]);
  const dispatch = vi.fn(dispatchImplementation ?? (async (nativeRequest) =>
    receipt(nativeRequest, nowMs)));
  let lifecycle: ((event: Readonly<{
    roleId: string;
    generation: number;
    reason: "document-superseded" | "surface-retired";
  }>) => void) | null = null;
  const coordinator = new ChromiumTrustedInputCoordinator({
    native: { dispatch },
    surfaces: {
      resolveInputSurface: (roleId) => surfaces.get(roleId) ?? null,
      subscribeTrustedInputLifecycle: (listener) => {
        lifecycle = listener;
        return () => { lifecycle = null; };
      }
    },
    nowMs: () => nowMs,
    ...(preflightAutomaticInputContext ? { preflightAutomaticInputContext } : {}),
    ...(onRecoveryProof ? { onRecoveryProof } : {})
  });
  return {
    coordinator,
    dispatch,
    emitLifecycle: (event: Parameters<NonNullable<typeof lifecycle>>[0]) =>
      lifecycle?.(event),
    surfaces,
    setNow: (value: number) => { nowMs = value; }
  };
}

describe("Electron Chromium trusted-input coordinator", () => {
  it("runs the exact document-context preflight before native normal input but not cleanup", async () => {
    const preflight = vi.fn(() => {
      throw {
        code: "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED",
        message: "Embedded frame owns input."
      };
    });
    const harness = subject(undefined, preflight);

    await expect(harness.coordinator.execute(request("blocked")))
      .rejects.toMatchObject({ code: "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED" });
    expect(preflight).toHaveBeenCalledWith("role-1", 1);
    expect(harness.dispatch).not.toHaveBeenCalled();

    await expect(harness.coordinator.execute(request("cleanup", {
      intent: "cleanup"
    }))).resolves.toMatchObject({ status: "applied" });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it("forwards an exact generation-fenced request and accepts an applied receipt", async () => {
    const harness = subject();
    const action = request("request-1", {
      action: {
        type: "key",
        phase: "tap",
        key: "a",
        code: "KeyA",
        modifiers: ["primary"],
        ownerId: "macro-1",
        suppressOverlayShortcut: true
      }
    });

    await expect(harness.coordinator.execute(action)).resolves.toMatchObject({
      requestId: "request-1",
      surfaceGeneration: 1,
      status: "applied"
    });
    expect(harness.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-1",
      roleId: "role-1",
      inputEpoch: 1,
      surfaceGeneration: 1,
      action: action.action
    }));
  });

  it("rejects an obsolete exact document fence before any native submission", async () => {
    const harness = subject();

    await expect(harness.coordinator.execute(request("stale-document", {
      surfaceGeneration: 1,
      documentInstanceId: "document-obsolete"
    }))).rejects.toMatchObject({ code: "BROWSER_ACTION_STALE" });
    expect(harness.dispatch).not.toHaveBeenCalled();

    await expect(harness.coordinator.execute(request("current-document", {
      surfaceGeneration: 1,
      documentInstanceId: "document-1"
    }))).resolves.toMatchObject({ status: "applied" });
    expect(harness.dispatch).toHaveBeenCalledOnce();
  });

  it("keeps a navigated held key quarantined until exact cleanup proves neutrality", async () => {
    const harness = subject();
    await harness.coordinator.execute(request("held-old-document", {
      surfaceGeneration: 1,
      documentInstanceId: "document-1",
      action: {
        type: "key",
        phase: "hold",
        key: "2",
        code: "Digit2",
        modifiers: [],
        ownerId: "managed-shortcut:press-1",
        suppressOverlayShortcut: true
      }
    }));
    harness.emitLifecycle({
      roleId: "role-1",
      generation: 1,
      reason: "document-superseded"
    });
    harness.surfaces.set("role-1", {
      roleId: "role-1",
      surfaceGeneration: 1,
      documentInstanceId: "document-2",
      state: "active"
    });

    await expect(harness.coordinator.execute(request("normal-before-cleanup")))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_QUARANTINED" });
    await expect(harness.coordinator.retireSurface("role-1", 1))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE" });

    await expect(harness.coordinator.execute(request("cleanup-old-ledger", {
      intent: "cleanup",
      surfaceGeneration: 1,
      documentInstanceId: "document-1",
      action: {
        type: "key",
        phase: "release",
        key: "2",
        code: "Digit2",
        modifiers: [],
        ownerId: "managed-shortcut:press-1",
        suppressOverlayShortcut: true
      }
    }))).resolves.toMatchObject({
      status: "applied",
      confirmedInputNeutrality: true
    });
    await expect(harness.coordinator.execute(request("normal-after-cleanup")))
      .resolves.toMatchObject({ status: "applied" });
    expect(harness.dispatch).toHaveBeenCalledTimes(3);
  });

  it("tracks exact tap, click, hold, and cleanup-release neutrality in one role lane", async () => {
    const harness = subject();
    const key = (phase: "tap" | "hold" | "release") => ({
      type: "key" as const,
      phase,
      key: "a",
      code: "KeyA",
      modifiers: [] as Array<"primary" | "ctrl" | "alt" | "shift" | "meta">,
      ownerId: "macro-1",
      suppressOverlayShortcut: false
    });

    await expect(harness.coordinator.execute(request("tap", { action: key("tap") })))
      .resolves.toMatchObject({ confirmedInputNeutrality: true });
    await expect(harness.coordinator.execute(request("click", {
      action: {
        type: "click",
        anchor: null,
        unit: "px",
        x: 10.5,
        y: 20.25,
        button: "left"
      }
    }))).resolves.toMatchObject({ confirmedInputNeutrality: true });
    await expect(harness.coordinator.execute(request("hold", { action: key("hold") })))
      .resolves.toMatchObject({ confirmedInputNeutrality: false });
    await expect(harness.coordinator.execute(request("release", {
      action: key("release"),
      intent: "cleanup"
    }))).resolves.toMatchObject({ confirmedInputNeutrality: true });

    expect(harness.dispatch.mock.calls.map(([nativeRequest]) => ({
      requestId: nativeRequest.requestId,
      before: nativeRequest.expectedInputNeutralityBefore,
      after: nativeRequest.expectedInputNeutralityAfter
    }))).toEqual([
      { requestId: "tap", before: true, after: true },
      { requestId: "click", before: true, after: true },
      { requestId: "hold", before: true, after: false },
      { requestId: "release", before: false, after: true }
    ]);
  });

  it("quarantines a native receipt that lies about the prepared terminal neutrality", async () => {
    const harness = subject(async (nativeRequest) => receipt(nativeRequest, 1_100, {
      confirmedInputNeutrality: true
    }));
    await expect(harness.coordinator.execute(request("invalid-hold", {
      action: {
        type: "key",
        phase: "hold",
        key: "a",
        code: "KeyA",
        modifiers: [],
        ownerId: "macro-1",
        suppressOverlayShortcut: false
      }
    }))).rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE" });
    await expect(harness.coordinator.execute(request("quarantined")))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_QUARANTINED" });
  });

  it("serializes one role while allowing independent role lanes to progress", async () => {
    const firstGate = deferred<ChromiumNativeTrustedInputReceipt>();
    const secondRoleGate = deferred<ChromiumNativeTrustedInputReceipt>();
    const queuedStarted = deferred<void>();
    const harness = subject(async (nativeRequest) => {
      if (nativeRequest.requestId === "role-1-first") return firstGate.promise;
      if (nativeRequest.roleId === "role-2") return secondRoleGate.promise;
      queuedStarted.resolve();
      return receipt(nativeRequest, 1_100);
    });
    harness.surfaces.set("role-2", {
      roleId: "role-2",
      surfaceGeneration: 4,
      documentInstanceId: "document-2",
      state: "active"
    });

    const first = harness.coordinator.execute(request("role-1-first"));
    const queued = harness.coordinator.execute(request("role-1-second"));
    const independent = harness.coordinator.execute(request("role-2-first", {
      roleId: "role-2"
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.dispatch.mock.calls.map(([value]) => value.requestId)).toEqual([
      "role-1-first",
      "role-2-first"
    ]);
    firstGate.resolve(receipt(harness.dispatch.mock.calls[0]![0], 1_100));
    await first;
    await queuedStarted.promise;
    expect(harness.dispatch).toHaveBeenCalledTimes(3);
    secondRoleGate.resolve(receipt(harness.dispatch.mock.calls[1]![0], 1_100));
    await expect(Promise.all([queued, independent])).resolves.toHaveLength(2);
  });

  it("rejects expired and obsolete normal work before native submission", async () => {
    const harness = subject();
    await harness.coordinator.execute(request("epoch-2", { inputEpoch: 2 }));

    await expect(harness.coordinator.execute(request("epoch-1"))).rejects.toMatchObject({
      code: "BROWSER_ACTION_STALE"
    });
    harness.setNow(2_000);
    await expect(harness.coordinator.execute(request("expired", {
      inputEpoch: 2
    }))).rejects.toMatchObject({ code: "BROWSER_ACTION_DEADLINE" });
    expect(harness.dispatch).toHaveBeenCalledTimes(1);
  });

  it("quarantines an indeterminate role but still permits cleanup input", async () => {
    const onRecoveryProof = vi.fn();
    const harness = subject(async (nativeRequest) => receipt(nativeRequest, 1_100, {
      status: nativeRequest.requestId === "uncertain" ? "indeterminate" : "applied",
      errorCode: nativeRequest.requestId === "uncertain"
        ? "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
        : null,
      errorMessage: nativeRequest.requestId === "uncertain"
        ? "Native acknowledgement was lost."
        : null
    }), undefined, onRecoveryProof);

    await expect(harness.coordinator.execute(request("uncertain"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
    });
    await expect(harness.coordinator.execute(request("blocked"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_QUARANTINED"
    });
    harness.setNow(3_000);
    await expect(harness.coordinator.execute(request("cleanup", {
      intent: "cleanup",
      action: {
        type: "key",
        phase: "release",
        key: "a",
        code: "KeyA",
        modifiers: [],
        ownerId: "macro-1",
        suppressOverlayShortcut: false
      }
    }))).resolves.toMatchObject({ status: "applied" });
    expect(harness.dispatch).toHaveBeenCalledTimes(2);
    expect(onRecoveryProof).toHaveBeenCalledWith({
      kind: "cleanup-neutral",
      requestId: "cleanup",
      roleId: "role-1",
      inputEpoch: 1,
      surfaceGeneration: 1
    });
    await expect(harness.coordinator.execute(request("after-cleanup", {
      inputEpoch: 1,
      deadlineMs: 4_000
    }))).resolves.toMatchObject({ status: "applied" });
  });

  it("clears quarantine only for the exact replacement surface generation", async () => {
    const harness = subject(async (nativeRequest) => receipt(nativeRequest, 1_100, {
      status: "indeterminate",
      errorCode: "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
      errorMessage: "Native acknowledgement was lost.",
      confirmedInputNeutrality: false
    }));
    await expect(harness.coordinator.execute(request("uncertain")))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE" });
    await expect(harness.coordinator.resumeAfterDocumentReplacement("role-1", 2))
      .resolves.toBe(false);
    await expect(harness.coordinator.resumeAfterDocumentReplacement("role-1", 1))
      .resolves.toBe(true);
  });

  it("resumes only the latest exact event-bound reload document and input epoch", async () => {
    const harness = subject();
    const first = Object.freeze({
      documentInstanceId: "document-1",
      inputEpoch: 2,
      operationId: "reload-1",
      roleId: "role-1",
      surfaceGeneration: 1
    });
    await expect(harness.coordinator.prepareControlledDocumentReplacement(first))
      .resolves.toBeUndefined();
    await expect(harness.coordinator.confirmControlledDocumentReplacementNeutral(first))
      .resolves.toBe(true);
    await expect(harness.coordinator.execute(request("normal-fenced")))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_QUARANTINED" });
    await expect(harness.coordinator.execute(request("cleanup-allowed", {
      intent: "cleanup"
    }))).resolves.toMatchObject({ status: "applied" });

    const replacement = Object.freeze({ ...first, operationId: "reload-2" });
    await expect(harness.coordinator.prepareControlledDocumentReplacement(replacement))
      .resolves.toBeUndefined();
    harness.surfaces.set("role-1", {
      roleId: "role-1",
      surfaceGeneration: 1,
      documentInstanceId: "document-2",
      state: "active"
    });
    await expect(harness.coordinator.resumeControlledDocumentReplacement(
      first,
      "document-2"
    )).resolves.toBe(false);
    await expect(harness.coordinator.resumeControlledDocumentReplacement(
      replacement,
      "document-2"
    )).resolves.toBe(true);
    await expect(harness.coordinator.execute(request("normal-resumed", {
      inputEpoch: 2,
      surfaceGeneration: 1,
      documentInstanceId: "document-2"
    }))).resolves.toMatchObject({ status: "applied" });
  });

  it("retains submitted reload quarantine without role state until exact generation retirement", async () => {
    const harness = subject();
    const submitted = Object.freeze({
      documentInstanceId: "document-1",
      inputEpoch: 2,
      operationId: "reload-submitted",
      roleId: "role-1",
      surfaceGeneration: 1
    });
    await expect(harness.coordinator.prepareControlledDocumentReplacement(submitted))
      .resolves.toBeUndefined();
    expect(harness.coordinator.supersedeControlledDocumentReplacement(
      submitted,
      true
    )).toBe(true);
    const replacement = Object.freeze({
      ...submitted,
      operationId: "reload-replacement"
    });
    await expect(harness.coordinator.prepareControlledDocumentReplacement(replacement))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_QUARANTINED" });
    await expect(harness.coordinator.confirmControlledDocumentReplacementNeutral(replacement))
      .resolves.toBe(false);
    await expect(harness.coordinator.retireSurfaceForDestruction("role-1", 1))
      .resolves.toBe(true);

    harness.emitLifecycle({
      generation: 2,
      reason: "surface-retired",
      roleId: "role-1"
    });
    await expect(harness.coordinator.prepareControlledDocumentReplacement(replacement))
      .rejects.toMatchObject({ code: "SYSTEM_TRUSTED_INPUT_QUARANTINED" });

    harness.emitLifecycle({
      generation: 1,
      reason: "surface-retired",
      roleId: "role-1"
    });
    harness.surfaces.set("role-1", {
      documentInstanceId: "document-2",
      roleId: "role-1",
      state: "active",
      surfaceGeneration: 2
    });
    const nextGeneration = Object.freeze({
      ...replacement,
      documentInstanceId: "document-2",
      operationId: "reload-next-generation",
      surfaceGeneration: 2
    });
    await expect(harness.coordinator.prepareControlledDocumentReplacement(nextGeneration))
      .resolves.toBeUndefined();
    await expect(harness.coordinator.confirmControlledDocumentReplacementNeutral(nextGeneration))
      .resolves.toBe(true);
  });

  it("does not quarantine a proven-neutral native failure", async () => {
    const harness = subject(async (nativeRequest) => nativeRequest.requestId === "failed"
      ? receipt(nativeRequest, 1_100, {
          status: "failed",
          errorCode: "SYSTEM_TRUSTED_INPUT_FAILED",
          errorMessage: "The native target rejected input before submission.",
          confirmedInputNeutrality: true
        })
      : receipt(nativeRequest, 1_100));

    await expect(harness.coordinator.execute(request("failed"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_FAILED"
    });
    await expect(harness.coordinator.execute(request("next"))).resolves.toMatchObject({
      status: "applied"
    });
  });

  it("converts an unproven failure or malformed receipt into quarantine", async () => {
    const harness = subject(async (nativeRequest) => receipt(nativeRequest, 1_100, {
      status: "failed",
      errorCode: "SYSTEM_TRUSTED_INPUT_FAILED",
      errorMessage: "Submission failed without neutral-state evidence.",
      confirmedInputNeutrality: false
    }));

    await expect(harness.coordinator.execute(request("unproven"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
    });
    await expect(harness.coordinator.execute(request("blocked"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_QUARANTINED"
    });
  });

  it("rejects late or identity-mismatched receipts and quarantines the generation", async () => {
    const harness = subject(async (nativeRequest) => receipt(nativeRequest, 1_100, {
      requestId: "forged-request"
    }));

    await expect(harness.coordinator.execute(request("expected"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
    });
    await expect(harness.coordinator.execute(request("blocked"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_QUARANTINED"
    });

    const late = subject(async (nativeRequest) => {
      late.setNow(2_000);
      return receipt(nativeRequest, 1_900);
    });
    await expect(late.coordinator.execute(request("late"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE"
    });
  });

  it("requires exact retirement before a replacement surface can establish a lane", async () => {
    const harness = subject();
    await harness.coordinator.execute(request("generation-1"));
    harness.surfaces.set("role-1", {
      roleId: "role-1",
      surfaceGeneration: 2,
      documentInstanceId: "document-2",
      state: "active"
    });

    await expect(harness.coordinator.execute(request("generation-2-stale", {
      inputEpoch: 2
    }))).rejects.toMatchObject({ code: "BROWSER_ACTION_STALE" });
    await expect(harness.coordinator.retireSurface("role-1", 2)).resolves.toBe(false);
    await expect(harness.coordinator.retireSurface("role-1", 1)).resolves.toBe(true);
    await expect(harness.coordinator.execute(request("generation-2", {
      inputEpoch: 2
    }))).resolves.toMatchObject({ surfaceGeneration: 2 });
  });

  it("retires the exact lane when a surface is destroyed outside executor control", async () => {
    const harness = subject();
    await harness.coordinator.execute(request("generation-1"));
    harness.emitLifecycle({
      roleId: "role-1",
      generation: 1,
      reason: "surface-retired"
    });
    harness.surfaces.set("role-1", {
      roleId: "role-1",
      surfaceGeneration: 2,
      documentInstanceId: "document-2",
      state: "active"
    });

    await expect(harness.coordinator.execute(request("generation-2", {
      inputEpoch: 2
    }))).resolves.toMatchObject({ surfaceGeneration: 2 });
    expect(harness.dispatch).toHaveBeenCalledTimes(2);
  });

  it("allows cleanup on a closing surface but rejects normal work", async () => {
    const harness = subject();
    harness.surfaces.set("role-1", {
      roleId: "role-1",
      surfaceGeneration: 1,
      documentInstanceId: "document-1",
      state: "closing"
    });

    await expect(harness.coordinator.execute(request("normal"))).rejects.toMatchObject({
      code: "SYSTEM_TRUSTED_INPUT_QUARANTINED"
    });
    await expect(harness.coordinator.execute(request("cleanup", {
      intent: "cleanup"
    }))).resolves.toMatchObject({ status: "applied" });
  });

  it("drains accepted work and rejects new input during disposal", async () => {
    const gate = deferred<ChromiumNativeTrustedInputReceipt>();
    const harness = subject(async () => gate.promise);
    const pending = harness.coordinator.execute(request("pending"));
    await Promise.resolve();
    const disposal = harness.coordinator.dispose();

    await expect(harness.coordinator.execute(request("rejected"))).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_INPUT_DRAINING"
    });
    gate.resolve(receipt(harness.dispatch.mock.calls[0]![0], 1_100));
    await expect(pending).resolves.toMatchObject({ status: "applied" });
    await expect(disposal).resolves.toBeUndefined();
  });
});
