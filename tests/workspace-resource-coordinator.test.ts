import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { SystemPressureSnapshot } from "../src/main/browser/SystemPressureMonitor";

import {
  WorkspaceResourceCoordinator,
  type WorkspaceResourceTarget
} from "../src/main/browser/WorkspaceResourceCoordinator";

describe("WorkspaceResourceCoordinator", () => {
  it("adapts background roles from 2x to 4x when system pressure rises", async () => {
    let snapshot: SystemPressureSnapshot = { level: "normal", reason: "baseline" };
    const pressure = Object.assign(new EventEmitter(), { getSnapshot: () => snapshot });
    const coordinator = new WorkspaceResourceCoordinator(pressure);
    const first = createTarget("role-1");
    const second = createTarget("role-2");

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "adaptive", backgroundCpuThrottleRate: 4, primaryRoleId: "role-1" },
      [first.target, second.target]
    );
    expect(second.setRate).toHaveBeenLastCalledWith(2);
    expect(coordinator.getStatus("role-2")).toMatchObject({
      cpuThrottleRate: 2,
      resourcePressureLevel: "normal",
      resourceReason: "baseline"
    });

    snapshot = { level: "constrained", reason: "cpu" };
    pressure.emit("change", snapshot);
    await vi.waitFor(() => expect(second.setRate).toHaveBeenLastCalledWith(4));
    expect(coordinator.getStatus("role-2")).toMatchObject({
      cpuThrottleRate: 4,
      resourcePressureLevel: "constrained",
      resourceReason: "cpu"
    });
  });

  it("keeps the configured primary at 1x and throttles the other roles", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 2, primaryRoleId: "role-1" },
      [first.target, second.target]
    );

    expect(first.setRate).toHaveBeenCalledWith(1);
    expect(second.setRate).toHaveBeenCalledWith(2);
    expect(first.focus).toHaveBeenCalledOnce();
    expect(coordinator.getStatus("role-1")).toEqual({ resourceState: "primary", cpuThrottleRate: 1 });
    expect(coordinator.getStatus("role-2")).toEqual({ resourceState: "throttled", cpuThrottleRate: 2 });
  });

  it("uses the first target when no initial primary is configured", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 2 },
      [first.target, second.target]
    );

    expect(first.setRate).toHaveBeenCalledWith(1);
    expect(second.setRate).toHaveBeenCalledWith(2);
    expect(first.focus).toHaveBeenCalledOnce();
    expect(coordinator.getStatus("role-1")?.resourceState).toBe("primary");
  });

  it("restores the new primary before slowing the old primary", async () => {
    const operations: string[] = [];
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1", { operations });
    const second = createTarget("role-2", { operations });
    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 4, primaryRoleId: "role-1" },
      [first.target, second.target]
    );
    operations.length = 0;

    second.emitFocus();

    await vi.waitFor(() => {
      expect(coordinator.getStatus("role-2")?.resourceState).toBe("primary");
    });
    const restoreIndex = operations.indexOf("role-2:1");
    const throttleIndex = operations.indexOf("role-1:4");
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(throttleIndex).toBeGreaterThan(restoreIndex);
  });

  it("temporarily restores macro roles and reapplies the policy afterwards", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");
    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 2, primaryRoleId: "role-1" },
      [first.target, second.target]
    );

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

  it("protects every role sharing the primary renderer process", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1", { processId: 101 });
    const second = createTarget("role-2", { processId: 101 });

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 4, primaryRoleId: "role-1" },
      [first.target, second.target]
    );

    expect(second.setRate).toHaveBeenLastCalledWith(1);
    expect(coordinator.getStatus("role-2")).toEqual({
      resourceState: "shared_process",
      cpuThrottleRate: 1,
      resourceReason: "shared_process"
    });
  });

  it("regroups and reapplies rates after an embedded renderer PID changes", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1", { processId: 101 });
    const second = createTarget("role-2", { processId: 101 });
    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 2, primaryRoleId: "role-1" },
      [first.target, second.target]
    );

    second.setProcessId(202);
    second.emitInvalidated();

    await vi.waitFor(() => {
      expect(coordinator.getStatus("role-2")).toEqual({
        resourceState: "throttled",
        cpuThrottleRate: 2
      });
    });
  });

  it("fails open and reports unavailable when a CDP command fails", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2", { rejectRate: 2 });

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 2, primaryRoleId: "role-1" },
      [first.target, second.target]
    );

    expect(second.release).toHaveBeenCalledOnce();
    expect(coordinator.getStatus("role-2")).toEqual({
      resourceState: "unavailable",
      cpuThrottleRate: 1,
      resourceReason: "unavailable"
    });
  });

  it("does nothing for unrestricted or single-role workspaces", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");

    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "unrestricted", backgroundCpuThrottleRate: 2 },
      [first.target, second.target]
    );
    await coordinator.activateWorkspace(
      "workspace-2",
      { mode: "primary_priority", backgroundCpuThrottleRate: 2, primaryRoleId: "role-1" },
      [first.target]
    );

    expect(first.setRate).not.toHaveBeenCalled();
    expect(second.setRate).not.toHaveBeenCalled();
  });

  it("releases the remaining role when the primary runtime disappears", async () => {
    const coordinator = new WorkspaceResourceCoordinator();
    const first = createTarget("role-1");
    const second = createTarget("role-2");
    await coordinator.activateWorkspace(
      "workspace-1",
      { mode: "primary_priority", backgroundCpuThrottleRate: 4, primaryRoleId: "role-1" },
      [first.target, second.target]
    );

    await coordinator.reconcileRuntimeRoleIds("embedded", ["role-2"]);

    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).toHaveBeenCalledOnce();
    expect(coordinator.getStatus("role-1")).toBeUndefined();
    expect(coordinator.getStatus("role-2")).toBeUndefined();
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
  const focusListeners = new Set<() => void>();
  const invalidationListeners = new Set<() => void>();
  let processId = options.processId;
  const setRate = vi.fn(async (rate: 1 | 2 | 4) => {
    options.operations?.push(`${roleId}:${rate}`);
    if (options.rejectRate === rate) {
      throw new Error("CDP unavailable");
    }
  });
  const release = vi.fn(async () => undefined);
  const focus = vi.fn(async () => undefined);
  const target: WorkspaceResourceTarget = {
    roleId,
    runtimeMode: "embedded",
    focus,
    getProcessId: () => processId,
    onFocus: (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    onInvalidated: (listener) => {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
    releaseThrottle: release,
    setCpuThrottleRate: setRate
  };
  return {
    emitFocus: () => focusListeners.forEach((listener) => listener()),
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
