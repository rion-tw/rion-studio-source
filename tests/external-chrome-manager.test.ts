import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  buildExternalChromeArgs,
  ExternalChromeManager
} from "../src/main/browser/ExternalChromeManager";
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

describe("ExternalChromeManager", () => {
  it("builds visible Chrome app-window launch arguments", () => {
    expect(
      buildExternalChromeArgs(role, "/tmp/rion/role-1/browser", {
        x: 100,
        y: 50,
        width: 1280,
        height: 720
      })
    ).toEqual([
      "--user-data-dir=/tmp/rion/role-1/browser",
      "--app=https://example.com/play",
      "--window-position=100,50",
      "--window-size=1280,720",
      "--no-first-run",
      "--disable-default-apps"
    ]);
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
    expect(status).toMatchObject({ roleId: role.id, runtimeMode: "external", state: "running" });
  });

  it("loads a prepared role-local CDN compatibility extension", async () => {
    const prepareCdnCompatibility = vi.fn().mockResolvedValue({
      enabled: true,
      extensionPath: "/profiles/role-1/cdn-compat-extension",
      proxyServer: "socks5://127.0.0.1:7890"
    });
    const harness = createHarness({ prepareCdnCompatibility });

    const launchPromise = harness.manager.launch(role);
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    const status = await launchPromise;

    expect(prepareCdnCompatibility).toHaveBeenCalledWith(role, "/profiles/role-1/browser");
    expect(harness.spawnChrome).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--load-extension=/profiles/role-1/cdn-compat-extension"])
    );
    expect(harness.spawnChrome).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--proxy-server=socks5://127.0.0.1:7890"])
    );
    expect(status.notice).toContain("developer extension warning");
  });

  it("opens original URLs when CDN extension preparation fails", async () => {
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

  it("launches workspace roles using normalized slot rectangles", async () => {
    const harness = createHarness();
    const secondRole = { ...role, id: "role-2", name: "Alt" };

    const launchPromise = harness.manager.launchWorkspace(
      { id: "workspace-1" },
      [
        { role, rect: { x: 0, y: 0, width: 0.5, height: 1 } },
        { role: secondRole, rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
      ],
      { notice: "fallback" }
    );
    await waitForChild(harness.children, 0);
    harness.children[0].emit("spawn");
    await waitForChild(harness.children, 1);
    harness.children[1].emit("spawn");
    const statuses = await launchPromise;

    const spawnCalls = harness.spawnChrome.mock.calls as unknown as Array<[string, string[]]>;
    expect(spawnCalls[0][1]).toEqual(
      expect.arrayContaining(["--window-position=100,50", "--window-size=600,800"])
    );
    expect(spawnCalls[1][1]).toEqual(
      expect.arrayContaining(["--window-position=700,50", "--window-size=600,800"])
    );
    expect(statuses).toEqual([
      expect.objectContaining({ roleId: "role-1", notice: "fallback", runtimeMode: "external" }),
      expect.objectContaining({ roleId: "role-2", notice: "fallback", runtimeMode: "external" })
    ]);
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
  });
});

function createHarness(options: {
  prepareCdnCompatibility?: ReturnType<typeof vi.fn>;
} = {}) {
  const children: Array<ReturnType<typeof createChild>> = [];
  const roleStore = {
    ensureBrowserUserDataDir: vi.fn(async (roleId: string) => `/profiles/${roleId}/browser`)
  };
  const spawnChrome = vi.fn(() => {
    const child = createChild();
    children.push(child);
    return child as never;
  });
  const manager = new ExternalChromeManager(roleStore, {
    findExecutable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    ...(options.prepareCdnCompatibility
      ? { prepareCdnCompatibility: options.prepareCdnCompatibility }
      : {}),
    spawnChrome
  });

  return { children, manager, roleStore, spawnChrome };
}

function createChild() {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    killed: false,
    kill: vi.fn(function kill(this: { killed: boolean }) {
      this.killed = true;
    })
  });
}

async function waitForChild(children: Array<ReturnType<typeof createChild>>, index: number): Promise<void> {
  await vi.waitFor(() => expect(children[index]).toBeDefined());
}
