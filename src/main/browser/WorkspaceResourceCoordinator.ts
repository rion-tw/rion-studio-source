import { EventEmitter } from "node:events";

import type {
  BrowserRuntimeMode,
  WorkspacePressureLevel,
  WorkspaceCpuThrottleRate,
  WorkspaceResourcePolicy,
  WorkspaceResourceReason,
  WorkspaceResourceState
} from "../../shared/types";
import type { SystemPressureSnapshot, SystemPressureSource } from "./SystemPressureMonitor";

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

interface ManagedWorkspace {
  id: string;
  macroRoleIds: Set<string>;
  policy: WorkspaceResourcePolicy;
  removeListeners: Array<() => void>;
  tail: Promise<void>;
  targets: Map<string, WorkspaceResourceTarget>;
  unavailableRoleIds: Set<string>;
}

interface TargetGroup {
  key: string;
  targets: WorkspaceResourceTarget[];
}

export class WorkspaceResourceCoordinator extends EventEmitter<{ change: [] }> {
  private readonly roleStatuses = new Map<string, WorkspaceResourceStatus>();
  private readonly workspaces = new Map<string, ManagedWorkspace>();
  private hiddenRuntimeTabIds = new Set<string>();
  private macroRoleIds = new Set<string>();
  private pressureSnapshot: SystemPressureSnapshot = { level: "normal", reason: "baseline" };

  constructor(pressureMonitor?: SystemPressureSource) {
    super();
    if (pressureMonitor) {
      this.pressureSnapshot = pressureMonitor.getSnapshot();
      pressureMonitor.on("change", (snapshot) => {
        this.pressureSnapshot = snapshot;
        void Promise.all([...this.workspaces.values()].map((managed) =>
          managed.policy.mode === "adaptive" && this.hiddenRuntimeTabIds.has(managed.id)
            ? this.enqueue(managed, () => this.applyWorkspace(managed))
            : Promise.resolve()
        )).catch(() => undefined);
      });
    }
  }

  getStatus(roleId: string): WorkspaceResourceStatus | undefined {
    return this.roleStatuses.get(roleId);
  }

  async activateWorkspace(
    workspaceId: string,
    policy: WorkspaceResourcePolicy,
    targets: WorkspaceResourceTarget[]
  ): Promise<void> {
    await this.deactivateWorkspace(workspaceId);
    if (targets.length === 0) {
      return;
    }

    const targetByRoleId = new Map(targets.map((target) => [target.roleId, target]));
    const primaryRoleId = policy.primaryRoleId && targetByRoleId.has(policy.primaryRoleId)
      ? policy.primaryRoleId
      : targets[0]?.roleId;
    if (!primaryRoleId) {
      return;
    }

    const managed: ManagedWorkspace = {
      id: workspaceId,
      macroRoleIds: new Set([...this.macroRoleIds].filter((roleId) => targetByRoleId.has(roleId))),
      policy: { ...policy, primaryRoleId },
      removeListeners: [],
      tail: Promise.resolve(),
      targets: targetByRoleId,
      unavailableRoleIds: new Set()
    };
    this.workspaces.set(workspaceId, managed);
    targets.forEach((target) => {
      if (target.onInvalidated) {
        managed.removeListeners.push(target.onInvalidated(() => {
          void this.enqueue(managed, () => this.applyWorkspace(managed));
        }));
      }
    });

    await this.enqueue(managed, () => this.applyWorkspace(managed));
    await targetByRoleId.get(primaryRoleId)?.focus?.().catch(() => undefined);
  }

  async deactivateWorkspace(workspaceId: string): Promise<void> {
    const managed = this.workspaces.get(workspaceId);
    if (!managed) {
      return;
    }

    this.workspaces.delete(workspaceId);
    managed.removeListeners.splice(0).forEach((remove) => remove());
    await managed.tail.catch(() => undefined);
    await Promise.all(
      [...managed.targets.values()].map((target) => target.releaseThrottle().catch(() => undefined))
    );
    let changed = false;
    managed.targets.forEach((target) => {
      changed = this.roleStatuses.delete(target.roleId) || changed;
    });
    if (changed) {
      this.emit("change");
    }
  }

  async setMacroActiveRoleIds(roleIds: Iterable<string>): Promise<void> {
    this.macroRoleIds = new Set(roleIds);
    await Promise.all([...this.workspaces.values()].map(async (managed) => {
      managed.macroRoleIds = new Set(
        [...this.macroRoleIds].filter((roleId) => managed.targets.has(roleId))
      );
      await this.enqueue(managed, () => this.applyWorkspace(managed));
    }));
  }

  async setHiddenRuntimeTabIds(workspaceIds: Iterable<string>): Promise<void> {
    this.hiddenRuntimeTabIds = new Set(workspaceIds);
    await Promise.all([...this.workspaces.values()].map((managed) =>
      this.enqueue(managed, () => this.applyWorkspace(managed))
    ));
  }

  async prepareWorkspaceForeground(workspaceId: string): Promise<void> {
    this.hiddenRuntimeTabIds.delete(workspaceId);
    const managed = this.workspaces.get(workspaceId);
    if (managed) {
      await this.enqueue(managed, () => this.applyWorkspace(managed));
    }
  }

  async reconcileRuntimeRoleIds(
    runtimeMode: BrowserRuntimeMode,
    activeRoleIds: Iterable<string>
  ): Promise<void> {
    const active = new Set(activeRoleIds);
    await Promise.all([...this.workspaces.values()].map(async (managed) => {
      const missingRoleIds = [...managed.targets.values()]
        .filter((target) => target.runtimeMode === runtimeMode && !active.has(target.roleId))
        .map((target) => target.roleId);
      if (missingRoleIds.length === 0) {
        return;
      }
      await this.enqueue(managed, () => this.removeTargets(managed, missingRoleIds));
    }));
  }

  private enqueue(managed: ManagedWorkspace, operation: () => Promise<void>): Promise<void> {
    const result = managed.tail.then(async () => {
      if (this.workspaces.get(managed.id) !== managed) {
        return;
      }
      await operation();
    });
    managed.tail = result.catch(() => undefined);
    return result;
  }

  private async applyWorkspace(managed: ManagedWorkspace): Promise<void> {
    const isHiddenRuntimeTab = this.hiddenRuntimeTabIds.has(managed.id);
    if (managed.policy.mode === "unrestricted" || !isHiddenRuntimeTab) {
      await Promise.all(
        [...managed.targets.values()].map((target) => target.releaseThrottle().catch(() => undefined))
      );
      let changed = false;
      managed.targets.forEach((target) => {
        changed = this.roleStatuses.delete(target.roleId) || changed;
      });
      if (changed) {
        this.emit("change");
      }
      return;
    }

    const groups = this.createGroups(managed);
    const fullSpeedRoleIds = new Set(managed.macroRoleIds);
    const fullSpeedGroups = groups.filter((group) =>
      group.targets.some((target) => fullSpeedRoleIds.has(target.roleId))
    );
    const throttledGroups = groups.filter((group) => !fullSpeedGroups.includes(group));

    await Promise.all(fullSpeedGroups.map((group) => this.applyGroupRate(managed, group, 1)));
    await Promise.all(
      throttledGroups.map((group) =>
        this.applyGroupRate(managed, group, this.getBackgroundRate())
      )
    );
    this.updateStatuses(managed, groups, fullSpeedRoleIds);
  }

  private getBackgroundRate(): WorkspaceCpuThrottleRate {
    return this.pressureSnapshot.level === "constrained" ? 4 : 2;
  }

  private async removeTargets(managed: ManagedWorkspace, roleIds: string[]): Promise<void> {
    const removedTargets = roleIds.flatMap((roleId) => {
      const target = managed.targets.get(roleId);
      if (!target) {
        return [];
      }
      managed.targets.delete(roleId);
      managed.macroRoleIds.delete(roleId);
      managed.unavailableRoleIds.delete(roleId);
      this.roleStatuses.delete(roleId);
      return [target];
    });
    await Promise.all(removedTargets.map((target) => target.releaseThrottle().catch(() => undefined)));
    await this.applyWorkspace(managed);
  }

  private createGroups(managed: ManagedWorkspace): TargetGroup[] {
    const groups = new Map<string, WorkspaceResourceTarget[]>();
    managed.targets.forEach((target) => {
      const processId = target.getProcessId?.();
      const key = processId && processId > 0
        ? `${target.runtimeMode}:process:${processId}`
        : `${target.runtimeMode}:role:${target.roleId}`;
      const existing = groups.get(key) ?? [];
      existing.push(target);
      groups.set(key, existing);
    });
    return [...groups].map(([key, targets]) => ({ key, targets }));
  }

  private async applyGroupRate(
    managed: ManagedWorkspace,
    group: TargetGroup,
    rate: 1 | WorkspaceCpuThrottleRate
  ): Promise<void> {
    await Promise.all(group.targets.map(async (target) => {
      try {
        await target.setCpuThrottleRate(rate);
        managed.unavailableRoleIds.delete(target.roleId);
      } catch (error) {
        managed.unavailableRoleIds.add(target.roleId);
        await target.releaseThrottle().catch(() => undefined);
        console.warn(`Workspace CPU throttling is unavailable for role ${target.roleId}.`, error);
      }
    }));
  }

  private updateStatuses(
    managed: ManagedWorkspace,
    groups: TargetGroup[],
    fullSpeedRoleIds: Set<string>
  ): void {
    groups.forEach((group) => {
      const groupHasFullSpeedRole = group.targets.some((target) => fullSpeedRoleIds.has(target.roleId));
      group.targets.forEach((target) => {
        let status: WorkspaceResourceStatus;
        if (managed.unavailableRoleIds.has(target.roleId)) {
          status = {
            resourceState: "unavailable",
            cpuThrottleRate: 1,
            resourceReason: "unavailable"
          };
        } else if (managed.macroRoleIds.has(target.roleId)) {
          status = { resourceState: "macro_override", cpuThrottleRate: 1, resourceReason: "macro" };
        } else if (groupHasFullSpeedRole) {
          status = {
            resourceState: "shared_process",
            cpuThrottleRate: 1,
            resourceReason: "shared_process"
          };
        } else {
          const cpuThrottleRate = this.getBackgroundRate();
          status = {
            resourceState: "throttled",
            cpuThrottleRate,
            resourcePressureLevel: this.pressureSnapshot.level,
            resourceReason: this.pressureSnapshot.level === "normal"
              ? "runtime_tab_background"
              : this.pressureSnapshot.reason
          };
        }
        this.roleStatuses.set(target.roleId, status);
      });
    });
    this.emit("change");
  }
}
