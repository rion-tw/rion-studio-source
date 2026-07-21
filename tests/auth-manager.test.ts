import { describe, expect, it, vi } from "vitest";

import { AuthManager } from "../src/main/auth/AuthManager";
import { BrowserLoginCancelledError } from "../src/main/browser/BrowserManager";
import { ImportedChromeProfileLoginRetryableError } from "../src/main/browser/ImportedChromeProfileLoginVerifier";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  gameId: "game-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  notes: "",
  authState: "login_required",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("AuthManager embedded login", () => {
  it("opens the role in the app and waits for embedded authentication", async () => {
    const authentication = deferred<{ authState: "authenticated"; finalUrl: string }>();
    const roleStore = createRoleStore();
    const browserManager = {
      startLogin: vi.fn().mockResolvedValue(undefined),
      waitForAuthentication: vi.fn(() => authentication.promise)
    };
    const manager = new AuthManager(roleStore, browserManager);

    expect(manager.startLogin(role)).toMatchObject({ roleId: role.id, state: "opening_app" });
    await vi.waitFor(() => expect(manager.listStatuses()[0]?.state).toBe("waiting_for_login"));
    expect(browserManager.startLogin).toHaveBeenCalledWith(role);

    authentication.resolve({ authState: "authenticated", finalUrl: role.launchUrl });
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "authenticated");
  });

  it("surfaces an embedded browser rejection as auth_failed", async () => {
    const roleStore = createRoleStore();
    const browserManager = {
      startLogin: vi.fn().mockResolvedValue(undefined),
      waitForAuthentication: vi.fn().mockResolvedValue({
        authState: "auth_failed" as const,
        finalUrl: "https://accounts.google.com/",
        message: "Google rejected this browser during session check."
      })
    };
    const manager = new AuthManager(roleStore, browserManager);

    manager.startLogin(role);

    await vi.waitFor(() => expect(manager.listStatuses()[0]?.state).toBe("failed"));
    expect(manager.listStatuses()[0]?.message).toContain("Google rejected");
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "auth_failed");
  });

  it("marks unexpected embedded login failures without storing credentials", async () => {
    const roleStore = createRoleStore();
    const browserManager = {
      startLogin: vi.fn().mockRejectedValue(new Error("Embedded page failed to load.")),
      waitForAuthentication: vi.fn()
    };
    const manager = new AuthManager(roleStore, browserManager);

    manager.startLogin(role);

    await vi.waitFor(() => expect(manager.listStatuses()[0]?.state).toBe("failed"));
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "auth_failed");
    expect(manager.listStatuses()[0]?.message).toBe("Embedded page failed to load.");
  });

  it("removes a cancelled flow without changing auth metadata", async () => {
    const roleStore = createRoleStore();
    const browserManager = {
      startLogin: vi.fn().mockResolvedValue(undefined),
      waitForAuthentication: vi.fn().mockRejectedValue(new BrowserLoginCancelledError())
    };
    const manager = new AuthManager(roleStore, browserManager);

    manager.startLogin(role);

    await vi.waitFor(() => expect(browserManager.waitForAuthentication).toHaveBeenCalled());
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
    expect(roleStore.updateAuthState).not.toHaveBeenCalled();
  });

  it("returns the active flow when login is requested twice", async () => {
    const authentication = deferred<{ authState: "authenticated" }>();
    const browserManager = {
      startLogin: vi.fn().mockResolvedValue(undefined),
      waitForAuthentication: vi.fn(() => authentication.promise)
    };
    const manager = new AuthManager(createRoleStore(), browserManager);

    const first = manager.startLogin(role);
    const second = manager.startLogin(role);

    expect(second).toEqual(first);
    expect(browserManager.startLogin).toHaveBeenCalledTimes(1);
    authentication.resolve({ authState: "authenticated" });
  });

  it("verifies a pending imported Chrome profile before the embedded final check", async () => {
    const roleStore = createRoleStore();
    const embeddedAuthentication = deferred<{ authState: "authenticated" }>();
    const browserManager = {
      startLogin: vi.fn().mockResolvedValue(undefined),
      waitForAuthentication: vi.fn(() => embeddedAuthentication.promise)
    };
    const importedChromeProfileLoginVerifier = {
      complete: vi.fn().mockResolvedValue(undefined),
      hasPendingVerification: vi.fn().mockResolvedValue(true),
      verify: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(roleStore, browserManager, { importedChromeProfileLoginVerifier });

    manager.startLogin(role);

    await vi.waitFor(() => expect(browserManager.waitForAuthentication).toHaveBeenCalledOnce());
    expect(importedChromeProfileLoginVerifier.verify).toHaveBeenCalledWith(role);
    expect(browserManager.startLogin).toHaveBeenCalledWith(role, { forceLaunchUrl: true });
    expect(importedChromeProfileLoginVerifier.complete).not.toHaveBeenCalled();

    embeddedAuthentication.resolve({ authState: "authenticated" });
    await vi.waitFor(() => expect(manager.listStatuses()).toEqual([]));
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "authenticated");
    expect(importedChromeProfileLoginVerifier.complete).toHaveBeenCalledWith(role.id);
  });

  it("keeps a failed imported profile pending instead of marking it auth_failed", async () => {
    const roleStore = createRoleStore();
    const browserManager = {
      startLogin: vi.fn(),
      waitForAuthentication: vi.fn()
    };
    const importedChromeProfileLoginVerifier = {
      complete: vi.fn(),
      hasPendingVerification: vi.fn().mockResolvedValue(true),
      verify: vi.fn().mockRejectedValue(new ImportedChromeProfileLoginRetryableError("CDP unavailable"))
    };
    const manager = new AuthManager(roleStore, browserManager, { importedChromeProfileLoginVerifier });

    manager.startLogin(role);

    await vi.waitFor(() => expect(manager.listStatuses()[0]).toMatchObject({
      state: "failed",
      message: "CDP unavailable"
    }));
    expect(browserManager.startLogin).not.toHaveBeenCalled();
    expect(roleStore.updateAuthState).not.toHaveBeenCalled();
    expect(importedChromeProfileLoginVerifier.complete).not.toHaveBeenCalled();
  });

  it("does not complete a pending profile when the embedded game still requires login", async () => {
    const roleStore = createRoleStore();
    const browserManager = {
      startLogin: vi.fn().mockResolvedValue(undefined),
      waitForAuthentication: vi.fn().mockResolvedValue({
        authState: "login_required" as const,
        message: "Login is still required."
      })
    };
    const importedChromeProfileLoginVerifier = {
      complete: vi.fn(),
      hasPendingVerification: vi.fn().mockResolvedValue(true),
      verify: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(roleStore, browserManager, { importedChromeProfileLoginVerifier });

    manager.startLogin(role);

    await vi.waitFor(() => expect(manager.listStatuses()[0]).toMatchObject({ state: "failed" }));
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
    expect(importedChromeProfileLoginVerifier.complete).not.toHaveBeenCalled();
  });
});

function createRoleStore() {
  return {
    updateAuthState: vi.fn().mockImplementation(async (_roleId: string, authState: Role["authState"]) => ({
      ...role,
      authState
    }))
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
