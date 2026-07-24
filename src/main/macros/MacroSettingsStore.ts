import type { MacroSettings } from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

export class MacroSettingsStore {
  constructor(_userDataDir: string, private readonly core: Pick<AppCoreClient, "invoke">) {}

  async getSettings(): Promise<MacroSettings> {
    return { ...await this.core.invoke({ type: "macroSettingsGet" }) };
  }

  async updateSettings(
    settings: MacroSettings,
    _publishCache = true
  ): Promise<MacroSettings> {
    const normalized = await this.core.invoke({ type: "macroSettingsReplace", settings });
    return { ...normalized };
  }

  publishSettingsForImport(_settings: MacroSettings): void {
    // SQLite is authoritative; portable apply publishes one Rust transaction.
  }
}
