import { EventEmitter } from "node:events";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  buildExternalChromeArgs,
  ExternalChromeManager
} from "../src/main/browser/ExternalChromeManager";
import type { Role } from "../src/shared/types";

type AnyMock = Mock;

const role: Role = {
  id: "role-1",
  gameId: "game-1",
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

describe("ExternalChromeManager", () => {
  it("builds visible Chrome app-window launch arguments", () => {
    expect(
      buildExternalChromeArgs(role, "/tmp/rion/role-1/browser", {
        x: -1280,
        y: -120,
        width: 1280,
        height: 720
      })
    ).toEqual([
      "--user-data-dir=/tmp/rion/role-1/browser",
      "--app=https://example.com/play",
      "--window-position=-1280,-120",
      "--window-size=1280,720",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-component-extensions-with-background-pages",
      "--metrics-recording-only",
      "--no-service-autorun",
      "--disable-search-engine-choice-screen",
      "--disable-features=MediaRouter,OptimizationHints,Translate",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0"
    ]);
  });

  it("adds only the graphics switches selected by the applied startup mode", () => {
    const bounds = { x: 0, y: 0, width: 1280, height: 720 };
    expect(buildExternalChromeArgs(role, "/tmp/profile", bounds, undefined, "automatic"))
      .not.toContain("--ignore-gpu-blocklist");
    expect(buildExternalChromeArgs(role, "/tmp/profile", bounds, undefined, "high_performance"))
      .toContain("--force-high-performance-gpu");
    expect(buildExternalChromeArgs(role, "/tmp/profile", bounds, undefined, "experimental"))
      .toEqual(expect.arrayContaining([
        "--force-high-performance-gpu",
        "--ignore-gpu-blocklist",
        "--enable-unsafe-webgpu"
      ]));
  });

  it("launches a single role with its isolated browser directory and work-area bounds", async () => {
    const harness = createHarness();

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(harness.roleStore.ensureBrowserUserDataDir).toHaveBeenCalledWith(role.id);
    expect(harness.spawnChrome).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        "--user-data-dir=/profiles/role-1/browser",
        "--window-position=100,50",
        "--window-size=1200,720"
      ])
    );
    expect(harness.automationTargets[0].setWindowBounds).toHaveBeenCalledWith({
      x: 100,
      y: 50,
      width: 1200,
      height: 720
    });
    expect(status).toMatchObject({ roleId: role.id, runtimeMode: "external", state: "running" });
    expect(status.automationState).toBe("ready");
  });

  it("aligns a single Windows Chrome visible frame after CDP positioning", async () => {
    const windowBoundsAdapter = createWindowBoundsAdapter((bounds) => ({
      x: bounds.x * 2,
      y: bounds.y * 2,
      width: bounds.width * 2,
      height: bounds.height * 2
    }));
    const harness = createHarness({ childPid: 4321, windowBoundsAdapter });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(windowBoundsAdapter.dipToPhysicalBounds).toHaveBeenCalledWith({
      x: 100,
      y: 50,
      width: 1200,
      height: 720
    });
    expect(windowBoundsAdapter.alignVisibleBounds).toHaveBeenCalledWith({
      browserProcessId: 4321,
      physicalBounds: { x: 200, y: 100, width: 2400, height: 1440 }
    });
    expect(harness.automationTargets[0].setWindowBounds.mock.invocationCallOrder[0])
      .toBeLessThan(windowBoundsAdapter.alignVisibleBounds.mock.invocationCallOrder[0]);
    expect(status).toMatchObject({ state: "running", automationState: "ready" });
  });

  it("enables CDN interception through CDP after Chrome connects", async () => {
    const prepareCdnCompatibility = vi.fn().mockResolvedValue({
      enabled: true,
      proxyServer: "socks5://127.0.0.1:7890"
    });
    const harness = createHarness({ prepareCdnCompatibility });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(prepareCdnCompatibility).toHaveBeenCalledWith(role, "/profiles/role-1/browser");
    expect(harness.connectAutomation).toHaveBeenCalledWith(
      "/profiles/role-1/browser",
      role.launchUrl,
      { cdnCompatibilityEnabled: true }
    );
    expect(harness.spawnChrome).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--proxy-server=socks5://127.0.0.1:7890"])
    );
    const args = (harness.spawnChrome.mock.calls as unknown as Array<[string, string[]]>)[0][1];
    expect(args.some((argument: string) => argument.startsWith("--load-extension="))).toBe(false);
    expect(status.notice).toBe("China CDN compatibility mode is active in external Chrome.");
  });

  it("opens original URLs when CDN preparation fails", async () => {
    const harness = createHarness({
      prepareCdnCompatibility: vi.fn().mockRejectedValue(new Error("write failed"))
    });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    const args = (harness.spawnChrome.mock.calls as unknown as Array<[string, string[]]>)[0][1];
    expect(args.some((argument: string) => argument.startsWith("--load-extension="))).toBe(false);
    expect(status.notice).toContain("original resource URLs");
  });

  it("keeps original URLs and reports CDN unavailable when CDP interception cannot connect", async () => {
    const harness = createHarness({
      connectAutomation: vi.fn().mockRejectedValue(new Error("CDP unavailable")),
      prepareCdnCompatibility: vi.fn().mockResolvedValue({ enabled: true })
    });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(status).toMatchObject({ state: "running", automationState: "unavailable" });
    expect(status.notice).toContain("original resource URLs");
    expect(status.notice).not.toContain("is active in external Chrome");
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  it("marks CDN interception unavailable if the CDP connection later disconnects", async () => {
    const harness = createHarness({
      prepareCdnCompatibility: vi.fn().mockResolvedValue({ enabled: true })
    });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await launchPromise;
    harness.automationTargets[0].disconnect();

    const [status] = harness.manager.listStatuses();
    expect(status).toMatchObject({ state: "running", automationState: "unavailable" });
    expect(status.notice).toContain("original resource URLs");
    expect(status.notice).not.toContain("is active in external Chrome");
  });

  it("keeps external Chrome running when macro automation cannot connect", async () => {
    const harness = createHarness({
      connectAutomation: vi.fn().mockRejectedValue(new Error("CDP unavailable"))
    });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(status).toMatchObject({
      roleId: role.id,
      runtimeMode: "external",
      state: "running",
      automationState: "unavailable"
    });
    expect(status.notice).toContain("Restart this role");
    expect(harness.manager.getAutomationSession(role.id)).toBeUndefined();
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  it("launches workspace roles using normalized slot rectangles", async () => {
    const harness = createHarness();
    const secondRole = { ...role, id: "role-2", name: "Alt" };

    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-1" },
      [
        { role, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { role: secondRole, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ],
      {
        notice: "fallback",
        workArea: { x: 2000, y: 40, width: 1600, height: 900 }
      }
    );
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await waitForChild(harness.children, 1);
    harness.children[1].emit("spawn");
    const statuses = await launchPromise;

    const spawnCalls = harness.spawnChrome.mock.calls as unknown as Array<[string, string[]]>;
    expect(spawnCalls[0][1]).toEqual(
      expect.arrayContaining(["--window-position=2000,40", "--window-size=800,900"])
    );
    expect(spawnCalls[1][1]).toEqual(
      expect.arrayContaining(["--window-position=2800,40", "--window-size=800,900"])
    );
    expect(harness.automationTargets[0].setWindowBounds).toHaveBeenCalledWith({
      x: 2000,
      y: 40,
      width: 800,
      height: 900
    });
    expect(harness.automationTargets[1].setWindowBounds).toHaveBeenCalledWith({
      x: 2800,
      y: 40,
      width: 800,
      height: 900
    });
    expect(statuses).toEqual([
      expect.objectContaining({ roleId: "role-1", notice: "fallback", runtimeMode: "external" }),
      expect.objectContaining({ roleId: "role-2", notice: "fallback", runtimeMode: "external" })
    ]);
    expect(harness.manager.hasWorkspace("workspace-1")).toBe(true);
  });

  it("aligns every external Chrome window to shared rounded grid edges", async () => {
    const harness = createHarness();
    const roles = Array.from({ length: 4 }, (_value, index) => ({
      ...role,
      id: `role-${index + 1}`,
      name: `Role ${index + 1}`
    }));
    const rects = [
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
    ];

    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-grid" },
      roles.map((gridRole, index) => ({ role: gridRole, rect: rects[index] })),
      { workArea: { x: 2000, y: 40, width: 1601, height: 901 } }
    );
    for (let index = 0; index < roles.length; index += 1) {
      await waitForChild(harness.children, index);
      harness.children[index].emit("spawn");
    }
    await launchPromise;

    expect(harness.automationTargets.map((target) => target.setWindowBounds.mock.calls[0][0]))
      .toEqual([
        { x: 2000, y: 40, width: 801, height: 451 },
        { x: 2801, y: 40, width: 800, height: 451 },
        { x: 2000, y: 491, width: 801, height: 450 },
        { x: 2801, y: 491, width: 800, height: 450 }
      ]);
  });

  it("derives Windows workspace slots from one converted physical work area", async () => {
    const windowBoundsAdapter = createWindowBoundsAdapter(() => ({
      x: -1920,
      y: -80,
      width: 2001,
      height: 1127
    }));
    const harness = createHarness({ childPid: 5000, windowBoundsAdapter });
    const roles = Array.from({ length: 4 }, (_value, index) => ({
      ...role,
      id: `physical-role-${index + 1}`,
      name: `Physical Role ${index + 1}`
    }));
    const rects = [
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      { x: 0, y: 0.5, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }
    ];

    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-physical-grid" },
      roles.map((gridRole, index) => ({ role: gridRole, rect: rects[index] })),
      { workArea: { x: -1536, y: -64, width: 1601, height: 901 } }
    );
    for (let index = 0; index < roles.length; index += 1) {
      await waitForChild(harness.children, index);
      harness.children[index].emit("spawn");
    }
    await launchPromise;

    expect(windowBoundsAdapter.dipToPhysicalBounds).toHaveBeenCalledTimes(1);
    expect(windowBoundsAdapter.dipToPhysicalBounds).toHaveBeenCalledWith({
      x: -1536,
      y: -64,
      width: 1601,
      height: 901
    });
    expect(windowBoundsAdapter.alignVisibleBounds.mock.calls.map(([input]) => input)).toEqual([
      {
        browserProcessId: 5000,
        physicalBounds: { x: -1920, y: -80, width: 1001, height: 564 }
      },
      {
        browserProcessId: 5001,
        physicalBounds: { x: -919, y: -80, width: 1000, height: 564 }
      },
      {
        browserProcessId: 5002,
        physicalBounds: { x: -1920, y: 484, width: 1001, height: 563 }
      },
      {
        browserProcessId: 5003,
        physicalBounds: { x: -919, y: 484, width: 1000, height: 563 }
      }
    ]);
  });

  it("still runs native visible-frame alignment when CDP cannot connect", async () => {
    const windowBoundsAdapter = createWindowBoundsAdapter((bounds) => bounds);
    const harness = createHarness({
      childPid: 6100,
      connectAutomation: vi.fn().mockRejectedValue(new Error("CDP unavailable")),
      windowBoundsAdapter
    });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(windowBoundsAdapter.alignVisibleBounds).toHaveBeenCalledWith({
      browserProcessId: 6100,
      physicalBounds: { x: 100, y: 50, width: 1200, height: 720 }
    });
    expect(status).toMatchObject({ state: "running", automationState: "unavailable" });
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  it("keeps automation ready when native visible-frame alignment fails or PID is missing", async () => {
    const failingAdapter = createWindowBoundsAdapter((bounds) => bounds);
    failingAdapter.alignVisibleBounds.mockRejectedValue(new Error("helper was blocked"));
    const failureHarness = createHarness({ childPid: 6200, windowBoundsAdapter: failingAdapter });

    const failedAlignmentLaunch = failureHarness.manager.launch(role);
    await waitForChild(failureHarness.children, 0);
    failureHarness.children[0].emit("spawn");
    const failureStatus = await failedAlignmentLaunch;

    const missingPidAdapter = createWindowBoundsAdapter((bounds) => bounds);
    const missingPidHarness = createHarness({ windowBoundsAdapter: missingPidAdapter });
    const missingPidLaunch = missingPidHarness.manager.launch({ ...role, id: "missing-pid" });
    await waitForChild(missingPidHarness.children, 0);
    missingPidHarness.children[0].emit("spawn");
    const missingPidStatus = await missingPidLaunch;

    expect(failureStatus).toMatchObject({ state: "running", automationState: "ready" });
    expect(failureHarness.children[0].kill).not.toHaveBeenCalled();
    expect(missingPidAdapter.alignVisibleBounds).not.toHaveBeenCalled();
    expect(missingPidStatus).toMatchObject({ state: "running", automationState: "ready" });
    expect(missingPidHarness.children[0].kill).not.toHaveBeenCalled();
  });

  it("does not report a role as running if Chrome closes during native alignment", async () => {
    let finishAlignment: (() => void) | undefined;
    const windowBoundsAdapter = createWindowBoundsAdapter((bounds) => bounds);
    windowBoundsAdapter.alignVisibleBounds.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishAlignment = resolve;
      })
    );
    const harness = createHarness({ childPid: 6250, windowBoundsAdapter });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await vi.waitFor(() => expect(windowBoundsAdapter.alignVisibleBounds).toHaveBeenCalled());
    harness.children[0].emit("close");
    finishAlignment?.();

    await expect(launchPromise).rejects.toThrow("closed before window alignment completed");
    expect(harness.manager.listStatuses()).toEqual([]);
  });

  it("keeps automation ready when exact window alignment fails", async () => {
    const automationTarget = createAutomationTarget();
    automationTarget.setWindowBounds.mockRejectedValue(new Error("window manager rejected bounds"));
    const windowBoundsAdapter = createWindowBoundsAdapter((bounds) => bounds);
    const harness = createHarness({
      childPid: 6300,
      connectAutomation: vi.fn().mockResolvedValue(automationTarget),
      windowBoundsAdapter
    });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(status).toMatchObject({
      roleId: role.id,
      runtimeMode: "external",
      state: "running",
      automationState: "ready"
    });
    expect(harness.manager.getAutomationSession(role.id)?.target).toBe(automationTarget);
    expect(windowBoundsAdapter.alignVisibleBounds).toHaveBeenCalledWith({
      browserProcessId: 6300,
      physicalBounds: { x: 100, y: 50, width: 1200, height: 720 }
    });
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  it("stops role and workspace Chrome child processes", async () => {
    const harness = createHarness();
    const secondRole = { ...role, id: "role-2", name: "Alt" };

    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-1" },
      [
        { role, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { role: secondRole, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ]
    );
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await waitForChild(harness.children, 1);
    harness.children[1].emit("spawn");
    await launchPromise;

    await harness.manager.stop("role-1");
    await harness.manager.stopWorkspace("workspace-1");

    expect(harness.children[0].kill).toHaveBeenCalledTimes(1);
    expect(harness.children[1].kill).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
    expect(harness.manager.hasWorkspace("workspace-1")).toBe(false);
  });
});

function createHarness(options: {
  childPid?: number;
  connectAutomation?: AnyMock;
  prepareCdnCompatibility?: AnyMock;
  windowBoundsAdapter?: ReturnType<typeof createWindowBoundsAdapter>;
} = {}) {
  const children: Array<ReturnType<typeof createChild>> = [];
  const automationTargets: Array<ReturnType<typeof createAutomationTarget>> = [];
  const roleStore = {
    ensureBrowserUserDataDir: vi.fn(async (roleId: string) => `/profiles/${roleId}/browser`)
  };
  const spawnChrome = vi.fn(() => {
    const child = createChild(
      options.childPid === undefined ? undefined : options.childPid + children.length
    );
    children.push(child);
    return child as never;
  });
  const connectAutomation = options.connectAutomation ?? vi.fn(async () => {
    const target = createAutomationTarget();
    automationTargets.push(target);
    return target;
  });
  const manager = new ExternalChromeManager(roleStore, {
    connectAutomation,
    findExecutable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    ...(options.prepareCdnCompatibility
      ? { prepareCdnCompatibility: options.prepareCdnCompatibility }
      : {}),
    spawnChrome,
    ...(options.windowBoundsAdapter ? { windowBoundsAdapter: options.windowBoundsAdapter } : {})
  });

  return { automationTargets, children, connectAutomation, manager, roleStore, spawnChrome };
}

function createAutomationTarget() {
  const disconnectListeners = new Set<() => void>();
  return {
    close: vi.fn(),
    disconnect: () => disconnectListeners.forEach((listener) => listener()),
    dispatchClick: vi.fn().mockResolvedValue(undefined),
    dispatchKey: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined),
    installMacroOverlay: vi.fn().mockResolvedValue(undefined),
    onDisconnect: vi.fn((listener: () => void) => {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    }),
    setWindowBounds: vi.fn().mockResolvedValue(undefined)
  };
}

function createChild(pid?: number) {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    killed: false,
    pid,
    kill: vi.fn(function kill(this: { killed: boolean }) {
      this.killed = true;
    })
  });
}

function createWindowBoundsAdapter(
  convert: (bounds: { x: number; y: number; width: number; height: number }) => {
    x: number;
    y: number;
    width: number;
    height: number;
  }
) {
  return {
    alignVisibleBounds: vi.fn().mockResolvedValue(undefined),
    dipToPhysicalBounds: vi.fn(convert)
  };
}

async function waitForChild(children: Array<ReturnType<typeof createChild>>, index: number): Promise<void> {
  await vi.waitFor(() => expect(children[index]).toBeDefined());
}
