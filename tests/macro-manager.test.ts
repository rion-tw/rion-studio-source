import { afterEach, describe, expect, it, vi } from "vitest";

import { MacroManager, MacroMutationBusyError } from "../src/main/macros/MacroManager";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { Macro, MacroSettings } from "../src/shared/types";

const testMacroSettings: MacroSettings = { ...DEFAULT_MACRO_SETTINGS, startupDelayMs: 0 };

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
      expect(target.dispatchKey).toHaveBeenCalledWith("F2", expectInputOptions());
      expect(target.dispatchClick).toHaveBeenCalledWith(25, 75, expectInputOptions(false));
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
      { getMacro: vi.fn(async () => ({ ...macro, roleIds: ["role-1"] })) } as never,
      { getSettings: vi.fn(async () => testMacroSettings) }
    );

    await manager.start("macro-1");
    await vi.waitFor(() => expect(target.dispatchKey).toHaveBeenCalledOnce());

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

  it("holds a key without blocking until an explicit stop releases it", async () => {
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        roleIds: ["role-1"],
        steps: [{
          id: "hold",
          type: "key",
          code: "KeyW",
          action: "hold_until_stop"
        }]
      },
      targets: { "role-1": target }
    });

    await manager.start("macro-1");
    await vi.waitFor(() => expect(target.holdKey).toHaveBeenCalledWith(
      "KeyW",
      expect.stringContaining("macro-invocation-"),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    ));
    expect(manager.listStatuses()).toMatchObject([{ state: "running" }]);
    expect(target.releaseKey).not.toHaveBeenCalled();

    await manager.stop("macro-1");
    expect(target.releaseKey).toHaveBeenCalledWith(
      "KeyW",
      expect.stringContaining("macro-invocation-")
    );
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
  });

  it("starts and releases a while-held macro for one or many assigned roles", async () => {
    const targets = {
      "role-1": createTarget(),
      "role-2": createTarget()
    };
    const manager = createManager({
      macroOverride: {
        ...macro,
        activationMode: "while_held",
        trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false },
        steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
      },
      targets
    });

    await expect(manager.pressForRole("macro-1", "role-1", "press-1")).resolves.toHaveLength(2);
    await vi.waitFor(() => {
      expect(targets["role-1"].holdKey).toHaveBeenCalledOnce();
      expect(targets["role-2"].holdKey).toHaveBeenCalledOnce();
    });

    await manager.releaseForRole("macro-1", "role-1", "press-1");
    expect(targets["role-1"].releaseKey).toHaveBeenCalledOnce();
    expect(targets["role-2"].releaseKey).toHaveBeenCalledOnce();
  });

  it("does not release a held invocation for a different source or press id", async () => {
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        activationMode: "while_held",
        roleIds: ["role-1", "role-2"],
        trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false },
        steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
      },
      targets: { "role-1": target }
    });

    await manager.pressForRole("macro-1", "role-1", "press-1");
    await vi.waitFor(() => expect(target.holdKey).toHaveBeenCalledOnce());
    await manager.releaseForRole("macro-1", "role-2", "press-1");
    await manager.releaseForRole("macro-1", "role-1", "press-2");
    expect(target.releaseKey).not.toHaveBeenCalled();

    await manager.releaseForRole("macro-1", "role-1", "press-1");
    expect(target.releaseKey).toHaveBeenCalledOnce();
  });

  it("uses distinct owners when two macros hold the same role key", async () => {
    const target = createTarget();
    const owners = new Set<string>();
    const physicalKeyDown = vi.fn();
    const physicalKeyUp = vi.fn();
    target.holdKey.mockImplementation(async (_code, ownerId) => {
      if (owners.size === 0) physicalKeyDown();
      owners.add(ownerId);
    });
    target.releaseKey.mockImplementation(async (_code, ownerId) => {
      owners.delete(ownerId);
      if (owners.size === 0) physicalKeyUp();
    });
    const macroById = Object.fromEntries(["macro-1", "macro-2"].map((id) => [id, {
      ...macro,
      id,
      roleIds: ["role-1"],
      steps: [{ id: `${id}-hold`, type: "key" as const, code: "KeyW", action: "hold_until_stop" as const }]
    }]));
    const manager = createManager({ macroById, targets: { "role-1": target } });

    await manager.start("macro-1");
    await manager.start("macro-2");
    await vi.waitFor(() => expect(target.holdKey).toHaveBeenCalledTimes(2));
    expect(new Set(target.holdKey.mock.calls.map(([, ownerId]) => ownerId)).size).toBe(2);
    expect(physicalKeyDown).toHaveBeenCalledOnce();

    await manager.stop("macro-1");
    expect(physicalKeyUp).not.toHaveBeenCalled();
    await manager.stop("macro-2");
    expect(physicalKeyUp).toHaveBeenCalledOnce();
  });

  it("serializes a quick release behind input preparation without dispatching a held key", async () => {
    const target = createTarget();
    const preparation = createDeferred<boolean>();
    target.ensureInputFocus.mockReturnValueOnce(preparation.promise);
    const manager = createManager({
      macroOverride: {
        ...macro,
        activationMode: "while_held",
        roleIds: ["role-1"],
        trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false },
        steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
      },
      targets: { "role-1": target }
    });

    const press = manager.pressForRole("macro-1", "role-1", "quick-press");
    await vi.waitFor(() => expect(target.ensureInputFocus).toHaveBeenCalledOnce());
    const release = manager.releaseForRole("macro-1", "role-1", "quick-press");
    preparation.resolve(true);
    await Promise.all([press, release]);

    expect(target.holdKey).not.toHaveBeenCalled();
    expect(manager.listStatuses()).toEqual([]);
  });

  it("cancels a press when its matching release is received first", async () => {
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        activationMode: "while_held",
        roleIds: ["role-1"],
        trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false }
      },
      targets: { "role-1": target }
    });

    await manager.releaseForRole("macro-1", "role-1", "release-first");
    await expect(manager.pressForRole("macro-1", "role-1", "release-first")).resolves.toEqual([]);
    expect(target.ensureInputFocus).not.toHaveBeenCalled();
    expect(target.dispatchKey).not.toHaveBeenCalled();
  });

  it("applies the startup buffer once before the first iteration", async () => {
    vi.useFakeTimers();
    const target = createTarget();
    const manager = createManager({
      macroOverride: {
        ...macro,
        roleIds: ["role-1"],
        repeat: { type: "loop", intervalMs: 50 }
      },
      settings: { ...DEFAULT_MACRO_SETTINGS, startupDelayMs: 100 },
      targets: { "role-1": target }
    });

    await manager.start("macro-1");
    await vi.advanceTimersByTimeAsync(99);
    expect(target.dispatchKey).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(target.dispatchKey).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(target.dispatchKey).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(target.dispatchKey).toHaveBeenCalledTimes(2);

    await manager.stop("macro-1");
  });

  it("captures settings at start and applies later changes only to new runs", async () => {
    vi.useFakeTimers();
    const target = createTarget();
    let settings: MacroSettings = { ...DEFAULT_MACRO_SETTINGS, startupDelayMs: 100 };
    const getSettings = vi.fn(async () => ({ ...settings }));
    const manager = createManager({
      macroOverride: { ...macro, roleIds: ["role-1"] },
      getSettings,
      targets: { "role-1": target }
    });

    await manager.start("macro-1");
    settings = { ...DEFAULT_MACRO_SETTINGS, startupDelayMs: 0, keyHoldMs: 80 };
    await vi.advanceTimersByTimeAsync(100);
    expect(target.dispatchKey).toHaveBeenCalledWith(
      "F2",
      expect.objectContaining({ holdMs: 30, postDelayMs: 30 })
    );
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));

    target.dispatchKey.mockClear();
    await manager.start("macro-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(target.dispatchKey).toHaveBeenCalledWith(
      "F2",
      expect.objectContaining({ holdMs: 80, postDelayMs: 30 })
    );
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it("starts available assigned roles and skips unavailable sessions", async () => {
    const target = createTarget();
    const manager = createManager({
      targets: { "role-1": target }
    });

    await expect(manager.start("macro-1")).resolves.toMatchObject([
      { roleId: "role-1", macroId: "macro-1", state: "running" }
    ]);
    await vi.waitFor(() => expect(target.dispatchKey).toHaveBeenCalledWith("F2", expectInputOptions()));
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
    await vi.waitFor(() => expect(target.dispatchKey).toHaveBeenCalledWith("F2", expectInputOptions()));
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
    await vi.waitFor(() => expect(targets["role-1"].dispatchKey).toHaveBeenCalledWith("F2", expectInputOptions()));
    await vi.waitFor(() => expect(targets["role-2"].dispatchKey).toHaveBeenCalledWith("F2", expectInputOptions()));
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
    expect(target.dispatchKey.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
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
    expect(target.dispatchKey.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
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

  it("runs a called macro synchronously before continuing the parent", async () => {
    const parentTarget = createTarget();
    const childTarget = createTarget();
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["role-parent"],
      steps: [
        { id: "before", type: "key", code: "KeyA" },
        { id: "call", type: "macro", macroId: "child" },
        { id: "after", type: "key", code: "KeyC" }
      ]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["role-child"],
      steps: [{ id: "child-key", type: "key", code: "KeyB" }]
    };
    const manager = createManager({
      macroById: { parent, child },
      targets: { "role-parent": parentTarget, "role-child": childTarget }
    });

    await manager.start("parent");
    await vi.waitFor(() => expect(parentTarget.dispatchKey).toHaveBeenCalledTimes(2));

    expect(parentTarget.dispatchKey).toHaveBeenNthCalledWith(1, "KeyA", expectInputOptions());
    expect(childTarget.dispatchKey).toHaveBeenCalledWith("KeyB", expectInputOptions());
    expect(parentTarget.dispatchKey).toHaveBeenNthCalledWith(2, "KeyC", expectInputOptions());
    expect(parentTarget.dispatchKey.mock.invocationCallOrder[0]).toBeLessThan(
      childTarget.dispatchKey.mock.invocationCallOrder[0]
    );
    expect(childTarget.dispatchKey.mock.invocationCallOrder[0]).toBeLessThan(
      parentTarget.dispatchKey.mock.invocationCallOrder[1]
    );
  });

  it("waits at a multi-role barrier and creates only one child invocation", async () => {
    const firstParentTarget = createTarget();
    const secondParentTarget = createTarget();
    const childTarget = createTarget();
    const delayedParent = createDeferred<void>();
    secondParentTarget.dispatchKey.mockImplementationOnce(() => delayedParent.promise);
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-1", "parent-2"],
      steps: [
        { id: "before", type: "key", code: "KeyA" },
        { id: "call", type: "macro", macroId: "child" }
      ]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["child-role"],
      steps: [{ id: "child-key", type: "key", code: "KeyB" }]
    };
    const manager = createManager({
      macroById: { parent, child },
      targets: {
        "parent-1": firstParentTarget,
        "parent-2": secondParentTarget,
        "child-role": childTarget
      }
    });

    await manager.start("parent");
    await vi.waitFor(() => expect(firstParentTarget.dispatchKey).toHaveBeenCalledOnce());
    expect(childTarget.ensureInputFocus).not.toHaveBeenCalled();

    delayedParent.resolve(undefined);
    await vi.waitFor(() => expect(childTarget.dispatchKey).toHaveBeenCalledOnce());
    expect(childTarget.ensureInputFocus).toHaveBeenCalledOnce();
  });

  it("waits for every called-macro role before all parent roles continue", async () => {
    const parentTargets = { first: createTarget(), second: createTarget() };
    const childTargets = { first: createTarget(), second: createTarget() };
    const delayedChild = createDeferred<void>();
    childTargets.second.dispatchKey.mockImplementationOnce(() => delayedChild.promise);
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-1", "parent-2"],
      steps: [
        { id: "call", type: "macro", macroId: "child" },
        { id: "after", type: "key", code: "KeyC" }
      ]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["child-1", "child-2"],
      steps: [{ id: "child-key", type: "key", code: "KeyB" }]
    };
    const manager = createManager({
      macroById: { parent, child },
      targets: {
        "parent-1": parentTargets.first,
        "parent-2": parentTargets.second,
        "child-1": childTargets.first,
        "child-2": childTargets.second
      }
    });

    await manager.start("parent");
    await vi.waitFor(() => expect(childTargets.first.dispatchKey).toHaveBeenCalledOnce());
    expect(parentTargets.first.dispatchKey).not.toHaveBeenCalled();
    expect(parentTargets.second.dispatchKey).not.toHaveBeenCalled();

    delayedChild.resolve(undefined);
    await vi.waitFor(() => expect(parentTargets.first.dispatchKey).toHaveBeenCalledWith(
      "KeyC",
      expectInputOptions()
    ));
    expect(parentTargets.second.dispatchKey).toHaveBeenCalledWith("KeyC", expectInputOptions());
  });

  it("fails the parent when the called macro is already active", async () => {
    vi.useFakeTimers();
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-role"],
      steps: [{ id: "call", type: "macro", macroId: "child" }]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["child-role"],
      steps: [{ id: "wait", type: "delay", ms: 1000 }]
    };
    const manager = createManager({
      macroById: { parent, child },
      targets: { "parent-role": createTarget(), "child-role": createTarget() }
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.start("child");
    await manager.start("parent");
    await vi.waitFor(() => expect(manager.listStatuses()).toContainEqual(
      expect.objectContaining({
        macroId: "parent",
        state: "failed",
        error: "Called macro \"Child\" is already running."
      })
    ));

    await manager.stop("child");
    await manager.stop("parent");
    warning.mockRestore();
  });

  it("cancels the parent when its owned called invocation is manually stopped", async () => {
    vi.useFakeTimers();
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-role"],
      steps: [
        { id: "call", type: "macro", macroId: "child" },
        { id: "after", type: "key", code: "KeyC" }
      ]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["child-role"],
      steps: [{ id: "wait", type: "delay", ms: 1000 }]
    };
    const parentTarget = createTarget();
    const manager = createManager({
      macroById: { parent, child },
      targets: { "parent-role": parentTarget, "child-role": createTarget() }
    });

    await manager.start("parent");
    await vi.waitFor(() => expect(manager.listStatuses()).toContainEqual(
      expect.objectContaining({ macroId: "child", state: "running" })
    ));
    await manager.stop("child");
    await vi.waitFor(() => expect(manager.listStatuses()).toContainEqual(
      expect.objectContaining({
        macroId: "parent",
        state: "cancelled",
        error: "Cancelled because a called macro was stopped."
      })
    ));
    expect(parentTarget.dispatchKey).not.toHaveBeenCalled();
    await manager.stop("parent");
  });

  it("stopping a parent recursively stops its child without affecting unrelated runs", async () => {
    vi.useFakeTimers();
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-role"],
      steps: [{ id: "call", type: "macro", macroId: "child" }]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["child-role"],
      steps: [{ id: "wait", type: "delay", ms: 1000 }]
    };
    const unrelated: Macro = {
      ...macro,
      id: "unrelated",
      roleIds: ["unrelated-role"],
      steps: [{ id: "wait", type: "delay", ms: 1000 }]
    };
    const manager = createManager({
      macroById: { parent, child, unrelated },
      targets: {
        "parent-role": createTarget(),
        "child-role": createTarget(),
        "unrelated-role": createTarget()
      }
    });

    await manager.start("unrelated");
    await manager.start("parent");
    await vi.waitFor(() => expect(manager.listStatuses()).toContainEqual(
      expect.objectContaining({ macroId: "child", state: "running" })
    ));
    await manager.stop("parent");

    expect(manager.listStatuses()).toEqual([
      expect.objectContaining({ macroId: "unrelated", state: "running" })
    ]);
    await manager.stop("unrelated");
  });

  it("supports nested synchronous macro calls", async () => {
    const targets = { a: createTarget(), b: createTarget(), c: createTarget() };
    const macroA: Macro = {
      ...macro,
      id: "a",
      roleIds: ["role-a"],
      steps: [
        { id: "call-b", type: "macro", macroId: "b" },
        { id: "key-a", type: "key", code: "KeyA" }
      ]
    };
    const macroB: Macro = {
      ...macro,
      id: "b",
      roleIds: ["role-b"],
      steps: [
        { id: "call-c", type: "macro", macroId: "c" },
        { id: "key-b", type: "key", code: "KeyB" }
      ]
    };
    const macroC: Macro = {
      ...macro,
      id: "c",
      roleIds: ["role-c"],
      steps: [{ id: "key-c", type: "key", code: "KeyC" }]
    };
    const manager = createManager({
      macroById: { a: macroA, b: macroB, c: macroC },
      targets: { "role-a": targets.a, "role-b": targets.b, "role-c": targets.c }
    });

    await manager.start("a");
    await vi.waitFor(() => expect(targets.a.dispatchKey).toHaveBeenCalledOnce());
    expect(targets.c.dispatchKey.mock.invocationCallOrder[0]).toBeLessThan(
      targets.b.dispatchKey.mock.invocationCallOrder[0]
    );
    expect(targets.b.dispatchKey.mock.invocationCallOrder[0]).toBeLessThan(
      targets.a.dispatchKey.mock.invocationCallOrder[0]
    );
  });

  it("propagates a called macro failure to its parent", async () => {
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-role"],
      steps: [{ id: "call", type: "macro", macroId: "child" }]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["child-role"],
      steps: [{ id: "key", type: "key", code: "F2" }]
    };
    const childTarget = createTarget();
    childTarget.dispatchKey.mockRejectedValue(new Error("child target detached"));
    const manager = createManager({
      macroById: { parent, child },
      targets: { "parent-role": createTarget(), "child-role": childTarget }
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.start("parent");
    await vi.waitFor(() => expect(manager.listStatuses()).toContainEqual(
      expect.objectContaining({ macroId: "parent", state: "failed", error: "child target detached" })
    ));
    expect(manager.listStatuses()).toContainEqual(
      expect.objectContaining({ macroId: "child", state: "failed", error: "child target detached" })
    );
    await manager.stop("parent");
    await manager.stop("child");
    warning.mockRestore();
  });

  it.each([
    {
      childEnabled: false,
      expectedError: "Enable this macro before running it.",
      includeChildTarget: true
    },
    {
      childEnabled: true,
      expectedError: "Launch at least one assigned role before running a macro.",
      includeChildTarget: false
    }
  ])("fails the parent when a called macro cannot start", async ({
    childEnabled,
    expectedError,
    includeChildTarget
  }) => {
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-role"],
      steps: [{ id: "call", type: "macro", macroId: "child" }]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      enabled: childEnabled,
      name: "Child",
      roleIds: ["child-role"]
    };
    const manager = createManager({
      macroById: { parent, child },
      targets: {
        "parent-role": createTarget(),
        ...(includeChildTarget ? { "child-role": createTarget() } : {})
      }
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await manager.start("parent");
    await vi.waitFor(() => expect(manager.listStatuses()).toContainEqual(
      expect.objectContaining({ macroId: "parent", state: "failed", error: expectedError })
    ));
    await manager.stop("parent");
    warning.mockRestore();
  });

  it("calls a run-once child again on every parent loop iteration", async () => {
    const childTarget = createTarget();
    const parent: Macro = {
      ...macro,
      id: "parent",
      roleIds: ["parent-role"],
      repeat: { type: "loop", intervalMs: 1 },
      steps: [{ id: "call", type: "macro", macroId: "child" }]
    };
    const child: Macro = {
      ...macro,
      id: "child",
      name: "Child",
      roleIds: ["child-role"],
      steps: [{ id: "key", type: "key", code: "F2" }]
    };
    const manager = createManager({
      macroById: { parent, child },
      targets: { "parent-role": createTarget(), "child-role": childTarget }
    });

    await manager.start("parent");
    await vi.waitFor(() => expect(childTarget.dispatchKey.mock.calls.length).toBeGreaterThanOrEqual(2));
    await manager.stop("parent");
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
  settings?: MacroSettings;
  getSettings?: () => Promise<MacroSettings>;
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
    } as never,
    { getSettings: vi.fn(options.getSettings ?? (async () => options.settings ?? testMacroSettings)) }
  );
}

function expectInputOptions(includeHold = true) {
  return expect.objectContaining({
    ...(includeHold ? { holdMs: 30 } : {}),
    postDelayMs: 30,
    signal: expect.any(AbortSignal)
  });
}

function createTarget() {
  return {
    dispatchClick: vi.fn().mockResolvedValue(undefined),
    dispatchKey: vi.fn().mockResolvedValue(undefined),
    holdKey: vi.fn().mockResolvedValue(undefined),
    releaseKey: vi.fn().mockResolvedValue(undefined),
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
