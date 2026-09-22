import { describe, expect, it, vi } from "vitest";
import { ChromiumDrmRuntime } from "../src/electron/main/chromiumDrmRuntime";

describe.each(["darwin", "win32"])("CDM observation on %s", () => {
  function fixture() {
    const runtime = new ChromiumDrmRuntime();
    let resolve!: (results: { id: string; version: string | null }[]) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<{ id: string; version: string | null }[]>((yes, no) => { resolve = yes; reject = no; });
    const components = { WIDEVINE_CDM_ID: "widevine", updatesEnabled: true,
      whenReady: vi.fn(() => promise) };
    return { runtime, components, resolve, reject };
  }

  it("does not block Roles and accepts only the exact component completion once", async () => {
    const { runtime, components, resolve } = fixture();
    runtime.start(components);
    runtime.start(components);
    expect(runtime.snapshot().state).toBe("installing");
    expect(components.whenReady).toHaveBeenCalledExactlyOnceWith(["widevine"]);
    resolve([{ id: "widevine", version: "4.10.3050.0" }]);
    expect(await runtime.whenSettled()).toMatchObject({ state: "ready", componentVersion: "4.10.3050.0", revision: 2 });
    expect(Object.isFrozen(runtime.snapshot())).toBe(true);
  });

  it.each([[{ id: "other", version: "4.10.3050.0" }], [{ id: "widevine", version: "secret/path" }],
    [{ id: "widevine", version: null }]])("rejects mismatched or malformed results", async result => {
    const { runtime, components, resolve } = fixture();
    runtime.start(components);
    resolve([result]);
    expect(await runtime.whenSettled()).toMatchObject({ state: "failed", failure: "invalid-component-result", componentVersion: null });
  });

  it("sanitizes asynchronous failures and does not retry", async () => {
    const { runtime, components, reject } = fixture();
    runtime.start(components);
    reject(new Error("credential /private/path license-body"));
    const result = await runtime.whenSettled();
    expect(result).toMatchObject({ state: "failed", failure: "component-install-failed" });
    expect(JSON.stringify(result)).not.toContain("credential");
    runtime.start(components);
    expect(components.whenReady).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"])("fences a late %s after quit", async outcome => {
    const { runtime, components, resolve, reject } = fixture();
    runtime.start(components);
    const waiting = runtime.whenSettled();
    runtime.stop();
    const stopped = await waiting;
    if (outcome === "resolve") resolve([{ id: "widevine", version: "4.10.3050.0" }]);
    else reject(new Error("late"));
    await Promise.resolve(); await Promise.resolve();
    expect(runtime.snapshot()).toBe(stopped);
    expect(stopped.state).toBe("stopped");
  });

  it("classifies absent APIs and synchronous vendor failures", async () => {
    const missing = new ChromiumDrmRuntime(); missing.start(undefined);
    expect(await missing.whenSettled()).toMatchObject({ state: "unsupported" });
    const { runtime, components } = fixture();
    components.whenReady.mockImplementation(() => { throw new Error("private"); });
    runtime.start(components);
    expect(await runtime.whenSettled()).toMatchObject({ state: "failed", failure: "component-install-failed" });
  });
});
