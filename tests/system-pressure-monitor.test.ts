import type { CpuInfo } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { SystemPressureMonitor } from "../src/main/browser/SystemPressureMonitor";

describe("SystemPressureMonitor", () => {
  it("enters CPU pressure after three samples and recovers with longer hysteresis", () => {
    let user = 500;
    let idle = 500;
    const monitor = new SystemPressureMonitor({
      getCpuInfo: () => [cpu(user, idle)],
      getMemoryInfo: () => ({ free: 20, total: 100 })
    });
    const changes = vi.fn();
    monitor.on("change", changes);

    monitor.sample();
    for (let index = 0; index < 3; index += 1) {
      user += 90;
      idle += 10;
      monitor.sample();
    }
    expect(monitor.getSnapshot()).toEqual({ level: "constrained", reason: "cpu" });

    for (let index = 0; index < 4; index += 1) {
      user += 20;
      idle += 80;
      monitor.sample();
    }
    expect(monitor.getSnapshot().level).toBe("constrained");
    user += 20;
    idle += 80;
    monitor.sample();
    expect(monitor.getSnapshot()).toEqual({ level: "normal", reason: "baseline" });
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("uses memory and thermal pressure without relying on CPU metrics", () => {
    let free = 5;
    const monitor = new SystemPressureMonitor({
      getCpuInfo: () => [],
      getMemoryInfo: () => ({ free, total: 100 })
    });

    monitor.sample();
    monitor.sample();
    monitor.sample();
    expect(monitor.getSnapshot()).toEqual({ level: "constrained", reason: "memory" });

    free = 30;
    const thermalMonitor = new SystemPressureMonitor({
      getCpuInfo: () => [],
      getMemoryInfo: () => ({ free, total: 100 })
    });
    thermalMonitor.setThermalState("serious");
    expect(thermalMonitor.getSnapshot()).toEqual({ level: "constrained", reason: "thermal" });
  });
});

function cpu(user: number, idle: number): CpuInfo {
  return {
    model: "test",
    speed: 1,
    times: { user, nice: 0, sys: 0, idle, irq: 0 }
  };
}
