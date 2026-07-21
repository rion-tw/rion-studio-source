import { describe, expect, it, vi } from "vitest";

import {
  RoleBrowserDataClearError,
  RoleBrowserDataManager
} from "../src/main/browser/RoleBrowserDataManager";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.test/play",
  notes: "",
  browserSessionSource: "embedded",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("RoleBrowserDataManager", () => {
  it("stops the role, clears browser stores, and resets the session backend", async () => {
    const harness = createHarness();

    await expect(harness.manager.clear(role.id)).resolves.toMatchObject({
      id: role.id,
      browserSessionSource: "embedded"
    });

    expect(harness.roleStore.getRole).toHaveBeenCalledWith(role.id);
    expect(harness.browserManager.stopRoleAndRunRecoverableMutation).toHaveBeenCalledWith(
      role.id,
      expect.any(Function)
    );
    expect(harness.getSession).toHaveBeenCalledWith(role);
    expect(harness.session.closeAllConnections).toHaveBeenCalledOnce();
    expect(harness.session.clearData).toHaveBeenCalledWith({
      dataTypes: [
        "cache",
        "cookies",
        "fileSystems",
        "indexedDB",
        "localStorage",
        "serviceWorkers",
        "webSQL"
      ]
    });
    expect(harness.session.clearStorageData).toHaveBeenCalledWith({ storages: ["cachestorage"] });
    expect(harness.roleStore.resetBrowserUserDataDir).toHaveBeenCalledWith(role.id);
    expect(harness.roleStore.updateBrowserSessionSource).toHaveBeenCalledWith(role.id, "embedded");
  });

  it("attempts every target when one store fails", async () => {
    const harness = createHarness();
    harness.session.clearData.mockRejectedValueOnce(new Error("partition locked"));
    harness.roleStore.resetBrowserUserDataDir.mockRejectedValueOnce(new Error("profile locked"));

    await expect(harness.manager.clear(role.id)).rejects.toBeInstanceOf(RoleBrowserDataClearError);

    expect(harness.session.clearStorageData).toHaveBeenCalledOnce();
    expect(harness.roleStore.resetBrowserUserDataDir).toHaveBeenCalledOnce();
    expect(harness.roleStore.updateBrowserSessionSource).toHaveBeenCalledWith(role.id, "embedded");
  });

  it("does not stop or clear an unknown role", async () => {
    const harness = createHarness();
    harness.roleStore.getRole.mockRejectedValueOnce(new Error("Role not found."));

    await expect(harness.manager.clear("missing")).rejects.toThrow("Role not found.");
    expect(harness.browserManager.stopRoleAndRunRecoverableMutation).not.toHaveBeenCalled();
    expect(harness.getSession).not.toHaveBeenCalled();
  });
});

function createHarness() {
  const session = {
    clearData: vi.fn().mockResolvedValue(undefined),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    closeAllConnections: vi.fn().mockResolvedValue(undefined)
  };
  const getSession = vi.fn(() => session);
  const roleStore = {
    getRole: vi.fn().mockResolvedValue(role),
    resetBrowserUserDataDir: vi.fn().mockResolvedValue("/roles/role-1/browser"),
    updateBrowserSessionSource: vi.fn(async (_id: string, browserSessionSource: "embedded" | "chrome-profile") => ({
      ...role,
      browserSessionSource
    }))
  };
  const browserManager = {
    stopRoleAndRunRecoverableMutation: vi.fn(
      async (_id: string, operation: () => Promise<unknown>) => operation()
    )
  };
  return {
    browserManager,
    getSession,
    manager: new RoleBrowserDataManager({
      browserManager: browserManager as never,
      getSession: getSession as never,
      roleStore
    }),
    roleStore,
    session
  };
}
