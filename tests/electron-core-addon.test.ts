import { describe, expect, it, vi } from "vitest";

import {
  CoreAddonClient,
  type RawNodeApiCoreBinding
} from "../src/electron/core/coreAddonClient";

type ChromeImportBindingStubs = Omit<RawNodeApiCoreBinding,
  | "invoke"
  | "subscribeCoreEvents"
  | "dispatchCoreEffectResults"
  | "readRoleSessionTransferVaultInternal"
  | "shutdown"
>;

function chromeImportBindingStubs(): ChromeImportBindingStubs {
  return {
    beginRoleSessionMigrationImportInternal: vi.fn(async () => "{}"),
    transitionRoleSessionMigrationTargetInternal: vi.fn(async () => "{}"),
    acquireChromeProfileImportTransactionInternal: vi.fn(async () => "{}"),
    refreshChromeProfileImportTransactionInternal: vi.fn(async () => "{}"),
    readChromeProfileImportPayloadInternal: vi.fn(async () => Buffer.from("{}")),
    writeChromeProfileImportBackupInternal: vi.fn(async () => "{}"),
    readChromeProfileImportBackupInternal: vi.fn(async () => Buffer.from("{}")),
    prepareChromeProfileImportFreshVerificationInternal: vi.fn(async () => Buffer.alloc(32)),
    completeChromeProfileImportFreshVerificationInternal: vi.fn(async () => "{}"),
    commitChromeProfileImportInternal: vi.fn(async () => "{}"),
    verifyChromeProfileImportCommitMarkerInternal: vi.fn(async () => "{}"),
    releaseChromeProfileImportTransactionInternal: vi.fn(async () => undefined),
    recoverPendingChromeProfileImportsInternal: vi.fn(async () =>
      JSON.stringify({ recovered: 0, pending: 0 })
    ),
    launchChromeProfileImportHelperInternal: vi.fn(async () => ({
      outcome: "applied",
      metadataBytes: Buffer.from("{}"),
      secretBytes: Buffer.alloc(0),
      exitEvidenceSha256: "a".repeat(64)
    })),
    beginRoleBrowserDataClearCommandDrain: vi.fn(),
    waitForRoleBrowserDataClearCommandDrain: vi.fn(async () => true),
    invalidateRuntimeRestoreSessionCleanExitInternal: vi.fn(async () => undefined)
  };
}

describe("Electron Core addon client", () => {
  it("fences and proves the split clear-command drain before checked shutdown", async () => {
    const stubs = chromeImportBindingStubs();
    const beginDrain = vi.mocked(stubs.beginRoleBrowserDataClearCommandDrain);
    const waitForDrain = vi.mocked(stubs.waitForRoleBrowserDataClearCommandDrain);
    const shutdown = vi.fn(async () => undefined);
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"), subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...stubs, shutdown
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});

    client.beginRoleBrowserDataClearCommandDrain();
    expect(beginDrain).toHaveBeenCalledOnce();
    await expect(client.waitForRoleBrowserDataClearCommandDrain(30_000))
      .resolves.toBe(true);
    expect(waitForDrain).toHaveBeenCalledWith(30_000);
    waitForDrain.mockResolvedValueOnce(false);
    await expect(client.waitForRoleBrowserDataClearCommandDrain(1)).resolves.toBe(false);
    await expect(client.waitForRoleBrowserDataClearCommandDrain(0)).rejects.toMatchObject({
      code: "ELECTRON_ROLE_BROWSER_DATA_CLEAR_DRAIN_TIMEOUT_INVALID"
    });

    shutdown.mockRejectedValueOnce(new Error(JSON.stringify({
      code: "ROLE_BROWSER_DATA_CLEAR_DRAIN_UNVERIFIED",
      message: "A clear command still owns its role directory."
    })));
    await expect(client.shutdown()).rejects.toMatchObject({
      code: "ROLE_BROWSER_DATA_CLEAR_DRAIN_UNVERIFIED"
    });
  });

  it("parses only the closed Chrome-profile recovery result and decodes Core failures", async () => {
    const stubs = chromeImportBindingStubs();
    const recover = vi.mocked(stubs.recoverPendingChromeProfileImportsInternal);
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...stubs,
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});

    recover.mockResolvedValueOnce(JSON.stringify({ recovered: 2, pending: 1 }));
    await expect(client.recoverPendingChromeProfileImportsInternal()).resolves.toEqual({
      recovered: 2,
      pending: 1
    });

    for (const malformed of [
      { recovered: 0 },
      { recovered: 0, pending: -1 },
      { recovered: 0, pending: 0, callerControlled: true }
    ]) {
      recover.mockResolvedValueOnce(JSON.stringify(malformed));
      await expect(client.recoverPendingChromeProfileImportsInternal())
        .rejects.toMatchObject({
          code: "ELECTRON_CHROME_PROFILE_IMPORT_RECOVERY_INVALID"
        });
    }

    recover.mockRejectedValueOnce(new Error(JSON.stringify({
      code: "CHROME_PROFILE_IMPORT_RECOVERY_FAILED",
      message: "Recovery evidence was not exact."
    })));
    await expect(client.recoverPendingChromeProfileImportsInternal())
      .rejects.toMatchObject({
        code: "CHROME_PROFILE_IMPORT_RECOVERY_FAILED",
        message: "Recovery evidence was not exact."
      });
  });

  it("keeps generated commands typed and drains subscriptions before idempotent shutdown", async () => {
    let emit: ((eventsJson: string) => void) | undefined;
    let fail: ((failureJson: string) => void) | undefined;
    const report = {
      accepted: [],
      duplicate: [],
      late: [],
      unknown: [],
      operationMismatch: []
    };
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async (commandJson) =>
        JSON.parse(commandJson).type === "health" ? JSON.stringify("ok") : "null"
      ),
      subscribeCoreEvents: vi.fn((listener, failureListener) => {
        emit = listener;
        fail = failureListener;
      }),
      dispatchCoreEffectResults: vi.fn(async () => JSON.stringify(report)),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {
      dataDirectory: "/data"
    });

    await expect(client.invoke({ type: "health" })).resolves.toBe("ok");
    expect(binding.subscribeCoreEvents).not.toHaveBeenCalled();
    const listener = vi.fn();
    const failureListener = vi.fn();
    const unsubscribe = client.subscribeCoreEvents(listener);
    const unsubscribeFailure = client.subscribeCoreEventStreamFailures(failureListener);
    expect(binding.subscribeCoreEvents).not.toHaveBeenCalled();
    client.startCoreEventBridge();
    client.startCoreEventBridge();
    expect(binding.subscribeCoreEvents).toHaveBeenCalledOnce();
    emit?.(JSON.stringify([{ type: "shutdown" }]));
    expect(listener).toHaveBeenCalledWith({ type: "shutdown" });
    fail?.(JSON.stringify({
      code: "CORE_EVENT_STREAM_CLOSED",
      message: "The stream closed after normal Shutdown."
    }));
    expect(failureListener).not.toHaveBeenCalled();

    const firstShutdown = client.shutdown();
    const secondShutdown = client.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
    unsubscribe();
    unsubscribeFailure();
    expect(binding.shutdown).toHaveBeenCalledOnce();
    expect(binding.invoke).toHaveBeenCalledWith(JSON.stringify({ type: "health" }));
    await expect(client.invoke({ type: "health" })).rejects.toMatchObject({
      code: "ELECTRON_CORE_STOPPED"
    });
  });

  it("decodes async effect reports and isolates malformed native event batches", async () => {
    let emit: ((eventsJson: string) => void) | undefined;
    let fail: ((failureJson: string) => void) | undefined;
    const onEventBridgeError = vi.fn();
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn((listener, failureListener) => {
        emit = listener;
        fail = failureListener;
      }),
      dispatchCoreEffectResults: vi.fn(async () => JSON.stringify({
        accepted: ["effect-1"],
        duplicate: [],
        late: [],
        unknown: [],
        operationMismatch: []
      })),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create(
      { createAppCore: () => binding },
      {},
      { onEventBridgeError }
    );
    const result = {
      effectId: "effect-1",
      operationId: "operation-1",
      ok: true,
      valueJson: null,
      error: null
    };

    await expect(client.dispatchCoreEffectResults([result])).resolves.toMatchObject({
      accepted: ["effect-1"]
    });
    expect(binding.dispatchCoreEffectResults).toHaveBeenCalledWith(JSON.stringify([result]));

    const eventListener = vi.fn();
    const failureListener = vi.fn();
    client.subscribeCoreEvents(eventListener);
    client.subscribeCoreEventStreamFailures(failureListener);
    client.startCoreEventBridge();
    emit?.("{malformed");
    expect(onEventBridgeError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CORE_EVENT_INVALID"
    }));
    expect(failureListener).toHaveBeenCalledOnce();
    expect(failureListener).toHaveBeenCalledWith({
      type: "eventStreamFailure",
      error: expect.objectContaining({ code: "ELECTRON_CORE_EVENT_INVALID" }),
      drained: expect.any(Promise)
    });

    emit?.(JSON.stringify([{ type: "shutdown" }]));
    fail?.(JSON.stringify({
      code: "CORE_EVENT_STREAM_CLOSED",
      message: "The native stream closed unexpectedly."
    }));
    expect(eventListener).not.toHaveBeenCalled();
    expect(failureListener).toHaveBeenCalledOnce();
    expect(onEventBridgeError).toHaveBeenCalledOnce();
  });

  it("synchronously fences commands after stream loss while preserving cleanup lanes", async () => {
    let fail: ((failureJson: string) => void) | undefined;
    const stubs = chromeImportBindingStubs();
    let finishInvalidation!: () => void;
    vi.mocked(stubs.invalidateRuntimeRestoreSessionCleanExitInternal)
      .mockReturnValueOnce(new Promise<void>((resolve) => { finishInvalidation = resolve; }));
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => JSON.stringify("ok")),
      subscribeCoreEvents: vi.fn((_listener, failureListener) => {
        fail = failureListener;
      }),
      dispatchCoreEffectResults: vi.fn(async () => JSON.stringify({
        accepted: ["effect-1"],
        duplicate: [],
        late: [],
        unknown: [],
        operationMismatch: []
      })),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...stubs,
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});
    const failureListener = vi.fn();
    client.subscribeCoreEvents(vi.fn());
    client.subscribeCoreEventStreamFailures(failureListener);
    client.startCoreEventBridge();

    fail?.(JSON.stringify({
      code: "CORE_EVENT_STREAM_CLOSED",
      message: "The authoritative event stream closed unexpectedly."
    }));
    expect(stubs.invalidateRuntimeRestoreSessionCleanExitInternal).toHaveBeenCalledOnce();
    const terminal = failureListener.mock.calls[0]?.[0];
    let invalidationDrained = false;
    void terminal?.drained.then(() => { invalidationDrained = true; });
    await Promise.resolve();
    expect(invalidationDrained).toBe(false);

    await expect(client.invoke({ type: "health" })).rejects.toMatchObject({
      code: "ELECTRON_CORE_EVENT_STREAM_FAILED"
    });
    expect(binding.invoke).not.toHaveBeenCalled();
    await expect(client.dispatchCoreEffectResults([{
      effectId: "effect-1",
      operationId: "operation-1",
      ok: false,
      valueJson: null,
      error: { code: "EFFECT_FAILED", message: "The effect was terminalized." }
    }])).resolves.toMatchObject({ accepted: ["effect-1"] });
    await expect(client.releaseChromeProfileImportTransactionInternal({
      leaseId: "lease-1",
      roleId: "role-1",
      transactionId: "transaction-1"
    })).resolves.toBeUndefined();
    expect(stubs.releaseChromeProfileImportTransactionInternal).toHaveBeenCalledOnce();
    finishInvalidation();
    await expect(terminal?.drained).resolves.toBeUndefined();
    await client.shutdown();
  });

  it("closed-validates critical effect and cancellation batches before fanout", async () => {
    const malformedBatches = [
      [{
        type: "coreEffects",
        effects: [{
          effectId: "effect-1",
          operationId: "operation-1",
          target: { kind: "webContents", handleId: "role-1" },
          completionPolicy: "eventBound",
          deadlineMs: 10,
          action: { type: "embeddedDestroyRole", roleId: "role-1" }
        }]
      }],
      [{
        type: "coreEffects",
        effects: [{
          effectId: "effect-1",
          operationId: "operation-1",
          target: { kind: "forged", handleId: "role-1" },
          completionPolicy: "eventBound",
          action: { type: "embeddedDestroyRole", roleId: "role-1" }
        }]
      }],
      [{
        type: "coreEffectCancellations",
        cancellations: [{
          effectId: "effect-1",
          operationId: "operation-1",
          reason: "callerControlled",
          ignored: true
        }]
      }],
      [{ type: "ready", schemaVersion: 1, callerControlled: true }],
      [{ type: "logsChanged", callerControlled: true }],
      [{
        type: "logEntriesCaptured",
        entries: [{
          id: "log-1", timestamp: "2026-01-01T00:00:00Z", level: "info",
          source: "main", event: "startup", message: "started", sessionId: "session-1",
          error: { name: "Error", message: "failed", callerControlled: true }
        }]
      }],
      [{
        type: "browserActions",
        actions: [{
          requestId: "request-1", roleId: "role-1", origin: "macro",
          inputEpoch: 1, intent: "normal", scheduledAtMs: 1, deadlineMs: 100,
          action: { type: "focus", callerControlled: true }
        }]
      }],
      [{
        type: "stateChanged",
        revision: 1,
        changedCollections: ["callerControlled"]
      }],
      [{
        type: "browserStatuses",
        statuses: [{
          roleId: "role-1",
          state: "running",
          runtimeMode: "embedded",
          callerControlled: true
        }]
      }],
      [{
        type: "browserLaunchCompleted",
        operationId: "operation-1",
        sourceId: "role-1",
        sourceType: "role",
        tabId: "tab-1",
        ok: true,
        errorCode: 42
      }],
      [{
        type: "macroStatuses",
        reliable: true,
        statuses: [{
          roleId: "role-1",
          macroId: "macro-1",
          state: "running",
          iteration: 1,
          lastClick: { sequence: 1, stepId: "step-1", callerControlled: true },
          startedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          error: null
        }]
      }],
      [{
        type: "coreEffects",
        effects: [{
          effectId: "effect-1",
          operationId: "operation-1",
          target: { kind: "webContents", handleId: "role-1" },
          completionPolicy: "eventBound",
          action: {
            type: "browserAction",
            request: {
              requestId: "request-1",
              roleId: "role-1",
              origin: "macro",
              inputEpoch: 1,
              intent: "normal",
              scheduledAtMs: 1,
              deadlineMs: 100,
              action: { type: "focus", callerControlled: true }
            }
          }
        }]
      }],
      [{ type: "shutdown", callerControlled: true }],
      [{ type: "overlayChanged", roleIds: [""] }],
      [{
        type: "chromeProfileImportProgress",
        progress: {
          importId: "import-1", phase: "applying", completed: 1, total: 2,
          callerControlled: true
        }
      }],
      [{ type: "callerControlledEvent" }]
    ];

    for (const batch of malformedBatches) {
      let emit: ((eventsJson: string) => void) | undefined;
      const binding: RawNodeApiCoreBinding = {
        invoke: vi.fn(async () => "null"),
        subscribeCoreEvents: vi.fn((listener) => { emit = listener; }),
        dispatchCoreEffectResults: vi.fn(async () => "{}"),
        readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
        ...chromeImportBindingStubs(),
        shutdown: vi.fn(async () => undefined)
      };
      const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});
      const eventListener = vi.fn();
      const failureListener = vi.fn();
      client.subscribeCoreEvents(eventListener);
      client.subscribeCoreEventStreamFailures(failureListener);
      client.startCoreEventBridge();
      emit?.(JSON.stringify(batch));
      expect(eventListener).not.toHaveBeenCalled();
      expect(failureListener).toHaveBeenCalledOnce();
      expect(failureListener).toHaveBeenCalledWith({
        type: "eventStreamFailure",
        error: expect.objectContaining({ code: "ELECTRON_CORE_EVENT_INVALID" }),
        drained: expect.any(Promise)
      });
      await client.shutdown();
    }
  });

  it("accepts the exact closed shape of every Rust-critical event variant", async () => {
    let emit: ((eventsJson: string) => void) | undefined;
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn((listener) => { emit = listener; }),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});
    const listener = vi.fn();
    const failureListener = vi.fn();
    client.subscribeCoreEvents(listener);
    client.subscribeCoreEventStreamFailures(failureListener);
    client.startCoreEventBridge();

    emit?.(JSON.stringify([
      { type: "ready", schemaVersion: 23 },
      { type: "stateChanged", revision: 1, changedCollections: ["roles"] },
      { type: "logsChanged" },
      {
        type: "logEntriesCaptured",
        entries: [{
          id: "log-1", timestamp: "2026-01-01T00:00:00Z", level: "info",
          source: "main", event: "startup", message: "started", sessionId: "session-1"
        }]
      },
      {
        type: "browserActions",
        actions: [{
          requestId: "request-1", roleId: "role-1", origin: "macro",
          inputEpoch: 1, intent: "normal", scheduledAtMs: 1, deadlineMs: 100,
          action: { type: "focus" }
        }]
      },
      {
        type: "coreEffects",
        effects: [{
          effectId: "effect-1",
          operationId: "operation-1",
          target: { kind: "webContents", handleId: "role-1" },
          completionPolicy: "eventBound",
          action: { type: "embeddedDestroyRole", roleId: "role-1" }
        }]
      },
      {
        type: "coreEffectCancellations",
        cancellations: [{
          effectId: "effect-1",
          operationId: "operation-1",
          reason: "operationCancelled"
        }]
      },
      {
        type: "browserStatuses",
        statuses: [{ roleId: "role-1", state: "running", runtimeMode: "embedded" }]
      },
      {
        type: "browserLaunchCompleted",
        operationId: "operation-1",
        sourceId: "role-1",
        sourceType: "role",
        tabId: "tab-1",
        ok: true
      },
      {
        type: "macroStatuses",
        reliable: true,
        statuses: [{
          roleId: "role-1",
          macroId: "macro-1",
          state: "running",
          iteration: 1,
          lastClick: null,
          startedAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          error: null
        }]
      },
      { type: "overlayChanged", roleIds: ["role-1"] },
      {
        type: "chromeProfileImportProgress",
        progress: {
          importId: "import-1", phase: "applying", completed: 1, total: 2
        }
      },
      { type: "shutdown" }
    ]));

    expect(failureListener).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(13);
    expect(listener).toHaveBeenLastCalledWith({ type: "shutdown" });
    await client.shutdown();
  });

  it("fans out one native stream failure even when its observer throws", async () => {
    let fail: ((failureJson: string) => void) | undefined;
    const onEventBridgeError = vi.fn(() => {
      throw new Error("observational reporter failed");
    });
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn((_listener, failureListener) => {
        fail = failureListener;
      }),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create(
      { createAppCore: () => binding },
      {},
      { onEventBridgeError }
    );
    const failureListener = vi.fn();
    client.subscribeCoreEventStreamFailures(() => {
      throw new Error("failure listener failed");
    });
    client.subscribeCoreEvents(vi.fn());
    client.subscribeCoreEventStreamFailures(failureListener);
    client.startCoreEventBridge();

    const payload = JSON.stringify({
      code: "CORE_EVENT_STREAM_CLOSED",
      message: "The authoritative Core event receiver closed before Shutdown."
    });
    fail?.(payload);
    fail?.(payload);

    expect(failureListener).toHaveBeenCalledOnce();
    expect(failureListener).toHaveBeenCalledWith({
      type: "eventStreamFailure",
      error: {
        code: "CORE_EVENT_STREAM_CLOSED",
        message: "The authoritative Core event receiver closed before Shutdown."
      },
      drained: expect.any(Promise)
    });
    expect(onEventBridgeError).toHaveBeenCalledTimes(2);
  });

  it("finishes current fanout then terminalizes a throwing event consumer", async () => {
    let emit: ((eventsJson: string) => void) | undefined;
    const onEventBridgeError = vi.fn();
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn((listener) => {
        emit = listener;
      }),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create(
      { createAppCore: () => binding },
      {},
      { onEventBridgeError }
    );
    const survivor = vi.fn();
    const failureListener = vi.fn();
    client.subscribeCoreEvents(() => {
      throw new Error("consumer failed");
    });
    client.subscribeCoreEvents(survivor);
    client.subscribeCoreEventStreamFailures(failureListener);
    client.startCoreEventBridge();

    emit?.(JSON.stringify([{ type: "logsChanged" }]));
    expect(survivor).toHaveBeenCalledWith({ type: "logsChanged" });
    expect(failureListener).toHaveBeenCalledOnce();
    expect(failureListener).toHaveBeenCalledWith({
      type: "eventStreamFailure",
      error: expect.objectContaining({ code: "ELECTRON_CORE_EVENT_LISTENER_FAILED" }),
      drained: expect.any(Promise)
    });
    expect(onEventBridgeError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_CORE_EVENT_LISTENER_FAILED"
    }));
    emit?.(JSON.stringify([{ type: "shutdown" }]));
    expect(survivor).toHaveBeenCalledOnce();
  });

  it("requires a ready local consumer and remains safe when shutdown precedes raw start", async () => {
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});

    expect(() => client.startCoreEventBridge()).toThrow(
      "local Core event consumer must be ready"
    );
    await client.shutdown();
    expect(binding.subscribeCoreEvents).not.toHaveBeenCalled();
    expect(() => client.startCoreEventBridge()).toThrow("stopping or has stopped");
  });

  it("decodes exact structured Core failures without classifying transport failures", async () => {
    const payload = {
      code: "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
      message: "The durable migration belongs to the opposite host platform."
    };
    const structured = (): Error => new Error(JSON.stringify(payload));

    await expect(CoreAddonClient.create({
      createAppCore: async () => { throw structured(); }
    }, {})).rejects.toMatchObject({
      name: "RionBridgeError",
      code: payload.code,
      message: payload.message
    });

    const invoke = vi.fn(async () => { throw structured(); });
    const begin = vi.fn(async () => { throw structured(); });
    const transition = vi.fn(async () => { throw structured(); });
    const binding: RawNodeApiCoreBinding = {
      invoke,
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      beginRoleSessionMigrationImportInternal: begin,
      transitionRoleSessionMigrationTargetInternal: transition,
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});
    const admission = {
      roleId: "11111111-1111-4111-8111-111111111111",
      transferId: "22222222-2222-4222-8222-222222222222",
      expectedJournalRevision: 3
    };
    const target = {
      ...admission,
      transitionId: "33333333-3333-4333-8333-333333333333",
      expectedPhase: "importing" as const,
      nextPhase: "verifying" as const,
      occurredAt: "2026-08-30T00:00:02.000Z"
    };

    await expect(client.invoke({ type: "health" })).rejects.toMatchObject(payload);
    await expect(client.beginRoleSessionMigrationImportInternal(admission))
      .rejects.toMatchObject(payload);
    await expect(client.transitionRoleSessionMigrationTargetInternal(target))
      .rejects.toMatchObject(payload);

    const transport = new Error("native acknowledgement channel closed");
    transition.mockRejectedValueOnce(transport);
    await expect(client.transitionRoleSessionMigrationTargetInternal(target))
      .rejects.toBe(transport);
    const nonExact = new Error(JSON.stringify({ ...payload, detail: "untrusted" }));
    transition.mockRejectedValueOnce(nonExact);
    await expect(client.transitionRoleSessionMigrationTargetInternal(target))
      .rejects.toBe(nonExact);
  });

  it("keeps target vault reads on the explicit Electron-main-only binding", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const transferId = "22222222-2222-4222-8222-222222222222";
    const envelopeBytes = Buffer.from(JSON.stringify({ metadata: {}, inventory: {} }));
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => envelopeBytes),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});

    await expect(
      client.readRoleSessionTransferVaultInternal(roleId, transferId)
    ).resolves.toBe(envelopeBytes);
    expect(binding.readRoleSessionTransferVaultInternal).toHaveBeenCalledWith(
      roleId,
      transferId
    );
    expect("writeRoleSessionTransferVaultInternal" in client).toBe(false);
  });

  it("keeps migration journal mutation on the privileged native method", async () => {
    const input = {
      roleId: "11111111-1111-4111-8111-111111111111",
      transferId: "22222222-2222-4222-8222-222222222222",
      transitionId: "33333333-3333-4333-8333-333333333333",
      expectedPhase: "importing" as const,
      expectedJournalRevision: 4,
      nextPhase: "verifying" as const,
      cleanFlushReceiptId:
        "chromium-cookie-flush:22222222-2222-4222-8222-222222222222:9",
      occurredAt: "2026-08-30T00:00:02.000Z"
    };
    const record = {
      roleId: input.roleId,
      transferId: input.transferId,
      phase: "verifying",
      journalRevision: 5,
      platform: "macos",
      sourceEngine: "wkwebview",
      targetEngine: "chromium",
      sourceRevision: 12,
      targetRevision: 9,
      envelopeSha256: "a".repeat(64),
      inventorySha256: "b".repeat(64),
      cookieCount: 1,
      localStorageOriginCount: 0,
      localStorageEntryCount: 0,
      startedAt: "2026-08-30T00:00:00.000Z",
      phaseChangedAt: input.occurredAt,
      updatedAt: input.occurredAt,
      cleanFlushReceiptId: input.cleanFlushReceiptId
    };
    const transition = vi.fn(async () => JSON.stringify(record));
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => {
        throw new Error("renderer-facing invoke must not mutate migration state");
      }),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      transitionRoleSessionMigrationTargetInternal: transition,
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});

    await expect(client.transitionRoleSessionMigrationTargetInternal(input))
      .resolves.toEqual(record);
    expect(transition).toHaveBeenCalledWith(JSON.stringify(input));
    expect(binding.invoke).not.toHaveBeenCalled();

    transition.mockResolvedValueOnce(JSON.stringify({ ...record, transferId: "forged" }));
    await expect(client.transitionRoleSessionMigrationTargetInternal(input))
      .rejects.toThrow("migration record is invalid");
  });

  it("keeps exported migration admission on its Rust-owned private boundary", async () => {
    const input = {
      roleId: "11111111-1111-4111-8111-111111111111",
      transferId: "22222222-2222-4222-8222-222222222222",
      expectedJournalRevision: 2
    };
    const record = {
      roleId: input.roleId,
      transferId: input.transferId,
      phase: "importing",
      journalRevision: 3,
      platform: "windows",
      sourceEngine: "webview2",
      targetEngine: "chromium",
      sourceRevision: 12,
      targetRevision: 1,
      envelopeSha256: "a".repeat(64),
      inventorySha256: "b".repeat(64),
      cookieCount: 1,
      localStorageOriginCount: 0,
      localStorageEntryCount: 0,
      startedAt: "2026-08-30T00:00:00.000Z",
      phaseChangedAt: "2026-08-30T00:00:02.000Z",
      updatedAt: "2026-08-30T00:00:02.000Z"
    };
    const begin = vi.fn(async () => JSON.stringify(record));
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => {
        throw new Error("renderer-facing invoke must not admit migration import");
      }),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      beginRoleSessionMigrationImportInternal: begin,
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});

    await expect(client.beginRoleSessionMigrationImportInternal(input))
      .resolves.toEqual(record);
    expect(begin).toHaveBeenCalledWith(JSON.stringify(input));
    expect(binding.invoke).not.toHaveBeenCalled();
  });

  it("rejects unbounded vault reads on the privileged target client", async () => {
    const oversizedBytes = Buffer.allocUnsafe(64 * 1024 * 1024 + 1);
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => oversizedBytes),
      ...chromeImportBindingStubs(),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});

    await expect(
      client.readRoleSessionTransferVaultInternal(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222"
      )
    ).rejects.toThrow("vault envelope bytes are invalid");
  });

  it("keeps Chrome-import transaction secrets bounded, binary, fenced, and consumed", async () => {
    const roleId = "11111111-1111-4111-8111-111111111111";
    const transactionId = "22222222-2222-4222-8222-222222222222";
    const leaseId = "33333333-3333-4333-8333-333333333333";
    const descriptor = {
      contractVersion: 1,
      leaseId,
      operationId: `chrome-profile-import-${transactionId}`,
      transactionId,
      roleId,
      journalPhase: "prepared",
      journalRevision: 1,
      launchUrl: "https://game.example/play",
      launchOrigin: "https://game.example",
      replaceExisting: false,
      createdRole: true,
      rolePaths: {
        browserUserDataDir: `/data/roles/${roleId}/browser`,
        systemBrowserDataDir: `/data/roles/${roleId}/browser/system`,
        webview2UserDataDir: `/data/roles/${roleId}/browser/webview2`,
        chromiumUserDataDir: `/data/roles/${roleId}/browser/chromium`,
        webkitDataStoreKey: `role:${roleId}:wkwebview`,
        webkitDataStoreIdentifier: "44444444-4444-8444-8444-444444444444"
      },
      chromiumPathSha256: "a".repeat(64),
      stagingSha256: "b".repeat(64),
      stagingBytes: 128,
      cookieCount: 1,
      localStorageCount: 1,
      unsupported: {
        partitionedCookieCount: 2,
        appBoundCookieCount: 3,
        decryptFailureCount: 4,
        storageReadFailureCount: 5
      },
      warnings: ["COOKIE_PARTITIONED_UNSUPPORTED"]
    };
    const evidence = {
      transactionId,
      roleId,
      journalPhase: "prepared",
      journalRevision: 1,
      protectedSha256: "c".repeat(64),
      inventorySha256: "d".repeat(64),
      cookieCount: 0,
      localStorageCount: 0
    };
    const capturedBackup: Buffer[] = [];
    const capturedCapability: Buffer[] = [];
    const stubs = chromeImportBindingStubs();
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...stubs,
      acquireChromeProfileImportTransactionInternal: vi.fn(async () =>
        JSON.stringify(descriptor)
      ),
      readChromeProfileImportPayloadInternal: vi.fn(async () =>
        Buffer.from('{"cookies":[],"localStorage":[]}')
      ),
      writeChromeProfileImportBackupInternal: vi.fn(async (_fence, bytes) => {
        capturedBackup.push(Buffer.from(bytes));
        return JSON.stringify(evidence);
      }),
      prepareChromeProfileImportFreshVerificationInternal: vi.fn(async () =>
        Buffer.alloc(32, 7)
      ),
      completeChromeProfileImportFreshVerificationInternal: vi.fn(
        async (_fence, capability) => {
          capturedCapability.push(Buffer.from(capability));
          return JSON.stringify({
            ...descriptor,
            journalPhase: "freshVerified",
            journalRevision: 4
          });
        }
      ),
      commitChromeProfileImportInternal: vi.fn(async () => JSON.stringify({
        ...evidence,
        journalPhase: "committing",
        journalRevision: 5
      })),
      verifyChromeProfileImportCommitMarkerInternal: vi.fn(async () => JSON.stringify({
        ...evidence,
        journalPhase: "committing",
        journalRevision: 5
      })),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});
    const acquired = await client.acquireChromeProfileImportTransactionInternal({
      roleId,
      transactionId,
      expectedJournalPhase: "prepared",
      expectedJournalRevision: 1,
      expectedLaunchUrl: "https://game.example/play",
      expectedReplaceExisting: false
    });
    expect(acquired).toEqual(descriptor);
    const fence = {
      leaseId,
      roleId,
      transactionId,
      expectedJournalPhase: "prepared" as const,
      expectedJournalRevision: 1
    };
    const payload = await client.readChromeProfileImportPayloadInternal(fence);
    expect(payload.toString()).toBe('{"cookies":[],"localStorage":[]}');
    payload.fill(0);

    const backup = Buffer.from("secret-backup");
    await expect(client.writeChromeProfileImportBackupInternal(fence, backup))
      .resolves.toEqual(evidence);
    expect([...backup]).toEqual(new Array(backup.byteLength).fill(0));
    expect(capturedBackup[0]?.toString()).toBe("secret-backup");
    const nativeBackupArgument = vi.mocked(binding.writeChromeProfileImportBackupInternal)
      .mock.calls[0]?.[1];
    expect(nativeBackupArgument && [...nativeBackupArgument])
      .toEqual(new Array("secret-backup".length).fill(0));

    const capability = await client.prepareChromeProfileImportFreshVerificationInternal(fence);
    expect(capability).toEqual(Buffer.alloc(32, 7));
    const receipt = {
      verifierInstanceId: "55555555-5555-4555-8555-555555555555",
      parentExitEvidenceSha256: "e".repeat(64),
      surfaceDrainEvidenceSha256: "f".repeat(64),
      chromiumPathSha256: "a".repeat(64),
      inventorySha256: "d".repeat(64),
      cookieCount: 1,
      localStorageCount: 1
    };
    await expect(client.completeChromeProfileImportFreshVerificationInternal(
      { ...fence, expectedJournalPhase: "awaitingFreshVerification", expectedJournalRevision: 3 },
      capability,
      receipt
    )).resolves.toMatchObject({ journalPhase: "freshVerified", journalRevision: 4 });
    expect([...capability]).toEqual(new Array(32).fill(0));
    expect(capturedCapability[0]).toEqual(Buffer.alloc(32, 7));
    const nativeCapabilityArgument = vi.mocked(
      binding.completeChromeProfileImportFreshVerificationInternal
    ).mock.calls[0]?.[1];
    expect(nativeCapabilityArgument && [...nativeCapabilityArgument])
      .toEqual(new Array(32).fill(0));

    await expect(client.commitChromeProfileImportInternal({
      ...fence,
      expectedJournalPhase: "freshVerified",
      expectedJournalRevision: 4
    })).resolves.toMatchObject({ journalPhase: "committing", journalRevision: 5 });
    await expect(client.verifyChromeProfileImportCommitMarkerInternal({
      ...fence,
      expectedJournalPhase: "committing",
      expectedJournalRevision: 5
    })).resolves.toMatchObject({ protectedSha256: "c".repeat(64) });
    await expect(client.releaseChromeProfileImportTransactionInternal({
      leaseId,
      roleId,
      transactionId
    })).resolves.toBeUndefined();

    const helperMetadata = Buffer.from('{"kind":"snapshot"}');
    const helperSecret = Buffer.from("bounded-secret");
    await expect(client.launchChromeProfileImportHelperInternal(
      helperMetadata,
      helperSecret
    )).resolves.toMatchObject({
      outcome: "applied",
      metadataBytes: Buffer.from("{}"),
      secretBytes: Buffer.alloc(0),
      exitEvidenceSha256: "a".repeat(64)
    });
    expect([...helperSecret]).toEqual(new Array(helperSecret.byteLength).fill(0));
    const nativeHelperSecret = vi.mocked(
      binding.launchChromeProfileImportHelperInternal
    ).mock.calls[0]?.[1];
    expect(nativeHelperSecret && [...nativeHelperSecret])
      .toEqual(new Array("bounded-secret".length).fill(0));
    const nativeHelperMetadata = vi.mocked(
      binding.launchChromeProfileImportHelperInternal
    ).mock.calls[0]?.[0];
    expect(nativeHelperMetadata && [...nativeHelperMetadata])
      .toEqual(new Array(helperMetadata.byteLength).fill(0));
  });

  it("binds AbortSignal to one native helper and waits for its terminal launch promise", async () => {
    let resolveLaunch!: (
      value: Awaited<ReturnType<RawNodeApiCoreBinding[
        "launchChromeProfileImportHelperInternal"
      ]>>
    ) => void;
    const launchChromeProfileImportHelperInternal = vi.fn((
      _metadataBytes: Buffer,
      _secretBytes: Buffer,
      _cancellationId?: string
    ) => new Promise<Awaited<ReturnType<RawNodeApiCoreBinding[
      "launchChromeProfileImportHelperInternal"
    ]>>>((resolve) => {
      resolveLaunch = resolve;
    }));
    const cancelChromeProfileImportHelperInternal = vi.fn(() => true);
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...chromeImportBindingStubs(),
      launchChromeProfileImportHelperInternal,
      cancelChromeProfileImportHelperInternal,
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});
    const controller = new AbortController();
    const metadata = Buffer.from('{"kind":"clearAndVerify"}');
    const secret = Buffer.alloc(0);
    const launch = client.launchChromeProfileImportHelperInternal(
      metadata,
      secret,
      controller.signal
    );
    await vi.waitFor(() => {
      expect(launchChromeProfileImportHelperInternal).toHaveBeenCalledOnce();
    });
    const cancellationId = launchChromeProfileImportHelperInternal.mock.calls[0]?.[2];
    expect(cancellationId).toMatch(/^[0-9a-f-]{36}$/u);

    controller.abort();
    expect(cancelChromeProfileImportHelperInternal)
      .toHaveBeenCalledWith(cancellationId);
    let settled = false;
    void launch.then(
      () => { settled = true; },
      () => { settled = true; }
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    const rawMetadata = Buffer.from("{}");
    const rawSecret = Buffer.alloc(0);
    resolveLaunch({
      outcome: "applied",
      metadataBytes: rawMetadata,
      secretBytes: rawSecret,
      exitEvidenceSha256: "a".repeat(64)
    });
    await expect(launch).rejects.toMatchObject({
      code: "CHROME_PROFILE_IMPORT_HELPER_CANCELLED"
    });
    expect([...rawMetadata]).toEqual([0, 0]);
  });

  it("rejects a pre-aborted helper launch without entering native code", async () => {
    const stubs = chromeImportBindingStubs();
    const binding: RawNodeApiCoreBinding = {
      invoke: vi.fn(async () => "null"),
      subscribeCoreEvents: vi.fn(),
      dispatchCoreEffectResults: vi.fn(async () => "{}"),
      readRoleSessionTransferVaultInternal: vi.fn(async () => Buffer.from("{}")),
      ...stubs,
      cancelChromeProfileImportHelperInternal: vi.fn(() => true),
      shutdown: vi.fn(async () => undefined)
    };
    const client = await CoreAddonClient.create({ createAppCore: () => binding }, {});
    const controller = new AbortController();
    controller.abort();
    const secret = Buffer.from("secret");

    await expect(client.launchChromeProfileImportHelperInternal(
      Buffer.from("{}"),
      secret,
      controller.signal
    )).rejects.toMatchObject({ code: "CHROME_PROFILE_IMPORT_HELPER_CANCELLED" });
    expect(stubs.launchChromeProfileImportHelperInternal).not.toHaveBeenCalled();
    expect([...secret]).toEqual(new Array(secret.byteLength).fill(0));
  });
});
