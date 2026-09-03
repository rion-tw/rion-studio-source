import type { CoreEvent } from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";

import {
  CoreRendererEventBridge,
  type ElectronCoreEventSource
} from "../src/electron/main/coreRendererEventBridge";
import type { AppSnapshot } from "../src/shared/types";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function snapshot(revision: number): AppSnapshot {
  return {
    revision,
    stateRevision: revision,
    runtimeRevision: 0,
    embeddedRuntimeState: {
      revision: 0,
      capturedAt: "2026-08-30T00:00:00.000Z",
      windows: [],
      tabs: []
    },
    games: [],
    gameWindows: [],
    roles: [],
    roleStatuses: [],
    launchWorkspaces: [],
    displayTopology: {
      revision,
      capturedAt: "2026-08-30T00:00:00.000Z",
      cause: "test",
      displays: []
    },
    macros: [],
    macroStatuses: [],
    quickAccessPreferences: { pinnedItems: [], recentItems: [] }
  };
}

function harness(
  readAppSnapshot = vi.fn(async () => snapshot(1)),
  refreshRoleOverlays = vi.fn(async (_roleIds: readonly string[]) => undefined)
) {
  let listener: ((event: CoreEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const core: ElectronCoreEventSource = {
    subscribeCoreEvents: (next) => {
      listener = next;
      return unsubscribe;
    }
  };
  const publishAppSnapshot = vi.fn();
  const publishLogEntry = vi.fn();
  const publishChromeProfileImportProgress = vi.fn();
  const onError = vi.fn();
  const bridge = new CoreRendererEventBridge({
    core,
    readAppSnapshot,
    publishAppSnapshot,
    publishLogEntry,
    publishChromeProfileImportProgress,
    refreshRoleOverlays,
    onError
  });
  bridge.start();
  return {
    bridge,
    emit: (event: CoreEvent) => listener?.(event),
    onError,
    publishAppSnapshot,
    publishChromeProfileImportProgress,
    publishLogEntry,
    readAppSnapshot,
    refreshRoleOverlays,
    unsubscribe
  };
}

describe("Electron Core renderer event bridge", () => {
  it("coalesces revision events and never publishes an overtaken snapshot", async () => {
    const first = deferred<AppSnapshot>();
    const second = deferred<AppSnapshot>();
    const readAppSnapshot = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const test = harness(readAppSnapshot);

    test.emit({ type: "stateChanged", revision: 2, changedCollections: ["games"] });
    test.emit({ type: "browserStatuses", statuses: [] });
    first.resolve(snapshot(2));
    await first.promise;
    await Promise.resolve();

    expect(test.publishAppSnapshot).not.toHaveBeenCalled();
    expect(readAppSnapshot).toHaveBeenCalledTimes(2);

    second.resolve(snapshot(3));
    await second.promise;
    await Promise.resolve();
    expect(test.publishAppSnapshot).toHaveBeenCalledOnce();
    expect(test.publishAppSnapshot).toHaveBeenCalledWith(snapshot(3));
  });

  it("forwards event payloads that do not require a snapshot read", () => {
    const test = harness();
    const entry = {
      id: "log-1",
      timestamp: "2026-08-30T00:00:00.000Z",
      level: "info" as const,
      source: "main" as const,
      event: "test",
      message: "captured",
      sessionId: "session-1"
    };
    const progress = {
      importId: "import-1",
      phase: "preparing",
      completed: 1,
      total: 2
    };

    test.emit({ type: "logEntriesCaptured", entries: [entry] });
    test.emit({ type: "chromeProfileImportProgress", progress });

    expect(test.publishLogEntry).toHaveBeenCalledWith(entry);
    expect(test.publishChromeProfileImportProgress).toHaveBeenCalledWith(progress);
    expect(test.readAppSnapshot).not.toHaveBeenCalled();
  });

  it("refreshes after an exact native projection commit", async () => {
    const test = harness();

    test.bridge.observeNativeProjectionChanged();
    await Promise.resolve();
    await Promise.resolve();

    expect(test.readAppSnapshot).toHaveBeenCalledOnce();
    expect(test.publishAppSnapshot).toHaveBeenCalledWith(snapshot(1));
  });

  it("routes exact overlay role sets, including empty meaning every live overlay", () => {
    const test = harness();

    test.emit({ type: "overlayChanged", roleIds: ["role-2", "role-1"] });
    test.emit({ type: "overlayChanged", roleIds: [] });

    expect(test.refreshRoleOverlays).toHaveBeenNthCalledWith(
      1,
      ["role-2", "role-1"]
    );
    expect(Object.isFrozen(test.refreshRoleOverlays.mock.calls[0]![0])).toBe(true);
    expect(test.refreshRoleOverlays).toHaveBeenNthCalledWith(2, []);
    expect(Object.isFrozen(test.refreshRoleOverlays.mock.calls[1]![0])).toBe(true);
    expect(test.readAppSnapshot).not.toHaveBeenCalled();
  });

  it("does not present an overlay refresh superseded by document replacement", async () => {
    const refreshRoleOverlays = vi.fn(async () => {
      throw { code: "ELECTRON_ROLE_OVERLAY_DOCUMENT_SUPERSEDED", message: "superseded" };
    });
    const test = harness(vi.fn(async () => snapshot(1)), refreshRoleOverlays);

    test.emit({ type: "overlayChanged", roleIds: ["role-1"] });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("reports a non-terminal overlay refresh failure through the bridge error port", async () => {
    const refreshRoleOverlays = vi.fn(async () => {
      throw { code: "ELECTRON_ROLE_OVERLAY_REFRESH_INVALID", message: "invalid" };
    });
    const test = harness(vi.fn(async () => snapshot(1)), refreshRoleOverlays);

    test.emit({ type: "overlayChanged", roleIds: ["role-1"] });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.onError).toHaveBeenCalledWith({
      code: "ELECTRON_ROLE_OVERLAY_REFRESH_INVALID",
      message: "invalid"
    });
  });

  it("reports the current refresh failure and unsubscribes exactly once", async () => {
    const readAppSnapshot = vi.fn(async () => {
      throw { code: "CORE_READ_FAILED", message: "Could not read Core." };
    });
    const test = harness(readAppSnapshot);

    test.emit({ type: "macroStatuses", reliable: true, statuses: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(test.onError).toHaveBeenCalledWith({
      code: "CORE_READ_FAILED",
      message: "Could not read Core."
    });

    test.bridge.dispose();
    test.bridge.dispose();
    expect(test.unsubscribe).toHaveBeenCalledOnce();
  });
});
