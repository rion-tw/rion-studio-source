import type {
  CoreAppSnapshotRecord,
  CoreCommand,
  CoreCommandResult,
  RuntimeRestoreSessionRecord,
  RuntimeRestoreWindowRecord,
  StateGameWindowRecord
} from "../../shared/generated";
import type {
  DiscardSavedGameWindowsInput,
  RestoreSavedGameWindowsInput
} from "../../shared/types";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumSavedWindowActionPort } from
  "./chromiumRuntimeActionBackend";
import type { ChromiumRuntimeRestoreSessionMutationPort } from
  "./chromiumRuntimeRestoreSessionCoordinator";

export interface ChromiumSavedWindowRestoreCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

export interface ChromiumSavedWindowRestoreLaunchPort {
  openEmptySavedGameWindow: (window: StateGameWindowRecord) => Promise<void>;
  restoreSavedGameWindow: (window: StateGameWindowRecord) => Promise<void>;
}

export interface ChromiumSavedWindowRestoreControllerInput {
  readonly core: ChromiumSavedWindowRestoreCorePort;
  readonly launches: ChromiumSavedWindowRestoreLaunchPort;
  readonly restoreSession: ChromiumRuntimeRestoreSessionMutationPort;
}

function restoreError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function restoreWindow(window: StateGameWindowRecord): RuntimeRestoreWindowRecord {
  return {
    id: window.id,
    targetDisplay: structuredClone(window.targetDisplay),
    wasVisible: true,
    ...(window.activeTabId === undefined
      ? {}
      : {
          activeSourceId: window.tabs.find(
            (tab) => tab.id === window.activeTabId
          )?.sourceId
        }),
    tabs: window.tabs.map((tab) => ({
      tabType: tab.tabType,
      sourceId: tab.sourceId,
      name: tab.name,
      roleIds: [...new Set([
        ...tab.roleSlots.map((slot) => slot.roleId),
        ...(tab.workspaceSlots ?? []).flatMap(
          (slot) => slot.roleId === undefined ? [] : [slot.roleId]
        )
      ])],
      hidden: tab.hidden,
      audioMuted: tab.audioMuted
    }))
  };
}

/** Persists restore progress before each event-bound native hydration step. */
export class ChromiumSavedWindowRestoreController
implements ChromiumSavedWindowActionPort {
  readonly #input: ChromiumSavedWindowRestoreControllerInput;
  #lane: Promise<void> = Promise.resolve();

  constructor(input: ChromiumSavedWindowRestoreControllerInput) {
    this.#input = input;
  }

  openEmpty(windowId: string): Promise<void> {
    return this.#enqueue(async () => {
      const snapshot = await this.#input.core.invoke({ type: "appSnapshot" });
      const window = snapshot.state.gameWindows.find(
        (candidate) => candidate.id === windowId
      );
      if (
        !window || window.tabs.length !== 0 ||
        snapshot.logicalWindows.some((candidate) => candidate.windowId === windowId)
      ) {
        throw restoreError(
          "ELECTRON_CHROMIUM_EMPTY_SAVED_WINDOW_UNAVAILABLE",
          "The requested empty saved Game Window is unavailable or already live."
        );
      }
      await this.#input.launches.openEmptySavedGameWindow(window);
    });
  }

  restore(input: RestoreSavedGameWindowsInput): Promise<void> {
    return this.#enqueue(async () => {
      const snapshot = await this.#input.core.invoke({ type: "appSnapshot" });
      const session = await this.#input.restoreSession.inspect();
      const windows = this.#selectWindows(snapshot, session, input);
      for (const window of windows) {
        await this.#markRestoring(session, window);
        // Failure deliberately leaves the persisted in-progress identity for resume.
        await this.#input.launches.restoreSavedGameWindow(window);
        await this.#markRestored(window.id);
      }
    });
  }

  discard(input: DiscardSavedGameWindowsInput): Promise<void> {
    return this.#enqueue(async () => {
      const session = await this.#input.restoreSession.inspect();
      const discarded = input.scope === "all"
        ? new Set((session.windows ?? []).map((window) => window.id))
        : new Set([input.windowId]);
      await this.#input.restoreSession.mutate((current) => ({
        lastFocusedWindowId: current.lastFocusedWindowId !== undefined &&
          discarded.has(current.lastFocusedWindowId)
          ? undefined
          : current.lastFocusedWindowId,
        restoreInProgressWindowIds: current.restoreInProgressWindowIds.filter(
          (windowId) => !discarded.has(windowId)
        ),
        liveWindowIds: (current.liveWindowIds ?? []).filter(
          (windowId) => !discarded.has(windowId)
        ),
        windows: (current.windows ?? []).filter(
          (window) => !discarded.has(window.id)
        )
      }));
    });
  }

  resumeInterrupted(): Promise<void> {
    return this.#enqueue(async () => {
      const session = await this.#input.restoreSession.inspect();
      const interrupted = [...new Set(session.restoreInProgressWindowIds)];
      if (interrupted.length === 0) return;
      const snapshot = await this.#input.core.invoke({ type: "appSnapshot" });
      for (const windowId of interrupted) {
        const window = snapshot.state.gameWindows.find(
          (candidate) => candidate.id === windowId
        );
        if (!window) {
          await this.#markRestored(windowId);
          continue;
        }
        if (snapshot.logicalWindows.some((live) => live.windowId === windowId)) {
          await this.#markRestored(windowId);
          continue;
        }
        if (window.tabs.length === 0) {
          await this.#markRestored(windowId);
          continue;
        }
        await this.#input.launches.restoreSavedGameWindow(window);
        await this.#markRestored(windowId);
      }
    });
  }

  #selectWindows(
    snapshot: CoreAppSnapshotRecord,
    session: RuntimeRestoreSessionRecord,
    input: RestoreSavedGameWindowsInput
  ): StateGameWindowRecord[] {
    const live = new Set(snapshot.logicalWindows.map((window) => window.windowId));
    const dormant = snapshot.state.gameWindows.filter(
      (window) => !live.has(window.id)
    );
    const saved = dormant.filter((window) => window.tabs.length > 0);
    if (input.scope === "window") {
      const exact = saved.find((window) => window.id === input.windowId);
      if (!exact) {
        if (dormant.some(
          (window) => window.id === input.windowId && window.tabs.length === 0
        )) {
          throw restoreError(
            "ELECTRON_CHROMIUM_SAVED_WINDOW_EMPTY",
            "A saved Game Window must contain at least one tab before it can be restored."
          );
        }
        throw restoreError(
          "ELECTRON_CHROMIUM_SAVED_WINDOW_NOT_FOUND",
          "The requested dormant Game Window is unavailable or already live."
        );
      }
      return [exact];
    }
    if (input.scope === "all") return saved;
    const visible = new Set(session.schemaVersion >= 2
      ? (session.liveWindowIds ?? [])
      : (session.windows ?? [])
          .filter((window) => window.wasVisible)
          .map((window) => window.id));
    const preferred = session.lastFocusedWindowId;
    const selected = preferred && visible.has(preferred)
      ? saved.find((window) => window.id === preferred)
      : saved.find((window) => visible.has(window.id));
    return selected ? [selected] : [];
  }

  async #markRestoring(
    prior: RuntimeRestoreSessionRecord,
    window: StateGameWindowRecord
  ): Promise<void> {
    await this.#input.restoreSession.mutate((current) => {
      const windows = (current.windows ?? []).filter(
        (candidate) => candidate.id !== window.id
      );
      windows.push(restoreWindow(window));
      return {
        cleanExit: false,
        lastFocusedWindowId: current.lastFocusedWindowId ?? prior.lastFocusedWindowId,
        windows,
        restoreInProgressWindowIds: [
          ...new Set([...current.restoreInProgressWindowIds, window.id])
        ]
      };
    });
  }

  async #markRestored(windowId: string): Promise<void> {
    await this.#input.restoreSession.mutate((current) => ({
      restoreInProgressWindowIds: current.restoreInProgressWindowIds.filter(
        (candidate) => candidate !== windowId
      ),
      liveWindowIds: [...new Set([...(current.liveWindowIds ?? []), windowId])],
      windows: (current.windows ?? []).filter((window) => window.id !== windowId)
    }));
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.#lane.then(task);
    this.#lane = result.then(() => undefined, () => undefined);
    return result;
  }
}
