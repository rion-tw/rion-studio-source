import { EventEmitter } from "node:events";

import type { AppCoreClient } from "../core/nativeCore";
import type { WorkspacePressureLevel, WorkspaceResourceReason } from "../../shared/types";

export interface SystemPressureSnapshot {
  level: WorkspacePressureLevel;
  reason: Extract<WorkspaceResourceReason, "baseline" | "cpu" | "memory" | "thermal">;
}

export interface SystemPressureSource {
  getSnapshot: () => SystemPressureSnapshot;
  on: (event: "change", listener: (snapshot: SystemPressureSnapshot) => void) => unknown;
}

/**
 * Thin Electron adapter for the Rust sampler. The native core owns the only
 * periodic sampler and hysteresis state; Electron contributes power and
 * thermal notifications that are unavailable through the portable sampler.
 */
export class RustSystemPressureMonitor extends EventEmitter<{
  change: [SystemPressureSnapshot];
}> implements SystemPressureSource {
  private readonly unsubscribe: () => void;
  private snapshot: SystemPressureSnapshot = { level: "normal", reason: "baseline" };

  constructor(private readonly core: AppCoreClient) {
    super();
    this.unsubscribe = core.subscribe((events) => {
      events.forEach((event) => {
        if (event.type !== "pressureChanged") return;
        const snapshot = normalizeSnapshot(event.snapshot);
        if (
          snapshot.level === this.snapshot.level &&
          snapshot.reason === this.snapshot.reason
        ) {
          return;
        }
        this.snapshot = snapshot;
        this.emit("change", this.getSnapshot());
      });
    });
  }

  getSnapshot(): SystemPressureSnapshot {
    return { ...this.snapshot };
  }

  start(): void {
    // The Rust core starts exactly one sampler during createAppCore().
  }

  stop(): void {
    this.unsubscribe();
  }

  setSpeedLimit(limit: number): void {
    void this.core.invoke({
      type: "systemPressureUpdate",
      speedLimit: Number.isFinite(limit) ? limit : 100
    });
  }

  setThermalState(state: "unknown" | "nominal" | "fair" | "serious" | "critical"): void {
    void this.core.invoke({ type: "systemPressureUpdate", thermalState: state });
  }
}

function normalizeSnapshot(value: { level: "normal" | "constrained"; reason: string }): SystemPressureSnapshot {
  const reason = ["baseline", "cpu", "memory", "thermal"].includes(value.reason)
    ? value.reason as SystemPressureSnapshot["reason"]
    : "baseline";
  return { level: value.level, reason };
}
