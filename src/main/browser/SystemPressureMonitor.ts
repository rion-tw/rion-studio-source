import { cpus, type CpuInfo } from "node:os";
import { EventEmitter } from "node:events";

import type {
  WorkspacePressureLevel,
  WorkspaceResourceReason
} from "../../shared/types";

export interface SystemPressureSnapshot {
  level: WorkspacePressureLevel;
  reason: Extract<WorkspaceResourceReason, "baseline" | "cpu" | "memory" | "thermal">;
}

export interface SystemPressureSource {
  getSnapshot: () => SystemPressureSnapshot;
  on: (event: "change", listener: (snapshot: SystemPressureSnapshot) => void) => unknown;
}

interface MemorySnapshot {
  free: number;
  purgeable?: number;
  total: number;
}

export interface SystemPressureMonitorOptions {
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  getCpuInfo?: () => CpuInfo[];
  getMemoryInfo?: () => MemorySnapshot;
  sampleIntervalMs?: number;
  setInterval?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
}

interface CpuTotals {
  busy: number;
  total: number;
}

const ENTER_CPU_RATIO = 0.8;
const EXIT_CPU_RATIO = 0.65;
const ENTER_MEMORY_RATIO = 0.1;
const EXIT_MEMORY_RATIO = 0.15;
const ENTER_SAMPLE_COUNT = 3;
const EXIT_SAMPLE_COUNT = 5;

export class SystemPressureMonitor extends EventEmitter<{ change: [SystemPressureSnapshot] }> {
  private constrainedSamples = 0;
  private healthySamples = 0;
  private previousCpuTotals?: CpuTotals;
  private snapshot: SystemPressureSnapshot = { level: "normal", reason: "baseline" };
  private speedLimit = 100;
  private thermalState: "unknown" | "nominal" | "fair" | "serious" | "critical" = "unknown";
  private timer?: ReturnType<typeof setInterval>;
  private readonly clearTimer: NonNullable<SystemPressureMonitorOptions["clearInterval"]>;
  private readonly getCpuInfo: NonNullable<SystemPressureMonitorOptions["getCpuInfo"]>;
  private readonly getMemoryInfo: NonNullable<SystemPressureMonitorOptions["getMemoryInfo"]>;
  private readonly sampleIntervalMs: number;
  private readonly setTimer: NonNullable<SystemPressureMonitorOptions["setInterval"]>;

  constructor(options: SystemPressureMonitorOptions = {}) {
    super();
    this.clearTimer = options.clearInterval ?? clearInterval;
    this.getCpuInfo = options.getCpuInfo ?? cpus;
    this.getMemoryInfo = options.getMemoryInfo ?? (() => {
      const electronProcess = process as NodeJS.Process & {
        getSystemMemoryInfo?: () => MemorySnapshot;
      };
      return electronProcess.getSystemMemoryInfo?.() ?? { free: 0, total: 0 };
    });
    this.sampleIntervalMs = options.sampleIntervalMs ?? 2_000;
    this.setTimer = options.setInterval ?? setInterval;
  }

  getSnapshot(): SystemPressureSnapshot {
    return { ...this.snapshot };
  }

  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = this.setTimer(() => this.sample(), this.sampleIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }

  setSpeedLimit(limit: number): void {
    this.speedLimit = Number.isFinite(limit) ? limit : 100;
    this.evaluate(undefined, this.readMemoryRatio());
  }

  setThermalState(state: typeof this.thermalState): void {
    this.thermalState = state;
    this.evaluate(undefined, this.readMemoryRatio());
  }

  sample(): void {
    const current = createCpuTotals(this.getCpuInfo());
    const previous = this.previousCpuTotals;
    this.previousCpuTotals = current;
    const totalDelta = previous ? current.total - previous.total : 0;
    const busyDelta = previous ? current.busy - previous.busy : 0;
    const cpuRatio = totalDelta > 0 ? Math.max(0, Math.min(1, busyDelta / totalDelta)) : undefined;
    this.evaluate(cpuRatio, this.readMemoryRatio());
  }

  private readMemoryRatio(): number | undefined {
    const memory = this.getMemoryInfo();
    const available = memory.free + (memory.purgeable ?? 0);
    return memory.total > 0 ? Math.max(0, Math.min(1, available / memory.total)) : undefined;
  }

  private evaluate(cpuRatio: number | undefined, memoryRatio: number | undefined): void {
    const thermalPressure = this.thermalState === "serious" || this.thermalState === "critical" ||
      this.speedLimit < 80;
    const cpuPressure = cpuRatio !== undefined && cpuRatio >= ENTER_CPU_RATIO;
    const memoryPressure = memoryRatio !== undefined && memoryRatio <= ENTER_MEMORY_RATIO;
    const healthy = !thermalPressure &&
      (cpuRatio === undefined || cpuRatio <= EXIT_CPU_RATIO) &&
      (memoryRatio === undefined || memoryRatio >= EXIT_MEMORY_RATIO) &&
      this.speedLimit >= 95;

    if (thermalPressure) {
      this.constrainedSamples = ENTER_SAMPLE_COUNT;
    } else if (cpuPressure || memoryPressure) {
      this.constrainedSamples += 1;
    } else {
      this.constrainedSamples = 0;
    }
    this.healthySamples = healthy ? this.healthySamples + 1 : 0;

    if (this.snapshot.level === "normal" && this.constrainedSamples >= ENTER_SAMPLE_COUNT) {
      this.update({
        level: "constrained",
        reason: thermalPressure ? "thermal" : memoryPressure ? "memory" : "cpu"
      });
      return;
    }
    if (this.snapshot.level === "constrained" && this.healthySamples >= EXIT_SAMPLE_COUNT) {
      this.constrainedSamples = 0;
      this.update({ level: "normal", reason: "baseline" });
    }
  }

  private update(snapshot: SystemPressureSnapshot): void {
    if (this.snapshot.level === snapshot.level && this.snapshot.reason === snapshot.reason) return;
    this.snapshot = snapshot;
    this.emit("change", this.getSnapshot());
  }
}

function createCpuTotals(cpuInfo: CpuInfo[]): CpuTotals {
  return cpuInfo.reduce<CpuTotals>((totals, cpu) => {
    const values = Object.values(cpu.times);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      busy: totals.busy + total - cpu.times.idle,
      total: totals.total + total
    };
  }, { busy: 0, total: 0 });
}
