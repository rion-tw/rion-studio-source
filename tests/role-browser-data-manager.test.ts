import { describe, expect, it, vi } from "vitest";

import {
  RoleBrowserDataClearError,
  RoleBrowserDataManager
} from "../src/main/browser/RoleBrowserDataManager";
import { createRoleSessionPartition } from "../src/main/browser/BrowserManager";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.test/play",
  notes: "",
  authState: "authenticated",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("RoleBrowserDataManager", () => {
  it("stops the role, clears both browser stores, and resets authentication", async () => {
    const harness = createHarness();

    await expect(harness.manager.clear(role.id)).resolves.toMatchObject({
      id: role.id,
      authState: "login_required"
    });

    expect(harness.roleStore.getRole).toHaveBeenCalledWith(role.id);
    expect(harness.browserManager.stopRoleAndRunRecoverableMutation).toHaveBeenCalledWith(
      role.id,
      expect.any(Function)
    );
    expect(harness.browserManager.clearEmbeddedSessionStorageSeed).toHaveBeenCalledWith(role.id);
    expect(harness.clearEmbeddedStorageSeed).toHaveBeenCalledWith(role.id);
    expect(harness.getSession).toHaveBeenCalledWith(createRoleSessionPartition(role.id));
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
    expect(harness.roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
  });

  it("attempts every target and resets authentication when one store fails", async () => {
    const harness = createHarness();
    harness.session.clearData.mockRejectedValueOnce(new Error("partition locked"));
    harness.roleStore.resetBrowserUserDataDir.mockRejectedValueOnce(new Error("profile locked"));

    await expect(harness.manager.clear(role.id)).rejects.toBeInstanceOf(RoleBrowserDataClearError);

    expect(harness.session.clearStorageData).toHaveBeenCalledOnce();
    expect(harness.roleStore.resetBrowserUserDataDir).toHaveBeenCalledOnce();
    expect(harness.roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
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
    updateAuthState: vi.fn(async (_id: string, authState: Role["authState"]) => ({
      ...role,
      authState
    }))
  };
  const browserManager = {
    clearEmbeddedSessionStorageSeed: vi.fn(),
    stopRoleAndRunRecoverableMutation: vi.fn(
      async (_id: string, operation: () => Promise<unknown>) => operation()
    )
  };
  const clearEmbeddedStorageSeed = vi.fn().mockResolvedValue(undefined);

  return {
    browserManager,
    clearEmbeddedStorageSeed,
    getSession,
    manager: new RoleBrowserDataManager({
      browserManager: browserManager as never,
      clearEmbeddedStorageSeed,
      getSession: getSession as never,
      roleStore
    }),
    roleStore,
    session
  };
}
