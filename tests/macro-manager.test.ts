import { afterEach, describe, expect, it, vi } from "vitest";

import { MacroManager } from "../src/main/macros/MacroManager";
import type { Macro } from "../src/shared/types";

const macro: Macro = {
  id: "macro-1",
  name: "Auto heal",
  roleId: "role-1",
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "F2" }],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("MacroManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches key and click steps through the automation target in order", async () => {
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [
          { id: "step-1", type: "key", code: "F2" },
          { id: "step-2", type: "click", xPercent: 25, yPercent: 75 }
        ]
      },
      target
    });

    await manager.start("role-1", "macro-1");
    await vi.waitFor(() => expect(target.dispatchClick).toHaveBeenCalledTimes(1));

    expect(target.dispatchKey).toHaveBeenCalledWith("F2");
    expect(target.dispatchClick).toHaveBeenCalledWith(25, 75);
    expect(target.dispatchKey.mock.invocationCallOrder[0]).toBeLessThan(
      target.dispatchClick.mock.invocationCallOrder[0]
    );
  });

  it("cancels a delay when the macro is stopped", async () => {
    vi.useFakeTimers();
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [
          { id: "step-1", type: "delay", ms: 1000 },
          { id: "step-2", type: "key", code: "F3" }
        ]
      },
      target
    });

    await manager.start("role-1", "macro-1");
    await manager.stop("role-1", "macro-1");
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
    expect(target.dispatchKey).not.toHaveBeenCalled();
  });

  it("loops until stopped", async () => {
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        repeat: { type: "loop", intervalMs: 1 }
      },
      target
    });

    await manager.start("role-1", "macro-1");
    await vi.waitFor(() => expect(target.dispatchKey.mock.calls.length).toBeGreaterThanOrEqual(2));
    await manager.stop("role-1", "macro-1");
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
  });

  it("rejects unavailable sessions and macros assigned to another role", async () => {
    await expect(createManager({ target: undefined }).start("role-1", "macro-1")).rejects.toThrow(
      "Launch this role before running a macro."
    );

    await expect(
      createManager({ macroOverride: { ...macro, roleId: "role-2" }, target: createTarget() }).start(
        "role-1",
        "macro-1"
      )
    ).rejects.toThrow("Macro is not assigned to this role.");
  });
});

function createManager(options: {
  macroOverride?: Macro;
  target?: ReturnType<typeof createTarget>;
} = {}): MacroManager {
  const hasTarget = Object.prototype.hasOwnProperty.call(options, "target");
  const target = hasTarget ? options.target : createTarget();

  return new MacroManager(
    {
      getAutomationSession: vi.fn(() =>
        target
          ? {
              role: { ...macroRole },
              target
            }
          : undefined
      )
    } as never,
    {
      getMacro: vi.fn().mockResolvedValue(options.macroOverride ?? macro)
    } as never
  );
}

function createTarget() {
  return {
    dispatchClick: vi.fn().mockResolvedValue(undefined),
    dispatchKey: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined)
  };
}

const macroRole = {
  id: "role-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  launchPreset: "performance" as const,
  authState: "authenticated" as const,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};
