import type {
  CoreCommand,
  CoreCommandResult,
  RuntimeRestoreSessionRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeExecutorSnapshot } from
  "./chromiumRuntimeSnapshot";

export interface ChromiumRuntimeRestoreSessionCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

export interface ChromiumRuntimeRestoreSessionCoordinatorInput {
  readonly core: ChromiumRuntimeRestoreSessionCorePort;
  readonly now?: () => string;
}

export type ChromiumRuntimeRestoreSessionMutation = (
  current: Readonly<RuntimeRestoreSessionRecord>
) => Partial<RuntimeRestoreSessionRecord>;

export interface ChromiumRuntimeRestoreSessionMutationPort {
  inspect: () => Promise<RuntimeRestoreSessionRecord>;
  mutate: (
    mutation: ChromiumRuntimeRestoreSessionMutation
  ) => Promise<RuntimeRestoreSessionRecord>;
}

type PersistMode = "clean-exit" | "runtime-committed";

function persistenceError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function nextGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw persistenceError(
      "ELECTRON_RUNTIME_RESTORE_SESSION_GENERATION_INVALID",
      "Core returned an invalid runtime-restore session generation."
    );
  }
  const next = value + 1;
  if (!Number.isSafeInteger(next)) {
    throw persistenceError(
      "ELECTRON_RUNTIME_RESTORE_SESSION_GENERATION_EXHAUSTED",
      "The runtime-restore session generation is exhausted."
    );
  }
  return next;
}

function sameJsonStructure(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every(
        (value, index) => sameJsonStructure(value, right[index])
      );
  }
  if (
    left === null || right === null ||
    typeof left !== "object" || typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => leftRecord[key] !== undefined)
    .sort();
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => rightRecord[key] !== undefined)
    .sort();
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] &&
      sameJsonStructure(leftRecord[key], rightRecord[key])
  );
}

function snapshotWindowState(snapshot: ChromiumRuntimeExecutorSnapshot): Readonly<{
  focusedWindowId: string | null;
  liveWindowIds: readonly string[];
}> {
  const windowIds = new Set<string>();
  const tabIds = new Set<string>();
  let focusedWindowId: string | null = null;
  for (const window of snapshot.windows) {
    if (
      !validIdentifier(window.windowId) || windowIds.has(window.windowId) ||
      !Number.isSafeInteger(window.windowGeneration) || window.windowGeneration < 0 ||
      !Number.isSafeInteger(window.topologyRevision) || window.topologyRevision < 0 ||
      !Array.isArray(window.tabIds) ||
      window.tabIds.some((tabId) =>
        !validIdentifier(tabId) || tabIds.has(tabId)
      ) ||
      (window.focused && (!window.visible || focusedWindowId !== null))
    ) {
      throw persistenceError(
        "ELECTRON_RUNTIME_RESTORE_NATIVE_SNAPSHOT_INVALID",
        "The native Chromium runtime cannot be persisted from an ambiguous window snapshot."
      );
    }
    windowIds.add(window.windowId);
    for (const tabId of window.tabIds) tabIds.add(tabId);
    if (window.focused) focusedWindowId = window.windowId;
  }
  return Object.freeze({
    focusedWindowId,
    liveWindowIds: Object.freeze([...windowIds].sort())
  });
}

/**
 * Serializes the exact native Game Window cohort into Rust-owned recovery
 * state. Runtime commits remain unclean until a normal lifecycle drain first
 * persists one final clean snapshot. A fatal startup uses the drain without
 * this clean boundary and therefore cannot masquerade as a successful exit.
 */
export class ChromiumRuntimeRestoreSessionCoordinator {
  readonly #input: ChromiumRuntimeRestoreSessionCoordinatorInput;
  #lane: Promise<void> = Promise.resolve();

  constructor(input: ChromiumRuntimeRestoreSessionCoordinatorInput) {
    this.#input = input;
  }

  synchronize(
    snapshot: ChromiumRuntimeExecutorSnapshot
  ): Promise<RuntimeRestoreSessionRecord> {
    return this.#enqueue(snapshot, "runtime-committed");
  }

  persistCleanExit(
    snapshot: ChromiumRuntimeExecutorSnapshot
  ): Promise<RuntimeRestoreSessionRecord> {
    return this.#enqueue(snapshot, "clean-exit");
  }

  inspect(): Promise<RuntimeRestoreSessionRecord> {
    return this.#enqueueOperation(async () => structuredClone(
      await this.#input.core.invoke({ type: "runtimeRestoreSessionGet" })
    ));
  }

  mutate(
    mutation: ChromiumRuntimeRestoreSessionMutation
  ): Promise<RuntimeRestoreSessionRecord> {
    return this.#enqueueOperation(async () => {
      const current = await this.#input.core.invoke({
        type: "runtimeRestoreSessionGet"
      });
      return this.#replace(current, mutation(structuredClone(current)));
    });
  }

  #enqueue(
    snapshot: ChromiumRuntimeExecutorSnapshot,
    mode: PersistMode
  ): Promise<RuntimeRestoreSessionRecord> {
    let native: ReturnType<typeof snapshotWindowState>;
    try {
      native = snapshotWindowState(snapshot);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueueOperation(async () => {
      const current = await this.#input.core.invoke({
        type: "runtimeRestoreSessionGet"
      });
      const cleanExit = mode === "clean-exit";
      const live = new Set(native.liveWindowIds);
      const retainedFocus = current.lastFocusedWindowId;
      const lastFocusedWindowId = native.focusedWindowId ?? (
        retainedFocus !== undefined && live.has(retainedFocus)
          ? retainedFocus
          : cleanExit && native.liveWindowIds.length === 1
            ? native.liveWindowIds[0]
            : undefined
      );
      return this.#replace(current, {
        cleanExit,
        lastFocusedWindowId,
        restoreInProgressWindowIds: cleanExit
          ? []
          : [...new Set(current.restoreInProgressWindowIds)].sort(),
        liveWindowIds: [...native.liveWindowIds],
        windows: []
      });
    });
  }

  async #replace(
    current: RuntimeRestoreSessionRecord,
    changes: Partial<RuntimeRestoreSessionRecord>
  ): Promise<RuntimeRestoreSessionRecord> {
    const session: RuntimeRestoreSessionRecord = {
      ...structuredClone(current),
      ...structuredClone(changes),
      schemaVersion: 2,
      sessionGeneration: nextGeneration(current.sessionGeneration),
      updatedAt: (this.#input.now ?? (() => new Date().toISOString()))()
    };
    if (session.lastFocusedWindowId === undefined) {
      delete session.lastFocusedWindowId;
    }
    const replaced = await this.#input.core.invoke({
      type: "runtimeRestoreSessionReplace",
      session
    });
    if (
      replaced.schemaVersion !== 2 ||
      replaced.sessionGeneration !== session.sessionGeneration ||
      replaced.cleanExit !== session.cleanExit ||
      JSON.stringify(replaced.liveWindowIds ?? []) !==
        JSON.stringify(session.liveWindowIds ?? []) ||
      JSON.stringify(replaced.restoreInProgressWindowIds) !==
        JSON.stringify(session.restoreInProgressWindowIds) ||
      replaced.lastFocusedWindowId !== session.lastFocusedWindowId ||
      !sameJsonStructure(replaced.windows ?? [], session.windows ?? [])
    ) {
      throw persistenceError(
        "ELECTRON_RUNTIME_RESTORE_SESSION_RECEIPT_INVALID",
        "Core did not retain the exact Chromium runtime recovery cohort."
      );
    }
    return replaced;
  }

  #enqueueOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#lane.then(operation);
    this.#lane = result.then(() => undefined, () => undefined);
    return result;
  }
}
