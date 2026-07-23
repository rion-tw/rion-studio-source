import type { RuntimeWindowPreferencesRecord } from "../../shared/generated";
import type { AppCoreClient } from "../core/nativeCore";

export type RuntimeWindowPreferences = RuntimeWindowPreferencesRecord;

export class RuntimeWindowPreferencesStore {
  constructor(_userDataDir: string, private readonly core: Pick<AppCoreClient, "invoke">) {}

  async getPreferences(): Promise<RuntimeWindowPreferences> {
    return {
      ...await this.core.invoke({ type: "runtimeWindowPreferencesGet" })
    };
  }

  async updatePreferences(value: RuntimeWindowPreferences): Promise<RuntimeWindowPreferences> {
    const persisted = await this.core.invoke({
      type: "runtimeWindowPreferencesReplace",
      preferences: value
    });
    return { ...persisted };
  }
}
