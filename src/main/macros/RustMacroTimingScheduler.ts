import type { AppCoreClient } from "../core/nativeCore";
import type { MacroTimingScheduler } from "./MacroManager";

export class RustMacroTimingScheduler implements MacroTimingScheduler {
  constructor(private readonly core: AppCoreClient) {}

  wait(id: string, durationMs: number): Promise<void> {
    return this.core.scheduleWait(id, durationMs);
  }

  cancel(id: string): void {
    this.core.cancelWait(id);
  }
}
