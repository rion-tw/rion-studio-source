/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RionStudioApi } from "../../../src/shared/api";
import type { AppSnapshot } from "../../../src/shared/types";

const browserPort = vi.hoisted(() => ({
  execute: vi.fn(),
  executeAsync: vi.fn()
}));

vi.mock("@wdio/globals", () => ({ browser: browserPort }));

import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForGameWindowProjection,
  waitForMacroProjection,
  waitForRoleProjection,
  waitForRuntimeProjection
} from "./renderer-events";

const CAPTURED_AT = "2026-08-31T00:00:00.000Z";
const ROLE_ID = "role-1";
const TAB_ID = "tab-1";
const WINDOW_ID = "window-1";

function snapshot(revision: number): AppSnapshot {
  return {
    revision,
    stateRevision: revision,
    runtimeRevision: revision,
    embeddedRuntimeState: {
      revision,
      capturedAt: CAPTURED_AT,
      windows: [{
        id: WINDOW_ID,
        windowId: WINDOW_ID,
        displayId: 1,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        visible: true,
        focused: true,
        activeTabId: TAB_ID,
        tabCount: 1,
        presentation: "normal"
      }],
      tabs: [{
        id: TAB_ID,
        type: "role",
        sourceId: ROLE_ID,
        name: "Role One",
        windowId: WINDOW_ID,
        roleIds: [ROLE_ID],
        slots: [],
        hidden: false,
        active: true,
        audible: false,
        audioMuted: false
      }]
    },
    games: [],
    gameWindows: [{
      id: WINDOW_ID,
      name: "Window One",
      targetDisplay: { id: 1 },
      placement: {
        normalBounds: { x: 0, y: 0, width: 800, height: 600 },
        savedWorkArea: { x: 0, y: 0, width: 800, height: 600 },
        presentation: "normal"
      },
      tabs: [],
      createdAt: CAPTURED_AT,
      updatedAt: CAPTURED_AT
    }],
    roles: [],
    roleStatuses: [{ roleId: ROLE_ID, state: "running", runtimeMode: "embedded" }],
    launchWorkspaces: [],
    displayTopology: {
      revision,
      capturedAt: CAPTURED_AT,
      cause: "test",
      displays: []
    },
    macros: [],
    macroStatuses: [{
      roleId: ROLE_ID,
      macroId: "macro-1",
      state: "running",
      startedAt: CAPTURED_AT,
      updatedAt: CAPTURED_AT
    }],
    quickAccessPreferences: { pinnedItems: [], recentItems: [] }
  };
}

beforeEach(() => {
  browserPort.execute.mockReset().mockImplementation(
    async (operation: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      operation(...args)
  );
  browserPort.executeAsync.mockReset().mockImplementation(
    (operation: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      new Promise((resolve) => operation(...args, resolve))
  );
  Reflect.deleteProperty(window, "__rionStudioDesktopE2eEventJournal");
});

describe("desktop E2E renderer event journal", () => {
  it("fans a post-cursor canonical snapshot into every derived projection lane", async () => {
    let emitSnapshot: ((value: AppSnapshot) => void) | undefined;
    const initial = snapshot(1);
    const subscribe = () => () => undefined;
    window.rionStudio = {
      onAppSnapshotChanged: (callback: (value: AppSnapshot) => void) => {
        emitSnapshot = callback;
        return () => undefined;
      },
      onGameWindowsChanged: subscribe,
      onMacroStatusChanged: subscribe,
      onRoleStatusChanged: subscribe,
      onEmbeddedRuntimeStateChanged: subscribe,
      onSurfaceRecoveryAttemptChanged: subscribe,
      getAppSnapshot: async () => initial,
      listGameWindows: async () => initial.gameWindows,
      listMacroStatuses: async () => initial.macroStatuses,
      listRoleStatuses: async () => initial.roleStatuses,
      getEmbeddedRuntimeState: async () => initial.embeddedRuntimeState
    } as unknown as RionStudioApi;

    await installRendererEventJournal();
    await Promise.resolve();
    const afterSequence = await rendererEventCursor();

    const waits = [
      waitForGameWindowProjection({ afterSequence, windowId: WINDOW_ID }),
      waitForMacroProjection({
        afterSequence,
        macroId: "macro-1",
        roleIds: [ROLE_ID],
        state: "running"
      }),
      waitForRoleProjection({ afterSequence, roleId: ROLE_ID, state: "running" }),
      waitForRuntimeProjection({ afterSequence, sourceId: ROLE_ID })
    ] as const;
    let settled = false;
    void Promise.all(waits).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitSnapshot?.(snapshot(2));
    const [gameWindows, macroStatuses, roleStatuses, runtime] = await Promise.all(waits);

    expect(gameWindows.some(({ id }) => id === WINDOW_ID)).toBe(true);
    expect(macroStatuses.some(({ macroId }) => macroId === "macro-1")).toBe(true);
    expect(roleStatuses).toContainEqual(expect.objectContaining({
      roleId: ROLE_ID,
      state: "running"
    }));
    expect(runtime.tabs).toContainEqual(expect.objectContaining({
      sourceId: ROLE_ID,
      windowId: WINDOW_ID
    }));
  });
});
