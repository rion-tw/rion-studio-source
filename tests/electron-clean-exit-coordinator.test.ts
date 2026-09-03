import { describe, expect, it, vi } from "vitest";

import {
  cleanExitFailureRequiresInvalidation,
  prepareElectronCleanExit
} from
  "../src/electron/main/cleanExitCoordinator";
import { RionBridgeError } from "../src/electron/ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeSnapshot";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const snapshot: ChromiumRuntimeExecutorSnapshot = {
  windows: [], tabs: [], roles: [], webSurfaces: []
};

describe("Electron clean-exit coordinator", () => {
  it.each([
    "CORE_SHUTDOWN_ROLE_BROWSER_DATA_CLEAR_UNVERIFIED",
    "CORE_SHUTDOWN_BROWSER_OPERATIONS_UNVERIFIED",
    "CORE_SHUTDOWN_PRETERMINAL_UNVERIFIED",
    "CHROME_PROFILE_IMPORT_HELPER_REGISTRY_FAILED",
    "CORE_INTERNAL_FAILED"
  ])("invalidates an ambiguous or preterminal checked failure: %s", (code) => {
    expect(cleanExitFailureRequiresInvalidation({
      cleanBoundaryPersisted: true,
      error: new RionBridgeError({ code, message: "controlled failure" }),
      fatalGenerationInvalidated: false,
      phase: "checkedCoreShutdown"
    })).toBe(true);
  });

  it.each([
    "CORE_LOG_DATABASE_FAILED",
    "CORE_SHUTTING_DOWN",
    "CORE_SHUTDOWN_INSTANCE_LOCK_UNVERIFIED",
    "CORE_SHUTDOWN_RUNTIME_UNVERIFIED",
    "CORE_STATE_DATABASE_FAILED"
  ])("retains clean only for a proven-late checked failure: %s", (code) => {
    expect(cleanExitFailureRequiresInvalidation({
      cleanBoundaryPersisted: true,
      error: new RionBridgeError({ code, message: "controlled failure" }),
      fatalGenerationInvalidated: false,
      phase: "checkedCoreShutdown"
    })).toBe(false);
  });

  it("invalidates unstructured, clean-boundary, and post-shutdown fatal failures", () => {
    expect(cleanExitFailureRequiresInvalidation({
      cleanBoundaryPersisted: true,
      error: new Error("transport failed"),
      fatalGenerationInvalidated: false,
      phase: "checkedCoreShutdown"
    })).toBe(true);
    expect(cleanExitFailureRequiresInvalidation({
      cleanBoundaryPersisted: false,
      error: new Error("persist failed"),
      fatalGenerationInvalidated: false,
      phase: "cleanBoundary"
    })).toBe(true);
    expect(cleanExitFailureRequiresInvalidation({
      cleanBoundaryPersisted: true,
      error: new Error("fatal generation changed"),
      fatalGenerationInvalidated: true,
      phase: "postShutdownFatalFence"
    })).toBe(true);
  });

  it("fences all command ingress synchronously and persists only after ordered drains", async () => {
    const order: string[] = [];
    const renderer = deferred();
    const core = {
      beginRoleBrowserDataClearCommandDrain: vi.fn(() => { order.push("core-fence"); }),
      waitForRoleBrowserDataClearCommandDrain: vi.fn(async () => {
        order.push("core-clear-drained"); return true;
      }),
      invalidateRuntimeRestoreSessionCleanExitInternal: vi.fn(async () => undefined)
    };
    const runtime = {
      beginCleanExit: vi.fn(() => { order.push("runtime-fence"); }),
      prepareCleanExit: vi.fn(async (
        persist: (value: ChromiumRuntimeExecutorSnapshot) => Promise<unknown>
      ) => {
        order.push("runtime-drained"); await persist(snapshot);
      })
    };
    const work = prepareElectronCleanExit({
      core, runtime,
      rendererIngress: { closeAndDrain: () => renderer.promise },
      releaseRendererIngress: () => { order.push("renderer-fence"); },
      persistCleanExit: vi.fn(async () => { order.push("persist-clean"); }),
      clearCommandDrainTimeoutMs: 321
    });

    expect(order).toEqual(["core-fence", "runtime-fence", "renderer-fence"]);
    expect(runtime.prepareCleanExit).not.toHaveBeenCalled();
    renderer.resolve();
    await expect(work).resolves.toBeUndefined();
    expect(order).toEqual([
      "core-fence", "runtime-fence", "renderer-fence", "runtime-drained",
      "core-clear-drained", "persist-clean"
    ]);
    expect(core.waitForRoleBrowserDataClearCommandDrain).toHaveBeenCalledWith(321);
  });

  it("leaves the journal unclean when the bounded Core clear drain is indeterminate", async () => {
    const persistCleanExit = vi.fn(async () => undefined);
    const invalidateCleanExit = vi.fn(async () => undefined);
    const work = prepareElectronCleanExit({
      core: {
        beginRoleBrowserDataClearCommandDrain: vi.fn(),
        waitForRoleBrowserDataClearCommandDrain: vi.fn(async () => false),
        invalidateRuntimeRestoreSessionCleanExitInternal: invalidateCleanExit
      },
      runtime: {
        beginCleanExit: vi.fn(),
        prepareCleanExit: vi.fn(async (persist) => { await persist(snapshot); })
      },
      rendererIngress: { closeAndDrain: vi.fn(async () => undefined) },
      releaseRendererIngress: vi.fn(),
      persistCleanExit,
      clearCommandDrainTimeoutMs: 1
    });

    await expect(work).rejects.toMatchObject({
      code: "ELECTRON_ROLE_BROWSER_DATA_CLEAR_DRAIN_INDETERMINATE"
    });
    expect(persistCleanExit).not.toHaveBeenCalled();
    expect(invalidateCleanExit).toHaveBeenCalledOnce();
  });

  it("replays unclean after a fatal persist settles later than its first invalidation", async () => {
    const persistenceStarted = deferred();
    const persistence = deferred();
    let cleanMarker = false;
    const invalidate = vi.fn(async () => { cleanMarker = false; });
    const fatalFailure = new Error("event stream failed during clean persistence");
    const work = prepareElectronCleanExit({
      core: {
        beginRoleBrowserDataClearCommandDrain: vi.fn(),
        waitForRoleBrowserDataClearCommandDrain: vi.fn(async () => true),
        invalidateRuntimeRestoreSessionCleanExitInternal: invalidate
      },
      runtime: {
        beginCleanExit: vi.fn(),
        prepareCleanExit: vi.fn(async (persist) => {
          await persist(snapshot);
          throw fatalFailure;
        })
      },
      rendererIngress: { closeAndDrain: vi.fn(async () => undefined) },
      releaseRendererIngress: vi.fn(),
      persistCleanExit: async () => {
        persistenceStarted.resolve();
        await persistence.promise;
        cleanMarker = true;
      }
    });
    await persistenceStarted.promise;

    // CoreAddon owns the first fatal cleanup immediately, independently of
    // the still-pending clean replace. It may therefore finish first.
    await invalidate();
    expect(invalidate).toHaveBeenCalledOnce();
    expect(cleanMarker).toBe(false);

    // The older clean submission settles last and temporarily restores true.
    // prepareElectronCleanExit must then submit a second invalidation.
    persistence.resolve();

    await expect(work).rejects.toBe(fatalFailure);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(cleanMarker).toBe(false);
  });
});
