import type { GraphicsSettingsRecord, GraphicsStatusRecord } from "../../shared/generated";

export interface GraphicsDiagnosticsPort {
  on(event: "gpu-info-update", callback: () => void): unknown;
  removeListener(event: "gpu-info-update", callback: () => void): unknown;
  isHardwareAccelerationEnabled(): boolean;
  getGPUFeatureStatus(): object;
  getGPUInfo(type: "complete"): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function strings(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).flatMap(([key, item]) =>
    ["string", "number", "boolean"].includes(typeof item) ? [[key, String(item)]] : []));
}

/** Electron owns observations; sequence fences asynchronous complete GPU queries. */
export class GraphicsDiagnostics {
  #status: GraphicsStatusRecord;
  #epoch = 0;
  #disposed = false;
  #completeRequested = false;
  constructor(
    private readonly app: GraphicsDiagnosticsPort,
    applied: GraphicsSettingsRecord,
    versions: Record<string, string>,
    private readonly publish: (status: GraphicsStatusRecord) => void
  ) {
    this.#status = { supported: true, sequence: 0, initialized: false,
      hardwareAcceleration: null, appliedSettings: { ...applied }, features: {},
      devices: [], driver: {}, versions, problems: [], complete: false, error: null };
    app.on("gpu-info-update", this.#onUpdate);
  }
  snapshot(): GraphicsStatusRecord { return structuredClone(this.#status); }
  dispose(): void {
    this.#disposed = true;
    this.#epoch += 1;
    this.app.removeListener("gpu-info-update", this.#onUpdate);
  }
  readonly #onUpdate = (): void => {
    if (this.#disposed) return;
    this.#epoch += 1;
    try {
      this.#commit({ initialized: true,
        hardwareAcceleration: this.app.isHardwareAccelerationEnabled(),
        features: strings(this.app.getGPUFeatureStatus()), devices: [], driver: {},
        complete: false, error: null });
    } catch (error) {
      this.#commit({ error: error instanceof Error ? error.message : String(error) });
    }
    if (this.#completeRequested) void this.refresh();
  };
  async refresh(): Promise<GraphicsStatusRecord> {
    this.#completeRequested = true;
    if (!this.#status.initialized || this.#disposed) return this.snapshot();
    this.#completeRequested = false;
    const epoch = ++this.#epoch;
    try {
      const info = record(await this.app.getGPUInfo("complete"));
      if (!this.#disposed && epoch === this.#epoch) {
        const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice.map(strings) : [];
        const problems = Array.isArray(info.problems) ? info.problems.filter((item): item is string => typeof item === "string") : [];
        this.#commit({ devices, driver: strings(info.auxAttributes), problems, complete: true, error: null });
      }
    } catch (error) {
      if (!this.#disposed && epoch === this.#epoch) this.#commit({ complete: false,
        error: error instanceof Error ? error.message : String(error) });
    }
    return this.snapshot();
  }
  #commit(patch: Partial<GraphicsStatusRecord>): void {
    this.#status = { ...this.#status, ...patch, sequence: this.#status.sequence + 1 };
    this.publish(this.snapshot());
  }
}
