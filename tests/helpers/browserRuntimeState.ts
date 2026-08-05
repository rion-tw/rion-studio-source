import type {
  BrowserOperationLease,
  BrowserOperationRequest,
  BrowserRoleStatusRecord,
  BrowserRuntimeCommand,
  BrowserRuntimeResult,
  BrowserRuntimeRoleOwnerRecord,
  BrowserRuntimeRoleRecord,
  BrowserRuntimeSnapshot,
  BrowserRuntimeTabRecord,
  BrowserRuntimeWindowRecord,
  BrowserRuntimeWorkspaceRecord,
  CoreCommand,
  CoreCommandResult,
  CoreEvent
} from "../../src/shared/generated";

export function createBrowserRuntimeState() {
  let nextTabId = 0;
  let nextOperationId = 0;
  let nextOwnerGeneration = 0;
  const windows = new Map<string, BrowserRuntimeWindowRecord>();
  const roles = new Map<string, BrowserRuntimeRoleRecord>();
  const tabs = new Map<string, BrowserRuntimeTabRecord>();
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

  const operationError = (code: string, message: string): Error => {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
  };
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
  const grantReadyOperations = (): void => {
    for (const [id, ticket] of operationTickets) {
      if (ticket.active || !ticket.lease.roleIds.every(
        (roleId) => operationQueues.get(roleId)?.[0] === id
      )) continue;
      if (ticket.lease.roleIds.some((roleId) => blockedRoleIds.has(roleId))) {
        removeOperation(id);
        ticket.reject(operationError(
          "ROLE_MUTATION_BLOCKED",
          "Role is blocked by a destructive mutation."
        ));
        grantReadyOperations();
        return;
      }
      if (ticket.kind === "normal" && ticket.lease.roleIds.some(
        (roleId) => (roleVersions.get(roleId) ?? 0) !== (ticket.queuedVersions.get(roleId) ?? 0)
      )) {
        removeOperation(id);
        ticket.reject(operationError(
          "ROLE_DATA_CHANGED",
          "Role data changed while the operation was queued."
        ));
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
  const registerWindow = (windowId: string): BrowserRuntimeWindowRecord => {
    const existing = windows.get(windowId);
    if (existing) return existing;
    const runtimeWindow: BrowserRuntimeWindowRecord = { windowId, tabIds: [] };
    windows.set(windowId, runtimeWindow);
    return runtimeWindow;
  };
  const nextOwner = (tabId: string, slotId: string): BrowserRuntimeRoleOwnerRecord => {
    if (!tabs.has(tabId)) throw operationError("RUNTIME_TAB_NOT_FOUND", "Runtime tab was not found.");
    return {
      tabId,
      slotId,
      generation: ++nextOwnerGeneration
    };
  };
  const refreshSlots = (): void => {
    tabs.forEach((tab) => {
      tab.slots.forEach((slot) => {
        const role = roles.get(slot.roleId);
        if (!role) {
          slot.state = "available";
          delete slot.owner;
        } else if (role.owner.tabId === tab.id && role.owner.slotId === slot.slotId) {
          slot.state = role.state;
          slot.owner = { ...role.owner };
        } else {
          slot.state = "blocked";
          slot.owner = { ...role.owner };
        }
      });
    });
  };
  const workspaceState = (
    slots: BrowserRuntimeTabRecord["slots"]
  ): BrowserRuntimeWorkspaceRecord["state"] => {
    if (slots.some((slot) => slot.state === "stopping")) return "stopping";
    if (slots.every((slot) => slot.state === "running")) return "running";
    if (slots.some((slot) => slot.state === "launching")) return "launching";
    return "partial";
  };
  const projectedWorkspaces = (): BrowserRuntimeWorkspaceRecord[] => [...tabs.values()]
    .filter((tab) => tab.tabType === "workspace")
    .map((tab) => ({
      workspaceId: tab.workspaceId ?? tab.sourceId,
      name: tab.name,
      runtime: "embedded",
      windowId: tab.windowId,
      tabId: tab.id,
      roleIds: tab.slots.map((slot) => slot.roleId),
      state: workspaceState(tab.slots)
    }));
  const snapshot = (): BrowserRuntimeSnapshot => ({
    windows: [...windows.values()].map((window) => ({
      ...window,
      tabIds: [...window.tabIds]
    })),
    roles: [...roles.values()].map((role) => ({
      ...role,
      owner: { ...role.owner }
    })),
    tabs: [...tabs.values()].map((tab) => ({
      ...tab,
      slots: tab.slots.map((slot) => ({
        ...slot,
        ...(slot.owner ? { owner: { ...slot.owner } } : {})
      }))
    })),
    workspaces: projectedWorkspaces()
  });
  const removeTab = (tabId: string): void => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tabs.delete(tabId);
    const runtimeWindow = windows.get(tab.windowId);
    if (runtimeWindow) {
      runtimeWindow.tabIds = runtimeWindow.tabIds.filter((id) => id !== tabId);
      if (runtimeWindow.activeTabId === tabId) delete runtimeWindow.activeTabId;
    }
    roles.forEach((role, roleId) => {
      if (role.owner.tabId === tabId) roles.delete(roleId);
    });
    refreshSlots();
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
    publishBrowserStatuses(statuses: BrowserRoleStatusRecord[]): void {
      listeners.forEach((listener) => listener([{ type: "browserStatuses", statuses }]));
    },
    listBrowserStatuses(): BrowserRoleStatusRecord[] {
      return snapshot().roles.map((role) => ({
        roleId: role.roleId,
        state: role.state,
        ...(role.launchedAt ? { launchedAt: role.launchedAt } : {}),
        runtimeMode: role.runtime
      }));
    },
    listBrowserWorkspaceStatuses() {
      return projectedWorkspaces().map(({ state, workspaceId }) => ({ state, workspaceId }));
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
        command.type === "browserRoleStop"
        || command.type === "browserWorkspaceStop"
        || command.type === "embeddedRoleStop"
        || command.type === "embeddedWorkspaceStop"
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
        case "registerWindow":
          registerWindow(command.windowId);
          break;
        case "removeWindow":
          if ((windows.get(command.windowId)?.tabIds.length ?? 0) === 0) {
            windows.delete(command.windowId);
          }
          break;
        case "createTab": {
          if ([...tabs.values()].some((tab) =>
            tab.sourceId === command.sourceId && tab.tabType === command.tabType)) {
            throw operationError("RUNTIME_SOURCE_ALREADY_OPEN", "The runtime source is already open.");
          }
          const roleIds = new Set(command.roleSlots.map((slot) => slot.roleId));
          const slotIds = new Set(command.roleSlots.map((slot) => slot.slotId));
          if (
            command.roleSlots.length === 0
            || roleIds.size !== command.roleSlots.length
            || slotIds.size !== command.roleSlots.length
          ) {
            throw operationError("RUNTIME_ROLE_SLOT_INVALID", "Runtime role slots are invalid.");
          }
          createdTabId = command.tabId ?? `runtime-tab-${++nextTabId}`;
          const runtimeWindow = registerWindow(command.windowId);
          runtimeWindow.tabIds.push(createdTabId);
          tabs.set(createdTabId, {
            id: createdTabId,
            sourceId: command.sourceId,
            name: command.name,
            windowId: command.windowId,
            tabType: command.tabType,
            ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
            slots: command.roleSlots.map((slot) => ({
              ...slot,
              state: "available"
            })),
            hidden: true
          });
          refreshSlots();
          break;
        }
        case "removeTab":
          removeTab(command.tabId);
          break;
        case "roleTransition": {
          const tab = tabs.get(command.tabId);
          const slot = tab?.slots.find((candidate) =>
            candidate.roleId === command.roleId
            && (!command.slotId || candidate.slotId === command.slotId));
          if (!tab || !slot) {
            throw operationError("RUNTIME_ROLE_SLOT_NOT_FOUND", "Runtime role slot was not found.");
          }
          const previous = roles.get(command.roleId);
          const owner = previous?.owner.tabId === tab.id && previous.owner.slotId === slot.slotId
            ? previous.owner
            : nextOwner(tab.id, slot.slotId);
          roles.set(command.roleId, {
            roleId: command.roleId,
            runtime: command.runtime,
            owner,
            state: command.state,
            ...(command.launchedAt || previous?.launchedAt
              ? { launchedAt: command.launchedAt ?? previous?.launchedAt }
              : {})
          });
          refreshSlots();
          break;
        }
        case "releaseRole": {
          const role = roles.get(command.roleId);
          if (command.expectedTabId && role?.owner.tabId !== command.expectedTabId) {
            throw operationError("RUNTIME_ROLE_OWNER_STALE", "Runtime role owner changed.");
          }
          roles.delete(command.roleId);
          refreshSlots();
          break;
        }
        case "claimRoleSlot": {
          const tab = tabs.get(command.tabId);
          const slot = tab?.slots.find((candidate) =>
            candidate.slotId === command.slotId && candidate.roleId === command.roleId);
          if (!tab || !slot) {
            throw operationError("RUNTIME_ROLE_SLOT_NOT_FOUND", "Runtime role slot was not found.");
          }
          const previous = roles.get(command.roleId);
          if (
            command.expectedOwnerGeneration !== undefined
            && previous?.owner.generation !== command.expectedOwnerGeneration
          ) {
            throw operationError("RUNTIME_ROLE_OWNER_STALE", "Runtime role owner changed.");
          }
          roles.set(command.roleId, {
            roleId: command.roleId,
            runtime: "embedded",
            owner: nextOwner(command.tabId, command.slotId),
            state: "launching",
            ...(previous?.launchedAt ? { launchedAt: previous.launchedAt } : {})
          });
          refreshSlots();
          break;
        }
      }
      const runtimeSnapshot = snapshot();
      this.publishStatuses();
      return { ...(createdTabId ? { createdTabId } : {}), snapshot: runtimeSnapshot };
    }
  };
}
