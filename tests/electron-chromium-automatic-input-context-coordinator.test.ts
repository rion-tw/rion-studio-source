import type {
  CoreEffectDispatchReport,
  CoreEffectRequest,
  CoreEffectResult
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  ChromiumAutomaticInputContextCoordinator
} from "../src/electron/main/chromiumAutomaticInputContextCoordinator";
import { RionBridgeError } from "../src/electron/ipc/errors";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from "../src/electron/main/chromiumRoleSurfaceRegistry";

function identity(frameToken = "document-1"): ChromiumRoleOverlayFrameIdentity {
  return {
    roleId: "role-1",
    generation: 7,
    frame: {},
    frameToken,
    documentInstanceId: frameToken
  };
}

function effect(): CoreEffectRequest {
  return {
    effectId: "effect-1",
    operationId: "operation-1",
    target: { kind: "webContents", handleId: "role-1" },
    completionPolicy: "deadlineBound",
    deadlineMs: 2_000,
    action: {
      type: "browserAction",
      request: {
        requestId: "recovery-1",
        roleId: "role-1",
        origin: "macro",
        inputEpoch: 4,
        intent: "normal",
        scheduledAtMs: 1_000,
        deadlineMs: 2_000,
        action: { type: "focus" }
      }
    }
  };
}

const failedResult: CoreEffectResult = {
  effectId: "effect-1",
  operationId: "operation-1",
  ok: false,
  valueJson: null,
  error: {
    code: "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED",
    message: "Embedded frame owns input."
  }
};

const indeterminateResult: CoreEffectResult = {
  ...failedResult,
  error: {
    code: "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
    message: "Native acknowledgement is unknown."
  }
};

const accepted: CoreEffectDispatchReport = {
  accepted: ["effect-1"],
  duplicate: [],
  late: [],
  unknown: [],
  operationMismatch: []
};

function harness() {
  let lifecycle: ((event: ChromiumRoleOverlayLifecycleEvent) => void) | null = null;
  const inspectRecovery = vi.fn(async () => ({
    recoveryId: "recovery-1",
    roleId: "role-1",
    inputEpoch: 5,
    pendingMacroRestartCount: 1
  }));
  const drainInput = vi.fn(async () => ({
    roleId: "role-1",
    inputEpoch: 5,
    current: true
  }));
  const completeRecovery = vi.fn(async () => ({
    recoveryId: "recovery-1",
    roleId: "role-1",
    inputEpoch: 5,
    deferredCount: 0,
    restartedCount: 1,
    skippedCount: 0,
    terminal: true
  }));
  const neutralizeRecovery = vi.fn(async () => ({
    recoveryId: "recovery-1",
    roleId: "role-1",
    inputEpoch: 5,
    neutralized: true,
    requestIds: ["neutralize-1"]
  }));
  let resolveFailureObserved!: () => void;
  const failureObserved = new Promise<void>((resolve) => {
    resolveFailureObserved = resolve;
  });
  const failRecovery = vi.fn(async () => {
    resolveFailureObserved();
    return {
      recoveryId: "recovery-1",
      roleId: "role-1",
      inputEpoch: 5,
      failed: true,
      restartRequired: true
    };
  });
  const onError = vi.fn();
  const resumeNativeAfterDocumentReplacement = vi.fn(async () => true);
  const retireManagedShortcuts = vi.fn(async () => undefined);
  const coordinator = new ChromiumAutomaticInputContextCoordinator({
    core: {
      inspectRecovery,
      drainInput,
      completeRecovery,
      neutralizeRecovery,
      failRecovery
    },
    surfaces: {
      subscribeOverlayLifecycle: (listener) => {
        lifecycle = listener;
        return () => { lifecycle = null; };
      }
    },
    resumeNativeAfterDocumentReplacement,
    retireManagedShortcuts,
    onError
  });
  return {
    coordinator,
    inspectRecovery,
    drainInput,
    completeRecovery,
    neutralizeRecovery,
    failRecovery,
    failureObserved,
    onError,
    retireManagedShortcuts,
    resumeNativeAfterDocumentReplacement,
    emitLifecycle: (event: ChromiumRoleOverlayLifecycleEvent) => lifecycle?.(event)
  };
}

function context(target: "document" | "embedded-frame" | "game", revision: number) {
  return {
    type: "game-input-context",
    documentInstanceId: "document-1",
    revision,
    target
  };
}

describe("Electron Chromium automatic-input context coordinator", () => {
  it("joins blocked input to the exact Core ticket and completes only on the same game document", async () => {
    const test = harness();
    await expect(test.coordinator.observe(identity(), context("embedded-frame", 1)))
      .resolves.toMatchObject({ status: "accepted", target: "embedded-frame" });
    expect(() => test.coordinator.preflight("role-1", 7)).toThrowError(
      expect.objectContaining({ code: "SYSTEM_AUTOMATIC_INPUT_CONTEXT_BLOCKED" })
    );

    await test.coordinator.afterEffectDispatch(effect(), failedResult, accepted);
    expect(test.inspectRecovery).toHaveBeenCalledWith({
      recoveryId: "recovery-1",
      roleId: "role-1",
      expectedInputEpoch: 5
    });
    expect(test.drainInput).toHaveBeenCalledWith({ roleId: "role-1", inputEpoch: 5 });
    expect(test.retireManagedShortcuts).not.toHaveBeenCalled();
    expect(test.completeRecovery).not.toHaveBeenCalled();

    await expect(test.coordinator.observe(identity(), context("game", 2)))
      .resolves.toMatchObject({ status: "accepted", target: "game" });
    expect(test.completeRecovery).toHaveBeenCalledWith(expect.objectContaining({
      recoveryId: "recovery-1",
      roleId: "role-1",
      expectedInputEpoch: 5,
      surfaceGeneration: 7,
      documentInstanceId: "document-1"
    }));
    expect(test.failRecovery).not.toHaveBeenCalled();
  });

  it("supersedes stale observations and fails recovery when the exact document retires", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("embedded-frame", 2));
    await expect(test.coordinator.observe(identity(), context("game", 1)))
      .resolves.toMatchObject({ status: "superseded" });
    await expect(test.coordinator.observe(
      identity("document-2"),
      { ...context("game", 3), documentInstanceId: "document-1" }
    )).rejects.toMatchObject({ code: "ELECTRON_AUTOMATIC_INPUT_CONTEXT_INVALID" });

    await test.coordinator.afterEffectDispatch(effect(), failedResult, accepted);
    test.emitLifecycle({
      roleId: "role-1",
      generation: 7,
      reason: "document-superseded"
    });
    await test.failureObserved;
    expect(test.failRecovery).toHaveBeenCalledWith(expect.objectContaining({
      recoveryId: "recovery-1",
      roleId: "role-1",
      expectedInputEpoch: 5,
      message: "The Chromium input document changed before recovery completed."
    }));
    expect(test.completeRecovery).not.toHaveBeenCalled();
  });

  it("treats a stale ticket after neutralization failure as cancellation without a shell error", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("game", 1));
    test.failRecovery.mockRejectedValueOnce(new RionBridgeError({
      code: "MACRO_INPUT_RECOVERY_STALE",
      message: "The Role close retired this recovery ticket."
    }));
    test.neutralizeRecovery.mockRejectedValueOnce(new Error("surface retired"));

    await expect(test.coordinator.afterEffectDispatch(
      effect(),
      indeterminateResult,
      accepted
    )).rejects.toThrow("surface retired");

    expect(test.failRecovery).toHaveBeenCalledOnce();
    expect(test.onError).not.toHaveBeenCalled();
    expect(test.completeRecovery).not.toHaveBeenCalled();
  });

  it("marks Core restart-required when drain completion is not authoritative", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("embedded-frame", 1));
    test.drainInput.mockRejectedValueOnce(new Error("binding closed"));

    await expect(test.coordinator.afterEffectDispatch(effect(), failedResult, accepted))
      .rejects.toThrow("binding closed");
    expect(test.failRecovery).toHaveBeenCalledWith(expect.objectContaining({
      recoveryId: "recovery-1",
      expectedInputEpoch: 5
    }));
    await test.coordinator.observe(identity(), context("game", 2));
    expect(test.completeRecovery).not.toHaveBeenCalled();
  });

  it("accepts an exact deferred multi-role receipt without failing or replaying the role", async () => {
    const test = harness();
    test.completeRecovery.mockResolvedValueOnce({
      recoveryId: "recovery-1",
      roleId: "role-1",
      inputEpoch: 5,
      deferredCount: 1,
      restartedCount: 0,
      skippedCount: 0,
      terminal: false
    });
    await test.coordinator.observe(identity(), context("embedded-frame", 1));
    await test.coordinator.afterEffectDispatch(effect(), failedResult, accepted);

    await expect(test.coordinator.observe(identity(), context("game", 2)))
      .resolves.toMatchObject({ status: "accepted" });
    await expect(test.coordinator.observe(identity(), context("game", 3)))
      .resolves.toMatchObject({ status: "accepted" });
    expect(test.completeRecovery).toHaveBeenCalledOnce();
    expect(test.failRecovery).not.toHaveBeenCalled();
  });

  it("completes indeterminate native input from explicit neutralization, not a game event", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("game", 1));
    await test.coordinator.afterEffectDispatch(effect(), indeterminateResult, accepted);

    expect(test.neutralizeRecovery).toHaveBeenCalledWith(expect.objectContaining({
      recoveryId: "recovery-1",
      expectedInputEpoch: 5,
      surfaceGeneration: 7,
      documentInstanceId: "document-1"
    }));
    expect(test.completeRecovery).toHaveBeenCalledOnce();
    await test.coordinator.observe(identity(), context("game", 2));
    expect(test.completeRecovery).toHaveBeenCalledOnce();
    expect(test.resumeNativeAfterDocumentReplacement).not.toHaveBeenCalled();
  });

  it("joins a Core-deadline late indeterminate result to its already-open recovery ticket", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("game", 1));
    await test.coordinator.afterEffectDispatch(effect(), indeterminateResult, {
      accepted: [],
      duplicate: [],
      late: ["effect-1"],
      unknown: [],
      operationMismatch: []
    });

    expect(test.inspectRecovery).toHaveBeenCalledWith({
      recoveryId: "recovery-1",
      roleId: "role-1",
      expectedInputEpoch: 5
    });
    expect(test.drainInput).toHaveBeenCalledWith({ roleId: "role-1", inputEpoch: 5 });
  });

  it("accepts Core supersede when a newer role terminal state retired the recovery ticket", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("game", 1));
    test.inspectRecovery.mockRejectedValueOnce(new RionBridgeError({
      code: "MACRO_INPUT_RECOVERY_STALE",
      message: "A newer navigation terminalized the role."
    }));

    await expect(test.coordinator.afterEffectDispatch(
      effect(),
      indeterminateResult,
      accepted
    )).resolves.toBeUndefined();
    expect(test.drainInput).not.toHaveBeenCalled();
    expect(test.failRecovery).not.toHaveBeenCalled();
  });

  it("uses only an exact cached neutral cleanup proof and otherwise neutralizes", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("game", 1));
    await test.coordinator.observeNeutralityProof({
      kind: "cleanup-neutral",
      requestId: "cleanup-wrong-epoch",
      roleId: "role-1",
      inputEpoch: 4,
      surfaceGeneration: 7
    });
    await test.coordinator.afterEffectDispatch(effect(), indeterminateResult, accepted);
    expect(test.neutralizeRecovery).toHaveBeenCalledOnce();
    expect(test.completeRecovery).toHaveBeenCalledOnce();

    const exact = harness();
    await exact.coordinator.observe(identity(), context("game", 1));
    await exact.coordinator.observeNeutralityProof({
      kind: "cleanup-neutral",
      requestId: "recovery-1",
      roleId: "role-1",
      inputEpoch: 5,
      surfaceGeneration: 7
    });
    await exact.coordinator.afterEffectDispatch(effect(), indeterminateResult, accepted);
    expect(exact.neutralizeRecovery).not.toHaveBeenCalled();
    expect(exact.completeRecovery).toHaveBeenCalledOnce();
  });

  it("marks restart-required without navigating when explicit neutralization fails", async () => {
    const test = harness();
    await test.coordinator.observe(identity(), context("game", 1));
    test.neutralizeRecovery.mockRejectedValueOnce(new Error("neutrality unknown"));
    await expect(test.coordinator.afterEffectDispatch(
      effect(), indeterminateResult, accepted
    )).rejects.toThrow("neutrality unknown");
    expect(test.failRecovery).toHaveBeenCalledOnce();
    test.emitLifecycle({
      roleId: "role-1",
      generation: 7,
      reason: "document-superseded"
    });

    await test.coordinator.observe(identity("document-2"), {
      type: "game-input-context",
      documentInstanceId: "document-2",
      revision: 1,
      target: "document"
    });
    expect(test.resumeNativeAfterDocumentReplacement).not.toHaveBeenCalled();
    expect(test.completeRecovery).not.toHaveBeenCalled();
  });

  it("waits event-bound for the exact replacement game context", async () => {
    const test = harness();
    const waiting = test.coordinator.waitForExactGameContext({
      documentInstanceId: "document-2",
      roleId: "role-1",
      surfaceGeneration: 7
    });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await test.coordinator.observe(identity("document-2"), {
      type: "game-input-context",
      documentInstanceId: "document-2",
      revision: 1,
      target: "game"
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await test.coordinator.establishReloadDocumentChallenge(
      identity("document-2"),
      {
        documentInstanceId: "document-2",
        revision: 2,
        target: "game"
      }
    );
    await expect(waiting).resolves.toBeUndefined();
    await expect(test.coordinator.waitForExactGameContext({
      documentInstanceId: "document-2",
      roleId: "role-1",
      surfaceGeneration: 7
    })).resolves.toBeUndefined();

    const retired = test.coordinator.waitForExactGameContext({
      documentInstanceId: "document-3",
      roleId: "role-1",
      surfaceGeneration: 7
    });
    test.emitLifecycle({
      roleId: "role-1",
      generation: 7,
      reason: "surface-retired"
    });
    await expect(retired).rejects.toMatchObject({
      code: "ELECTRON_AUTOMATIC_INPUT_SURFACE_RETIRED"
    });
  });
});
