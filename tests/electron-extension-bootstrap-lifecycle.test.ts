import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromiumExtensionSessions } from "../src/electron/main/chromiumExtensionSessions";
import type { CompatibilityReadyCallback } from "../third_party/electron-chrome-extensions/src/browser/api/compatibility";
import { clearChromiumExtensionRuntimeDiagnosticsForTests, recentChromiumExtensionRuntimeDiagnostics }
  from "../src/electron/main/chromiumExtensionRuntimeDiagnostics";

vi.mock("node:fs/promises", () => ({ readFile: async () => JSON.stringify({
  background: { service_worker: "background.js" },
  declarative_net_request: { rule_resources: [{ id: "disabled", enabled: false, path: "rules.json" }] }
}) }));
const id = "a".repeat(32);
const receipt = { availableApis: ["action", "alarms", "commands", "contextMenus", "notifications", "offscreen",
  "permissions", "storage.session", "tabs", "webNavigation"], staticRulesetCount: 0,
  staticRulesetStatus: "not-declared" as const, unavailableApis: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); clearChromiumExtensionRuntimeDiagnosticsForTests(); });

describe.each(["darwin", "win32"])("bootstrap lease lifecycle (%s)", platform => {
  function fixture() {
    const load = deferred<{ id: string }>();
    const started = deferred<void>();
    const removing = deferred<void>();
    const workers = Object.assign(new EventEmitter(), { getWorkerFromVersionID: () => ({
      scope: `chrome-extension://${id}/`, scriptURL: `chrome-extension://${id}/background.js`
    }) });
    const native = Object.assign(new EventEmitter(), {
      current: [] as { id: string }[], getAllExtensions: () => native.current,
      loadExtension: vi.fn(() => { started.resolve(); return load.promise.then(x => {
        native.current.push(x); return x;
      }); }),
      removeExtension: vi.fn(() => removing.resolve())
    });
    const core = { invoke: vi.fn(async (input: { command: { type: string } }) => ({
      snapshot: { installed: [{ id, requiredApiPermissions: [], removed: false,
        directory: platform === "win32" ? "C:\\fixture" : "/fixture" }] },
      lease: input.command.type === "acquire" ? { leaseId: "lease", roleId: "role", extensionIds: [id] } : null
    })) };
    let ready!: CompatibilityReadyCallback;
    const sessions = new ChromiumExtensionSessions(core as never, {
      createCompatibilityHost: (_session, onReady) => {
        ready = onReady; return { addTab: vi.fn(), removeTab: vi.fn() };
      }
    });
    const handle = { roleId: "role", session: { extensions: native, serviceWorkers: workers } };
    const surface = { contents: {}, window: {} };
    const prepared = sessions.prepare(handle as never, surface);
    const status = (runningStatus: string) => workers.emit("running-status-changed", { versionId: 1, runningStatus });
    const error = () => workers.emit("console-message", {}, { versionId: 1, source: "javascript", level: 3,
      sourceUrl: `chrome-extension://${id}/abp-background.js`, lineNumber: 8808 });
    const unloaded = () => {
      native.current = [];
      native.emit("extension-unloaded", {}, { id });
    };
    return { started, load, removing, native, workers, core, sessions, handle, surface, prepared, status, error,
      ready: () => ready(id, receipt, 1), unloaded };
  }

  it("accepts zero enabled rulesets even when disabled resources are declared", async () => {
    const f = fixture(); await f.started.promise;
    f.load.resolve({ id }); f.status("starting"); f.ready(); f.status("running");
    await f.prepared;
    expect(f.core.invoke).toHaveBeenLastCalledWith({ type: "extensions", command: {
      type: "complete", roleId: "role", leaseId: "lease", status: "loaded"
    } });
  });

  it("latches errors before native load completes and waits for exact unload before Core completion", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.started.promise;
    f.status("starting"); f.ready(); f.error();
    expect(f.native.removeExtension).not.toHaveBeenCalled();
    f.load.resolve({ id });
    await f.removing.promise;
    expect(f.core.invoke).toHaveBeenCalledTimes(1);
    expect(recentChromiumExtensionRuntimeDiagnostics()).toEqual([]);
    f.native.emit("extension-unloaded", {}, { id: "b".repeat(32) });
    expect(f.core.invoke).toHaveBeenCalledTimes(1);
    f.unloaded();
    await f.prepared;
    expect(f.core.invoke).toHaveBeenLastCalledWith({ type: "extensions", command: {
      type: "complete", roleId: "role", leaseId: "lease", status: "degraded"
    } });
    expect(recentChromiumExtensionRuntimeDiagnostics()).toEqual([expect.objectContaining({
      code: "ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR", relativeFile: "abp-background.js", line: 8808
    })]);
    f.ready(); f.status("running");
    expect(recentChromiumExtensionRuntimeDiagnostics()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["release", "host-failure"])("settles pending bootstrap on %s without the deadline", async action => {
    vi.useFakeTimers();
    const f = fixture();
    const failure = expect(f.prepared).rejects.toThrow(action === "release"
      ? "EXTENSIONS_SESSION_RELEASED" : "ELECTRON_EXTENSION_COMPATIBILITY_TAB_RETIRE_FAILED");
    await f.started.promise;
    f.load.resolve({ id }); f.status("starting");
    let released: Promise<void> | undefined;
    if (action === "release") released = f.sessions.release(f.handle as never);
    else f.sessions.retireSurface(f.handle as never, f.surface, true);
    await f.removing.promise;
    f.unloaded();
    await failure; await released;
    expect(f.workers.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.core.invoke.mock.calls.some(([input]) => "status" in input.command && input.command.status === "loaded")).toBe(false);
  });

  it("retains the existing bootstrap deadline when no native terminal event arrives", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.started.promise;
    f.load.resolve({ id }); f.status("starting"); f.ready();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.native.removeExtension).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await f.removing.promise; f.unloaded(); await f.prepared;
    expect(recentChromiumExtensionRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      code: "ELECTRON_EXTENSION_BOOTSTRAP_DEADLINE_EXCEEDED"
    }));
    expect(f.workers.eventNames()).toEqual([]);
  });

  it("keeps unknown native load indeterminate even after a worker error and unloads a late result", async () => {
    vi.useFakeTimers();
    const f = fixture(); const failure = expect(f.prepared).rejects.toThrow("EXTENSIONS_LOAD_INDETERMINATE");
    await f.started.promise; f.status("starting"); f.error();
    await vi.advanceTimersByTimeAsync(15_000); await failure;
    expect(f.core.invoke).toHaveBeenLastCalledWith({ type: "extensions", command: {
      type: "complete", roleId: "role", leaseId: "lease", status: "indeterminate"
    } });
    f.load.resolve({ id }); await f.removing.promise; f.unloaded();
    expect(f.workers.eventNames()).toEqual([]);
  });
});
