import type { AppSnapshot } from "../../../shared/types";

export const EMPTY_APP_SNAPSHOT: AppSnapshot = Object.freeze({
  revision: 0,
  stateRevision: 0,
  runtimeRevision: 0,
  embeddedRuntimeState: Object.freeze({
    revision: 0,
    capturedAt: "",
    windows: [],
    tabs: []
  }),
  games: [],
  gameWindows: [],
  roles: [],
  roleStatuses: [],
  launchWorkspaces: [],
  displayTopology: Object.freeze({
    revision: 0,
    capturedAt: "",
    cause: "initial",
    displays: []
  }),
  macros: [],
  macroStatuses: []
});

export class AppSnapshotStore {
  private snapshot: AppSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(initialSnapshot: AppSnapshot = EMPTY_APP_SNAPSHOT) {
    this.snapshot = deepFreeze(initialSnapshot);
  }

  readonly getSnapshot = (): AppSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly commit = (snapshot: AppSnapshot): boolean => {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision <= this.snapshot.revision) {
      return false;
    }
    this.snapshot = deepFreeze(snapshot);
    this.listeners.forEach((listener) => listener());
    return true;
  };

  readonly commitProjection = (
    update: (current: AppSnapshot) => AppSnapshot,
    minimumRevision = 0
  ): boolean => {
    const revision = Math.max(this.snapshot.revision + 1, minimumRevision);
    return this.commit({ ...update(this.snapshot), revision });
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export const appSnapshotStore = new AppSnapshotStore();
