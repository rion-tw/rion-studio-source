import { EventEmitter } from "node:events";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  buildExternalChromeArgs,
  createSeamlessWorkspaceBounds,
  EXTERNAL_ZOOM_UNAVAILABLE_NOTICE,
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
      }, undefined, "automatic", "linux")
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
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-features=MediaRouter,OptimizationHints,Translate",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0"
    ]);
  });

  it.each([
    ["win32", true],
    ["darwin", false],
    ["linux", false]
  ] as const)("uses platform-scoped background switches on %s", (platform, hasOcclusionSwitch) => {
    const args = buildExternalChromeArgs(
      role,
      "/tmp/profile",
      { x: 0, y: 0, width: 1280, height: 720 },
      undefined,
      "automatic",
      platform
    );

    expect(args).toContain("--disable-background-timer-throttling");
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args.includes("--disable-backgrounding-occluded-windows")).toBe(hasOcclusionSwitch);
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
      expect.objectContaining({
        cdnCompatibilityEnabled: true,
        onDiagnostic: expect.any(Function),
        platform: "linux"
      })
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

  it("keeps native zoom independent when macro automation cannot connect", async () => {
    const harness = createHarness({
      connectAutomation: vi.fn().mockRejectedValue(new Error("CDP unavailable"))
    });

    const launchPromise = harness.manager.launch(role, { zoomFactor: 0.75 });
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(status).toMatchObject({ state: "running", automationState: "unavailable" });
    expect(status.notice).not.toContain(EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
    expect(harness.applyBrowserZoom).toHaveBeenCalledWith("/profiles/role-1/browser", 0.75);
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  it("keeps automation ready when only native zoom preference writing fails", async () => {
    const applyBrowserZoom = vi.fn().mockRejectedValue(new Error("zoom rejected"));
    const harness = createHarness({
      applyBrowserZoom
    });

    const launchPromise = harness.manager.launch(role, { zoomFactor: 0.75 });
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(status).toMatchObject({ state: "running", automationState: "ready" });
    expect(status.notice).toBe(EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
    expect(harness.manager.getAutomationSession(role.id)?.target).toBe(harness.automationTargets[0]);
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  it("keeps a running external session unchanged when a different zoom is requested", async () => {
    const harness = createHarness();
    const launchPromise = harness.manager.launch(role, { zoomFactor: 0.75 });
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await launchPromise;

    const status = await harness.manager.launch(role, { zoomFactor: 0.9 });

    expect(status.notice).toBe(EXTERNAL_ZOOM_UNAVAILABLE_NOTICE);
    expect(harness.applyBrowserZoom).toHaveBeenCalledTimes(1);
    expect(harness.spawnChrome).toHaveBeenCalledTimes(1);
    expect(harness.children[0].kill).not.toHaveBeenCalled();
  });

  it("applies adaptive native zoom before spawning an external Chrome workspace window", async () => {
    const harness = createHarness();
    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-1" },
      [{ role, rect: { x: 0, y: 0, width: 1, height: 1 } }],
      { zoomMode: "adaptive" }
    );

    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await launchPromise;

    expect(harness.applyBrowserZoom).toHaveBeenCalledWith("/profiles/role-1/browser", 0.9);
    expect(harness.applyBrowserZoom.mock.invocationCallOrder[0]).toBeLessThan(
      harness.spawnChrome.mock.invocationCallOrder[0]
    );
  });

  it("uses a per-role zoom override instead of adaptive external Chrome zoom", async () => {
    const harness = createHarness();
    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-1" },
      [{
        role,
        rect: { x: 0, y: 0, width: 1, height: 1 },
        browserZoomPercent: 120
      }],
      { zoomMode: "adaptive" }
    );

    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await launchPromise;

    expect(harness.applyBrowserZoom).toHaveBeenCalledWith("/profiles/role-1/browser", 1.2);
  });

  it("calculates adaptive native zoom independently for every eight-grid role", async () => {
    const harness = createHarness();
    const roles = Array.from({ length: 8 }, (_value, index) => ({
      ...role,
      id: `role-${index + 1}`,
      name: `Role ${index + 1}`
    }));
    const items = roles.map((gridRole, index) => ({
      role: gridRole,
      rect: {
        x: (index % 4) * 0.25,
        y: Math.floor(index / 4) * 0.5,
        width: 0.25,
        height: 0.5
      }
    }));

    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-eight-grid" },
      items,
      {
        workArea: { x: 0, y: 0, width: 2_560, height: 1_400 },
        zoomMode: "adaptive"
      }
    );
    for (let index = 0; index < roles.length; index += 1) {
      await waitForChild(harness.children, index);
      harness.children[index].emit("spawn");
    }
    await launchPromise;

    expect(harness.applyBrowserZoom).toHaveBeenCalledTimes(8);
    for (const gridRole of roles) {
      expect(harness.applyBrowserZoom).toHaveBeenCalledWith(
        `/profiles/${gridRole.id}/browser`,
        0.5
      );
    }
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
        workArea: { x: 2000, y: 40, width: 1600, height: 900 },
        zoomFactor: 0.75
      }
    );
    await waitForChild(harness.children, 0);
    await waitForChild(harness.children, 1);
    expect(harness.manager.listWorkspaceRuntimeStatuses()).toEqual([
      { workspaceId: "workspace-1", state: "launching" }
    ]);
    harness.children[0].emit("spawn");
    harness.children[1].emit("spawn");
    const statuses = await launchPromise;

    expect(getSpawnArgsForRole(harness.spawnChrome, role.id)).toEqual(
      expect.arrayContaining(["--window-position=2000,40", "--window-size=800,900"])
    );
    expect(getSpawnArgsForRole(harness.spawnChrome, secondRole.id)).toEqual(
      expect.arrayContaining(["--window-position=2800,40", "--window-size=800,900"])
    );
    const firstTarget = harness.automationTargetsByRoleId.get(role.id)!;
    const secondTarget = harness.automationTargetsByRoleId.get(secondRole.id)!;
    expect(firstTarget.setWindowBounds).toHaveBeenCalledWith({
      x: 2000,
      y: 40,
      width: 800,
      height: 900
    });
    expect(secondTarget.setWindowBounds).toHaveBeenCalledWith({
      x: 2800,
      y: 40,
      width: 800,
      height: 900
    });
    expect(firstTarget.focus).toHaveBeenCalledOnce();
    expect(secondTarget.focus).not.toHaveBeenCalled();
    expect(firstTarget.focus.mock.invocationCallOrder[0]).toBeGreaterThan(
      secondTarget.setWindowBounds.mock.invocationCallOrder[0]
    );
    expect(harness.applyBrowserZoom).toHaveBeenCalledWith("/profiles/role-1/browser", 0.75);
    expect(harness.applyBrowserZoom).toHaveBeenCalledWith("/profiles/role-2/browser", 0.75);
    expect(statuses).toEqual([
      expect.objectContaining({ roleId: "role-1", notice: "fallback", runtimeMode: "external" }),
      expect.objectContaining({ roleId: "role-2", notice: "fallback", runtimeMode: "external" })
    ]);
    expect(harness.manager.hasWorkspace("workspace-1")).toBe(true);
    expect(harness.manager.listWorkspaceRuntimeStatuses()).toEqual([
      { workspaceId: "workspace-1", state: "running" }
    ]);
  });

  it("stops fulfilled workspace sessions when another concurrent Chrome launch fails", async () => {
    const harness = createHarness();
    const secondRole = { ...role, id: "role-2", name: "Alt" };
    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-partial-failure" },
      [
        { role, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { role: secondRole, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ]
    );

    await waitForChild(harness.children, 1);
    harness.children[0].emit("spawn");
    harness.children[1].emit("error", new Error("Chrome failed to spawn"));

    await expect(launchPromise).rejects.toThrow("Chrome failed to spawn");
    expect(harness.children[0].kill).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
    expect(harness.manager.hasWorkspace("workspace-partial-failure")).toBe(false);
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

    expect(roles.map((gridRole) =>
      harness.automationTargetsByRoleId.get(gridRole.id)!.setWindowBounds.mock.calls[0][0]
    ))
      .toEqual([
        { x: 2000, y: 40, width: 801, height: 451 },
        { x: 2801, y: 40, width: 800, height: 451 },
        { x: 2000, y: 491, width: 801, height: 450 },
        { x: 2801, y: 491, width: 800, height: 450 }
      ]);
  });

  it("normalizes shared edges and tiles external Chrome without gaps on every platform", async () => {
    const harness = createHarness();
    const roles = Array.from({ length: 8 }, (_value, index) => ({
      ...role,
      id: `eight-grid-role-${index + 1}`,
      name: `Eight Grid Role ${index + 1}`
    }));
    const rects = Array.from({ length: 8 }, (_value, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      const x = column === 2 ? 0.50002 : column / 4;
      const y = row === 1 ? 0.50002 : 0;
      const right = column === 1 ? 0.49998 : (column + 1) / 4;
      const bottom = row === 0 ? 0.49998 : 1;
      return { x, y, width: right - x, height: bottom - y };
    });

    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-eight-grid" },
      roles.map((gridRole, index) => ({ role: gridRole, rect: rects[index] })),
      { workArea: { x: 2000, y: 40, width: 1603, height: 903 } }
    );
    for (let index = 0; index < roles.length; index += 1) {
      await waitForChild(harness.children, index);
      harness.children[index].emit("spawn");
    }
    await launchPromise;

    const bounds = roles.map((gridRole) =>
      harness.automationTargetsByRoleId.get(gridRole.id)!.setWindowBounds.mock.calls[0][0]
    );
    expect(bounds).toEqual([
      { x: 2000, y: 40, width: 401, height: 452 },
      { x: 2401, y: 40, width: 401, height: 452 },
      { x: 2802, y: 40, width: 400, height: 452 },
      { x: 3202, y: 40, width: 401, height: 452 },
      { x: 2000, y: 492, width: 401, height: 451 },
      { x: 2401, y: 492, width: 401, height: 451 },
      { x: 2802, y: 492, width: 400, height: 451 },
      { x: 3202, y: 492, width: 401, height: 451 }
    ]);
  });

  it("overlaps only shared macOS seams enough to cover native rounded corners", () => {
    expect(
      createSeamlessWorkspaceBounds(
        [
          { x: 0, y: 24, width: 800, height: 450 },
          { x: 800, y: 24, width: 800, height: 450 },
          { x: 0, y: 474, width: 800, height: 450 },
          { x: 800, y: 474, width: 800, height: 450 }
        ],
        12
      )
    ).toEqual([
      { x: 0, y: 24, width: 812, height: 462 },
      { x: 800, y: 24, width: 800, height: 462 },
      { x: 0, y: 474, width: 812, height: 450 },
      { x: 800, y: 474, width: 800, height: 450 }
    ]);
  });

  it("applies the macOS corner overlap to Chrome launch and CDP bounds", async () => {
    const harness = createHarness({ platform: "darwin" });
    const secondRole = { ...role, id: "mac-role-2", name: "Mac Alt" };

    const launchPromise = harness.manager.launchWorkspace(
      { id: "mac-seamless-workspace" },
      [
        { role, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { role: secondRole, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ],
      { workArea: { x: 2000, y: 40, width: 1600, height: 900 } }
    );
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await waitForChild(harness.children, 1);
    harness.children[1].emit("spawn");
    await launchPromise;

    expect([role, secondRole].map((workspaceRole) =>
      harness.automationTargetsByRoleId.get(workspaceRole.id)!.setWindowBounds.mock.calls[0][0]
    ))
      .toEqual([
        { x: 2000, y: 40, width: 812, height: 900 },
        { x: 2800, y: 40, width: 800, height: 900 }
      ]);
    expect(getSpawnArgsForRole(harness.spawnChrome, role.id)).toEqual(
      expect.arrayContaining(["--window-position=2000,40", "--window-size=812,900"])
    );
    expect(getSpawnArgsForRole(harness.spawnChrome, secondRole.id)).toEqual(
      expect.arrayContaining(["--window-position=2800,40", "--window-size=800,900"])
    );
  });

  it("derives Windows workspace slots from one converted physical work area", async () => {
    const windowBoundsAdapter = createWindowBoundsAdapter(() => ({
      x: -1920,
      y: -80,
      width: 2001,
      height: 1127
    }));
    const roles = Array.from({ length: 4 }, (_value, index) => ({
      ...role,
      id: `physical-role-${index + 1}`,
      name: `Physical Role ${index + 1}`
    }));
    const zoomResolversByRoleId = new Map<string, () => void>();
    const applyBrowserZoom = vi.fn((browserUserDataDir: string) => new Promise<void>((resolve) => {
      const roleId = /^\/profiles\/(.+)\/browser$/.exec(browserUserDataDir)![1];
      zoomResolversByRoleId.set(roleId, resolve);
      if (zoomResolversByRoleId.size === roles.length) {
        queueMicrotask(() => {
          // Reproduce an out-of-order Windows launch instead of assuming role index matches PID order.
          [roles[0], roles[1], roles[3], roles[2]].forEach((workspaceRole) => {
            zoomResolversByRoleId.get(workspaceRole.id)!();
          });
        });
      }
    }));
    const harness = createHarness({
      applyBrowserZoom,
      childPid: 5000,
      platform: "win32",
      windowBoundsAdapter
    });
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
    expect(windowBoundsAdapter.alignVisibleBounds).toHaveBeenCalledTimes(4);
    expect(getSpawnCallIndexForRole(harness.spawnChrome, roles[3].id))
      .toBeLessThan(getSpawnCallIndexForRole(harness.spawnChrome, roles[2].id));
    const expectedPhysicalBounds = [
      { x: -1920, y: -80, width: 1002, height: 565 },
      { x: -919, y: -80, width: 1000, height: 565 },
      { x: -1920, y: 484, width: 1002, height: 563 },
      { x: -919, y: 484, width: 1000, height: 563 }
    ];
    expect(windowBoundsAdapter.alignVisibleBounds.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining(roles.map((workspaceRole, index) => ({
        browserProcessId: getSpawnedChildPidForRole(
          harness.spawnChrome,
          harness.children,
          workspaceRole.id
        ),
        physicalBounds: expectedPhysicalBounds[index]
      })))
    );
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
  applyBrowserZoom?: AnyMock;
  childPid?: number;
  connectAutomation?: AnyMock;
  platform?: NodeJS.Platform;
  prepareCdnCompatibility?: AnyMock;
  windowBoundsAdapter?: ReturnType<typeof createWindowBoundsAdapter>;
} = {}) {
  const children: Array<ReturnType<typeof createChild>> = [];
  const automationTargets: Array<ReturnType<typeof createAutomationTarget>> = [];
  const automationTargetsByRoleId = new Map<string, ReturnType<typeof createAutomationTarget>>();
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
  const connectAutomation = options.connectAutomation ?? vi.fn(async (browserUserDataDir: string) => {
    const target = createAutomationTarget();
    automationTargets.push(target);
    const roleId = /^\/profiles\/(.+)\/browser$/.exec(browserUserDataDir)?.[1];
    if (roleId) automationTargetsByRoleId.set(roleId, target);
    return target;
  });
  const applyBrowserZoom = options.applyBrowserZoom ?? vi.fn().mockResolvedValue(undefined);
  const manager = new ExternalChromeManager(roleStore, {
    applyBrowserZoom,
    connectAutomation,
    findExecutable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    platform: options.platform ?? "linux",
    ...(options.prepareCdnCompatibility
      ? { prepareCdnCompatibility: options.prepareCdnCompatibility }
      : {}),
    spawnChrome,
    ...(options.windowBoundsAdapter ? { windowBoundsAdapter: options.windowBoundsAdapter } : {})
  });

  return {
    applyBrowserZoom,
    automationTargets,
    automationTargetsByRoleId,
    children,
    connectAutomation,
    manager,
    roleStore,
    spawnChrome
  };
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

function getSpawnArgsForRole(spawnChrome: AnyMock, roleId: string): string[] {
  const calls = spawnChrome.mock.calls as unknown as Array<[string, string[]]>;
  return calls[getSpawnCallIndexForRole(spawnChrome, roleId)][1];
}

function getSpawnCallIndexForRole(spawnChrome: AnyMock, roleId: string): number {
  const calls = spawnChrome.mock.calls as unknown as Array<[string, string[]]>;
  const callIndex = calls.findIndex(([, args]) =>
    args.includes(`--user-data-dir=/profiles/${roleId}/browser`)
  );
  if (callIndex < 0) throw new Error(`Chrome spawn arguments not found for role ${roleId}.`);
  return callIndex;
}

function getSpawnedChildPidForRole(
  spawnChrome: AnyMock,
  children: Array<ReturnType<typeof createChild>>,
  roleId: string
): number {
  const pid = children[getSpawnCallIndexForRole(spawnChrome, roleId)]?.pid;
  if (!Number.isInteger(pid)) throw new Error(`Chrome process ID not found for role ${roleId}.`);
  return pid as number;
}
