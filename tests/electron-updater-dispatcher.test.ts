import { describe, expect, it, vi } from "vitest";

import type { RionApiDispatcher } from
  "../src/electron/main/registerIpcBridge";
import { createElectronUpdaterDispatcher } from
  "../src/electron/main/electronUpdaterDispatcher";
import type { RendererIdentity } from
  "../src/electron/main/rendererIdentity";

const identity = {
  kind: "main",
  id: "main-1",
  generation: 1
} as unknown as RendererIdentity;

describe("Electron updater dispatcher", () => {
  it("routes all updater APIs without moving trust into the fallback shell", async () => {
    const status = {
      currentVersion: "22.0.0",
      installMode: "automatic" as const,
      isPackaged: true,
      autoUpdateEnabled: true,
      state: "idle" as const
    };
    const attempt = {
      attemptId: "attempt-1",
      targetVersion: "23.0.0",
      phase: "accepted" as const,
      startedAt: "2026-08-30T00:00:00Z",
      updatedAt: "2026-08-30T00:00:00Z"
    };
    const updates = {
      getUpdateStatus: vi.fn(() => status),
      checkForUpdates: vi.fn(async () => status),
      setAutoUpdateEnabled: vi.fn(async () => status),
      installDownloadedUpdate: vi.fn(async () => attempt)
    };
    const fallback = {
      invoke: vi.fn(async () => "fallback")
    } as unknown as RionApiDispatcher;
    const dispatcher = createElectronUpdaterDispatcher(updates, fallback);

    await expect(dispatcher.invoke(identity, "getUpdateStatus", [])).resolves.toBe(status);
    await expect(dispatcher.invoke(identity, "checkForUpdates", [])).resolves.toBe(status);
    await expect(
      dispatcher.invoke(identity, "setAutoUpdateEnabled", [false])
    ).resolves.toBe(status);
    await expect(
      dispatcher.invoke(identity, "installDownloadedUpdate", [])
    ).resolves.toBe(attempt);
    await expect(dispatcher.invoke(identity, "getAppVersion", [])).resolves.toBe("fallback");

    expect(updates.setAutoUpdateEnabled).toHaveBeenCalledWith(false);
    expect(fallback.invoke).toHaveBeenCalledOnce();
  });
});
