import { describe, expect, it, vi } from "vitest";

import { RustSystemPressureMonitor } from "../src/main/browser/RustSystemPressureMonitor";
import type { CoreEvent } from "../src/shared/generated";

describe("RustSystemPressureMonitor", () => {
  it("forwards one merged native pressure event", () => {
    let listener: ((events: CoreEvent[]) => void) | undefined;
    const unsubscribe = vi.fn();
    const core = {
      subscribe: vi.fn((next: (events: CoreEvent[]) => void) => {
        listener = next;
        return unsubscribe;
      }),
      updateSystemPressureSignals: vi.fn()
    };
    const monitor = new RustSystemPressureMonitor(core as never);
    const onChange = vi.fn();
    monitor.on("change", onChange);

    listener?.([{
      type: "pressureChanged",
      snapshot: { level: "constrained", reason: "memory" }
    }]);

    expect(monitor.getSnapshot()).toEqual({ level: "constrained", reason: "memory" });
    expect(onChange).toHaveBeenCalledTimes(1);
    monitor.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("passes Electron power signals to the native worker", () => {
    const updateSystemPressureSignals = vi.fn();
    const monitor = new RustSystemPressureMonitor({
      subscribe: vi.fn(() => vi.fn()),
      updateSystemPressureSignals
    } as never);

    monitor.setSpeedLimit(70);
    monitor.setThermalState("critical");

    expect(updateSystemPressureSignals).toHaveBeenNthCalledWith(1, { speedLimit: 70 });
    expect(updateSystemPressureSignals).toHaveBeenNthCalledWith(2, { thermalState: "critical" });
  });
});
