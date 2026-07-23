import { EventEmitter } from "node:events";

import type {
  MacroRunStatus as NativeMacroRunStatus
} from "../../shared/generated";
import type { MacroRunStatus } from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";
import {
  type HeldTriggerReleaseMode,
  type MacroManagerEvents,
  type MacroRuntimeManager
} from "./MacroRuntimeManager";

export class RustMacroManager
  extends EventEmitter<MacroManagerEvents>
  implements MacroRuntimeManager {
  constructor(private readonly core: AppCoreClient) {
    super();
    core.subscribe((events) => {
      const event = [...events].reverse().find((candidate) => candidate.type === "macroStatuses");
      if (event?.type !== "macroStatuses") return;
      this.emit("change", event.statuses.map(fromNativeStatus));
    });
  }

  async listStatuses(): Promise<MacroRunStatus[]> {
    return (await this.core.invoke<NativeMacroRunStatus[]>({ type: "macroStatuses" }))
      .map(fromNativeStatus);
  }

  start(macroId: string): Promise<MacroRunStatus[]> {
    return this.startUnlocked(macroId);
  }

  startForRole(macroId: string, roleId: string): Promise<MacroRunStatus[]> {
    return this.startUnlocked(macroId, roleId);
  }

  pressForRole(macroId: string, roleId: string, pressId: string): Promise<MacroRunStatus[]> {
    return this.core.invoke<NativeMacroRunStatus[]>({
      type: "macroPress", request: { macroId, roleId, pressId }
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

  private async startUnlocked(macroId: string, roleId?: string): Promise<MacroRunStatus[]> {
    return (await this.core.invoke<NativeMacroRunStatus[]>({
      type: "macroStart", request: { macroId, roleId: roleId ?? null }
    })).map(fromNativeStatus);
  }

  private async stopUnlocked(macroId: string): Promise<void> {
    await this.core.invoke({ type: "macroStop", macroId });
  }

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
