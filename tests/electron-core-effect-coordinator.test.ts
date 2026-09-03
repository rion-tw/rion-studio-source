import type {
  CoreEffectDispatchReport,
  CoreEffectRequest,
  CoreEvent
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  CoreEffectCoordinator,
  createCoreEffectProcessReceiptLedger,
  type CoreEffectProcessReceiptLedger,
  type ElectronCoreEffectPort
} from "../src/electron/main/coreEffectCoordinator";
import type { CoreEventStreamFailure } from
  "../src/electron/core/coreAddonClient";
import {
  coreEffectEventContinuation,
  type CoreEffectExecutionContext
} from
  "../src/electron/main/coreEffectContinuation";
import { RionBridgeError } from "../src/electron/ipc/errors";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function effect(
  effectId: string,
  handleId: string,
  completionPolicy: "deadlineBound" | "eventBound" = "deadlineBound",
  targetKind: CoreEffectRequest["target"]["kind"] = "webContents"
): CoreEffectRequest {
  return {
    effectId,
    operationId: `operation-${effectId}`,
    target: { kind: targetKind, handleId },
    completionPolicy,
    ...(completionPolicy === "deadlineBound" ? { deadlineMs: 10_000 } : {}),
    action: { type: "embeddedDestroyRole", roleId: handleId }
  };
}

function destructiveEffect(effectId: string, roleId: string): CoreEffectRequest {
  const request = effect(effectId, roleId, "deadlineBound", "app");
  request.action = {
    type: "roleBrowserDataClearSession",
    roleId,
    webview2UserDataDir: `/roles/${roleId}/browser/system-webview/webview2`,
    webkitDataStoreIdentifier: roleId
  };
  return request;
}

function accepted(effectId: string): CoreEffectDispatchReport {
  return {
    accepted: [effectId],
    duplicate: [],
    late: [],
    unknown: [],
    operationMismatch: []
  };
}

function reloadEffect(
  phase: "prepare" | "commit" | "supersede",
  operationId = "reload-operation"
): CoreEffectRequest {
  const common = {
    effectId: `reload-${phase}`,
    operationId,
    target: { kind: "app" as const, handleId: "tab-1" },
    completionPolicy: "eventBound" as const
  };
  if (phase === "prepare") {
    return {
      ...common,
      action: {
        type: "embeddedPrepareTabRoleReload",
        reloadOperationId: operationId,
        tabId: "tab-1",
        windowId: "window-1",
        windowGeneration: 1,
        topologyRevision: 1,
        lifecycleEpoch: 1,
        roles: []
      }
    };
  }
  if (phase === "commit") {
    return {
      ...common,
      action: {
        type: "embeddedCommitTabRoleReload",
        reloadOperationId: operationId,
        tabId: "tab-1",
        windowId: "window-1",
        windowGeneration: 1,
        topologyRevision: 1,
        lifecycleEpoch: 1,
        roles: [],
        managedShortcutRetirements: []
      }
    };
  }
  return {
    ...common,
    action: {
      type: "embeddedSupersedeTabRoleReload",
      reloadOperationId: operationId,
      tabId: "tab-1",
      roleIds: [],
      managedShortcutRetirements: [],
      reason: "coreCancelled"
    }
  };
}

function harness(
  execute: (
    effect: CoreEffectRequest,
    context: CoreEffectExecutionContext
  ) => Promise<unknown>,
  afterDispatch?: ConstructorParameters<typeof CoreEffectCoordinator>[0]["afterDispatch"],
  processReceiptLedger: CoreEffectProcessReceiptLedger =
    createCoreEffectProcessReceiptLedger()
) {
  let listener: ((event: CoreEvent) => void) | undefined;
  let failureListener: ((failure: CoreEventStreamFailure) => void) | undefined;
  const unsubscribe = vi.fn();
  const unsubscribeFailure = vi.fn();
  const dispatchCoreEffectResults = vi.fn(async (results) => accepted(results[0]!.effectId));
  const core: ElectronCoreEffectPort = {
    subscribeCoreEvents: (next) => {
      listener = next;
      return unsubscribe;
    },
    subscribeCoreEventStreamFailures: (next) => {
      failureListener = next;
      return unsubscribeFailure;
    },
    dispatchCoreEffectResults
  };
  const onError = vi.fn();
  const onEventStreamFailure = vi.fn();
  const coordinator = new CoreEffectCoordinator({
    core,
    processReceiptLedger,
    execute,
    ...(afterDispatch ? { afterDispatch } : {}),
    onEventStreamFailure,
    onError
  });
  coordinator.start();
  return {
    coordinator,
    dispatchCoreEffectResults,
    emit: (event: CoreEvent) => listener?.(event),
    fail: (drained = Promise.resolve(), error = {
      code: "CORE_EVENT_STREAM_CLOSED",
      message: "The authoritative Core event stream closed unexpectedly."
    }) => failureListener?.({
      type: "eventStreamFailure", error, drained
    }),
    onEventStreamFailure,
    onError,
    unsubscribe,
    unsubscribeFailure
  };
}

describe("Electron Core effect coordinator", () => {
  it("settles a projection fence only after current native work and its Core acknowledgement", async () => {
    const native = deferred<unknown>();
    const postDispatch = deferred<void>();
    const test = harness(
      async () => native.promise,
      async () => postDispatch.promise
    );
    test.emit({
      type: "coreEffects",
      effects: [effect("effect-1", "tab-1", "deadlineBound", "app")]
    });

    let settled = false;
    const fence = test.coordinator.settleCurrentProjectionEffects().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    native.resolve({ projected: true });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);

    postDispatch.resolve();
    await fence;
    expect(settled).toBe(true);
    await test.coordinator.dispose();
  });

  it("does not hold the projection fence for a long-lived non-projection effect", async () => {
    const terminal = deferred<unknown>();
    const test = harness(async () => terminal.promise);
    const overlay = effect("overlay-effect", "tab-1", "eventBound", "app");
    overlay.action = {
      type: "embeddedInstallOverlays",
      roleIds: ["role-1"]
    };
    test.emit({ type: "coreEffects", effects: [overlay] });
    await Promise.resolve();

    await expect(test.coordinator.settleCurrentProjectionEffects())
      .resolves.toBe(0);
    expect(test.dispatchCoreEffectResults).not.toHaveBeenCalled();

    terminal.resolve(undefined);
    await test.coordinator.dispose();
  });

  it("fences native AppKit callbacks behind the current application effect acknowledgement", async () => {
    const terminal = deferred<unknown>();
    const test = harness(async () => terminal.promise);
    const load = effect("load-effect", "tab-1", "deadlineBound", "app");
    load.action = { type: "embeddedLoadRoles", roles: [] };
    test.emit({ type: "coreEffects", effects: [load] });
    await Promise.resolve();

    let settled = false;
    const fence = test.coordinator.settleCurrentApplicationEffects().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    terminal.resolve(undefined);
    await fence;
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    await test.coordinator.dispose();
  });

  it("waits for a future projection effect instead of scanning for native change", async () => {
    const test = harness(async () => undefined);
    let settled = false;
    const future = test.coordinator.waitForProjectionAfter(0).then((sequence) => {
      settled = true;
      return sequence;
    });
    test.emit({
      type: "coreEffects",
      effects: [{
        ...effect("overlay-effect", "tab-1", "eventBound", "app"),
        action: { type: "embeddedInstallOverlays", roleIds: ["role-1"] }
      }]
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    test.emit({
      type: "coreEffects",
      effects: [effect("projection-effect", "tab-1", "deadlineBound", "app")]
    });
    await expect(future).resolves.toBe(1);
    await test.coordinator.dispose();
  });

  it("runs post-dispatch recovery work only after Core accepts the exact result", async () => {
    const order: string[] = [];
    const afterDispatch = vi.fn(async () => { order.push("post-dispatch"); });
    const test = harness(async () => {
      order.push("execute");
      return { applied: true };
    }, afterDispatch);
    test.dispatchCoreEffectResults.mockImplementation(async (results) => {
      order.push("core-accepted");
      return accepted(results[0]!.effectId);
    });
    test.emit({ type: "coreEffects", effects: [effect("effect-1", "role-1")] });

    await vi.waitFor(() => expect(afterDispatch).toHaveBeenCalledOnce());
    await test.coordinator.dispose();
    expect(order).toEqual(["execute", "core-accepted", "post-dispatch"]);
    expect(afterDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ effectId: "effect-1" }),
      expect.objectContaining({ effectId: "effect-1", ok: true }),
      accepted("effect-1")
    );
  });

  it("serializes effects for one native target while independent targets continue", async () => {
    const first = deferred<unknown>();
    const execute = vi.fn((next: CoreEffectRequest) =>
      next.effectId === "effect-1" ? first.promise : Promise.resolve(next.effectId)
    );
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [
        effect("effect-1", "role-1"),
        effect("effect-2", "role-1"),
        effect("effect-3", "role-2")
      ]
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(execute.mock.calls.map(([request]) => request.effectId)).toEqual([
      "effect-1",
      "effect-3"
    ]);

    first.resolve({ loaded: true });
    await first.promise;
    await test.coordinator.dispose();
    expect(execute.mock.calls.map(([request]) => request.effectId)).toEqual([
      "effect-1",
      "effect-3",
      "effect-2"
    ]);
  });

  it("serializes every app-topology effect even when Core receipt handles differ", async () => {
    const first = deferred<unknown>();
    const execute = vi.fn((next: CoreEffectRequest) =>
      next.effectId === "effect-1" ? first.promise : Promise.resolve()
    );
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [
        effect("effect-1", "tab-1", "deadlineBound", "app"),
        effect("effect-2", "tab-2", "deadlineBound", "app")
      ]
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    first.resolve(undefined);
    await test.coordinator.dispose();
    expect(execute.mock.calls.map(([request]) => request.effectId)).toEqual([
      "effect-1",
      "effect-2"
    ]);
  });

  it("releases the app mutation lane while an authoritative event continuation is pending", async () => {
    const nativeEvent = deferred<unknown>();
    const cancel = vi.fn(() => nativeEvent.reject(new Error("cancelled")));
    const execute = vi.fn(async (next: CoreEffectRequest) =>
      next.effectId === "effect-1"
        ? coreEffectEventContinuation(nativeEvent.promise, cancel)
        : next.effectId
    );
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [
        effect("effect-1", "tab-1", "eventBound", "app"),
        effect("effect-2", "tab-2", "deadlineBound", "app")
      ]
    });
    await vi.waitFor(() => {
      expect(execute.mock.calls.map(([request]) => request.effectId)).toEqual([
        "effect-1",
        "effect-2"
      ]);
    });
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({ effectId: "effect-2", ok: true })
    ]);
    expect(test.dispatchCoreEffectResults).not.toHaveBeenCalledWith([
      expect.objectContaining({ effectId: "effect-1" })
    ]);

    nativeEvent.resolve({ focused: true });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
        expect.objectContaining({ effectId: "effect-1", ok: true })
      ]);
    });
    await test.coordinator.dispose();
    expect(cancel).not.toHaveBeenCalled();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: "effect-1",
        ok: true,
        valueJson: '{"focused":true}'
      })
    ]);
  });

  it("cancels pending event continuations before draining the coordinator", async () => {
    const nativeEvent = deferred<unknown>();
    const cancel = vi.fn(() => nativeEvent.reject(new Error("actor stopped")));
    const test = harness(async () =>
      coreEffectEventContinuation(nativeEvent.promise, cancel)
    );
    test.emit({
      type: "coreEffects",
      effects: [effect("effect-1", "tab-1", "eventBound", "app")]
    });
    await Promise.resolve();
    await Promise.resolve();

    await test.coordinator.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith("actorStop");
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: "effect-1",
        ok: false,
        error: expect.objectContaining({ code: "ELECTRON_CORE_EFFECT_ACTOR_STOPPED" })
      })
    ]);
  });

  it("aborts an in-flight promise executor before waiting for shutdown drain", async () => {
    let observedSignal: AbortSignal | undefined;
    const execute = vi.fn((
      _effect: CoreEffectRequest,
      context: CoreEffectExecutionContext
    ) => {
      observedSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          reject(new Error("native helper exited and released its reservation"));
        }, { once: true });
      });
    });
    const test = harness(execute);
    const clearEffect = effect(
      "plain-promise",
      "role-1",
      "deadlineBound",
      "app"
    );
    clearEffect.action = {
      type: "roleBrowserDataClearSession",
      roleId: "role-1",
      webview2UserDataDir: "/roles/role-1/browser/system-webview/webview2",
      webkitDataStoreIdentifier: "role-1"
    };
    test.emit({
      type: "coreEffects",
      effects: [clearEffect]
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await test.coordinator.dispose();
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe("actorStop");
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: "plain-promise",
        ok: false,
        error: expect.objectContaining({
          code: "ELECTRON_CORE_EFFECT_ACTOR_STOPPED"
        })
      })
    ]);
  });

  it("terminalizes every pending executor only after event-stream failure cleanup", async () => {
    const helperTerminal = deferred<void>();
    const coreCleanup = deferred<void>();
    const continuationTerminal = deferred<unknown>();
    const continuationCancel = vi.fn();
    let helperSignal: AbortSignal | undefined;
    const execute = vi.fn((next: CoreEffectRequest, context: CoreEffectExecutionContext) => {
      if (next.effectId === "helper-effect") {
        helperSignal = context.signal;
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            void helperTerminal.promise.then(() => {
              reject(new Error("native helper exited and released its reservation"));
            });
          }, { once: true });
        });
      }
      return Promise.resolve(coreEffectEventContinuation(
        continuationTerminal.promise,
        continuationCancel
      ));
    });
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [
        effect("helper-effect", "role-1", "eventBound"),
        effect("continuation-effect", "role-2", "eventBound")
      ]
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    test.fail(coreCleanup.promise);
    test.fail();
    expect(test.onEventStreamFailure).toHaveBeenCalledOnce();
    const terminal = test.onEventStreamFailure.mock.calls[0]?.[0];
    expect(terminal).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: "CORE_EVENT_STREAM_CLOSED" }),
      drained: expect.any(Promise)
    }));
    expect(helperSignal?.aborted).toBe(true);
    expect(helperSignal?.reason).toBe("eventStreamFailure");
    expect(continuationCancel).toHaveBeenCalledOnce();
    expect(continuationCancel).toHaveBeenCalledWith("eventStreamFailure");
    expect(test.dispatchCoreEffectResults).not.toHaveBeenCalled();

    helperTerminal.resolve();
    await helperTerminal.promise;
    await Promise.resolve();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(1);

    continuationTerminal.resolve({ appliedAfterFailure: true });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(2);
    });
    let fatalDrainFinished = false;
    void terminal?.drained.then(() => { fatalDrainFinished = true; });
    await Promise.resolve();
    expect(fatalDrainFinished).toBe(false);
    coreCleanup.resolve();
    await terminal?.drained;
    await test.coordinator.dispose();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(2);
    expect(test.dispatchCoreEffectResults.mock.calls.map(([results]) => results[0]))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          effectId: "helper-effect",
          ok: false,
          error: expect.objectContaining({
            code: "ELECTRON_CORE_EFFECT_EVENT_STREAM_FAILED"
          })
        }),
        expect.objectContaining({
          effectId: "continuation-effect",
          ok: false,
          error: expect.objectContaining({
            code: "ELECTRON_CORE_EFFECT_EVENT_STREAM_FAILED"
          })
        })
      ]));
    expect(test.dispatchCoreEffectResults).not.toHaveBeenCalledWith([
      expect.objectContaining({ effectId: "continuation-effect", ok: true })
    ]);
    expect(test.onError).toHaveBeenCalledOnce();
    expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "CORE_EVENT_STREAM_CLOSED"
    }));
    expect(test.unsubscribe).toHaveBeenCalledOnce();
    expect(test.unsubscribeFailure).toHaveBeenCalledOnce();
  });

  it("routes fatal terminality even when one continuation cancel callback throws", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const cancellationFailure = new Error("native cancellation callback failed");
    const firstCancel = vi.fn(() => {
      throw cancellationFailure;
    });
    const secondCancel = vi.fn(() => second.reject(new Error("cancelled")));
    const execute = vi.fn(async (next: CoreEffectRequest) => coreEffectEventContinuation(
      next.effectId === "first" ? first.promise : second.promise,
      next.effectId === "first" ? firstCancel : secondCancel
    ));
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [
        effect("first", "role-1", "eventBound"),
        effect("second", "role-2", "eventBound")
      ]
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(() => test.fail()).not.toThrow();
    expect(test.onEventStreamFailure).toHaveBeenCalledOnce();
    expect(firstCancel).toHaveBeenCalledWith("eventStreamFailure");
    expect(secondCancel).toHaveBeenCalledWith("eventStreamFailure");
    const terminal = test.onEventStreamFailure.mock.calls[0]?.[0];
    await expect(terminal?.drained).rejects.toBe(cancellationFailure);
    await expect(test.coordinator.dispose()).rejects.toBe(cancellationFailure);
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(2);
  });

  it("drains effect cleanup even when event unsubscribe throws", async () => {
    const completion = deferred<unknown>();
    const cancel = vi.fn(() => completion.reject(new Error("cancelled")));
    const unsubscribeFailure = new Error("event unsubscribe failed");
    const test = harness(async () => coreEffectEventContinuation(
      completion.promise,
      cancel
    ));
    test.unsubscribe.mockImplementationOnce(() => {
      throw unsubscribeFailure;
    });
    test.emit({
      type: "coreEffects",
      effects: [effect("effect-1", "role-1", "eventBound")]
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(() => test.fail()).not.toThrow();
    const terminal = test.onEventStreamFailure.mock.calls[0]?.[0];
    await expect(terminal?.drained).rejects.toBe(unsubscribeFailure);
    expect(cancel).toHaveBeenCalledWith("eventStreamFailure");
    expect(test.unsubscribeFailure).toHaveBeenCalledOnce();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: "effect-1",
        ok: false,
        error: expect.objectContaining({
          code: "ELECTRON_CORE_EFFECT_EVENT_STREAM_FAILED"
        })
      })
    ]);
  });

  it("cancels only the exact pending continuation named by Core", async () => {
    const nativeEvent = deferred<unknown>();
    const cancel = vi.fn(() => nativeEvent.reject(new Error("core cancelled")));
    const execute = vi.fn(async () =>
      coreEffectEventContinuation(nativeEvent.promise, cancel)
    );
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [effect("effect-1", "tab-1", "eventBound", "app")]
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await Promise.resolve();
    test.emit({
      type: "coreEffectCancellations",
      cancellations: [{
        effectId: "effect-1",
        operationId: "operation-effect-1",
        reason: "operationCancelled"
      }]
    });

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("coreCancelled"));
    await test.coordinator.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: "effect-1",
        ok: false,
        error: expect.objectContaining({ code: "CHROMIUM_RUNTIME_EFFECT_CANCELLED" })
      })
    ]);
  });

  it("isolates a throwing continuation cancel callback from the Core event listener", async () => {
    const nativeEvent = deferred<unknown>();
    const cancellationFailure = new Error("native cancellation callback failed");
    const cancel = vi.fn(() => {
      throw cancellationFailure;
    });
    const test = harness(async () =>
      coreEffectEventContinuation(nativeEvent.promise, cancel)
    );
    test.emit({
      type: "coreEffects",
      effects: [effect("effect-1", "tab-1", "eventBound", "app")]
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(() => test.emit({
      type: "coreEffectCancellations",
      cancellations: [{
        effectId: "effect-1",
        operationId: "operation-effect-1",
        reason: "operationCancelled"
      }]
    })).not.toThrow();

    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
        expect.objectContaining({
          effectId: "effect-1",
          ok: false,
          error: expect.objectContaining({
            code: "CHROMIUM_RUNTIME_EFFECT_CANCELLED"
          })
        })
      ]);
    });
    expect(test.onEventStreamFailure).not.toHaveBeenCalled();
    expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CORE_EFFECT_CANCELLATION_FAILED"
    }));
    await expect(test.coordinator.dispose()).rejects.toBe(cancellationFailure);
  });

  it("keeps fatal terminality isolated when both failure observers throw", async () => {
    const test = harness(async () => undefined);
    test.onEventStreamFailure.mockImplementation(() => {
      throw new Error("fatal observer failed");
    });
    test.onError.mockImplementation(() => {
      throw new Error("error observer failed");
    });

    expect(() => test.fail()).not.toThrow();
    expect(test.onEventStreamFailure).toHaveBeenCalledOnce();
    const terminal = test.onEventStreamFailure.mock.calls[0]?.[0];
    await expect(terminal?.drained).resolves.toBeUndefined();
    expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CORE_EVENT_STREAM_FAILURE_HANDLER_FAILED"
    }));
    await expect(test.coordinator.dispose()).resolves.toBeUndefined();
  });

  it("rejects an operation-mismatched cancellation without cancelling any effect", async () => {
    const nativeEvent = deferred<unknown>();
    const cancel = vi.fn();
    const execute = vi.fn(async () =>
      coreEffectEventContinuation(nativeEvent.promise, cancel)
    );
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [effect("effect-1", "tab-1", "eventBound", "app")]
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await Promise.resolve();
    test.emit({
      type: "coreEffectCancellations",
      cancellations: [{
        effectId: "effect-1",
        operationId: "operation-for-another-effect",
        reason: "operationCancelled"
      }]
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CORE_EFFECT_CANCELLATION_MISMATCH"
    }));
    nativeEvent.resolve({ applied: true });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
        expect.objectContaining({ effectId: "effect-1", ok: true })
      ]);
    });
    await test.coordinator.dispose();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({ effectId: "effect-1", ok: true })
    ]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("maps a Core deadline cancellation onto the exact signal and never commits a late result", async () => {
    const execution = deferred<unknown>();
    let observedSignal: AbortSignal | undefined;
    const execute = vi.fn(async (
      _effect: CoreEffectRequest,
      context: CoreEffectExecutionContext
    ) => {
      observedSignal = context.signal;
      return execution.promise;
    });
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [effect("deadline-effect", "role-1")]
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    test.emit({
      type: "coreEffectCancellations",
      cancellations: [{
        effectId: "deadline-effect",
        operationId: "operation-deadline-effect",
        reason: "deadlineElapsed"
      }]
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe("deadlineElapsed");

    execution.resolve({ applied: true });
    await test.coordinator.dispose();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: "deadline-effect",
        ok: false,
        valueJson: null,
        error: expect.objectContaining({
          code: "ELECTRON_CORE_EFFECT_DEADLINE_ELAPSED"
        })
      })
    ]);
    expect(test.dispatchCoreEffectResults).not.toHaveBeenCalledWith([
      expect.objectContaining({ effectId: "deadline-effect", ok: true })
    ]);
  });

  it("preserves a continuation-owned post-submission terminal classification", async () => {
    const nativeEvent = deferred<unknown>();
    const cancel = vi.fn(() => nativeEvent.reject(new RionBridgeError({
      code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE",
      message: "Native visibility may already have changed."
    })));
    const execute = vi.fn(async () =>
      coreEffectEventContinuation(nativeEvent.promise, cancel)
    );
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [effect("effect-1", "tab-1", "eventBound", "app")]
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await Promise.resolve();
    test.emit({
      type: "coreEffectCancellations",
      cancellations: [{
        effectId: "effect-1",
        operationId: "operation-effect-1",
        reason: "operationCancelled"
      }]
    });

    await test.coordinator.dispose();
    expect(cancel).toHaveBeenCalledWith("coreCancelled");
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: "effect-1",
        ok: false,
        error: expect.objectContaining({
          code: "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE"
        })
      })
    ]);
  });

  it("keeps reload commit behind prepare while control-lane supersede proceeds", async () => {
    const preparation = deferred<unknown>();
    const execute = vi.fn((next: CoreEffectRequest) =>
      next.action.type === "embeddedPrepareTabRoleReload"
        ? preparation.promise
        : Promise.resolve(next.effectId));
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [
        reloadEffect("prepare"),
        reloadEffect("commit"),
        reloadEffect("supersede")
      ]
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(execute.mock.calls.map(([request]) => request.effectId)).toEqual([
      "reload-prepare",
      "reload-supersede"
    ]);

    preparation.resolve({ status: "superseded" });
    await test.coordinator.dispose();
    expect(execute.mock.calls.map(([request]) => request.effectId)).toEqual([
      "reload-prepare",
      "reload-supersede",
      "reload-commit"
    ]);
  });

  it("returns JSON success and coded failures through the authoritative Core acknowledgement", async () => {
    const execute = vi.fn(async (next: CoreEffectRequest) => {
      if (next.effectId === "failed") {
        throw { code: "ELECTRON_NATIVE_FAILED", message: "Native work failed." };
      }
      return { loaded: true };
    });
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [effect("success", "role-1"), effect("failed", "role-2")]
    });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(2);
    });
    await test.coordinator.dispose();

    expect(test.dispatchCoreEffectResults.mock.calls.map(([results]) => results[0]))
      .toEqual(expect.arrayContaining([
        {
          effectId: "success",
          operationId: "operation-success",
          ok: true,
          valueJson: '{"loaded":true}',
          error: null
        },
        {
          effectId: "failed",
          operationId: "operation-failed",
          ok: false,
          valueJson: null,
          error: {
            code: "ELECTRON_NATIVE_FAILED",
            message: "Native work failed."
          }
        }
      ]));
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("re-acknowledges an exact duplicate without repeating native mutation", async () => {
    const execution = deferred<unknown>();
    const execute = vi.fn(async () => execution.promise);
    const test = harness(execute);
    const duplicate = effect("effect-1", "role-1");
    test.emit({ type: "coreEffects", effects: [duplicate, duplicate] });
    await Promise.resolve();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();

    execution.resolve({ applied: true });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(2);
    });
    await test.coordinator.dispose();
    expect(execute).toHaveBeenCalledOnce();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(2);
    expect(test.dispatchCoreEffectResults.mock.calls.map(([results]) => results[0]))
      .toEqual([
        expect.objectContaining({ effectId: "effect-1", ok: true }),
        expect.objectContaining({ effectId: "effect-1", ok: true })
      ]);
  });

  it("retains a destructive receipt after the bounded general ledger is pruned", async () => {
    const execute = vi.fn(async (_effect: CoreEffectRequest) => ({ applied: true }));
    const test = harness(execute);
    const clear = destructiveEffect("destructive-clear", "role-clear");
    const initialDispatches = deferred<void>();
    test.dispatchCoreEffectResults.mockImplementation(async (results) => {
      if (test.dispatchCoreEffectResults.mock.calls.length === 4_097) {
        initialDispatches.resolve();
      }
      return accepted(results[0]!.effectId);
    });
    test.emit({
      type: "coreEffects",
      effects: [
        clear,
        ...Array.from({ length: 4_096 }, (_, index) =>
          effect(`general-${index}`, "shared-target", "deadlineBound", "app"))
      ]
    });
    await initialDispatches.promise;

    const replayDispatch = deferred<void>();
    test.dispatchCoreEffectResults.mockImplementation(async (results) => {
      if (test.dispatchCoreEffectResults.mock.calls.length === 4_098) {
        replayDispatch.resolve();
      }
      return accepted(results[0]!.effectId);
    });
    test.emit({ type: "coreEffects", effects: [clear] });
    await replayDispatch.promise;
    await test.coordinator.dispose();

    expect(execute.mock.calls.filter(([request]) =>
      request.effectId === clear.effectId)).toHaveLength(1);
    expect(test.dispatchCoreEffectResults.mock.calls.at(-1)?.[0][0]).toEqual(
      expect.objectContaining({ effectId: clear.effectId, ok: true })
    );
  });

  it("retains destructive receipts when the coordinator is rebuilt in the same process", async () => {
    const processReceiptLedger = createCoreEffectProcessReceiptLedger();
    const execute = vi.fn(async (_effect: CoreEffectRequest) => ({ applied: true }));
    const clear = destructiveEffect("process-clear", "process-role");
    const first = harness(execute, undefined, processReceiptLedger);
    first.emit({ type: "coreEffects", effects: [clear] });
    await vi.waitFor(() => {
      expect(first.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    });
    await first.coordinator.dispose();

    const second = harness(execute, undefined, processReceiptLedger);
    second.emit({ type: "coreEffects", effects: [clear] });
    await vi.waitFor(() => {
      expect(second.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    });
    await second.coordinator.dispose();

    const third = harness(execute, undefined, processReceiptLedger);
    third.emit({
      type: "coreEffects",
      effects: [destructiveEffect(clear.effectId, "conflicting-process-role")]
    });
    await vi.waitFor(() => {
      expect(third.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    });
    await third.coordinator.dispose();

    expect(execute).toHaveBeenCalledOnce();
    expect(second.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({ effectId: clear.effectId, ok: true })
    ]);
    expect(third.dispatchCoreEffectResults).toHaveBeenCalledWith([
      expect.objectContaining({
        effectId: clear.effectId,
        ok: false,
        error: expect.objectContaining({ code: "ELECTRON_CORE_EFFECT_ID_REUSED" })
      })
    ]);
  });

  it("joins an in-flight destructive receipt across coordinators before either drain completes", async () => {
    const processReceiptLedger = createCoreEffectProcessReceiptLedger();
    const helperCleanup = deferred<void>();
    let helperSignal: AbortSignal | undefined;
    const execute = vi.fn((
      _effect: CoreEffectRequest,
      context: CoreEffectExecutionContext
    ) => {
      helperSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          void helperCleanup.promise.then(() => {
            reject(new Error("native helper released its destructive reservation"));
          });
        }, { once: true });
      });
    });
    const clear = destructiveEffect("process-pending-clear", "process-pending-role");
    const first = harness(execute, undefined, processReceiptLedger);
    const second = harness(execute, undefined, processReceiptLedger);
    first.emit({ type: "coreEffects", effects: [clear] });
    await vi.waitFor(() => expect(helperSignal).toBeDefined());
    second.emit({ type: "coreEffects", effects: [clear] });
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();

    let secondDrained = false;
    const secondDrain = second.coordinator.dispose().then(() => {
      secondDrained = true;
    });
    await Promise.resolve();
    expect(secondDrained).toBe(false);
    const firstDrain = first.coordinator.dispose();
    expect(helperSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(secondDrained).toBe(false);

    helperCleanup.resolve();
    await Promise.all([firstDrain, secondDrain]);
    expect(first.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    expect(second.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    expect(second.dispatchCoreEffectResults.mock.calls[0]?.[0][0]).toEqual(
      first.dispatchCoreEffectResults.mock.calls[0]?.[0][0]
    );
  });

  it("latches destructive capacity and retains exact identities fail closed", async () => {
    const processReceiptLedger = createCoreEffectProcessReceiptLedger();
    const execute = vi.fn(async (_effect: CoreEffectRequest) => ({ applied: true }));
    const test = harness(execute, undefined, processReceiptLedger);
    const retained = destructiveEffect("destructive-0", "role-0");
    const capacityDispatches = deferred<void>();
    test.dispatchCoreEffectResults.mockImplementation(async (results) => {
      if (test.dispatchCoreEffectResults.mock.calls.length === 4_097) {
        capacityDispatches.resolve();
      }
      return accepted(results[0]!.effectId);
    });
    test.emit({
      type: "coreEffects",
      effects: [
        ...Array.from({ length: 4_096 }, (_, index) =>
          destructiveEffect(`destructive-${index}`, `role-${index}`)),
        destructiveEffect("capacity-trigger", "role-capacity-trigger")
      ]
    });
    await capacityDispatches.promise;
    await test.coordinator.dispose();

    const terminalDispatches = deferred<void>();
    const replay = harness(execute, undefined, processReceiptLedger);
    replay.dispatchCoreEffectResults.mockImplementation(async (results) => {
      if (replay.dispatchCoreEffectResults.mock.calls.length === 3) {
        terminalDispatches.resolve();
      }
      return accepted(results[0]!.effectId);
    });
    const conflict = destructiveEffect(retained.effectId, "role-conflict");
    replay.emit({
      type: "coreEffects",
      effects: [
        retained,
        destructiveEffect("capacity-latched", "role-capacity-latched"),
        conflict
      ]
    });
    await terminalDispatches.promise;
    await replay.coordinator.dispose();

    expect(execute).toHaveBeenCalledTimes(4_096);
    const finalResults = replay.dispatchCoreEffectResults.mock.calls
      .map(([results]) => results[0]);
    expect(finalResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectId: retained.effectId, ok: true }),
      expect.objectContaining({
        effectId: "capacity-latched",
        ok: false,
        error: expect.objectContaining({
          code: "ELECTRON_DESTRUCTIVE_EFFECT_REPLAY_CAPACITY"
        })
      }),
      expect.objectContaining({
        effectId: retained.effectId,
        ok: false,
        error: expect.objectContaining({ code: "ELECTRON_CORE_EFFECT_ID_REUSED" })
      })
    ]));
  });

  it("fails closed when one effect identity is reused for a different intent", async () => {
    const execute = vi.fn(async () => undefined);
    const test = harness(execute);
    test.emit({
      type: "coreEffects",
      effects: [
        effect("effect-1", "role-1"),
        effect("effect-1", "role-2")
      ]
    });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledTimes(2);
    });
    await test.coordinator.dispose();

    expect(execute).toHaveBeenCalledOnce();
    expect(test.dispatchCoreEffectResults.mock.calls.map(([results]) => results[0]))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ effectId: "effect-1", ok: true }),
        expect.objectContaining({
          effectId: "effect-1",
          ok: false,
          error: expect.objectContaining({ code: "ELECTRON_CORE_EFFECT_ID_REUSED" })
        })
      ]));
  });

  it("rejects malformed completion policies without starting native work", async () => {
    const execute = vi.fn(async () => undefined);
    const test = harness(execute);
    const malformed = effect("malformed", "role-1", "eventBound");
    malformed.deadlineMs = 1;
    test.emit({ type: "coreEffects", effects: [malformed] });
    await vi.waitFor(() => {
      expect(test.dispatchCoreEffectResults).toHaveBeenCalledOnce();
    });
    await test.coordinator.dispose();

    expect(execute).not.toHaveBeenCalled();
    expect(test.dispatchCoreEffectResults).toHaveBeenCalledWith([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "ELECTRON_CORE_EFFECT_POLICY_INVALID" })
    })]);
  });

  it("reports an acknowledgement identity mismatch and still drains on dispose", async () => {
    const test = harness(async () => undefined);
    test.dispatchCoreEffectResults.mockResolvedValue({
      accepted: [],
      duplicate: [],
      late: [],
      unknown: ["effect-1"],
      operationMismatch: []
    });
    test.emit({ type: "coreEffects", effects: [effect("effect-1", "role-1")] });

    await test.coordinator.dispose();
    expect(test.unsubscribe).toHaveBeenCalledOnce();
    expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CORE_EFFECT_ACK_REJECTED"
    }));
  });
});
