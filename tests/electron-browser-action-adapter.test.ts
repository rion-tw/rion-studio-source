import { describe, expect, it, vi } from "vitest";

import { ElectronBrowserActionAdapter } from "../src/main/core/ElectronBrowserActionAdapter";
import type { BrowserCoreEffectAction } from "../src/main/core/ElectronEffectExecutor";

const effect = (
  action: BrowserCoreEffectAction["request"]["action"],
  overrides: Partial<BrowserCoreEffectAction["request"]> = {}
): BrowserCoreEffectAction => ({
  type: "browserAction",
  request: {
    requestId: "request-1",
    roleId: "role-1",
    origin: "macro",
    scheduledAtMs: 900,
    deadlineMs: 2_000,
    action,
    ...overrides
  }
});

describe("ElectronBrowserActionAdapter", () => {
  it("executes a typed embedded effect without owning a subscription or result queue", async () => {
    const calls: string[] = [];
    const adapter = new ElectronBrowserActionAdapter({
      getTarget: () => ({
        ensureInputFocus: vi.fn(async () => {
          calls.push("ensure");
          return true;
        }),
        focus: vi.fn(async () => {
          calls.push("focus");
        })
      }) as never,
      now: () => 1_000
    });

    await adapter.executeEffect(effect({ type: "focus" }));

    expect(calls).toEqual(["ensure"]);
    expect(calls).not.toContain("focus");
  });

  it("preserves Rust-issued key effect order for one role", async () => {
    const calls: string[] = [];
    const target = {
      holdKey: vi.fn(async () => {
        calls.push("hold");
      }),
      releaseKey: vi.fn(async () => {
        calls.push("release");
      })
    };
    const adapter = new ElectronBrowserActionAdapter({
      getTarget: () => target as never,
      now: () => 1_000
    });

    await adapter.executeEffect(effect({
      type: "key",
      phase: "hold",
      key: "KeyA",
      code: "KeyA",
      modifiers: [],
      ownerId: "owner-1"
    }));
    await adapter.executeEffect(effect({
      type: "key",
      phase: "release",
      key: "KeyA",
      code: "KeyA",
      modifiers: [],
      ownerId: "owner-1"
    }));

    expect(calls).toEqual(["hold", "release"]);
  });

  it("rejects expired and missing-target effects with stable error codes", async () => {
    const adapter = new ElectronBrowserActionAdapter({
      getTarget: () => undefined,
      now: () => 10
    });

    await expect(adapter.executeEffect(effect(
      { type: "focus" },
      { deadlineMs: 9 }
    ))).rejects.toMatchObject({ code: "BROWSER_ACTION_DEADLINE" });
    await expect(adapter.executeEffect(effect(
      { type: "focus" },
      { deadlineMs: 20 }
    ))).rejects.toMatchObject({ code: "BROWSER_TARGET_UNAVAILABLE" });
  });

  it("records schedule-to-dispatch telemetry at the Electron bridge", async () => {
    const record = vi.fn();
    const adapter = new ElectronBrowserActionAdapter({
      getTarget: () => ({
        ensureInputFocus: vi.fn(async () => true),
        focus: vi.fn(async () => undefined)
      }) as never,
      now: () => 1_000,
      recordMacroScheduleToDispatchLatency: record
    });

    await adapter.executeEffect(effect({ type: "focus" }));

    expect(record).toHaveBeenCalledWith(100);
  });

  it("preserves typed Electron/CDP failures for the generic effect executor", async () => {
    const adapter = new ElectronBrowserActionAdapter({
      getTarget: () => ({
        evaluate: vi.fn(async () => {
          const error = new Error("CDP disconnected") as Error & { code: string };
          error.code = "CDP_DISCONNECTED";
          throw error;
        })
      }) as never,
      now: () => 1_000
    });

    await expect(adapter.executeEffect(effect({
      type: "evaluate",
      source: "void 0"
    }))).rejects.toMatchObject({
      code: "CDP_DISCONNECTED",
      message: "CDP disconnected"
    });
  });
});
