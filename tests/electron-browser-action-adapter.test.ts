import { describe, expect, it, vi } from "vitest";

import { ElectronBrowserActionAdapter } from "../src/main/core/ElectronBrowserActionAdapter";

describe("ElectronBrowserActionAdapter", () => {
  it("lets Rust execute external actions before the Electron effect adapter", async () => {
    let listener: ((events: never[]) => void) | undefined;
    const dispatchBrowserResults = vi.fn(async (_results: unknown) => undefined);
    const getTarget = vi.fn(() => undefined);
    new ElectronBrowserActionAdapter({
      dispatchBrowserResults,
      dispatchExternalBrowserActions: vi.fn(async (actions: Array<{ requestId: string }>) => ({
        results: [{
          requestId: actions[0].requestId,
          ok: true,
          valueJson: null,
          errorCode: null,
          errorMessage: null
        }],
        unhandled: []
      })),
      subscribe: (callback: (events: never[]) => void) => {
        listener = callback;
        return () => undefined;
      }
    } as never, { getTarget });

    listener?.([{
      type: "browserActions",
      actions: [{ requestId: "external", roleId: "r1", deadlineMs: Date.now() + 1_000, action: { type: "focus" } }]
    }] as never);

    await vi.waitFor(() => expect(dispatchBrowserResults).toHaveBeenCalledOnce());
    expect(getTarget).not.toHaveBeenCalled();
    expect(dispatchBrowserResults).toHaveBeenCalledWith([
      expect.objectContaining({ requestId: "external", ok: true })
    ]);
  });

  it("keeps same-role actions ordered and batches typed results", async () => {
    let listener: ((events: never[]) => void) | undefined;
    const dispatchBrowserResults = vi.fn(async (_results: unknown) => undefined);
    const calls: string[] = [];
    const target = {
      ensureInputFocus: vi.fn(async () => true),
      focus: vi.fn(async () => { calls.push("focus"); }),
      holdKey: vi.fn(async () => { calls.push("hold"); }),
      releaseKey: vi.fn(async () => { calls.push("release"); })
    };
    const core = {
      dispatchBrowserResults,
      dispatchExternalBrowserActions: vi.fn(async (actions) => ({ results: [], unhandled: actions })),
      subscribe: vi.fn((callback) => {
        listener = callback;
        return () => undefined;
      })
    };
    const adapter = new ElectronBrowserActionAdapter(core as never, {
      getTarget: () => target as never,
      now: () => 1_000
    });

    listener?.([{
      type: "browserActions",
      actions: [
        { requestId: "a1", roleId: "r1", deadlineMs: 2_000, action: { type: "focus" } },
        {
          requestId: "a2",
          roleId: "r1",
          deadlineMs: 2_000,
          action: {
            type: "key", phase: "hold", key: "KeyA", code: "KeyA", modifiers: [], ownerId: "o1"
          }
        },
        {
          requestId: "a3",
          roleId: "r1",
          deadlineMs: 2_000,
          action: {
            type: "key", phase: "release", key: "KeyA", code: "KeyA", modifiers: [], ownerId: "o1"
          }
        }
      ]
    }] as never);

    await vi.waitFor(() => expect(dispatchBrowserResults).toHaveBeenCalledOnce());
    expect(calls).toEqual(["focus", "hold", "release"]);
    expect(dispatchBrowserResults.mock.calls[0]?.[0]).toMatchObject([
      { requestId: "a1", ok: true },
      { requestId: "a2", ok: true },
      { requestId: "a3", ok: true }
    ]);
    await adapter.shutdown();
  });

  it("rejects expired and missing-target actions with stable error codes", async () => {
    let listener: ((events: never[]) => void) | undefined;
    const dispatchBrowserResults = vi.fn(async (_results: unknown) => undefined);
    new ElectronBrowserActionAdapter({
      dispatchBrowserResults,
      dispatchExternalBrowserActions: async (actions: never[]) => ({ results: [], unhandled: actions }),
      subscribe: (callback: (events: never[]) => void) => {
        listener = callback;
        return () => undefined;
      }
    } as never, {
      getTarget: () => undefined,
      now: () => 10
    });

    listener?.([{
      type: "browserActions",
      actions: [
        { requestId: "expired", roleId: "r1", deadlineMs: 9, action: { type: "focus" } },
        { requestId: "missing", roleId: "r2", deadlineMs: 20, action: { type: "focus" } }
      ]
    }] as never);

    await vi.waitFor(() => expect(dispatchBrowserResults).toHaveBeenCalledOnce());
    expect(dispatchBrowserResults.mock.calls[0]?.[0]).toMatchObject([
      { requestId: "expired", ok: false, errorCode: "BROWSER_ACTION_DEADLINE" },
      { requestId: "missing", ok: false, errorCode: "BROWSER_TARGET_UNAVAILABLE" }
    ]);
  });

  it("runs different Rust-ordered role groups concurrently", async () => {
    let listener: ((events: never[]) => void) | undefined;
    const dispatchBrowserResults = vi.fn(async (_results: unknown) => undefined);
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const adapter = new ElectronBrowserActionAdapter({
      dispatchBrowserResults,
      dispatchExternalBrowserActions: async (actions: never[]) => ({ results: [], unhandled: actions }),
      subscribe: (callback: (events: never[]) => void) => {
        listener = callback;
        return () => undefined;
      }
    } as never, {
      getTarget: (roleId) => ({
        ensureInputFocus: vi.fn(async () => true),
        focus: vi.fn(() => new Promise<void>((resolve) => {
          started.push(roleId);
          releases.set(roleId, resolve);
        }))
      }) as never,
      now: () => 1_000
    });

    listener?.([{
      type: "browserActions",
      actions: [
        { requestId: "r1-first", roleId: "r1", deadlineMs: 2_000, action: { type: "focus" } },
        { requestId: "r2-first", roleId: "r2", deadlineMs: 2_000, action: { type: "focus" } }
      ]
    }] as never);

    await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining(["r1", "r2"])));
    releases.get("r1")?.();
    releases.get("r2")?.();
    await vi.waitFor(() => expect(dispatchBrowserResults).toHaveBeenCalledOnce());
    expect(dispatchBrowserResults.mock.calls[0]?.[0]).toMatchObject([
      { requestId: "r1-first", ok: true },
      { requestId: "r2-first", ok: true }
    ]);
    await adapter.shutdown();
  });

  it("maps Electron/CDP failures and rejects late batches during shutdown", async () => {
    let listener: ((events: never[]) => void) | undefined;
    const dispatchBrowserResults = vi.fn(async (_results: unknown) => undefined);
    const adapter = new ElectronBrowserActionAdapter({
      dispatchBrowserResults,
      dispatchExternalBrowserActions: async (actions: never[]) => ({ results: [], unhandled: actions }),
      subscribe: (callback: (events: never[]) => void) => {
        listener = callback;
        return () => undefined;
      }
    } as never, {
      getTarget: () => ({
        evaluate: vi.fn(async () => {
          const error = new Error("CDP disconnected") as Error & { code: string };
          error.code = "CDP_DISCONNECTED";
          throw error;
        })
      }) as never,
      now: () => 1_000
    });

    listener?.([{
      type: "browserActions",
      actions: [{
        requestId: "cdp-failure",
        roleId: "r1",
        deadlineMs: 2_000,
        action: { type: "evaluate", source: "void 0" }
      }]
    }] as never);
    await vi.waitFor(() => expect(dispatchBrowserResults).toHaveBeenCalledOnce());
    expect(dispatchBrowserResults.mock.calls[0]?.[0]).toMatchObject([
      { requestId: "cdp-failure", ok: false, errorCode: "CDP_DISCONNECTED" }
    ]);

    await adapter.shutdown();
    listener?.([{
      type: "browserActions",
      actions: [{ requestId: "late", roleId: "r1", deadlineMs: 2_000, action: { type: "focus" } }]
    }] as never);
    await vi.waitFor(() => expect(dispatchBrowserResults).toHaveBeenCalledTimes(2));
    expect(dispatchBrowserResults.mock.calls[1]?.[0]).toMatchObject([
      { requestId: "late", ok: false, errorCode: "CORE_SHUTTING_DOWN" }
    ]);
  });
});
