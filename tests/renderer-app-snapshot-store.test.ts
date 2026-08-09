import { describe, expect, it, vi } from "vitest";

import type { AppSnapshot } from "../src/shared/types";
import {
  AppSnapshotStore,
  EMPTY_APP_SNAPSHOT
} from "../src/renderer/src/app/appSnapshotStore";

function snapshot(revision: number, roleName = `Role ${revision}`): AppSnapshot {
  return {
    ...EMPTY_APP_SNAPSHOT,
    revision,
    roles: [{
      id: `role-${revision}`,
      gameId: "game-runtime-qa",
      name: roleName,
      launchUrl: "http://127.0.0.1:43119/role",
      notes: "",
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z"
    }]
  };
}

describe("AppSnapshotStore", () => {
  it("replays event-before-snapshot without allowing the slower response to rewind it", () => {
    const store = new AppSnapshotStore();
    expect(store.commit(snapshot(4, "event"))).toBe(true);
    expect(store.commit(snapshot(3, "snapshot"))).toBe(false);
    expect(store.getSnapshot().roles[0]?.name).toBe("event");
  });

  it("accepts snapshot-before-event and applies the newer authoritative revision", () => {
    const store = new AppSnapshotStore();
    store.commit(snapshot(2, "snapshot"));
    store.commit(snapshot(5, "event"));
    expect(store.getSnapshot().revision).toBe(5);
    expect(store.getSnapshot().roles[0]?.name).toBe("event");
  });

  it("ignores duplicate and out-of-order responses and notifies subscribers once", () => {
    const store = new AppSnapshotStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.commit(snapshot(7));
    store.commit(snapshot(7));
    store.commit(snapshot(6));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.commit(snapshot(8));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports StrictMode subscribe-unsubscribe-resubscribe without losing state", () => {
    const store = new AppSnapshotStore();
    const first = vi.fn();
    store.subscribe(first)();
    store.commit(snapshot(9));
    const second = vi.fn();
    const unsubscribe = store.subscribe(second);
    expect(store.getSnapshot().revision).toBe(9);
    store.commit(snapshot(10));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("publishes cross-collection mutations as one deeply immutable revision", () => {
    const store = new AppSnapshotStore();
    const observed = vi.fn(() => {
      const current = store.getSnapshot();
      expect(current.roles).toHaveLength(1);
      expect(current.gameWindows).toHaveLength(1);
      expect(current.roleStatuses).toHaveLength(1);
    });
    store.subscribe(observed);
    const next = snapshot(11, "Atomic role");
    next.gameWindows = [{
      id: "window-qa",
      name: "Atomic window",
      targetDisplay: { id: 0 },
      placement: {
        normalBounds: { x: 0, y: 0, width: 900, height: 700 },
        savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
        presentation: "normal"
      },
      tabs: [],
      createdAt: "2026-08-09T00:00:00Z",
      updatedAt: "2026-08-09T00:00:00Z"
    }];
    next.roleStatuses = [{
      roleId: "role-11",
      runtimeMode: "embedded",
      state: "running",
      launchedAt: "2026-08-09T00:00:00Z"
    }];
    expect(store.commit(next)).toBe(true);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().roles)).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().roles[0])).toBe(true);
    expect(store.commit({ ...snapshot(10), gameWindows: [] })).toBe(false);
    expect(store.getSnapshot().gameWindows).toHaveLength(1);
  });
});
