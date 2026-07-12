import { describe, expect, it, vi } from "vitest";

import {
  BrowserHiddenHelperError,
  BrowserLaunchAuthError,
  BrowserManager,
  buildChromiumArgs,
  buildLaunchOptions
} from "../src/main/browser/BrowserManager";
import type { LoginStorageSnapshot } from "../src/main/auth/loginEvidence";
import type { Role } from "../src/shared/types";

const role: Role = {
  id: "role-1",
  name: "Main",
  launchUrl: "https://example.com/play",
  windowWidth: 1280,
  windowHeight: 720,
  notes: "",
  launchPreset: "performance",
  authState: "authenticated",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

describe("BrowserManager", () => {
  it("launches with an adaptive page viewport", () => {
    expect(buildLaunchOptions(role)).toMatchObject({
      headless: false,
      viewport: null
    });
    expect(buildLaunchOptions(role).args).toEqual(expect.arrayContaining(["--window-size=1280,720"]));
  });

  it("includes an executable override when one is provided", () => {
    expect(buildLaunchOptions(role, "/tmp/Rion Studio Browser.app/Contents/MacOS/Chromium")).toMatchObject({
      executablePath: "/tmp/Rion Studio Browser.app/Contents/MacOS/Chromium"
    });
  });

  it("builds minimal app-mode Chromium arguments", () => {
    const args = buildChromiumArgs(role);

    expect(args).toEqual(
      expect.arrayContaining([
        "--app=https://example.com/play",
        "--window-size=1280,720",
        "--disable-extensions",
        "--enable-gpu",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling"
      ])
    );
    expect(args.some((arg) => arg.startsWith("--remote-debugging"))).toBe(false);
  });

  it("uses workspace bounds instead of role window size when provided", () => {
    const args = buildChromiumArgs(role, { x: 40, y: 80, width: 960, height: 540 });

    expect(args).toEqual(
      expect.arrayContaining([
        "--app=https://example.com/play",
        "--window-size=960,540",
        "--window-position=40,80"
      ])
    );
    expect(args).not.toContain("--window-size=1280,720");
  });

  it("focuses an existing session instead of launching the same role twice", async () => {
    const context = createBrowserContext([createStorageSnapshot({ cookies: { sid: "session-1" } })]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);

    await manager.launch(role);
    await manager.launch(role);

    expect(launcher).toHaveBeenCalledTimes(1);
    expect(store.ensureBrowserUserDataDir).toHaveBeenCalledTimes(1);
    expect(context.page.goto).toHaveBeenCalledTimes(1);
    expect(context.page.bringToFront).toHaveBeenCalledTimes(2);
    expect(store.updateAuthState).not.toHaveBeenCalled();
    expect(manager.listStatuses()).toMatchObject([{ roleId: role.id, state: "running" }]);
  });

  it("installs the macro overlay after a new launch", async () => {
    const context = createBrowserContext([createStorageSnapshot({ cookies: { sid: "session-1" } })]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);
    const overlayInstaller = vi.fn().mockResolvedValue(undefined);
    manager.setMacroOverlayInstaller(overlayInstaller);

    await manager.launch(role);

    expect(overlayInstaller).toHaveBeenCalledWith(role, context.page);
  });

  it("reinstalls the macro overlay when focusing an existing session", async () => {
    const context = createBrowserContext([
      createStorageSnapshot({ cookies: { sid: "session-1" } }),
      createStorageSnapshot({ cookies: { sid: "session-1" } })
    ]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);
    const overlayInstaller = vi.fn().mockResolvedValue(undefined);
    manager.setMacroOverlayInstaller(overlayInstaller);

    await manager.launch(role);
    await manager.launch(role);

    expect(launcher).toHaveBeenCalledTimes(1);
    expect(overlayInstaller).toHaveBeenCalledTimes(2);
    expect(overlayInstaller).toHaveBeenNthCalledWith(2, role, context.page);
  });

  it("applies workspace bounds to a newly launched browser window", async () => {
    const context = createBrowserContext([createStorageSnapshot({ cookies: { sid: "session-1" } })]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);

    await manager.launch(role, { bounds: { x: 10, y: 20, width: 700, height: 500 } });

    expect(launcher.mock.calls[0][1].args).toEqual(
      expect.arrayContaining(["--window-size=700,500", "--window-position=10,20"])
    );
    expect(context.browserContext.newCDPSession).toHaveBeenCalledWith(context.page);
    expect(context.cdpSession.send).toHaveBeenCalledWith("Browser.getWindowForTarget");
    expect(context.cdpSession.send).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 7,
      bounds: {
        left: 10,
        top: 20,
        width: 700,
        height: 500,
        windowState: "normal"
      }
    });
    expect(context.cdpSession.detach).toHaveBeenCalledTimes(1);
  });

  it("repositions an existing session without launching it again", async () => {
    const context = createBrowserContext([
      createStorageSnapshot({ cookies: { sid: "session-1" } }),
      createStorageSnapshot({ cookies: { sid: "session-1" } })
    ]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);

    await manager.launch(role);
    await manager.launch(role, { bounds: { x: 100, y: 200, width: 800, height: 600 } });

    expect(launcher).toHaveBeenCalledTimes(1);
    expect(context.browserContext.newCDPSession).toHaveBeenCalledTimes(1);
    expect(context.cdpSession.send).toHaveBeenCalledWith("Browser.setWindowBounds", {
      windowId: 7,
      bounds: {
        left: 100,
        top: 200,
        width: 800,
        height: 600,
        windowState: "normal"
      }
    });
    expect(context.page.bringToFront).toHaveBeenCalledTimes(2);
  });

  it("launches when localStorage has persisted auth evidence", async () => {
    const context = createBrowserContext([createStorageSnapshot({ localStorage: { authToken: "token-1" } })]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);

    await expect(manager.launch(role)).resolves.toMatchObject({
      roleId: role.id,
      state: "running"
    });

    expect(context.page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 5_000 });
    expect(context.browserContext.cookies).toHaveBeenCalledWith(role.launchUrl);
    expect(context.page.evaluate).toHaveBeenCalledTimes(1);
    expect(context.context.close).not.toHaveBeenCalled();
    expect(store.updateAuthState).not.toHaveBeenCalled();
  });

  it("closes the launched browser and resets auth state when no persisted session exists", async () => {
    const context = createBrowserContext([createStorageSnapshot()]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);

    await expect(manager.launch(role)).rejects.toThrow(BrowserLaunchAuthError);

    expect(context.context.close).toHaveBeenCalled();
    expect(store.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
    expect(manager.listStatuses()).toEqual([]);
  });

  it("does not launch when a login prompt is still visible even with storage evidence", async () => {
    const context = createBrowserContext([
      createStorageSnapshot({
        cookies: { sid: "session-1" },
        bodyText: "Continue with Facebook"
      })
    ]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);

    await expect(manager.launch(role)).rejects.toThrow("Login is still required.");

    expect(context.context.close).toHaveBeenCalled();
    expect(store.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
    expect(manager.listStatuses()).toEqual([]);
  });

  it("closes an existing session and resets auth state when focus validation fails", async () => {
    const context = createBrowserContext([
      createStorageSnapshot({ localStorage: { authToken: "token-1" } }),
      createStorageSnapshot()
    ]);
    const launcher = vi.fn().mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, launcher);

    await manager.launch(role);

    await expect(manager.launch(role)).rejects.toThrow(BrowserLaunchAuthError);

    expect(launcher).toHaveBeenCalledTimes(1);
    expect(context.context.close).toHaveBeenCalled();
    expect(store.updateAuthState).toHaveBeenCalledWith(role.id, "login_required");
    expect(manager.listStatuses()).toEqual([]);
  });

  it("falls back to bundled Chromium when an executable override launch fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const context = createBrowserContext([createStorageSnapshot({ cookies: { sid: "session-1" } })]);
    const launcher = vi.fn().mockRejectedValueOnce(new Error("helper blocked")).mockResolvedValue(context.context);
    const store = createRoleStore();
    const manager = new BrowserManager(store, {
      launchPersistentContext: launcher,
      executablePathResolver: vi.fn().mockResolvedValue("/tmp/Rion Studio Browser.app/Contents/MacOS/Chromium")
    });

    try {
      await manager.launch(role);

      expect(launcher).toHaveBeenCalledTimes(2);
      expect(launcher.mock.calls[0][1]).toMatchObject({
        executablePath: "/tmp/Rion Studio Browser.app/Contents/MacOS/Chromium"
      });
      expect(launcher.mock.calls[1][1]).not.toHaveProperty("executablePath");
      expect(context.page.goto).toHaveBeenCalledWith(role.launchUrl, { waitUntil: "domcontentloaded" });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not fall back to visible Chromium when fallback is disabled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const launcher = vi.fn().mockRejectedValue(new Error("helper blocked"));
    const store = createRoleStore();
    const manager = new BrowserManager(store, {
      launchPersistentContext: launcher,
      executablePathResolver: vi.fn().mockResolvedValue("/tmp/Rion Studio Browser.app/Contents/MacOS/Chromium"),
      allowVisibleFallback: false
    });

    try {
      await expect(manager.launch(role)).rejects.toThrow(BrowserHiddenHelperError);

      expect(launcher).toHaveBeenCalledTimes(1);
      expect(launcher.mock.calls[0][1]).toMatchObject({
        executablePath: "/tmp/Rion Studio Browser.app/Contents/MacOS/Chromium"
      });
      expect(warn).toHaveBeenCalledWith(
        "Failed to launch hidden Rion Studio browser helper.",
        expect.any(Error)
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not launch visible Chromium when executable resolution fails and fallback is disabled", async () => {
    const launcher = vi.fn();
    const store = createRoleStore();
    const manager = new BrowserManager(store, {
      launchPersistentContext: launcher,
      executablePathResolver: vi.fn().mockResolvedValue(undefined),
      allowVisibleFallback: false
    });

    await expect(manager.launch(role)).rejects.toThrow(BrowserHiddenHelperError);

    expect(launcher).not.toHaveBeenCalled();
  });
});

function createRoleStore(): {
  ensureBrowserUserDataDir: ReturnType<typeof vi.fn>;
  updateAuthState: ReturnType<typeof vi.fn>;
} {
  return {
    ensureBrowserUserDataDir: vi.fn().mockResolvedValue("/tmp/rion-studio/role-1/browser"),
    updateAuthState: vi.fn().mockResolvedValue({ ...role, authState: "login_required" })
  };
}

function createBrowserContext(snapshots: LoginStorageSnapshot[]): {
  context: {
    pages: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  browserContext: {
    cookies: ReturnType<typeof vi.fn>;
    newCDPSession: ReturnType<typeof vi.fn>;
  };
  cdpSession: {
    detach: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  page: {
    bringToFront: ReturnType<typeof vi.fn>;
    goto: ReturnType<typeof vi.fn>;
    waitForLoadState: ReturnType<typeof vi.fn>;
    url: ReturnType<typeof vi.fn>;
    context: ReturnType<typeof vi.fn>;
    evaluate: ReturnType<typeof vi.fn>;
  };
} {
  let readIndex = 0;
  let currentSnapshot: LoginStorageSnapshot | undefined;
  let closeListener: (() => void) | undefined;

  const readSnapshot = (): LoginStorageSnapshot => {
    const snapshot = currentSnapshot ?? snapshots[Math.min(readIndex, snapshots.length - 1)];

    if (!currentSnapshot) {
      readIndex += 1;
    }

    currentSnapshot = snapshot;
    return snapshot;
  };

  const browserContext = {
    cookies: vi.fn(async () => {
      const snapshot = readSnapshot();

      return Object.entries(snapshot.cookies).map(([name, value]) => ({
        name,
        value
      }));
    }),
    newCDPSession: vi.fn()
  };
  const cdpSession = {
    send: vi.fn(async (method: string) => (method === "Browser.getWindowForTarget" ? { windowId: 7 } : {})),
    detach: vi.fn().mockResolvedValue(undefined)
  };
  browserContext.newCDPSession.mockResolvedValue(cdpSession);
  const page = {
    bringToFront: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(role.launchUrl),
    context: vi.fn().mockReturnValue(browserContext),
    evaluate: vi.fn(async () => {
      const snapshot = readSnapshot();
      currentSnapshot = undefined;

      return {
        localStorage: snapshot.localStorage,
        sessionStorage: snapshot.sessionStorage,
        indexedDb: snapshot.indexedDb,
        bodyText: snapshot.bodyText
      };
    })
  };
  const context = {
    pages: vi.fn().mockReturnValue([page]),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "close") {
        closeListener = listener;
      }
    }),
    close: vi.fn(async () => {
      const listener = closeListener;
      closeListener = undefined;
      listener?.();
    })
  };

  return {
    context,
    browserContext,
    cdpSession,
    page
  };
}

function createStorageSnapshot(overrides: Partial<LoginStorageSnapshot> = {}): LoginStorageSnapshot {
  return {
    cookies: {},
    localStorage: {},
    sessionStorage: {},
    indexedDb: {},
    bodyText: "",
    ...overrides
  };
}
