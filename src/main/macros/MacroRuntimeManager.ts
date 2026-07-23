import type { MacroRunStatus } from "../../shared/types";

export interface MacroManagerEvents {
  change: [MacroRunStatus[]];
}

export type HeldTriggerReleaseMode = "complete_first_iteration" | "immediate";

export interface MacroRuntimeManager {
  listStatuses(): Promise<MacroRunStatus[]>;
  on(event: "change", listener: (statuses: MacroRunStatus[]) => void): this;
  pressForRole(macroId: string, roleId: string, pressId: string): Promise<MacroRunStatus[]>;
  releaseForRole(
    macroId: string,
    roleId: string,
    pressId: string,
    mode?: HeldTriggerReleaseMode
  ): Promise<void>;
  releaseHeldTriggersForRole(roleId: string): Promise<void>;
  runStoppedMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T>;
  runStoppedMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T>;
  start(macroId: string): Promise<MacroRunStatus[]>;
  startForRole(macroId: string, roleId: string): Promise<MacroRunStatus[]>;
  stop(macroId: string): Promise<void>;
  stopAndRunMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T>;
  stopAndRunMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T>;
  stopForRole(macroId: string, roleId: string): Promise<void>;
  stopRole(roleId: string): Promise<void>;
}

export class MacroMutationBusyError extends Error {
  constructor() {
    super("Stop affected macros before importing.");
    this.name = "MacroMutationBusyError";
  }
}
