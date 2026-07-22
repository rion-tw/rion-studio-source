import type { StateRepository } from "../core/RustStateRepository";
import type { RuntimeWindowPreferencesRecord } from "../../shared/generated";

export type RuntimeWindowPreferences = RuntimeWindowPreferencesRecord;

export class RuntimeWindowPreferencesStore {
  constructor(_userDataDir: string, private readonly stateRepository: StateRepository) {}

  async getPreferences(): Promise<RuntimeWindowPreferences> {
    return {
      ...await this.stateRepository.getRuntimeWindowPreferences()
    };
  }

  async updatePreferences(value: RuntimeWindowPreferences): Promise<RuntimeWindowPreferences> {
    const persisted = await this.stateRepository.replaceRuntimeWindowPreferences(value);
    return { ...persisted };
  }
}
