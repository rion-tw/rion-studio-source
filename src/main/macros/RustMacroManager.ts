import { EventEmitter } from "node:events";

import type {
  MacroDefinition,
  MacroRunStatus as NativeMacroRunStatus,
  MacroRuntimeSettings,
  MacroStartRequest,
  MacroStepDefinition
} from "../../shared/generated";
import type { Macro, MacroRunStatus, MacroSettings, MacroStep } from "../../shared/types";
import type { BrowserManager } from "../browser/BrowserManager";
import type { AppCoreClient } from "../core/nativeCore";
import {
  MacroMutationBusyError,
  type HeldTriggerReleaseMode,
  type MacroManagerEvents,
  type MacroRuntimeManager
} from "./MacroManager";
import type { MacroSettingsStore } from "./MacroSettingsStore";
import type { MacroStore } from "./MacroStore";

export class RustMacroManager
  extends EventEmitter<MacroManagerEvents>
  implements MacroRuntimeManager {
  private readonly macroMutationTails = new Map<string, Promise<void>>();
  private statuses: MacroRunStatus[] = [];

  constructor(
    private readonly browserManager: Pick<BrowserManager, "getAutomationSession"> &
      Partial<Pick<BrowserManager, "setMacroActiveRoleIds">>,
    private readonly macroStore: Pick<MacroStore, "getMacro" | "listMacros">,
    private readonly macroSettingsStore: Pick<MacroSettingsStore, "getSettings">,
    private readonly core: AppCoreClient
  ) {
    super();
    core.subscribe((events) => {
      const event = [...events].reverse().find((candidate) => candidate.type === "macroStatuses");
      if (event?.type !== "macroStatuses") return;
      this.statuses = event.statuses.map(fromNativeStatus);
      void this.browserManager.setMacroActiveRoleIds?.(
        this.statuses
          .filter((status) => status.state === "running" || status.state === "stopping")
          .map((status) => status.roleId)
      );
      this.emit("change", this.listStatuses());
    });
    void core.invoke<NativeMacroRunStatus[]>({ type: "macroStatuses" })
      .then((statuses) => {
        this.statuses = statuses.map(fromNativeStatus);
      })
      .catch(() => undefined);
  }

  listStatuses(): MacroRunStatus[] {
    return structuredClone(this.statuses);
  }

  start(macroId: string): Promise<MacroRunStatus[]> {
    return this.withMacroMutationLock(macroId, () => this.startUnlocked(macroId));
  }

  startForRole(macroId: string, roleId: string): Promise<MacroRunStatus[]> {
    return this.withMacroMutationLock(macroId, () => this.startUnlocked(macroId, roleId));
  }

  pressForRole(macroId: string, roleId: string, pressId: string): Promise<MacroRunStatus[]> {
    return this.withMacroMutationLock(macroId, async () => {
      const request = await this.createStartRequest(macroId, roleId);
      return (await this.core.invoke<NativeMacroRunStatus[]>({
        type: "macroPress",
        request: { start: request, pressId }
      })).map(fromNativeStatus);
    });
  }

  releaseForRole(
    macroId: string,
    roleId: string,
    pressId: string,
    mode: HeldTriggerReleaseMode = "complete_first_iteration"
  ): Promise<void> {
    return this.withMacroMutationLock(macroId, async () => {
      await this.core.invoke({
        type: "macroRelease",
        request: { macroId, roleId, pressId, mode }
      });
    });
  }

  async releaseHeldTriggersForRole(roleId: string): Promise<void> {
    await this.core.invoke({ type: "macroReleaseRole", roleId });
  }

  stop(macroId: string): Promise<void> {
    return this.withMacroMutationLock(macroId, () => this.stopUnlocked(macroId));
  }

  stopForRole(macroId: string, roleId: string): Promise<void> {
    return this.withMacroMutationLock(macroId, async () => {
      const macro = await this.macroStore.getMacro(macroId);
      if (!macro.roleIds.includes(roleId)) {
        throw new Error("This macro is not assigned to the current role.");
      }
      await this.stopUnlocked(macroId);
    });
  }

  async stopRole(roleId: string): Promise<void> {
    await this.core.invoke({ type: "macroStopRole", roleId });
  }

  runStoppedMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLock(macroId, async () => {
      if (this.hasActiveMacroRun(macroId)) {
        throw new Error("Stop the macro before editing it.");
      }
      return operation();
    });
  }

  runStoppedMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLocks(macroIds, async () => {
      if (macroIds.some((macroId) => this.hasActiveMacroRun(macroId))) {
        throw new MacroMutationBusyError();
      }
      return operation();
    });
  }

  stopAndRunMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLock(macroId, async () => {
      await this.stopUnlocked(macroId);
      return operation();
    });
  }

  stopAndRunMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    return this.withMacroMutationLocks(macroIds, async () => {
      for (const macroId of macroIds) await this.stopUnlocked(macroId);
      return operation();
    });
  }

  private async startUnlocked(macroId: string, roleId?: string): Promise<MacroRunStatus[]> {
    const request = await this.createStartRequest(macroId, roleId);
    return (await this.core.invoke<NativeMacroRunStatus[]>({
      type: "macroStart",
      request
    })).map(fromNativeStatus);
  }

  private async stopUnlocked(macroId: string): Promise<void> {
    await this.core.invoke({ type: "macroStop", macroId });
  }

  private async createStartRequest(macroId: string, roleId?: string): Promise<MacroStartRequest> {
    const [macros, settings] = await Promise.all([
      this.macroStore.listMacros(),
      this.macroSettingsStore.getSettings()
    ]);
    const activeRoleIds = [...new Set(macros.flatMap((macro) => macro.roleIds))]
      .filter((candidate) => Boolean(this.browserManager.getAutomationSession(candidate)));
    return {
      macros: macros.map(toNativeMacro),
      settings: toNativeSettings(settings),
      macroId,
      roleId: roleId ?? null,
      activeRoleIds
    };
  }

  private hasActiveMacroRun(macroId: string): boolean {
    return this.statuses.some(
      (status) => status.macroId === macroId &&
        (status.state === "running" || status.state === "stopping")
    );
  }

  private withMacroMutationLocks<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(macroIds)].sort();
    const acquire = (index: number): Promise<T> => {
      const macroId = ids[index];
      return macroId
        ? this.withMacroMutationLock(macroId, () => acquire(index + 1))
        : operation();
    };
    return acquire(0);
  }

  private withMacroMutationLock<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.macroMutationTails.get(macroId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.macroMutationTails.set(macroId, tail);
    void tail.finally(() => {
      if (this.macroMutationTails.get(macroId) === tail) {
        this.macroMutationTails.delete(macroId);
      }
    });
    return result;
  }
}

function toNativeMacro(macro: Macro): MacroDefinition {
  return {
    id: macro.id,
    enabled: macro.enabled,
    activationMode: macro.activationMode,
    name: macro.name,
    roleIds: [...macro.roleIds],
    trigger: macro.trigger ? { ...macro.trigger } : undefined,
    repeat: macro.repeat.type === "loop" ? { ...macro.repeat } : { type: "once" },
    steps: macro.steps.map(toNativeStep)
  };
}

function toNativeStep(step: MacroStep): MacroStepDefinition {
  switch (step.type) {
    case "key":
      return {
        type: "key",
        id: step.id,
        code: step.code,
        modifiers: [...(step.modifiers ?? [])],
        action: step.action
      };
    case "click":
      return {
        type: "click",
        id: step.id,
        unit: step.unit,
        anchor: step.anchor,
        xPercent: step.unit === "px" ? undefined : step.xPercent,
        yPercent: step.unit === "px" ? undefined : step.yPercent,
        xPx: step.unit === "px" ? step.xPx : undefined,
        yPx: step.unit === "px" ? step.yPx : undefined
      };
    case "delay":
      return { type: "delay", id: step.id, ms: step.ms };
    case "macro":
      return {
        type: "macro",
        id: step.id,
        macroId: step.macroId,
        callMode: step.callMode
      };
  }
}

function toNativeSettings(settings: MacroSettings): MacroRuntimeSettings {
  return {
    startupDelayMs: settings.startupDelayMs,
    keyHoldMs: settings.keyHoldMs,
    postInputDelayMs: settings.postInputDelayMs,
    defaultLoopDelayMs: settings.defaultLoopDelayMs
  };
}

function fromNativeStatus(status: NativeMacroRunStatus): MacroRunStatus {
  const state = status.state === "stopping" || status.state === "failed" ||
    status.state === "cancelled" ? status.state : "running";
  return {
    roleId: status.roleId,
    macroId: status.macroId,
    state,
    ...(status.iteration === null ? {} : { iteration: status.iteration }),
    ...(status.lastClick === null ? {} : { lastClick: { ...status.lastClick } }),
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    ...(status.error === null ? {} : { error: status.error })
  };
}
