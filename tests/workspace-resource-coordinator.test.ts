import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SystemPressureSnapshot } from "../src/main/browser/SystemPressureMonitor";
import {
  WorkspaceResourceCoordinator,
  type WorkspaceResourceTarget
} from "../src/main/browser/WorkspaceResourceCoordinator";

describe("WorkspaceResourceCoordinator", () => {
  it("keeps every visible adaptive role at full speed without attaching CDP", async () => {
    let snapshot: SystemPressureSnapshot = { level: "normal", reason: "baseline" };
    const pressure = Object.assign(new EventEmitter(), { getSnapshot: () => snapshot });
    const coordinator = new WorkspaceResourceCoordinator(pressure);
    const first = createTarget("role-1");
    const second = createTarget("role-2");

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "adaptive" },
      [first.target, second.target]
    );

    expect(first.focus).toHaveBeenCalledOnce();
    expect(first.setRate).not.toHaveBeenCalled();
    expect(second.setRate).not.toHaveBeenCalled();
    expect(coordinator.getStatus("role-1")).toBeUndefined();
    expect(coordinator.getStatus("role-2")).toBeUndefined();

    snapshot = { level: "constrained", reason: "cpu" };
    pressure.emit("change", snapshot);
    await Promise.resolve();
    expect(first.setRate).not.toHaveBeenCalled();
    expect(second.setRate).not.toHaveBeenCalled();
  });

  it("focuses the first target when a workspace is activated", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "adaptive" },
      [first.target, second.target]
    );

    expect(first.focus).toHaveBeenCalledOnce();
    expect(second.focus).not.toHaveBeenCalled();
    expect(first.setRate).not.toHaveBeenCalled();
    expect(second.setRate).not.toHaveBeenCalled();
  });

  it("adapts hidden tabs from 2x to 4x and reports the actual reason", async () => {
    let snapshot: SystemPressureSnapshot = { level: "normal", reason: "baseline" };
    const pressure = Object.assign(new EventEmitter(), { getSnapshot: () => snapshot });
    const coordinator = new WorkspaceResourceCoordinator(pressure);
    const target = createTarget("role-1");
    await coordinator.activateWorkspace("tab-1", { mode: "adaptive" }, [target.target]);

    await coordinator.setHiddenRuntimeTabIds(["tab-1"]);
    expect(target.setRate).toHaveBeenLastCalledWith(2);
    expect(coordinator.getStatus("role-1")).toEqual({
      resourceState: "throttled",
      cpuThrottleRate: 2,
      resourcePressureLevel: "normal",
      resourceReason: "runtime_tab_background"
    });

    snapshot = { level: "constrained", reason: "memory" };
    pressure.emit("change", snapshot);
    await vi.waitFor(() => expect(target.setRate).toHaveBeenLastCalledWith(4));
    expect(coordinator.getStatus("role-1")?.resourceReason).toBe("memory");
  });

  it("never attaches CDP for unrestricted tabs, including hidden tabs", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const target = createTarget("role-1");
    await coordinator.activateWorkspace("tab-1", { mode: "unrestricted" }, [target.target]);

    await coordinator.setHiddenRuntimeTabIds(["tab-1"]);

    expect(target.setRate).not.toHaveBeenCalled();
    expect(target.release).toHaveBeenCalled();
    expect(coordinator.getStatus("role-1")).toBeUndefined();
  });

  it("temporarily restores macro roles in hidden tabs and reapplies throttling afterwards", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");
    await coordinator.activateWorkspace("tab-1", { mode: "adaptive" }, [first.target, second.target]);
    await coordinator.setHiddenRuntimeTabIds(["tab-1"]);

    await coordinator.setMacroActiveRoleIds(["role-2"]);
    expect(second.setRate).toHaveBeenLastCalledWith(1);
    expect(coordinator.getStatus("role-2")).toEqual({
      resourceState: "macro_override",
      cpuThrottleRate: 1,
      resourceReason: "macro"
    });

    await coordinator.setMacroActiveRoleIds([]);
    expect(second.setRate).toHaveBeenLastCalledWith(2);
    expect(coordinator.getStatus("role-2")?.resourceState).toBe("throttled");
  });

  it("keeps a renderer process shared with a macro role at full speed", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1", { processId: 101 });
    const second = createTarget("role-2", { processId: 101 });
    await coordinator.activateWorkspace("tab-1", { mode: "adaptive" }, [first.target, second.target]);
    await coordinator.setHiddenRuntimeTabIds(["tab-1"]);

    await coordinator.setMacroActiveRoleIds(["role-1"]);

    expect(second.setRate).toHaveBeenLastCalledWith(1);
    expect(coordinator.getStatus("role-2")).toEqual({
      resourceState: "shared_process",
      cpuThrottleRate: 1,
      resourceReason: "shared_process"
    });
  });

  it("regroups after renderer invalidation and fails open when CDP is unavailable", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1", { processId: 101 });
    const second = createTarget("role-2", { processId: 101, rejectRate: 2 });
    await coordinator.activateWorkspace("tab-1", { mode: "adaptive" }, [first.target, second.target]);
    await coordinator.setMacroActiveRoleIds(["role-1"]);
    await coordinator.setHiddenRuntimeTabIds(["tab-1"]);

    second.setProcessId(202);
    second.emitInvalidated();

    await vi.waitFor(() => {
      expect(coordinator.getStatus("role-2")).toEqual({
        resourceState: "unavailable",
        cpuThrottleRate: 1,
        resourceReason: "unavailable"
      });
    });
    expect(second.release).toHaveBeenCalled();
  });

  it("releases throttling before a hidden workspace returns to the foreground", async () => {
    const operations: string[] = [];
    const coordinator = new WorkspaceResourceCoordinator();
    const target = createTarget("role-1", { operations });
    await coordinator.activateWorkspace("tab-1", { mode: "adaptive" }, [target.target]);
    await coordinator.setHiddenRuntimeTabIds(["tab-1"]);
    operations.length = 0;

    await coordinator.prepareWorkspaceForeground("tab-1");

    expect(operations).toEqual(["role-1:release"]);
    expect(coordinator.getStatus("role-1")).toBeUndefined();
  });

  it("releases removed targets and clears their state", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");
    await coordinator.activateWorkspace("tab-1", { mode: "adaptive" }, [first.target, second.target]);
    await coordinator.setHiddenRuntimeTabIds(["tab-1"]);

    await coordinator.reconcileRuntimeRoleIds("embedded", ["role-2"]);

    expect(first.release).toHaveBeenCalled();
    expect(coordinator.getStatus("role-1")).toBeUndefined();
    expect(coordinator.getStatus("role-2")?.resourceState).toBe("throttled");
  });
});

function createTarget(
  roleId: string,
  options: {
    operations?: string[];
    processId?: number;
    rejectRate?: 1 | 2 | 4;
  } = {}
) {
  const invalidationListeners = new Set<() => void>();
  let processId = options.processId;
  const setRate = vi.fn(async (rate: 1 | 2 | 4) => {
    options.operations?.push(`${roleId}:${rate}`);
    if (options.rejectRate === rate) throw new Error("CDP unavailable");
  });
  const release = vi.fn(async () => {
    options.operations?.push(`${roleId}:release`);
  });
  const focus = vi.fn(async () => undefined);
  const target: WorkspaceResourceTarget = {
    roleId,
    runtimeMode: "embedded",
    focus,
    getProcessId: () => processId,
    onInvalidated: (listener) => {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    releaseThrottle: release,
    setCpuThrottleRate: setRate
  };
  return {
    emitInvalidated: () => invalidationListeners.forEach((listener) => listener()),
    focus,
    release,
    setProcessId: (nextProcessId: number) => {
      processId = nextProcessId;
    },
    setRate,
    target
  };
}
