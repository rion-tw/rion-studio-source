import type {
  ResourceRuntimeCommand,
  ResourceRuntimeResult,
  ResourceRuntimeTargetRecord
} from "../../src/shared/generated";

interface Workspace {
  targets: Map<string, ResourceRuntimeTargetRecord>;
}

export function createResourceRuntimeState() {
  const workspaces = new Map<string, Workspace>();
  let hidden = new Set<string>();
  let macroRoles = new Set<string>();
  let unavailable = new Set<string>();
  let pressure: "normal" | "constrained" = "normal";
  let pressureReason = "baseline";

  const result = (releasedRoleIds: string[] = []): ResourceRuntimeResult => {
    const effects: ResourceRuntimeResult["effects"] = releasedRoleIds.map((roleId) => ({
      roleIds: [roleId], cpuThrottleRate: 1, release: true
    }));
    const statuses: ResourceRuntimeResult["statuses"] = [];
    for (const [workspaceId, workspace] of workspaces) {
      if (!hidden.has(workspaceId)) {
        effects.push(...[...workspace.targets.keys()].map((roleId) => ({
          roleIds: [roleId], cpuThrottleRate: 1 as const, release: true
        })));
        continue;
      }
      const groups = new Map<string, string[]>();
      for (const target of workspace.targets.values()) {
        const key = target.processId
          ? `${target.runtimeMode}:process:${target.processId}`
          : `${target.runtimeMode}:role:${target.roleId}`;
        groups.set(key, [...(groups.get(key) ?? []), target.roleId]);
      }
      for (const roleIds of groups.values()) {
        const sharedMacro = roleIds.some((roleId) => macroRoles.has(roleId));
        effects.push({
          roleIds,
          cpuThrottleRate: sharedMacro ? 1 : pressure === "constrained" ? 4 : 2,
          release: false
        });
        for (const roleId of roleIds) {
          statuses.push(unavailable.has(roleId)
            ? { roleId, resourceState: "unavailable", cpuThrottleRate: 1, resourceReason: "unavailable" }
            : macroRoles.has(roleId)
              ? { roleId, resourceState: "macro_override", cpuThrottleRate: 1, resourceReason: "macro" }
              : sharedMacro
                ? { roleId, resourceState: "shared_process", cpuThrottleRate: 1, resourceReason: "shared_process" }
                : {
                    roleId,
                    resourceState: "throttled",
                    cpuThrottleRate: pressure === "constrained" ? 4 : 2,
                    resourcePressureLevel: pressure,
                    resourceReason: pressure === "constrained"
                      ? pressureReason as "cpu" | "memory" | "thermal"
                      : "runtime_tab_background"
                  });
        }
      }
    }
    return { effects, statuses };
  };

  return {
    invokeResourceRuntime(command: ResourceRuntimeCommand): ResourceRuntimeResult {
      const released: string[] = [];
      switch (command.type) {
        case "snapshot": break;
        case "activateWorkspace": {
          const previous = workspaces.get(command.workspaceId);
          if (previous) released.push(...previous.targets.keys());
          workspaces.set(command.workspaceId, {
            targets: new Map(command.targets.map((target) => [target.roleId, { ...target }]))
          });
          break;
        }
        case "deactivateWorkspace": {
          const previous = workspaces.get(command.workspaceId);
          if (previous) released.push(...previous.targets.keys());
          workspaces.delete(command.workspaceId);
          hidden.delete(command.workspaceId);
          break;
        }
        case "setMacroRoleIds": macroRoles = new Set(command.roleIds); break;
        case "setHiddenWorkspaceIds": hidden = new Set(command.workspaceIds); break;
        case "prepareWorkspaceForeground": hidden.delete(command.workspaceId); break;
        case "setPressure":
          pressure = command.level;
          pressureReason = command.reason;
          break;
        case "setUnavailableRoleIds": unavailable = new Set(command.roleIds); break;
        case "refreshTarget": {
          const target = workspaces.get(command.workspaceId)?.targets.get(command.roleId);
          if (target) target.processId = command.processId;
          break;
        }
        case "reconcileRuntimeRoleIds": {
          const active = new Set(command.activeRoleIds);
          for (const workspace of workspaces.values()) {
            for (const [roleId, target] of workspace.targets) {
              if (target.runtimeMode !== command.runtimeMode || active.has(roleId)) continue;
              workspace.targets.delete(roleId);
              released.push(roleId);
            }
          }
          break;
        }
      }
      return result(released);
    }
  };
}
