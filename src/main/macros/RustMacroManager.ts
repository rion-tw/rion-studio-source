import { EventEmitter } from "node:events";

import type {
  MacroRunStatus as NativeMacroRunStatus
} from "../../shared/generated";
import type { MacroRunStatus } from "../../shared/types";
import type { BrowserManager } from "../browser/BrowserManager";
import type { AppCoreClient } from "../core/nativeCore";
import {
  MacroMutationBusyError,
  type HeldTriggerReleaseMode,
  type MacroManagerEvents,
  type MacroRuntimeManager
} from "./MacroRuntimeManager";

export class RustMacroManager
  extends EventEmitter<MacroManagerEvents>
  implements MacroRuntimeManager {
  private statuses: MacroRunStatus[] = [];

  constructor(
    private readonly browserManager: Pick<
      BrowserManager,
      "getEmbeddedAutomationSession" | "listStatuses"
    > &
      Partial<Pick<BrowserManager, "setMacroActiveRoleIds">>,
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
    return this.startUnlocked(macroId);
  }

  startForRole(macroId: string, roleId: string): Promise<MacroRunStatus[]> {
    return this.startUnlocked(macroId, roleId);
  }

  pressForRole(macroId: string, roleId: string, pressId: string): Promise<MacroRunStatus[]> {
    const activeRoleIds = this.listActiveRoleIds();
    return this.core.invoke<NativeMacroRunStatus[]>({
      type: "macroPress",
      request: { macroId, roleId, activeRoleIds, pressId }
    }).then((statuses) => statuses.map(fromNativeStatus));
  }

  releaseForRole(
    macroId: string,
    roleId: string,
    pressId: string,
    mode: HeldTriggerReleaseMode = "complete_first_iteration"
  ): Promise<void> {
    return this.core.invoke<void>({
      type: "macroRelease",
      request: { macroId, roleId, pressId, mode }
    });
  }

  async releaseHeldTriggersForRole(roleId: string): Promise<void> {
    await this.core.invoke({ type: "macroReleaseRole", roleId });
  }

  stop(macroId: string): Promise<void> {
    return this.stopUnlocked(macroId);
  }

  stopForRole(macroId: string, roleId: string): Promise<void> {
    return this.core.invoke<void>({ type: "macroStopForRole", macroId, roleId });
  }

  async stopRole(roleId: string): Promise<void> {
    await this.core.invoke({ type: "macroStopRole", roleId });
  }

  runStoppedMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    return this.withRustMutationLease([macroId], false, operation);
  }

  runStoppedMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    return this.withRustMutationLease(macroIds, false, operation);
  }

  stopAndRunMutation<T>(macroId: string, operation: () => Promise<T>): Promise<T> {
    return this.withRustMutationLease([macroId], true, operation);
  }

  stopAndRunMutations<T>(macroIds: string[], operation: () => Promise<T>): Promise<T> {
    return this.withRustMutationLease(macroIds, true, operation);
  }

  private async startUnlocked(macroId: string, roleId?: string): Promise<MacroRunStatus[]> {
    const activeRoleIds = this.listActiveRoleIds();
    return (await this.core.invoke<NativeMacroRunStatus[]>({
      type: "macroStart",
      request: { macroId, roleId: roleId ?? null, activeRoleIds }
    })).map(fromNativeStatus);
  }

  private async stopUnlocked(macroId: string): Promise<void> {
    await this.core.invoke({ type: "macroStop", macroId });
  }

  private listActiveRoleIds(): string[] {
    return this.browserManager.listStatuses()
      .filter((status) => status.runtimeMode === "external"
        ? status.automationState === "ready"
        : Boolean(this.browserManager.getEmbeddedAutomationSession(status.roleId)))
      .map((status) => status.roleId);
  }

  private async withRustMutationLease<T>(
    macroIds: string[],
    stopActive: boolean,
    operation: () => Promise<T>
  ): Promise<T> {
    let leaseId: string;
    try {
      ({ leaseId } = await this.core.invoke<{ leaseId: string }>({
        type: "macroMutationAcquire",
        macroIds: [...new Set(macroIds)],
        stopActive
      }));
    } catch (error) {
      if (isErrorWithCode(error, "MACRO_MUTATION_BUSY")) {
        throw new MacroMutationBusyError();
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await this.core.invoke({ type: "macroMutationRelease", leaseId });
    }
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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
