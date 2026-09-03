import { describe, expect, it, vi } from "vitest";

import { createCoreOwnedChromiumRuntimeActions } from
  "../src/electron/main/chromiumRuntimeActionsFactory";
import type { ElectronCoreCommandPort } from
  "../src/electron/main/coreApiDispatcher";

const identity = {
  kind: "main-renderer" as const,
  windowId: 1,
  webContentsId: 2,
  generation: 1
};

function input() {
  const publishQuickAccessRequest = vi.fn();
  const presentMainWindow = vi.fn(async () => undefined);
  return {
    core: {
      invoke: vi.fn(async () => {
        throw new Error("Core is not used by this composition test");
      })
    } as unknown as ElectronCoreCommandPort,
    platform: "win32" as const,
    readDisplayTopology: () => ({
      revision: 1,
      capturedAt: "2026-08-30T12:00:00.000Z",
      cause: "electron-initial",
      displays: []
    }),
    readNativeSnapshot: () => ({
      windows: [],
      tabs: [],
      roles: [],
      webSurfaces: []
    }),
    openEmptySavedGameWindow: vi.fn(async () => undefined),
    restoreSavedGameWindow: vi.fn(async () => undefined),
    restoreSession: {
      inspect: vi.fn(async () => ({
        schemaVersion: 2 as const,
        sessionGeneration: 0,
        updatedAt: "2026-08-30T12:00:00.000Z",
        cleanExit: true,
        restoreInProgressWindowIds: [],
        liveWindowIds: [],
        windows: []
      })),
      mutate: vi.fn(async () => {
        throw new Error("Restore session is not used by this composition test");
      })
    },
    windowPreferences: {
      applyWindowPreferences: vi.fn(async () => undefined)
    },
    publishQuickAccessRequest,
    presentMainWindow
  };
}

describe("Chromium runtime actions factory", () => {
  it("wires Quick Access through the authenticated action controller", async () => {
    const fixture = input();
    const services = createCoreOwnedChromiumRuntimeActions(fixture)!;

    const request = services.beginRuntimeTabQuickAccess("tab-one");
    const consumed = await services.actions.consumePendingQuickAccessRequest(
      identity
    );

    expect(consumed).toEqual(request);
    expect(fixture.publishQuickAccessRequest).toHaveBeenCalledWith(request);

    const mainRequest = services.beginMainWindowQuickAccess();
    await expect(services.actions.consumePendingQuickAccessRequest(identity))
      .resolves.toEqual(mainRequest);
  });

  it("returns no macOS lane when the exact AppKit adapter is unavailable", () => {
    const fixture = input();

    expect(createCoreOwnedChromiumRuntimeActions({
      ...fixture,
      platform: "darwin"
    })).toBeNull();
  });
});
