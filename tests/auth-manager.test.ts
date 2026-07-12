import { describe, expect, it, vi } from "vitest";

import { AuthManager } from "../src/main/auth/AuthManager";
import { BrowserUserDataLockTimeoutError } from "../src/main/browser/BrowserUserDataLockWatcher";
import type { LoginWindowMonitorResult, SystemChromeLoginSession } from "../src/main/system-browser/SystemChromeLauncher";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  launchPreset: "performance",
  authState: "login_required",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("AuthManager", () => {
  it("closes the temporary Chrome window and launches automatically after login is detected", async () => {
    const updatedRole: Role = { ...role, authState: "authenticated" };
    const loginSession = createLoginSession({
      monitor: Promise.resolve({
        state: "login_completed",
        port: 9222,
        targetId: "target-1",
        url: role.launchUrl
      })
    });
    const roleStore = {
      ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const systemChromeLauncher = {
      openLoginWindow: vi.fn().mockResolvedValue(loginSession)
    };
    const authSessionChecker = {
      check: vi.fn().mockResolvedValue({ authState: "authenticated" })
    };
    const userDataLockWatcher = {
      waitForRelease: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      systemChromeLauncher,
      authSessionChecker,
      userDataLockWatcher
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(browserManager.launch).toHaveBeenCalledWith(updatedRole);
    });

    expect(browserManager.stop).toHaveBeenCalledWith(role.id);
    expect(systemChromeLauncher.openLoginWindow).toHaveBeenCalledWith(role);
    expect(loginSession.close).toHaveBeenCalledTimes(1);
    expect(userDataLockWatcher.waitForRelease).toHaveBeenCalledWith(loginSession.userDataDir);
    expect(loginSession.close.mock.invocationCallOrder[0]).toBeLessThan(
      userDataLockWatcher.waitForRelease.mock.invocationCallOrder[0]
    );
    expect(userDataLockWatcher.waitForRelease.mock.invocationCallOrder[0]).toBeLessThan(
      authSessionChecker.check.mock.invocationCallOrder[0]
    );
    expect(authSessionChecker.check).toHaveBeenCalledWith(role);
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "authenticated");
    expect(manager.listStatuses()).toEqual([]);
  });

  it("explains every required session step while waiting for login", async () => {
    const monitor = createDeferred<LoginWindowMonitorResult>();
    const updatedRole: Role = { ...role, authState: "authenticated" };
    const loginSession = createLoginSession({ monitor: monitor.promise });
    const roleStore = {
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      { openLoginWindow: vi.fn().mockResolvedValue(loginSession) },
      { check: vi.fn().mockResolvedValue({ authState: "authenticated" }) },
      { waitForRelease: vi.fn().mockResolvedValue(undefined) }
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(manager.listStatuses()[0]).toMatchObject({
        roleId: role.id,
        state: "waiting_for_login",
        message: "Complete account login, select the target character, enter its game screen, then close Chrome."
      });
    });

    monitor.resolve({
      state: "login_completed",
      port: 9222,
      targetId: "target-1",
      url: role.launchUrl
    });

    await vi.waitFor(() => {
      expect(browserManager.launch).toHaveBeenCalledWith(updatedRole);
    });
  });

  it("checks the session and launches automatically after the user closes Chrome first", async () => {
    const closed = createDeferred<void>();
    const updatedRole: Role = { ...role, authState: "authenticated" };
    const loginSession = createLoginSession({
      closed: closed.promise,
      monitor: Promise.resolve({
        state: "manual",
        message: "Complete account login, select the target character, enter its game screen, then close Chrome."
      })
    });
    const roleStore = {
      ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const systemChromeLauncher = {
      openLoginWindow: vi.fn().mockResolvedValue(loginSession)
    };
    const authSessionChecker = {
      check: vi.fn().mockResolvedValue({ authState: "authenticated" })
    };
    const userDataLockWatcher = {
      waitForRelease: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      systemChromeLauncher,
      authSessionChecker,
      userDataLockWatcher
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(manager.listStatuses()[0]).toMatchObject({
        roleId: role.id,
        state: "waiting_for_chrome_close",
        message: "Complete account login, select the target character, enter its game screen, then close Chrome."
      });
    });
    expect(authSessionChecker.check).not.toHaveBeenCalled();
    closed.resolve();

    await vi.waitFor(() => {
      expect(browserManager.launch).toHaveBeenCalledWith(updatedRole);
    });

    expect(loginSession.close).not.toHaveBeenCalled();
    expect(authSessionChecker.check).toHaveBeenCalledWith(role);
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "authenticated");
    expect(manager.listStatuses()).toEqual([]);
  });

  it("falls back to waiting for Chrome to close when login monitoring is unavailable", async () => {
    const updatedRole: Role = { ...role, authState: "authenticated" };
    const loginSession = createLoginSession({
      monitor: Promise.resolve({ state: "unavailable", message: "Unable to find Chrome DevTools port." })
    });
    const roleStore = {
      ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const systemChromeLauncher = {
      openLoginWindow: vi.fn().mockResolvedValue(loginSession)
    };
    const authSessionChecker = {
      check: vi.fn().mockResolvedValue({ authState: "authenticated" })
    };
    const userDataLockWatcher = {
      waitForRelease: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      systemChromeLauncher,
      authSessionChecker,
      userDataLockWatcher
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(browserManager.launch).toHaveBeenCalledWith(updatedRole);
    });

    expect(loginSession.close).not.toHaveBeenCalled();
    expect(authSessionChecker.check).toHaveBeenCalledWith(role);
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "authenticated");
  });

  it("keeps the monitor timeout reason while waiting for manual Chrome close", async () => {
    const closed = createDeferred<void>();
    const updatedRole: Role = { ...role, authState: "authenticated" };
    const loginSession = createLoginSession({
      closed: closed.promise,
      monitor: Promise.resolve({
        state: "timed_out",
        message: "Timed out while waiting for login storage to be ready: storage_not_ready"
      })
    });
    const roleStore = {
      ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const systemChromeLauncher = {
      openLoginWindow: vi.fn().mockResolvedValue(loginSession)
    };
    const authSessionChecker = {
      check: vi.fn().mockResolvedValue({ authState: "authenticated" })
    };
    const userDataLockWatcher = {
      waitForRelease: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      systemChromeLauncher,
      authSessionChecker,
      userDataLockWatcher
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(manager.listStatuses()[0]).toMatchObject({
        roleId: role.id,
        state: "waiting_for_chrome_close",
        message:
          "Complete account login, select the target character, enter its game screen, then close Chrome. Timed out while waiting for login storage to be ready: storage_not_ready"
      });
    });

    expect(loginSession.close).not.toHaveBeenCalled();
    closed.resolve();

    await vi.waitFor(() => {
      expect(browserManager.launch).toHaveBeenCalledWith(updatedRole);
    });
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "authenticated");
  });

  it("does not launch when the session check fails", async () => {
    const updatedRole: Role = { ...role, authState: "login_required" };
    const roleStore = {
      ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const systemChromeLauncher = {
      openLoginWindow: vi.fn().mockResolvedValue(createLoginSession())
    };
    const authSessionChecker = {
      check: vi.fn().mockResolvedValue({ authState: "login_required", message: "Login is still required." })
    };
    const userDataLockWatcher = {
      waitForRelease: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      systemChromeLauncher,
      authSessionChecker,
      userDataLockWatcher
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(manager.listStatuses()[0]).toMatchObject({
        roleId: role.id,
        state: "failed",
        message: "Login is still required."
      });
    });

    expect(browserManager.launch).not.toHaveBeenCalled();
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
  });

  it("does not launch after manual Chrome close when no persisted session is found", async () => {
    const closed = createDeferred<void>();
    const updatedRole: Role = { ...role, authState: "login_required" };
    const loginSession = createLoginSession({
      closed: closed.promise,
      monitor: Promise.resolve({
        state: "manual",
        message: "Complete account login, select the target character, enter its game screen, then close Chrome."
      })
    });
    const roleStore = {
      ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const systemChromeLauncher = {
      openLoginWindow: vi.fn().mockResolvedValue(loginSession)
    };
    const authSessionChecker = {
      check: vi.fn().mockResolvedValue({
        authState: "login_required",
        message: "Login is still required. No persisted login session was found."
      })
    };
    const userDataLockWatcher = {
      waitForRelease: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      systemChromeLauncher,
      authSessionChecker,
      userDataLockWatcher
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(manager.listStatuses()[0]).toMatchObject({
        roleId: role.id,
        state: "waiting_for_chrome_close"
      });
    });
    closed.resolve();

    await vi.waitFor(() => {
      expect(manager.listStatuses()[0]).toMatchObject({
        roleId: role.id,
        state: "failed",
        message: "Login is still required. No persisted login session was found."
      });
    });

    expect(browserManager.launch).not.toHaveBeenCalled();
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
  });

  it("does not launch when Chrome keeps the browser user data locked", async () => {
    const updatedRole: Role = { ...role, authState: "auth_failed" };
    const roleStore = {
      ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
      updateAuthState: vi.fn().mockResolvedValue(updatedRole)
    };
    const browserManager = {
      stop: vi.fn().mockResolvedValue(undefined),
      launch: vi.fn().mockResolvedValue({ roleId: role.id, state: "running" })
    };
    const systemChromeLauncher = {
      openLoginWindow: vi.fn().mockResolvedValue(createLoginSession())
    };
    const authSessionChecker = {
      check: vi.fn().mockResolvedValue({ authState: "authenticated" })
    };
    const userDataLockWatcher = {
      waitForRelease: vi.fn().mockRejectedValue(new BrowserUserDataLockTimeoutError())
    };
    const manager = new AuthManager(
      roleStore,
      browserManager,
      systemChromeLauncher,
      authSessionChecker,
      userDataLockWatcher
    );

    manager.startLogin(role);

    await vi.waitFor(() => {
      expect(manager.listStatuses()[0]).toMatchObject({
        roleId: role.id,
        state: "failed",
        message: "Chrome is still using this role's browser data. Quit the Chrome login window and try again."
      });
    });

    expect(authSessionChecker.check).not.toHaveBeenCalled();
    expect(browserManager.launch).not.toHaveBeenCalled();
    expect(roleStore.updateAuthState).toHaveBeenCalledWith(role.id, "auth_failed");
  });
});

function createLoginSession(
  overrides: Partial<Omit<SystemChromeLoginSession, "close">> = {}
): SystemChromeLoginSession & { close: ReturnType<typeof vi.fn> } {
  return {
    userDataDir: "/tmp/rion-studio/role-1/browser",
    closed: Promise.resolve(),
    monitor: Promise.resolve({
      state: "login_completed",
      port: 9222,
      targetId: "target-1",
      url: role.launchUrl
    } satisfies LoginWindowMonitorResult),
    ...overrides,
    close: vi.fn().mockResolvedValue(undefined)
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve
  };
}
