import type {
  BrowserOperationLease,
  BrowserOperationRequest,
  BrowserRoleStatusRecord,
  CoreCommand,
  CoreCommandResult,
  CoreEvent,
  BrowserRuntimeCommand,
  BrowserRuntimeDisplayRecord,
  BrowserRuntimeRoleRecord,
  BrowserRuntimeResult,
  BrowserRuntimeSnapshot,
  BrowserRuntimeTabRecord,
  BrowserRuntimeWorkspaceRecord
} from "../../src/shared/generated";
import { createResourceRuntimeState } from "./resourceRuntimeState";

export function createBrowserRuntimeState() {
  const resourceRuntime = createResourceRuntimeState();
  let nextTabId = 0;
  let nextOperationId = 0;
  const displays = new Map<number, BrowserRuntimeDisplayRecord>();
  const roles = new Map<string, BrowserRuntimeRoleRecord>();
  const tabs = new Map<string, BrowserRuntimeTabRecord>();
  const workspaces = new Map<string, BrowserRuntimeWorkspaceRecord>();
  const operationQueues = new Map<string, string[]>();
  const roleVersions = new Map<string, number>();
  const blockedRoleIds = new Set<string>();
  const listeners = new Set<(events: CoreEvent[]) => void>();
  let typedInvoker: ((command: CoreCommand) => Promise<unknown>) | undefined;
  let typedTail: Promise<void> = Promise.resolve();
  const operationTickets = new Map<string, {
    active: boolean;
    kind: BrowserOperationRequest["kind"];
    lease: BrowserOperationLease;
    queuedVersions: Map<string, number>;
    reject: (error: Error) => void;
    resolve: (lease: BrowserOperationLease) => void;
  }>();

  const removeOperation = (id: string): void => {
    const ticket = operationTickets.get(id);
    if (!ticket) return;
    operationTickets.delete(id);
    ticket.lease.roleIds.forEach((roleId) => {
      const queue = operationQueues.get(roleId)?.filter((candidate) => candidate !== id) ?? [];
      if (queue.length === 0) operationQueues.delete(roleId);
      else operationQueues.set(roleId, queue);
    });
  };
  const operationError = (code: string, message: string): Error => {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
  };
  const grantReadyOperations = (): void => {
    for (const [id, ticket] of operationTickets) {
      if (ticket.active || !ticket.lease.roleIds.every(
        (roleId) => operationQueues.get(roleId)?.[0] === id
      )) continue;
      if (ticket.lease.roleIds.some((roleId) => blockedRoleIds.has(roleId))) {
        removeOperation(id);
        ticket.reject(operationError("ROLE_MUTATION_BLOCKED", "Role is blocked by a destructive mutation."));
        grantReadyOperations();
        return;
      }
      if (ticket.kind === "normal" && ticket.lease.roleIds.some(
        (roleId) => (roleVersions.get(roleId) ?? 0) !== (ticket.queuedVersions.get(roleId) ?? 0)
      )) {
        removeOperation(id);
        ticket.reject(operationError("ROLE_DATA_CHANGED", "Role data changed while the operation was queued."));
        grantReadyOperations();
        return;
      }
      if (ticket.kind === "recoverableMutation") {
        ticket.lease.roleIds.forEach((roleId) =>
          roleVersions.set(roleId, (roleVersions.get(roleId) ?? 0) + 1));
      } else if (ticket.kind === "destructiveMutation") {
        ticket.lease.roleIds.forEach((roleId) => blockedRoleIds.add(roleId));
      }
      ticket.active = true;
      ticket.resolve(ticket.lease);
    }
  };

  const registerDisplay = (displayId: number): BrowserRuntimeDisplayRecord => {
    const existing = displays.get(displayId);
    if (existing) return existing;
    const display = { displayId, tabIds: [] };
    displays.set(displayId, display);
    return display;
  };
  const snapshot = (): BrowserRuntimeSnapshot => ({
    displays: [...displays.values()].map((display) => ({
      ...display,
      tabIds: [...display.tabIds]
    })),
    roles: [...roles.values()].map((role) => ({ ...role })),
    tabs: [...tabs.values()].map((tab) => ({ ...tab, roleIds: [...tab.roleIds] })),
    workspaces: [...workspaces.values()].map((workspace) => ({
      ...workspace,
      roleIds: [...workspace.roleIds]
    }))
  });
  const refreshWorkspace = (workspaceId: string): void => {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) return;
    const states = workspace.roleIds
      .map((roleId) => roles.get(roleId)?.state)
      .filter((state): state is NonNullable<typeof state> => Boolean(state));
    if (states.includes("stopping")) workspace.state = "stopping";
    else if (states.length === workspace.roleIds.length && states.every((state) => state === "running")) {
      workspace.state = "running";
    } else if (states.length > 0) workspace.state = "launching";
  };
  const removeTab = (tabId: string): void => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tabs.delete(tabId);
    const display = displays.get(tab.displayId);
    if (display) {
      display.tabIds = display.tabIds.filter((id) => id !== tabId);
      if (display.activeTabId === tabId) {
        display.activeTabId = display.tabIds.find((id) => !tabs.get(id)?.hidden);
      }
      if (display.tabIds.length === 0) displays.delete(tab.displayId);
    }
    if (tab.workspaceId) workspaces.delete(tab.workspaceId);
  };

  return {
    subscribe(listener: (events: CoreEvent[]) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publishStatuses(): void {
      const statuses = this.listBrowserStatuses();
      listeners.forEach((listener) => listener([{ type: "browserStatuses", statuses }]));
    },
    invokeResourceRuntimeForTest: resourceRuntime.invokeResourceRuntime,
    evaluateExternalChrome<T>(): Promise<T> {
      return Promise.reject(new Error("External Chrome is not configured in this test harness."));
    },
    listBrowserStatuses(): BrowserRoleStatusRecord[] {
      const resourceStatuses = resourceRuntime.invokeResourceRuntime({ type: "snapshot" }).statuses;
      return snapshot().roles.map((role) => {
        const resource = resourceStatuses.find((status) => status.roleId === role.roleId);
        return {
          roleId: role.roleId,
          state: role.state,
          ...(role.launchedAt ? { launchedAt: role.launchedAt } : {}),
          runtimeMode: role.runtime,
          ...(role.runtime === "external"
            ? { automationState: "ready" as const, pageHealth: "healthy" as const }
            : {}),
          ...(resource ? {
            resourceState: resource.resourceState,
            cpuThrottleRate: resource.cpuThrottleRate,
            ...(resource.resourcePressureLevel
              ? { resourcePressureLevel: resource.resourcePressureLevel }
              : {}),
            ...(resource.resourceReason && resource.resourceReason !== "baseline"
              ? { resourceReason: resource.resourceReason }
              : {})
          } : {})
        };
      });
    },
    listBrowserWorkspaceStatuses() {
      return snapshot().workspaces.map(({ state, workspaceId }) => ({ state, workspaceId }));
    },
    invoke<C extends CoreCommand>(command: C): Promise<CoreCommandResult<C>> {
      if (command.type === "browserStatuses") {
        return Promise.resolve(this.listBrowserStatuses()) as Promise<CoreCommandResult<C>>;
      }
      if (command.type === "browserWorkspaceStatuses") {
        return Promise.resolve(this.listBrowserWorkspaceStatuses()) as Promise<CoreCommandResult<C>>;
      }
      if (command.type === "browserRuntimeSnapshot") {
        return Promise.resolve(snapshot()) as Promise<CoreCommandResult<C>>;
      }
      if (!typedInvoker) {
        return Promise.reject(new Error("The test Rust intent executor is not configured."));
      }
      if (
        command.type === "browserRoleStop" ||
        command.type === "browserWorkspaceStop" ||
        command.type === "embeddedRoleStop" ||
        command.type === "embeddedWorkspaceStop"
      ) {
        return typedInvoker(command) as Promise<CoreCommandResult<C>>;
      }
      const result = typedTail.then(() => typedInvoker!(command));
      typedTail = result.then(() => undefined, () => undefined);
      return result as Promise<CoreCommandResult<C>>;
    },
    setTypedInvoker(invoker: (command: CoreCommand) => Promise<unknown>): void {
      typedInvoker = invoker;
    },
    acquireBrowserOperation(request: BrowserOperationRequest): Promise<BrowserOperationLease> {
      const roleIds = [...new Set(request.roleIds)].sort();
      const id = `browser-operation-${++nextOperationId}`;
      const lease = { id, roleIds };
      const promise = new Promise<BrowserOperationLease>((resolve, reject) => {
        operationTickets.set(id, {
          active: false,
          kind: request.kind,
          lease,
          queuedVersions: new Map(
            roleIds.map((roleId) => [roleId, roleVersions.get(roleId) ?? 0])
          ),
          reject,
          resolve
        });
      });
      roleIds.forEach((roleId) => {
        const queue = operationQueues.get(roleId) ?? [];
        queue.push(id);
        operationQueues.set(roleId, queue);
      });
      grantReadyOperations();
      return promise;
    },
    completeBrowserOperation(id: string): void {
      removeOperation(id);
      grantReadyOperations();
    },
    invokeBrowserRuntime(command: BrowserRuntimeCommand): BrowserRuntimeResult {
      let createdTabId: string | undefined;
      switch (command.type) {
        case "snapshot":
          break;
        case "beginWorkspace":
          workspaces.set(command.workspaceId, {
            workspaceId: command.workspaceId,
            name: command.name,
            runtime: "pending",
            ...(command.displayId === undefined ? {} : { displayId: command.displayId }),
            exclusiveDisplay: false,
            roleIds: [...command.roleIds],
            state: "launching"
          });
          break;
        case "registerDisplay":
          registerDisplay(command.displayId);
          break;
        case "createTab": {
          createdTabId = `runtime-tab-${++nextTabId}`;
          const display = registerDisplay(command.displayId);
          display.tabIds.push(createdTabId);
          tabs.set(createdTabId, {
            id: createdTabId,
            sourceId: command.sourceId,
            name: command.name,
            displayId: command.displayId,
            tabType: command.tabType,
            ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
            roleIds: [...command.roleIds],
            hidden: true
          });
          if (command.workspaceId) {
            workspaces.set(command.workspaceId, {
              workspaceId: command.workspaceId,
              name: command.name,
              runtime: "embedded",
              displayId: command.displayId,
              exclusiveDisplay: false,
              tabId: createdTabId,
              roleIds: [...command.roleIds],
              state: "launching"
            });
          }
          break;
        }
        case "createExternalWorkspace": {
          const occupied = command.exclusiveDisplay && command.displayId !== undefined &&
            [...workspaces.values()].find(
              (workspace) => workspace.workspaceId !== command.workspaceId &&
                workspace.exclusiveDisplay && workspace.displayId === command.displayId
            );
          if (occupied) {
            const error = new Error("Launch workspace target display is already occupied.") as
              Error & { code: string };
            error.code = "WORKSPACE_DISPLAY_OCCUPIED";
            throw error;
          }
          workspaces.set(command.workspaceId, {
            workspaceId: command.workspaceId,
            name: command.name,
            runtime: "external",
            ...(command.displayId === undefined ? {} : { displayId: command.displayId }),
            exclusiveDisplay: command.exclusiveDisplay,
            roleIds: [...command.roleIds],
            state: "launching"
          });
          break;
        }
        case "removeTab":
          removeTab(command.tabId);
          break;
        case "activateTab": {
          const tab = tabs.get(command.tabId);
          if (tab) {
            tab.hidden = false;
            registerDisplay(tab.displayId).activeTabId = tab.id;
          }
          break;
        }
        case "showDisplay": {
          const display = displays.get(command.displayId);
          const selected = display?.activeTabId && !tabs.get(display.activeTabId)?.hidden
            ? display.activeTabId
            : display?.tabIds[0];
          const tab = selected ? tabs.get(selected) : undefined;
          if (display && tab) {
            tab.hidden = false;
            display.activeTabId = tab.id;
          }
          break;
        }
        case "activateAdjacentTab": {
          const display = displays.get(command.displayId);
          const visible = display?.tabIds.filter((tabId) => !tabs.get(tabId)?.hidden) ?? [];
          if (display && visible.length >= 2) {
            const current = visible.indexOf(display.activeTabId ?? "");
            const next = current < 0
              ? 0
              : command.direction === "next"
                ? (current + 1) % visible.length
                : (current - 1 + visible.length) % visible.length;
            display.activeTabId = visible[next];
          }
          break;
        }
        case "hideTab": {
          const tab = tabs.get(command.tabId);
          const display = tab ? displays.get(tab.displayId) : undefined;
          if (tab) tab.hidden = true;
          if (display?.activeTabId === command.tabId) {
            display.activeTabId = display.tabIds.find((id) => !tabs.get(id)?.hidden);
          }
          break;
        }
        case "reorderTab": {
          const tab = tabs.get(command.tabId);
          const display = tab ? displays.get(tab.displayId) : undefined;
          if (display) {
            const ids = display.tabIds.filter((id) => id !== command.tabId);
            const index = command.beforeTabId ? ids.indexOf(command.beforeTabId) : -1;
            ids.splice(index < 0 ? ids.length : index, 0, command.tabId);
            display.tabIds = ids;
          }
          break;
        }
        case "moveTab": {
          const tab = tabs.get(command.tabId);
          if (!tab) break;
          const source = displays.get(tab.displayId);
          if (source) {
            source.tabIds = source.tabIds.filter((id) => id !== tab.id);
            if (source.activeTabId === tab.id) {
              source.activeTabId = source.tabIds.find((id) => !tabs.get(id)?.hidden);
            }
            if (source.tabIds.length === 0) displays.delete(source.displayId);
          }
          tab.displayId = command.displayId;
          tab.hidden = false;
          const target = registerDisplay(command.displayId);
          target.tabIds.push(tab.id);
          target.activeTabId = tab.id;
          if (tab.workspaceId) {
            const workspace = workspaces.get(tab.workspaceId);
            if (workspace) workspace.displayId = command.displayId;
          }
          break;
        }
        case "moveDisplayTabs": {
          const source = displays.get(command.sourceDisplayId);
          if (!source) break;
          const target = registerDisplay(command.targetDisplayId);
          for (const tabId of source.tabIds) {
            const tab = tabs.get(tabId);
            if (!tab) continue;
            tab.displayId = command.targetDisplayId;
            target.tabIds.push(tabId);
            if (tab.workspaceId) {
              const workspace = workspaces.get(tab.workspaceId);
              if (workspace) workspace.displayId = command.targetDisplayId;
            }
          }
          if (!target.activeTabId) target.activeTabId = source.activeTabId;
          displays.delete(command.sourceDisplayId);
          break;
        }
        case "roleTransition": {
          const previousRole = roles.get(command.roleId);
          roles.set(command.roleId, {
            roleId: command.roleId,
            runtime: command.runtime,
            ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
            ...(command.tabId ? { tabId: command.tabId } : {}),
            state: command.state,
            ...(command.launchedAt || previousRole?.launchedAt
              ? { launchedAt: command.launchedAt ?? previousRole?.launchedAt }
              : {})
          });
          if (command.workspaceId) refreshWorkspace(command.workspaceId);
          break;
        }
        case "removeRole": {
          const role = roles.get(command.roleId);
          roles.delete(command.roleId);
          if (role?.workspaceId) refreshWorkspace(role.workspaceId);
          break;
        }
        case "setWorkspaceState": {
          const workspace = workspaces.get(command.workspaceId);
          if (workspace) workspace.state = command.state;
          break;
        }
        case "removeWorkspace":
          workspaces.delete(command.workspaceId);
          break;
      }
      const runtimeSnapshot = snapshot();
      this.publishStatuses();
      return { ...(createdTabId ? { createdTabId } : {}), snapshot: runtimeSnapshot };
    }
  };
}
