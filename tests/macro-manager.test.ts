import { afterEach, describe, expect, it, vi } from "vitest";

import { MacroManager } from "../src/main/macros/MacroManager";
import type { Macro } from "../src/shared/types";

const macro: Macro = {
  id: "macro-1",
  name: "Auto heal",
  roleIds: ["role-1", "role-2"],
  repeat: { type: "once" },
  steps: [{ id: "step-1", type: "key", code: "F2" }],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("MacroManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches key and click steps through every assigned automation target in order", async () => {
    const targets = {
      "role-1": createTarget(),
      "role-2": createTarget()
    };
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [
          { id: "step-1", type: "key", code: "F2" },
          { id: "step-2", type: "click", xPercent: 25, yPercent: 75 }
        ]
      },
      targets
    });

    await expect(manager.start("macro-1")).resolves.toHaveLength(2);
    await vi.waitFor(() => expect(targets["role-1"].dispatchClick).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(targets["role-2"].dispatchClick).toHaveBeenCalledTimes(1));

    for (const target of Object.values(targets)) {
      expect(target.dispatchKey).toHaveBeenCalledWith("F2");
      expect(target.dispatchClick).toHaveBeenCalledWith(25, 75);
      expect(target.dispatchKey.mock.invocationCallOrder[0]).toBeLessThan(
        target.dispatchClick.mock.invocationCallOrder[0]
      );
    }
  });

  it("cancels delays for every assigned role when the macro is stopped", async () => {
    vi.useFakeTimers();
    const targets = {
      "role-1": createTarget(),
      "role-2": createTarget()
    };
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [
          { id: "step-1", type: "delay", ms: 1000 },
          { id: "step-2", type: "key", code: "F3" }
        ]
      },
      targets
    });

    await manager.start("macro-1");
    await manager.stop("macro-1");
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
    expect(targets["role-1"].dispatchKey).not.toHaveBeenCalled();
    expect(targets["role-2"].dispatchKey).not.toHaveBeenCalled();
  });

  it("loops until stopped", async () => {
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        roleIds: ["role-1"],
        repeat: { type: "loop", intervalMs: 1 }
      },
      targets: { "role-1": target }
    });

    await manager.start("macro-1");
    await vi.waitFor(() => expect(target.dispatchKey.mock.calls.length).toBeGreaterThanOrEqual(2));
    await manager.stop("macro-1");
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
  });

  it("rejects unavailable sessions before starting any assigned role", async () => {
    const target = createTarget();
    const manager = createManager({
      targets: { "role-1": target }
    });

    await expect(manager.start("macro-1")).rejects.toThrow("Launch this role before running a macro.");
    expect(target.dispatchKey).not.toHaveBeenCalled();
    expect(manager.listStatuses()).toEqual([]);
  });

  it("rejects external runtime sessions before starting any assigned role", async () => {
    const manager = createManager({
      runtimeStatuses: [{ roleId: "role-1", runtimeMode: "external", state: "running" }],
      targets: {}
    });

    await expect(manager.start("macro-1")).rejects.toThrow("Macro control is unavailable");
    expect(manager.listStatuses()).toEqual([]);
  });

  it("runs macros across embedded and compatibility-mode automation targets", async () => {
    const targets = { "role-1": createTarget(), "role-2": createTarget() };
    const manager = createManager({
      macroOverride: { ...macro, roleIds: ["role-1", "role-2"] },
      runtimeStatuses: [{ roleId: "role-2", runtimeMode: "external", state: "running" }],
      targets
    });

    await manager.start("macro-1");
    await vi.waitFor(() => expect(targets["role-1"].dispatchKey).toHaveBeenCalledWith("F2"));
    await vi.waitFor(() => expect(targets["role-2"].dispatchKey).toHaveBeenCalledWith("F2"));
  });

  it("rejects when any assigned role is already running the macro", async () => {
    vi.useFakeTimers();
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [{ id: "step-1", type: "delay", ms: 1000 }]
      }
    });

    await manager.start("macro-1");
    await expect(manager.start("macro-1")).rejects.toThrow("Macro is already running for this role.");
    await manager.stop("macro-1");
    await vi.runOnlyPendingTimersAsync();
  });

  it("stops only the runs for the requested macro", async () => {
    vi.useFakeTimers();
    const manager = createManager({
      macroOverride: {
        ...macro,
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "delay", ms: 1000 }]
      },
      macroById: {
        "macro-1": {
          ...macro,
          roleIds: ["role-1"],
          steps: [{ id: "step-1", type: "delay", ms: 1000 }]
        },
        "macro-2": {
          ...macro,
          id: "macro-2",
          roleIds: ["role-2"],
          steps: [{ id: "step-1", type: "delay", ms: 1000 }]
        }
      }
    });

    await manager.start("macro-1");
    await manager.start("macro-2");
    await manager.stop("macro-1");

    expect(manager.listStatuses()).toMatchObject([{ macroId: "macro-1", state: "stopping" }, { macroId: "macro-2" }]);
    await manager.stop("macro-2");
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
  });
});

function createManager(options: {
  macroById?: Record<string, Macro>;
  macroOverride?: Macro;
  runtimeStatuses?: Array<{ roleId: string; runtimeMode: "external"; state: "running" }>;
  targets?: Record<string, ReturnType<typeof createTarget>>;
} = {}): MacroManager {
  const targets =
    options.targets ??
    macro.roleIds.reduce<Record<string, ReturnType<typeof createTarget>>>((targetMap, roleId) => {
      targetMap[roleId] = createTarget();
      return targetMap;
    }, {});
  const macroById = options.macroById ?? {
    [options.macroOverride?.id ?? macro.id]: options.macroOverride ?? macro
  };

  return new MacroManager(
    {
      getAutomationSession: vi.fn((roleId: string) =>
        targets[roleId]
          ? {
              role: { ...macroRole, id: roleId },
              target: targets[roleId]
            }
          : undefined
      ),
      listStatuses: vi.fn(() => options.runtimeStatuses ?? [])
    } as never,
    {
      getMacro: vi.fn((macroId: string) => Promise.resolve(macroById[macroId] ?? options.macroOverride ?? macro))
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
