import { describe, expect, it, vi } from "vitest";

import type { RolePathsRecord } from "../src/shared/generated";
import { SystemWebViewRuntimePool } from "../src/main/browser/SystemWebViewRuntimePool";
import type { WebSurfacePort } from "../src/main/browser/ports/WebSurfacePort";

const paths: RolePathsRecord = {
  browserUserDataDir: "/roles/one/browser",
  electronBrowserUserDataDir: "/roles/one/browser/electron",
  systemBrowserDataDir: "/roles/one/browser/system",
  webkitDataStoreIdentifier: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  webkitDataStoreKey: "rion.role.one",
  webview2UserDataDir: "C:\\roles\\one\\browser\\webview2"
};

function surface() {
  let listener: ((event: { type: "crashed"; reason?: string }) => void) | undefined;
  const value: WebSurfacePort = {
    addDocumentStartScript: vi.fn(async () => undefined),
    clearStorage: vi.fn(async () => undefined),
    configureRequestRewrites: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    evaluate: async <T>(_source: string) => undefined as T,
    focus: vi.fn(async () => undefined),
    getCookies: vi.fn(async () => []),
    loadUrl: vi.fn(async () => undefined),
    onLifecycleEvent: vi.fn((next) => {
      listener = next as typeof listener;
      return vi.fn();
    }),
    setAudioMuted: vi.fn(async () => undefined),
    setBounds: vi.fn(async () => undefined),
    setCookies: vi.fn(async (cookies) => cookies.length),
    setVisible: vi.fn(async () => undefined),
    setZoomFactor: vi.fn(async () => undefined)
  };
  return { emitCrash: () => listener?.({ type: "crashed", reason: "process-failed" }), value };
}

describe("SystemWebViewRuntimePool", () => {
  it.each([
    {
      engine: "wkwebview",
      expectedData: paths.webkitDataStoreIdentifier,
      platform: "darwin" as const
    },
    {
      engine: "webview2",
      expectedData: paths.webview2UserDataDir,
      platform: "win32" as const
    }
  ])("creates an isolated $engine role surface and forwards lifecycle", async ({
    engine,
    expectedData,
    platform
  }) => {
    const native = surface();
    const lifecycle = vi.fn();
    const createMacSurface = vi.fn(() => native.value);
    const createWindowsSurface = vi.fn(() => native.value as never);
    const pool = new SystemWebViewRuntimePool({
      createMacSurface,
      createWindowsSurface,
      onLifecycleEvent: lifecycle,
      platform
    });
    const hostWindow = {} as never;

    expect(pool.capability()).toEqual({ available: true, engine });
    expect(pool.create("role-1", hostWindow, paths).engine).toBe(engine);
    if (platform === "darwin") {
      expect(createMacSurface).toHaveBeenCalledWith(hostWindow, {
        dataStoreIdentifier: expectedData
      });
    } else {
      expect(createWindowsSurface).toHaveBeenCalledWith(hostWindow, {
        userDataFolder: expectedData
      });
    }
    await pool.load(
      "role-1",
      "https://example.test/game",
      { x: 4, y: 8, width: 640, height: 480 },
      1.25,
      true
    );
    native.emitCrash();
    expect(lifecycle).toHaveBeenCalledWith(
      "role-1",
      engine,
      { type: "crashed", reason: "process-failed" }
    );
    await pool.destroy("role-1");
    expect(native.value.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["darwin", "socks5://127.0.0.1:7890"],
    ["win32", "http://127.0.0.1:7890"]
  ] as const)("passes a normalized custom proxy into the %s surface before creation", (
    platform,
    proxyServer
  ) => {
    const native = surface();
    const createMacSurface = vi.fn(() => native.value);
    const createWindowsSurface = vi.fn(() => native.value as never);
    const pool = new SystemWebViewRuntimePool({
      createMacSurface,
      createWindowsSurface,
      platform
    });
    const hostWindow = {} as never;

    pool.create("role-1", hostWindow, paths, { proxyServer });

    const factory = platform === "darwin" ? createMacSurface : createWindowsSurface;
    expect(factory).toHaveBeenCalledWith(
      hostWindow,
      expect.objectContaining({ proxyServer })
    );
  });

  it("fails closed for missing adapters and duplicate role ownership", async () => {
    const unavailable = new SystemWebViewRuntimePool({ platform: "darwin" });
    expect(unavailable.capability()).toMatchObject({
      available: false,
      engine: "wkwebview"
    });
    expect(() => unavailable.create("role-1", {} as never, paths)).toThrow(
      "WKWebView native adapter is unavailable"
    );

    const native = surface();
    const pool = new SystemWebViewRuntimePool({
      createWindowsSurface: () => native.value as never,
      platform: "win32"
    });
    pool.create("role-1", {} as never, paths);
    expect(() => pool.create("role-1", {} as never, paths)).toThrow(
      "already exists"
    );
    await pool.destroyAll();
  });
});
