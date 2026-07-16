import { afterEach, describe, expect, it, vi } from "vitest";

import { MacroManager, MacroMutationBusyError } from "../src/main/macros/MacroManager";
import type { Macro } from "../src/shared/types";

const macro: Macro = {
  id: "macro-1",
  enabled: true,
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
      expect(target.ensureInputFocus).toHaveBeenCalledOnce();
      expect(target.ensureInputFocus.mock.invocationCallOrder[0]).toBeLessThan(
        target.dispatchKey.mock.invocationCallOrder[0]
      );
      expect(target.dispatchKey).toHaveBeenCalledWith("F2", expect.any(AbortSignal));
      expect(target.dispatchClick).toHaveBeenCalledWith(25, 75, expect.any(AbortSignal));
      expect(target.dispatchKey.mock.invocationCallOrder[0]).toBeLessThan(
        target.dispatchClick.mock.invocationCallOrder[0]
      );
    }
  });

  it("checks every target before publishing running state or dispatching the first step", async () => {
    const targets = {
      "role-1": createTarget(),
      "role-2": createTarget()
    };
    let releaseRole1!: () => void;
    let releaseRole2!: () => void;
    targets["role-1"].ensureInputFocus.mockReturnValue(new Promise<boolean>((resolve) => {
      releaseRole1 = () => resolve(true);
    }));
    targets["role-2"].ensureInputFocus.mockReturnValue(new Promise<boolean>((resolve) => {
      releaseRole2 = () => resolve(true);
    }));
    const manager = createManager({ targets });

    const start = manager.start("macro-1");
    await vi.waitFor(() => {
      expect(targets["role-1"].ensureInputFocus).toHaveBeenCalledOnce();
      expect(targets["role-2"].ensureInputFocus).toHaveBeenCalledOnce();
    });

    expect(manager.listStatuses()).toEqual([]);
    expect(targets["role-1"].dispatchKey).not.toHaveBeenCalled();
    expect(targets["role-2"].dispatchKey).not.toHaveBeenCalled();
    releaseRole1();
    releaseRole2();
    await expect(start).resolves.toHaveLength(2);
  });

  it("rechecks an active role for every macro start without refocusing an already focused canvas", async () => {
    vi.useFakeTimers();
    const target = createTarget();
    const focusCanvas = vi.fn();
    let canvasFocused = false;
    target.ensureInputFocus.mockImplementation(async () => {
      if (canvasFocused) return true;
      canvasFocused = true;
      focusCanvas();
      return true;
    });
    const macros = Object.fromEntries(["macro-1", "macro-2", "macro-3"].map((id) => [id, {
      ...macro,
      id,
      roleIds: ["role-1"],
      steps: [{ id: `${id}-delay`, type: "delay" as const, ms: 1000 }]
    }]));
    const manager = createManager({ macroById: macros, targets: { "role-1": target } });

    await manager.start("macro-1");
    await manager.start("macro-2");

    expect(target.ensureInputFocus).toHaveBeenCalledTimes(2);
    expect(focusCanvas).toHaveBeenCalledOnce();

    canvasFocused = false;
    await manager.start("macro-3");
    expect(target.ensureInputFocus).toHaveBeenCalledTimes(3);
    expect(focusCanvas).toHaveBeenCalledTimes(2);

    await Promise.all([manager.stop("macro-1"), manager.stop("macro-2"), manager.stop("macro-3")]);
  });

  it("serializes concurrent input preparation for the same role", async () => {
    const target = createTarget();
    let releaseFirst!: () => void;
    target.ensureInputFocus
      .mockReturnValueOnce(new Promise<boolean>((resolve) => {
        releaseFirst = () => resolve(true);
      }))
      .mockResolvedValue(true);
    const macros = Object.fromEntries(["macro-1", "macro-2"].map((id) => [id, {
      ...macro,
      id,
      roleIds: ["role-1"]
    }]));
    const manager = createManager({ macroById: macros, targets: { "role-1": target } });

    const first = manager.start("macro-1");
    const second = manager.start("macro-2");
    await vi.waitFor(() => expect(target.ensureInputFocus).toHaveBeenCalledOnce());
    releaseFirst();
    await Promise.all([first, second]);

    expect(target.ensureInputFocus).toHaveBeenCalledTimes(2);
    expect(target.ensureInputFocus.mock.invocationCallOrder[0]).toBeLessThan(
      target.ensureInputFocus.mock.invocationCallOrder[1]
    );
  });

  it("waits for resource overrides before dispatch and clears them after completion", async () => {
    const target = createTarget();
    const setMacroActiveRoleIds = vi.fn(async () => undefined);
    const manager = new MacroManager(
      {
        getAutomationSession: vi.fn(() => ({ role: macroRole, target })),
        setMacroActiveRoleIds
      } as never,
      { getMacro: vi.fn(async () => ({ ...macro, roleIds: ["role-1"] })) } as never
    );

    await manager.start("macro-1");

    expect(setMacroActiveRoleIds).toHaveBeenCalledWith(["role-1"]);
    expect(setMacroActiveRoleIds.mock.invocationCallOrder[0]).toBeLessThan(
      target.dispatchKey.mock.invocationCallOrder[0]
    );
    await vi.waitFor(() => {
      expect(setMacroActiveRoleIds).toHaveBeenLastCalledWith([]);
    });
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

  it("starts available assigned roles and skips unavailable sessions", async () => {
    const target = createTarget();
    const manager = createManager({
      targets: { "role-1": target }
    });

    await expect(manager.start("macro-1")).resolves.toMatchObject([
      { roleId: "role-1", macroId: "macro-1", state: "running" }
    ]);
    await vi.waitFor(() => expect(target.dispatchKey).toHaveBeenCalledWith("F2", expect.any(AbortSignal)));
  });

  it("rejects when no assigned role has an available automation session", async () => {
    const manager = createManager({ targets: {} });

    await expect(manager.start("macro-1")).rejects.toThrow(
      "Launch at least one assigned role before running a macro."
    );
    expect(manager.listStatuses()).toEqual([]);
  });

  it("does not start a disabled macro", async () => {
    const target = createTarget();
    const manager = createManager({
      macroOverride: { ...macro, enabled: false },
      targets: { "role-1": target }
    });

    await expect(manager.start("macro-1")).rejects.toThrow("Enable this macro before running it.");
    expect(target.dispatchKey).not.toHaveBeenCalled();
    expect(manager.listStatuses()).toEqual([]);
  });

  it("enforces the requesting overlay role inside the start and stop lifecycle lock", async () => {
    const manager = createManager({
      macroOverride: { ...macro, roleIds: ["role-1"] }
    });

    await expect(manager.startForRole("macro-1", "role-2")).rejects.toThrow(
      "This macro is not assigned to the current role."
    );
    await expect(manager.stopForRole("macro-1", "role-2")).rejects.toThrow(
      "This macro is not assigned to the current role."
    );
    expect(manager.listStatuses()).toEqual([]);
  });

  it("starts available sibling roles from an assigned overlay role", async () => {
    const target = createTarget();
    const manager = createManager({ targets: { "role-1": target } });

    await expect(manager.startForRole("macro-1", "role-1")).resolves.toMatchObject([
      { roleId: "role-1", macroId: "macro-1", state: "running" }
    ]);
    await vi.waitFor(() => expect(target.dispatchKey).toHaveBeenCalledWith("F2", expect.any(AbortSignal)));
  });

  it("rejects when compatibility sessions have no automation target", async () => {
    const manager = createManager({
      runtimeStatuses: [{ roleId: "role-1", runtimeMode: "external", state: "running" }],
      targets: {}
    });

    await expect(manager.start("macro-1")).rejects.toThrow(
      "Launch at least one assigned role before running a macro."
    );
    expect(manager.listStatuses()).toEqual([]);
  });

  it("does not add a skipped role after a looping macro has started", async () => {
    const firstTarget = createTarget();
    const targets: Record<string, ReturnType<typeof createTarget>> = { "role-1": firstTarget };
    const manager = createManager({
      macroOverride: { ...macro, repeat: { type: "loop", intervalMs: 1 } },
      targets
    });

    await manager.start("macro-1");
    const lateTarget = createTarget();
    targets["role-2"] = lateTarget;
    await vi.waitFor(() => expect(firstTarget.dispatchKey.mock.calls.length).toBeGreaterThanOrEqual(2));

    expect(lateTarget.dispatchKey).not.toHaveBeenCalled();
    await manager.stop("macro-1");
  });

  it("runs macros across embedded and compatibility-mode automation targets", async () => {
    const targets = { "role-1": createTarget(), "role-2": createTarget() };
    const manager = createManager({
      macroOverride: { ...macro, roleIds: ["role-1", "role-2"] },
      runtimeStatuses: [{ roleId: "role-2", runtimeMode: "external", state: "running" }],
      targets
    });

    await manager.start("macro-1");
    await vi.waitFor(() => expect(targets["role-1"].dispatchKey).toHaveBeenCalledWith("F2", expect.any(AbortSignal)));
    await vi.waitFor(() => expect(targets["role-2"].dispatchKey).toHaveBeenCalledWith("F2", expect.any(AbortSignal)));
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

    expect(manager.listStatuses()).toMatchObject([{ macroId: "macro-2", state: "running" }]);
    await manager.stop("macro-2");
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
  });

  it("stops every sibling run when one assigned role closes", async () => {
    vi.useFakeTimers();
    const manager = createManager({
      macroOverride: {
        ...macro,
        steps: [{ id: "step-1", type: "delay", ms: 1000 }]
      }
    });

    await manager.start("macro-1");
    await manager.stopRole("role-1");

    expect(manager.listStatuses()).toEqual([]);
  });

  it("yields to timers even when legacy input contains a zero loop interval and zero delay", async () => {
    const manager = createManager({
      macroOverride: {
        ...macro,
        roleIds: ["role-1"],
        repeat: { type: "loop", intervalMs: 0 },
        steps: [{ id: "step-1", type: "delay", ms: 0 }]
      }
    });
    let timerFired = false;

    await manager.start("macro-1");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 5);
    });

    expect(timerFired).toBe(true);
    await manager.stop("macro-1");
  });

  it("rejects edits while any assigned role is still running", async () => {
    vi.useFakeTimers();
    const manager = createManager({
      macroOverride: {
        ...macro,
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "delay", ms: 1000 }]
      }
    });
    const operation = vi.fn().mockResolvedValue(undefined);

    await manager.start("macro-1");
    await expect(manager.runStoppedMutation("macro-1", operation)).rejects.toThrow(
      "Stop the macro before editing it."
    );
    expect(operation).not.toHaveBeenCalled();
    await manager.stop("macro-1");
  });

  it("holds all requested macro locks and rejects an import-style mutation while one is running", async () => {
    vi.useFakeTimers();
    const manager = createManager({
      macroOverride: {
        ...macro,
        roleIds: ["role-1"],
        steps: [{ id: "step-1", type: "delay", ms: 1000 }]
      }
    });
    const operation = vi.fn().mockResolvedValue(undefined);

    await manager.start("macro-1");
    await expect(manager.runStoppedMutations(["macro-2", "macro-1"], operation))
      .rejects.toBeInstanceOf(MacroMutationBusyError);
    expect(operation).not.toHaveBeenCalled();
    await manager.stop("macro-1");
    await expect(manager.runStoppedMutations(["macro-2", "macro-1"], operation)).resolves.toBeUndefined();
  });

  it("aborts a hung dispatch before a destructive mutation runs", async () => {
    const deferred = createDeferred<void>();
    const target = createTarget();
    target.dispatchKey.mockImplementation(() => deferred.promise);
    const manager = createManager({
      macroOverride: { ...macro, roleIds: ["role-1"] },
      targets: { "role-1": target }
    });
    const operation = vi.fn().mockResolvedValue("deleted");

    await manager.start("macro-1");
    await vi.waitFor(() => expect(target.dispatchKey).toHaveBeenCalled());
    const mutation = manager.stopAndRunMutation("macro-1", operation);

    await expect(mutation).resolves.toBe("deleted");
    expect(target.dispatchKey.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
    expect(manager.listStatuses()).toEqual([]);
    deferred.resolve(undefined);
  });

  it("fails a hung input after the operation timeout", async () => {
    vi.useFakeTimers();
    const target = createTarget();
    target.dispatchKey.mockImplementation(() => new Promise<void>(() => undefined));
    const manager = createManager({
      macroOverride: { ...macro, roleIds: ["role-1"] },
      targets: { "role-1": target }
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.start("macro-1");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(manager.listStatuses()).toEqual([
      expect.objectContaining({ state: "failed", error: "Macro input timed out after 10000 ms." })
    ]);
    expect(target.dispatchKey.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
    warning.mockRestore();
  });

  it("reports a failed role and cancels sibling roles after a partial execution failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failedTarget = createTarget();
    failedTarget.dispatchKey.mockRejectedValue(new Error("target detached"));
    const siblingTarget = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        repeat: { type: "loop", intervalMs: 1000 }
      },
      targets: { "role-1": failedTarget, "role-2": siblingTarget }
    });

    await manager.start("macro-1");
    await vi.waitFor(() => {
      expect(manager.listStatuses()).toEqual([
        expect.objectContaining({ roleId: "role-1", macroId: "macro-1", state: "failed", error: "target detached" }),
        expect.objectContaining({
          roleId: "role-2",
          macroId: "macro-1",
          state: "cancelled",
          error: "Cancelled because another assigned role failed."
        })
      ]);
    });
    expect(warning).toHaveBeenCalledWith("Macro execution failed.", expect.any(Error));

    await manager.stop("macro-1");
    expect(manager.listStatuses()).toEqual([]);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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
      )
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
    ensureInputFocus: vi.fn().mockResolvedValue(true),
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
  authState: "authenticated" as const,
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};
