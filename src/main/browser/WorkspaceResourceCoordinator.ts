import { EventEmitter } from "node:events";

import type {
  BrowserRuntimeMode,
  WorkspacePressureLevel,
  WorkspaceCpuThrottleRate,
  WorkspaceResourcePolicy,
  WorkspaceResourceReason,
  WorkspaceResourceState
} from "../../shared/types";
import type {
  ResourceRuntimeCommand,
  ResourceRuntimeResult
} from "../../shared/generated";
import type { SystemPressureSnapshot, SystemPressureSource } from "./RustSystemPressureMonitor";

export interface WorkspaceResourceTarget {
  roleId: string;
  runtimeMode: BrowserRuntimeMode;
  focus?: () => Promise<void>;
  getProcessId?: () => number | undefined;
  onInvalidated?: (listener: () => void) => () => void;
  releaseThrottle: () => Promise<void>;
  setCpuThrottleRate: (rate: 1 | WorkspaceCpuThrottleRate) => Promise<void>;
}

export interface WorkspaceResourceStatus {
  resourceState: WorkspaceResourceState;
  cpuThrottleRate: 1 | WorkspaceCpuThrottleRate;
  resourcePressureLevel?: WorkspacePressureLevel;
  resourceReason?: WorkspaceResourceReason;
}

export interface ResourceRuntimeState {
  invokeResourceRuntime: (command: ResourceRuntimeCommand) => ResourceRuntimeResult;
}

interface ManagedWorkspace {
  id: string;
  removeListeners: Array<() => void>;
  targets: Map<string, WorkspaceResourceTarget>;
}

/**
 * Executes native browser effects selected by the authoritative Rust resource
 * runtime. This adapter retains only Electron/CDP handles and listener cleanup.
 */
export class WorkspaceResourceCoordinator extends EventEmitter<{ change: [] }> {
  private readonly workspaces = new Map<string, ManagedWorkspace>();
  private tail = Promise.resolve();

  constructor(
    private readonly state: ResourceRuntimeState,
    pressureMonitor?: SystemPressureSource
  ) {
    super();
    if (pressureMonitor) {
      this.enqueuePressure(pressureMonitor.getSnapshot());
      pressureMonitor.on("change", (snapshot) => this.enqueuePressure(snapshot));
    }
  }

  getStatus(roleId: string): WorkspaceResourceStatus | undefined {
    const status = this.state
      .invokeResourceRuntime({ type: "snapshot" })
      .statuses
      .find((candidate) => candidate.roleId === roleId);
    if (!status) return undefined;
    return {
      resourceState: status.resourceState,
      cpuThrottleRate: status.cpuThrottleRate,
      ...(status.resourcePressureLevel
        ? { resourcePressureLevel: status.resourcePressureLevel }
        : {}),
      ...(status.resourceReason ? { resourceReason: status.resourceReason } : {})
    };
  }

  async activateWorkspace(
    workspaceId: string,
    policy: WorkspaceResourcePolicy,
    targets: WorkspaceResourceTarget[]
  ): Promise<void> {
    await this.deactivateWorkspace(workspaceId);
    if (targets.length === 0) return;

    const managed: ManagedWorkspace = {
      id: workspaceId,
      removeListeners: [],
      targets: new Map(targets.map((target) => [target.roleId, target]))
    };
    this.workspaces.set(workspaceId, managed);
    for (const target of targets) {
      if (!target.onInvalidated) continue;
      managed.removeListeners.push(target.onInvalidated(() => {
        void this.enqueue(async () => {
          if (this.workspaces.get(workspaceId) !== managed) return;
          await this.applyCommand({
            type: "refreshTarget",
            workspaceId,
            roleId: target.roleId,
            ...(target.getProcessId?.() ? { processId: target.getProcessId!() } : {})
          });
        });
      }));
    }

    await this.enqueue(() => this.applyCommand({
      type: "activateWorkspace",
      workspaceId,
      policyMode: policy.mode,
      targets: targets.map((target) => ({
        roleId: target.roleId,
        runtimeMode: target.runtimeMode,
        ...(target.getProcessId?.() ? { processId: target.getProcessId!() } : {})
      }))
    }));
    await targets[0]?.focus?.().catch(() => undefined);
  }

  async deactivateWorkspace(workspaceId: string): Promise<void> {
    const managed = this.workspaces.get(workspaceId);
    if (!managed) return;
    await this.enqueue(() => this.applyCommand({ type: "deactivateWorkspace", workspaceId }));
    this.workspaces.delete(workspaceId);
    managed.removeListeners.splice(0).forEach((remove) => remove());
  }

  setMacroActiveRoleIds(roleIds: Iterable<string>): Promise<void> {
    return this.enqueue(() => this.applyCommand({
      type: "setMacroRoleIds",
      roleIds: [...roleIds]
    }));
  }

  setHiddenRuntimeTabIds(workspaceIds: Iterable<string>): Promise<void> {
    return this.enqueue(() => this.applyCommand({
      type: "setHiddenWorkspaceIds",
      workspaceIds: [...workspaceIds]
    }));
  }

  prepareWorkspaceForeground(workspaceId: string): Promise<void> {
    return this.enqueue(() => this.applyCommand({
      type: "prepareWorkspaceForeground",
      workspaceId
    }));
  }

  async reconcileRuntimeRoleIds(
    runtimeMode: BrowserRuntimeMode,
    activeRoleIds: Iterable<string>
  ): Promise<void> {
    const active = new Set(activeRoleIds);
    await this.enqueue(() => this.applyCommand({
      type: "reconcileRuntimeRoleIds",
      runtimeMode,
      activeRoleIds: [...active]
    }));
    for (const managed of this.workspaces.values()) {
      for (const [roleId, target] of managed.targets) {
        if (target.runtimeMode !== runtimeMode || active.has(roleId)) continue;
        managed.targets.delete(roleId);
      }
    }
  }

  private enqueuePressure(snapshot: SystemPressureSnapshot): void {
    void this.enqueue(() => this.applyCommand({
      type: "setPressure",
      level: snapshot.level,
      reason: snapshot.reason
    })).catch(() => undefined);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async applyCommand(command: ResourceRuntimeCommand): Promise<void> {
    const result = this.state.invokeResourceRuntime(command);
    const unavailableRoleIds = new Set<string>();
    for (const effect of result.effects) {
      await Promise.all(effect.roleIds.map(async (roleId) => {
        const target = this.findTarget(roleId);
        if (!target) return;
        try {
          if (effect.release) await target.releaseThrottle();
          else await target.setCpuThrottleRate(effect.cpuThrottleRate);
        } catch (error) {
          unavailableRoleIds.add(roleId);
          await target.releaseThrottle().catch(() => undefined);
          console.warn(`Workspace CPU throttling is unavailable for role ${roleId}.`, error);
        }
      }));
    }
    this.state.invokeResourceRuntime({
      type: "setUnavailableRoleIds",
      roleIds: [...unavailableRoleIds]
    });
    this.emit("change");
  }

  private findTarget(roleId: string): WorkspaceResourceTarget | undefined {
    for (const managed of this.workspaces.values()) {
      const target = managed.targets.get(roleId);
      if (target) return target;
    }
    return undefined;
  }
}
