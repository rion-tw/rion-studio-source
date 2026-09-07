import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browser: {
    electron: undefined as undefined | { windowHandle: string },
    setTimeout: vi.fn(async () => undefined),
    getPuppeteer: vi.fn(async () => ({ targets: () => [{
      type: () => "page", _targetId: "launcher", url: () => "file:///Rion/out/renderer/index.html"
    }] })),
    getWindowHandles: vi.fn(async () => ["launcher"]),
    switchToWindow: vi.fn(async () => undefined)
  },
  probe: vi.fn(async () => ({ processId: 123 })),
  prepare: vi.fn(async () => vi.fn()),
  register: vi.fn()
}));
vi.mock("@wdio/globals", () => ({ browser: mocks.browser }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(async () => undefined) }));
vi.mock("../e2e/desktop/support/electron-driver", () => ({
  electronDesktopE2eProbe: mocks.probe, requestElectronDesktopE2eClose: vi.fn()
}));
vi.mock("../e2e/desktop/support/native-failure-sample", () => ({
  prepareNativeFailureSampler: mocks.prepare, registerNativeFailureSampler: mocks.register,
  capturePreparedNativeFailureSample: vi.fn()
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.browser.electron = undefined;
  for (const [name, value] of Object.entries({
    RION_STUDIO_E2E_ARTIFACT_DIR: "/tmp/rion-service-order",
    RION_STUDIO_E2E_APP_BINARY: "/tmp/rion/main.js",
    RION_STUDIO_E2E_PHASE: "chromium-extensions-seed",
    RION_STUDIO_E2E_RUNTIME_TARGET: "chromium-v23-macos-appkit",
    RION_STUDIO_E2E_SESSION_TOKEN: "service-order-fixture",
    RION_STUDIO_USER_DATA_DIR: "/tmp/rion-service-order/user-data",
    RION_STUDIO_E2E_PACKAGED: "0"
  })) vi.stubEnv(name, value);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it.each(["darwin", "win32"])("defers Electron bridge consumers until all concurrent before hooks finish on %s", async (platform) => {
  vi.stubGlobal("process", { ...process, platform });
  // The WDIO runtime config belongs to its own runtime loader, not the node
  // project's static module graph. Exercise its actual hooks with mocked ports.
  const { config } = await vi.importActual<{ config: {
    before(capabilities: unknown, specs: string[], runner: WebdriverIO.Browser): Promise<void>;
    beforeSuite(): Promise<void>;
  } }>("../e2e/desktop/wdio.electron.conf");
  // This config hook may finish before the asynchronous Electron service hook.
  await expect(config.before({}, [], mocks.browser as unknown as WebdriverIO.Browser))
    .resolves.toBeUndefined();
  expect(mocks.browser.getPuppeteer).not.toHaveBeenCalled();
  expect(mocks.probe).not.toHaveBeenCalled();
  mocks.browser.electron = { windowHandle: "old-service-target" };
  await config.beforeSuite();
  expect(mocks.browser.electron.windowHandle).toBe("launcher");
  expect(mocks.browser.switchToWindow).toHaveBeenCalledWith("launcher");
  expect(mocks.probe).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
  expect(mocks.register).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
  // Nested suites must not steal the active target back from a user journey.
  mocks.browser.electron.windowHandle = "runtime-target";
  await config.beforeSuite();
  expect(mocks.browser.electron.windowHandle).toBe("runtime-target");
  expect(mocks.browser.switchToWindow).toHaveBeenCalledTimes(1);
});
