import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ChromiumExtensionBootstrap } from "../src/electron/main/chromiumExtensionBootstrap";

const id = "a".repeat(32);
const origin = `chrome-extension://${id}/`;
const receipt = { availableApis: [], staticRulesetCount: 0,
  staticRulesetStatus: "not-declared" as const, unavailableApis: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const start = deferred<{ scope: string; scriptURL: string; versionId: number }>();
  const workers = Object.assign(new EventEmitter(), {
    startWorkerForScope: vi.fn(() => start.promise),
    getWorkerFromVersionID: vi.fn((versionId: number) => ({
      scope: versionId === 9 ? "https://unrelated.invalid/" : origin,
      scriptURL: `${origin}background.js`
    }))
  });
  const bootstrap = new ChromiumExtensionBootstrap(workers as never, id);
  const status = (runningStatus: string, versionId = 1) =>
    workers.emit("running-status-changed", { runningStatus, versionId });
  const error = (overrides = {}) => workers.emit("console-message", {}, {
    versionId: 1, source: "javascript", level: 3,
    sourceUrl: `${origin}abp-background.js`, lineNumber: 8808,
    message: "Uncaught TypeError: Cannot read properties of undefined (reading 'onClicked')",
    ...overrides
  });
  return { bootstrap, workers, start, status, error };
}

// The same native follower protocol is used on both supported desktop targets.
describe.each(["darwin", "win32"])("worker bootstrap (%s)", () => {
  it("does not accept compatibility ready before evaluation fails", async () => {
    const { bootstrap, status, error, workers } = fixture();
    bootstrap.nativeLoaded();
    expect(bootstrap.inspect()).toEqual({ nativeLoaded: true, workerVersionId: null,
      workerRunning: false, workerWasRunning: false, compatibilityReady: false,
      events: ["native-loaded", "start-requested"] });
    status("starting");
    bootstrap.compatibilityReady(receipt, 1);
    expect(bootstrap.inspect()).toEqual({ nativeLoaded: true, workerVersionId: 1,
      workerRunning: false, workerWasRunning: false, compatibilityReady: true,
      events: ["native-loaded", "start-requested", "starting", "compatibility-ready"] });
    expect(bootstrap.outcome).toBeUndefined();
    error();
    const first = await bootstrap.result;
    expect(first).toEqual({ status: "failed", code: "ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR",
      relativeFile: "abp-background.js", line: 8808 });
    status("running");
    bootstrap.compatibilityReady(receipt, 1);
    bootstrap.cancel();
    expect(bootstrap.outcome).toBe(first);
    expect(workers.listenerCount("console-message")).toBe(0);
    expect(workers.listenerCount("running-status-changed")).toBe(0);
  });

  it.each([true, false])("requires load, running and receipt (receipt first: %s)", async receiptFirst => {
    const { bootstrap, status } = fixture();
    status("starting");
    if (receiptFirst) bootstrap.compatibilityReady(receipt, 1);
    status("running");
    if (!receiptFirst) bootstrap.compatibilityReady(receipt, 1);
    expect(bootstrap.outcome).toBeUndefined();
    bootstrap.nativeLoaded();
    expect(await bootstrap.result).toEqual({ status: "ready", receipt });
  });

  it("starts the exact scope once when load finishes before a native running event", async () => {
    const { bootstrap, workers, start, status } = fixture();
    status("starting");
    bootstrap.compatibilityReady(receipt, 1);
    bootstrap.nativeLoaded();
    bootstrap.nativeLoaded();
    expect(workers.startWorkerForScope).toHaveBeenCalledTimes(1);
    expect(workers.startWorkerForScope).toHaveBeenCalledWith(origin);
    start.resolve({ scope: origin, scriptURL: `${origin}background.js`, versionId: 1 });
    expect(await bootstrap.result).toEqual({ status: "ready", receipt });
  });

  it("accepts a sender-bound receipt only after the exact native start identifies its version", async () => {
    const { bootstrap, start } = fixture();
    bootstrap.compatibilityReady(receipt, 1);
    bootstrap.nativeLoaded();
    expect(bootstrap.outcome).toBeUndefined();
    start.resolve({ scope: origin, scriptURL: `${origin}background.js`, versionId: 1 });
    expect(await bootstrap.result).toEqual({ status: "ready", receipt });
  });

  it("keeps normal worker idle-stop from erasing a completed native running acknowledgement", async () => {
    const { bootstrap, status, workers } = fixture();
    status("starting"); status("running"); status("stopped");
    bootstrap.compatibilityReady(receipt, 1);
    bootstrap.nativeLoaded();
    expect(workers.startWorkerForScope).not.toHaveBeenCalled();
    expect(await bootstrap.result).toEqual({ status: "ready", receipt });
  });

  it("rejects a native start for a different worker version", async () => {
    const { bootstrap, start, status } = fixture();
    status("starting");
    bootstrap.compatibilityReady(receipt, 1);
    bootstrap.nativeLoaded();
    start.resolve({ scope: origin, scriptURL: `${origin}background.js`, versionId: 2 });
    expect(await bootstrap.result).toEqual({ status: "failed",
      code: "ELECTRON_EXTENSION_WORKER_IDENTITY_MISMATCH" });
  });

  it("terminalizes an explicit native start rejection", async () => {
    const { bootstrap, start } = fixture();
    bootstrap.nativeLoaded();
    start.reject(new Error("worker unavailable"));
    expect(await bootstrap.result).toEqual({ status: "failed",
      code: "ELECTRON_EXTENSION_SERVICE_WORKER_START_FAILED" });
  });

  it("terminalizes a synchronous native start failure", async () => {
    const { bootstrap, workers } = fixture();
    workers.startWorkerForScope.mockImplementation(() => { throw new Error("session retired"); });
    bootstrap.nativeLoaded();
    expect(await bootstrap.result).toEqual({ status: "failed",
      code: "ELECTRON_EXTENSION_SERVICE_WORKER_START_FAILED" });
  });

  it("ignores warnings, handled console errors, network errors and unrelated workers", async () => {
    const { bootstrap, workers, status, error } = fixture();
    status("starting", 9);
    error({ versionId: 9 });
    status("starting");
    error({ versionId: 2 });
    error({ source: "console-api" });
    error({ source: "network" });
    error({ level: 2 });
    bootstrap.compatibilityReady(receipt, 2);
    bootstrap.nativeLoaded();
    status("running");
    expect(bootstrap.outcome).toBeUndefined();
    // Ownership was captured at starting; error handling must not query a
    // potentially stopped worker or accept source URLs as worker identity.
    workers.getWorkerFromVersionID.mockImplementation(() => { throw new Error("gone"); });
    error({ sourceUrl: "https://unrelated.invalid/private?q=secret" });
    expect(await bootstrap.result).toMatchObject({ status: "failed", relativeFile: undefined });
  });

  it("does not treat stopping as failure or restart as success", () => {
    const { bootstrap, status } = fixture();
    status("starting");
    status("stopping");
    status("stopped");
    status("starting", 2);
    status("running", 2);
    bootstrap.compatibilityReady(receipt, 2);
    bootstrap.nativeLoaded();
    expect(bootstrap.outcome).toBeUndefined();
    bootstrap.cancel();
  });

  it("isolates identical extension IDs in different Role sessions", async () => {
    const a = fixture(); const b = fixture();
    a.status("starting"); b.status("starting");
    a.error();
    expect(b.bootstrap.outcome).toBeUndefined();
    b.bootstrap.cancel();
    expect(await a.bootstrap.result).toMatchObject({ status: "failed" });
    expect(await b.bootstrap.result).toMatchObject({ status: "cancelled" });
    expect(b.workers.eventNames()).toEqual([]);
  });
});
