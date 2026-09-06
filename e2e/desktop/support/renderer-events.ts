import { browser } from "@wdio/globals";

import type {
  AppSnapshot,
  EmbeddedRuntimeState,
  GameWindow,
  MacroRunStatus,
  RoleStatus
} from "../../../src/shared/types";
import type { SurfaceRecoveryAttemptRecord } from "../../../src/shared/generated";

const JOURNAL_KEY = "__rionStudioDesktopE2eEventJournal";

type CollectionName = "games" | "launchWorkspaces" | "macros" | "roles";

interface CollectionWaitRequest {
  absentNames?: string[];
  afterSequence?: number;
  collection: CollectionName;
  kind: "collection";
  names?: string[];
  orderedNames?: string[];
}

interface GameWindowWaitRequest {
  absent?: boolean;
  afterSequence?: number;
  kind: "gameWindow";
  name?: string;
  sourceId?: string;
  tabCount?: number;
  windowId?: string;
}

interface RecoveryWaitRequest {
  afterSequence?: number;
  kind: "recovery";
  phase?: SurfaceRecoveryAttemptRecord["phase"];
  roleId: string;
  status?: SurfaceRecoveryAttemptRecord["status"];
}

interface MacroWaitRequest {
  absent?: boolean;
  afterSequence?: number;
  macroId: string;
  minimumIteration?: number;
  roleIds?: string[];
  state?: string;
  kind: "macro";
}

interface RoleWaitRequest {
  absent?: boolean;
  afterSequence?: number;
  automationState?: RoleStatus["automationState"];
  kind: "role";
  pageHealth?: RoleStatus["pageHealth"];
  roleId: string;
  state?: RoleStatus["state"];
}

interface RuntimeWaitRequest {
  activeTabId?: string;
  absent?: boolean;
  afterSequence?: number;
  exactWindowIds?: string[];
  hidden?: boolean;
  kind: "runtime";
  recoveryAbsent?: boolean;
  recoveryTabCount?: number;
  recoveryWindowCount?: number;
  roleSlots?: Array<{
    ownedByTargetTab?: boolean;
    ownerTabId?: string;
    roleId: string;
    state?: "available" | "blocked" | "launching" | "running" | "stopping";
    tabId?: string;
  }>;
  roleIds?: string[];
  savedWindowStates?: Array<{
    state: "awaiting-recovery" | "dormant" | "failed" | "restoring";
    windowId: string;
  }>;
  sourceId?: string;
  tabId?: string;
  windowId?: string;
  windowIds?: string[];
}

type RendererWaitRequest =
  | CollectionWaitRequest
  | GameWindowWaitRequest
  | MacroWaitRequest
  | RecoveryWaitRequest
  | RoleWaitRequest
  | RuntimeWaitRequest;

interface RendererWaitResult<T> {
  error?: string;
  ok: boolean;
  value?: T;
}

export async function installRendererEventJournal(): Promise<void> {
  await browser.execute((key) => {
    interface PageEntry<T> {
      sequence: number;
      value: T;
    }
    interface PageJournal {
      gameWindows: Array<PageEntry<GameWindow[]>>;
      macroStatuses: Array<PageEntry<MacroRunStatus[]>>;
      nextSequence: number;
      recoveries: Array<PageEntry<SurfaceRecoveryAttemptRecord>>;
      roleStatuses: Array<PageEntry<RoleStatus[]>>;
      runtimeStates: Array<PageEntry<EmbeddedRuntimeState>>;
      snapshots: Array<PageEntry<AppSnapshot>>;
      waiters: Set<() => void>;
    }

    const page = window as unknown as Record<string, unknown>;
    if (page[key]) return;
    const journal: PageJournal = {
      gameWindows: [],
      macroStatuses: [],
      nextSequence: 1,
      recoveries: [],
      roleStatuses: [],
      runtimeStates: [],
      snapshots: [],
      waiters: new Set()
    };
    page[key] = journal;

    const record = <T>(entries: Array<PageEntry<T>>, value: T): void => {
      entries.push({ sequence: journal.nextSequence++, value });
      if (entries.length > 256) entries.shift();
      for (const waiter of [...journal.waiters]) waiter();
    };
    const recordSnapshot = (value: AppSnapshot): void => {
      record(journal.snapshots, value);
      record(journal.gameWindows, value.gameWindows);
      record(journal.macroStatuses, value.macroStatuses);
      record(journal.roleStatuses, value.roleStatuses);
      record(journal.runtimeStates, value.embeddedRuntimeState);
    };
    const api = window.rionStudio;
    api.onAppSnapshotChanged(recordSnapshot);
    api.onGameWindowsChanged((value) => record(journal.gameWindows, value));
    api.onMacroStatusChanged((value) => record(journal.macroStatuses, value));
    api.onRoleStatusChanged((value) => record(journal.roleStatuses, value));
    api.onEmbeddedRuntimeStateChanged((value) => record(journal.runtimeStates, value));
    api.onSurfaceRecoveryAttemptChanged((value) => record(journal.recoveries, value));
    void api.getAppSnapshot().then(recordSnapshot);
    void api.listGameWindows().then((value) => record(journal.gameWindows, value));
    void api.listMacroStatuses().then((value) => record(journal.macroStatuses, value));
    void api.listRoleStatuses().then((value) => record(journal.roleStatuses, value));
    void api.getEmbeddedRuntimeState().then((value) => record(journal.runtimeStates, value));
  }, JOURNAL_KEY);
}

export async function rendererEventCursor(): Promise<number> {
  return browser.execute((key) => {
    const page = window as unknown as Record<string, unknown>;
    const journal = page[key] as { nextSequence?: number } | undefined;
    return Math.max((journal?.nextSequence ?? 1) - 1, 0);
  }, JOURNAL_KEY);
}

async function waitForRendererProjection<T>(request: RendererWaitRequest): Promise<T> {
  const result = await browser.executeAsync(
    (
      key: string,
      waitRequest: RendererWaitRequest,
      done: (result: RendererWaitResult<T>) => void
    ) => {
      interface PageEntry<TValue> {
        sequence: number;
        value: TValue;
      }
      interface PageJournal {
        gameWindows: Array<PageEntry<GameWindow[]>>;
        macroStatuses: Array<PageEntry<MacroRunStatus[]>>;
        recoveries: Array<PageEntry<SurfaceRecoveryAttemptRecord>>;
        roleStatuses: Array<PageEntry<RoleStatus[]>>;
        runtimeStates: Array<PageEntry<EmbeddedRuntimeState>>;
        snapshots: Array<PageEntry<AppSnapshot>>;
        waiters: Set<() => void>;
      }

      const page = window as unknown as Record<string, unknown>;
      const journal = page[key] as PageJournal | undefined;
      if (!journal) {
        done({ error: "Renderer event journal is not installed", ok: false });
        return;
      }
      const afterSequence = waitRequest.afterSequence ?? 0;
      let settled = false;
      const latestEntry = <TValue>(entries: Array<PageEntry<TValue>>): PageEntry<TValue> | undefined => {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const entry = entries[index];
          if (entry.sequence > afterSequence) return entry;
        }
        return undefined;
      };

      const finish = (value: unknown): void => {
        if (settled) return;
        settled = true;
        journal.waiters.delete(check);
        done({ ok: true, value: value as T });
      };
      const findMatch = (): unknown => {
        if (waitRequest.kind === "collection") {
          const entry = latestEntry(journal.snapshots);
          if (!entry) return undefined;
          const entities = entry.value[waitRequest.collection] as Array<{ name: string }>;
          const names = entities.map((entity) => entity.name);
          if (waitRequest.names?.some((name) => !names.includes(name))) return undefined;
          if (waitRequest.absentNames?.some((name) => names.includes(name))) return undefined;
          if (waitRequest.orderedNames) {
            const expected = new Set(waitRequest.orderedNames);
            const selectedOrder = names.filter((name) => expected.has(name));
            if (selectedOrder.join("\n") !== waitRequest.orderedNames.join("\n")) return undefined;
          }
          return entry.value;
        }
        if (waitRequest.kind === "role") {
          const entry = latestEntry(journal.roleStatuses);
          if (!entry) return undefined;
          const status = entry.value.find((candidate) => candidate.roleId === waitRequest.roleId);
          if (waitRequest.absent) return status === undefined ? entry.value : undefined;
          if (!status) return undefined;
          return (!waitRequest.state || status.state === waitRequest.state)
            && (!waitRequest.pageHealth || status.pageHealth === waitRequest.pageHealth)
            && (!waitRequest.automationState || status.automationState === waitRequest.automationState)
            ? entry.value
            : undefined;
        }
        if (waitRequest.kind === "runtime") {
          for (let index = journal.runtimeStates.length - 1; index >= 0; index -= 1) {
            const entry = journal.runtimeStates[index];
            if (entry.sequence <= afterSequence) continue;
            const tab = waitRequest.tabId
              ? entry.value.tabs.find((candidate) => candidate.id === waitRequest.tabId)
              : waitRequest.sourceId
                ? entry.value.tabs.find((candidate) => candidate.sourceId === waitRequest.sourceId)
              : undefined;
            const runtimeWindow = waitRequest.windowId
              ? entry.value.windows.find((candidate) => candidate.windowId === waitRequest.windowId)
              : undefined;
            if (waitRequest.absent) {
              const targetAbsent = waitRequest.sourceId || waitRequest.tabId
                ? tab === undefined
                : runtimeWindow === undefined;
              if (targetAbsent) return entry.value;
              continue;
            }
            if (waitRequest.sourceId && !tab) continue;
            if (waitRequest.tabId && !tab) continue;
            if (waitRequest.hidden !== undefined && tab?.hidden !== waitRequest.hidden) continue;
            if (waitRequest.windowId && !runtimeWindow) continue;
            if (waitRequest.activeTabId && runtimeWindow?.activeTabId !== waitRequest.activeTabId) {
              continue;
            }
            if (waitRequest.windowIds?.some((windowId) =>
              !entry.value.windows.some((candidate) => candidate.windowId === windowId)
            )) {
              continue;
            }
            if (waitRequest.exactWindowIds) {
              const actualWindowIds = entry.value.windows.map((candidate) => candidate.windowId).sort();
              const expectedWindowIds = [...waitRequest.exactWindowIds].sort();
              if (actualWindowIds.join("\n") !== expectedWindowIds.join("\n")) continue;
            }
            if (waitRequest.recoveryAbsent && entry.value.recovery) continue;
            if (waitRequest.recoveryWindowCount !== undefined
              && entry.value.recovery?.windowCount !== waitRequest.recoveryWindowCount) {
              continue;
            }
            if (waitRequest.recoveryTabCount !== undefined
              && entry.value.recovery?.tabCount !== waitRequest.recoveryTabCount) {
              continue;
            }
            if (waitRequest.savedWindowStates?.some((expectation) =>
              !entry.value.savedWindows?.some((candidate) =>
                candidate.id === expectation.windowId && candidate.state === expectation.state
              )
            )) {
              continue;
            }
            if (waitRequest.roleSlots?.some((ownerExpectation) => {
              const targetTab = ownerExpectation.tabId
                ? entry.value.tabs.find((candidate) => candidate.id === ownerExpectation.tabId)
                : tab;
              const slot = targetTab?.slots.find(
                (candidate) => candidate.roleId === ownerExpectation.roleId
              );
              return !slot
                || Boolean(ownerExpectation.state && slot.state !== ownerExpectation.state)
                || Boolean(
                  ownerExpectation.ownerTabId
                  && slot.owner?.tabId !== ownerExpectation.ownerTabId
                )
                || Boolean(
                  ownerExpectation.ownedByTargetTab
                  && slot.owner?.tabId !== targetTab?.id
                );
            })) {
              continue;
            }
            if (!waitRequest.roleIds
              || (tab && waitRequest.roleIds.every((roleId) => tab.roleIds.includes(roleId)))) {
              return entry.value;
            }
          }
          return undefined;
        }
        if (waitRequest.kind === "gameWindow") {
          const entry = latestEntry(journal.gameWindows);
          if (!entry) return undefined;
          const gameWindow = entry.value.find((candidate) =>
            (!waitRequest.windowId || candidate.id === waitRequest.windowId)
            && (!waitRequest.name || candidate.name === waitRequest.name)
            && (!waitRequest.sourceId || candidate.tabs.some((tab) => tab.sourceId === waitRequest.sourceId))
          );
          if (waitRequest.absent) return gameWindow === undefined ? entry.value : undefined;
          return gameWindow
            && (waitRequest.tabCount === undefined || gameWindow.tabs.length === waitRequest.tabCount)
            ? entry.value
            : undefined;
        }
        if (waitRequest.kind === "macro") {
          for (let index = journal.macroStatuses.length - 1; index >= 0; index -= 1) {
            const entry = journal.macroStatuses[index];
            if (entry.sequence <= afterSequence) continue;
            const statuses = entry.value.filter((status) => status.macroId === waitRequest.macroId);
            if (waitRequest.absent) {
              if (statuses.length === 0) return entry.value;
              continue;
            }
            const roleIds = waitRequest.roleIds ?? [];
            if (roleIds.some((roleId) => !statuses.some((status) => status.roleId === roleId))) {
              continue;
            }
            const selected = roleIds.length === 0
              ? statuses
              : statuses.filter((status) => roleIds.includes(status.roleId));
            if (selected.length === 0) continue;
            if (waitRequest.state && selected.some((status) => status.state !== waitRequest.state)) {
              continue;
            }
            if (
              waitRequest.minimumIteration !== undefined
              && selected.some((status) => (status.iteration ?? 0) < waitRequest.minimumIteration!)
            ) {
              continue;
            }
            return entry.value;
          }
          return undefined;
        }
        for (let index = journal.recoveries.length - 1; index >= 0; index -= 1) {
          const entry = journal.recoveries[index];
          if (
            entry.sequence > afterSequence
            && entry.value.roleId === waitRequest.roleId
            && (!waitRequest.phase || entry.value.phase === waitRequest.phase)
            && (!waitRequest.status || entry.value.status === waitRequest.status)
          ) {
            return entry.value;
          }
        }
        return undefined;
      };
      const check = (): void => {
        const match = findMatch();
        if (match !== undefined) finish(match);
      };

      journal.waiters.add(check);
      check();
    },
    JOURNAL_KEY,
    request
  ).catch(async (error: unknown) => {
    let diagnostic: unknown;
    try {
      diagnostic = await browser.execute(async (key, macroId) => {
        const page = window as unknown as Record<string, unknown>;
        const journal = page[key] as {
          nextSequence: number;
          macroStatuses: Array<{ sequence: number; value: MacroRunStatus[] }>;
          waiters: Set<unknown>;
        } | undefined;
        const select = (statuses: MacroRunStatus[]) => statuses
          .filter(status => !macroId || status.macroId === macroId)
          .map(status => ({ macroId: status.macroId, roleId: status.roleId,
            state: status.state, iteration: status.iteration }));
        return {
          journalInstalled: !!journal,
          nextSequence: journal?.nextSequence,
          waiterCount: journal?.waiters.size,
          recentMacroEntries: journal?.macroStatuses.slice(-32).map(entry => ({
            sequence: entry.sequence, statuses: select(entry.value)
          })),
          currentMacroStatuses: window.rionStudio
            ? select(await window.rionStudio.listMacroStatuses()) : null
        };
      }, JOURNAL_KEY, request.kind === "macro" ? request.macroId : undefined);
    } catch (diagnosticError) {
      diagnostic = { unavailable: String(diagnosticError) };
    }
    throw new Error(`Renderer projection wait failed: ${JSON.stringify(request)}; ` +
      `diagnostic=${JSON.stringify(diagnostic)}`, { cause: error });
  }) as RendererWaitResult<T>;
  if (!result.ok) throw new Error(result.error ?? "Renderer event wait failed");
  return result.value as T;
}

export function waitForCollectionProjection(
  request: Omit<CollectionWaitRequest, "kind">
): Promise<AppSnapshot> {
  return waitForRendererProjection({ ...request, kind: "collection" });
}

export function waitForGameWindowProjection(
  request: Omit<GameWindowWaitRequest, "kind">
): Promise<GameWindow[]> {
  return waitForRendererProjection({ ...request, kind: "gameWindow" });
}

export function waitForMacroProjection(
  request: Omit<MacroWaitRequest, "kind">
): Promise<MacroRunStatus[]> {
  return waitForRendererProjection({ ...request, kind: "macro" });
}

export function waitForRecoveryAttempt(
  request: Omit<RecoveryWaitRequest, "kind">
): Promise<SurfaceRecoveryAttemptRecord> {
  return waitForRendererProjection({ ...request, kind: "recovery" });
}

export function waitForRoleProjection(
  request: Omit<RoleWaitRequest, "kind">
): Promise<RoleStatus[]> {
  return waitForRendererProjection({ ...request, kind: "role" });
}

export function waitForRuntimeProjection(
  request: Omit<RuntimeWaitRequest, "kind">
): Promise<EmbeddedRuntimeState> {
  return waitForRendererProjection({ ...request, kind: "runtime" });
}
