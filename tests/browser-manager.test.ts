import { EventEmitter } from "node:events";

import { describe, expect, it, vi, type Mock } from "vitest";

import {
  BrowserGameLoadError,
  BrowserLaunchAuthError,
  BrowserManager,
  BrowserWorkspaceDisplayOccupiedError,
  createRoleSessionPartition,
  normalizedRectToPixelBounds
} from "../src/main/browser/BrowserManager";
import { LOGIN_STORAGE_EXPRESSION } from "../src/main/auth/loginEvidence";
import { WORKSPACE_RESIZE_INDICATOR_CHANNEL } from "../src/shared/internalIpc";
import type {
  BrowserLaunchMode,
  LaunchWorkspace,
  PixelBounds,
  Role,
  WorkspaceAppearanceSettings,
  WorkspaceLayoutTemplate
} from "../src/shared/types";
import { getDefaultWorkspaceRects } from "../src/shared/workspaceLayout";

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

const workspace: LaunchWorkspace = {
  id: "workspace-1",
  browserLaunchMode: "inherit",
  name: "Party",
  template: "two_columns",
  browserZoomPercent: 90,
  slots: [
    { id: "slot-1", roleId: "role-1", rect: { x: 0, y: 0, width: 0.5, height: 1 } },
    { id: "slot-2", roleId: "role-2", rect: { x: 0.5, y: 0, width: 0.5, height: 1 } }
  ],
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

const persistedLayoutDividerCases: Array<[WorkspaceLayoutTemplate, PixelBounds[]]> = [
  ["single", []],
  ["two_columns", [{ x: 598, y: 0, width: 4, height: 800 }]],
  ["three_columns", [
    { x: 398, y: 0, width: 4, height: 800 },
    { x: 798, y: 0, width: 4, height: 800 }
  ]],
  ["main_left_stack_right", [
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 600, y: 398, width: 600, height: 4 }
  ]],
  ["main_right_stack_left", [
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 600, height: 4 }
  ]],
  ["main_center_side_stacks", [
    { x: 358, y: 0, width: 4, height: 800 },
    { x: 838, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 360, height: 4 },
    { x: 840, y: 398, width: 360, height: 4 }
  ]],
  ["three_top_two_bottom", [
    { x: 398, y: 0, width: 4, height: 400 },
    { x: 798, y: 0, width: 4, height: 400 },
    { x: 598, y: 400, width: 4, height: 400 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["two_top_three_bottom", [
    { x: 598, y: 0, width: 4, height: 400 },
    { x: 398, y: 400, width: 4, height: 400 },
    { x: 798, y: 400, width: 4, height: 400 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["quad", [
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["four_columns", [
    { x: 298, y: 0, width: 4, height: 800 },
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 898, y: 0, width: 4, height: 800 }
  ]],
  ["six_grid", [
    { x: 398, y: 0, width: 4, height: 800 },
    { x: 798, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]],
  ["eight_grid", [
    { x: 298, y: 0, width: 4, height: 800 },
    { x: 598, y: 0, width: 4, height: 800 },
    { x: 898, y: 0, width: 4, height: 800 },
    { x: 0, y: 398, width: 1200, height: 4 }
  ]]
];

describe("BrowserManager game host windows", () => {
  it("creates a persistent isolated partition for each role", () => {
    expect(createRoleSessionPartition("role:one/two")).toBe("persist:rion-role-role-one-two");
  });

  it("serializes role deletion after active work and rejects stale queued work", async () => {
    const harness = createHarness();
    const events: string[] = [];
    let releaseActiveOperation!: () => void;
    let markActiveOperationStarted!: () => void;
    const activeOperationStarted = new Promise<void>((resolve) => {
      markActiveOperationStarted = resolve;
    });
    const activeOperationGate = new Promise<void>((resolve) => {
      releaseActiveOperation = resolve;
    });

    const activeOperation = harness.manager.runRoleOperation([role.id], async () => {
      events.push("active:start");
      markActiveOperationStarted();
      await activeOperationGate;
      events.push("active:end");
    });
    await activeOperationStarted;

    const deletion = harness.manager.stopRoleAndRunMutation(role.id, async () => {
      events.push("delete");
    });
    const staleOperation = harness.manager.runRoleOperation([role.id], async () => {
      events.push("stale");
    });

    expect(events).toEqual(["active:start"]);
    releaseActiveOperation();

    await activeOperation;
    await deletion;
    await expect(staleOperation).rejects.toThrow("Role not found.");
    expect(events).toEqual(["active:start", "active:end", "delete"]);
  });

  it("opens a single role in a standard framed work-area window without an inner control offset", async () => {
    const harness = createHarness();
    const overlayInstaller = vi.fn().mockResolvedValue(undefined);
    harness.manager.setMacroOverlayInstaller(overlayInstaller);

    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 100,
        y: 50,
        width: 1200,
        height: 800,
        backgroundColor: "#000000",
        frame: true,
        show: false,
        title: role.name
      })
    );
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.not.objectContaining({ webPreferences: expect.anything() })
    );
    expect(harness.createView).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          backgroundThrottling: false,
          spellcheck: false,
          webgl: true
        })
      })
    );
    expect(harness.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
    expect(harness.hosts[0].show).toHaveBeenCalledTimes(1);
    expect(overlayInstaller).toHaveBeenCalledWith(role, harness.views[0].webContents);
  });

  it("wraps game page load failures with a stable user-facing error and cleans up the host", async () => {
    const harness = createHarness({
      loadUrlHandlers: [
        async () => {
          throw new Error("ERR_FAILED (-2) loading 'https://universe.flyff.com/play'");
        }
      ]
    });

    const launchPromise = harness.manager.launch(role);

    await expect(launchPromise).rejects.toThrow(BrowserGameLoadError);
    await expect(launchPromise).rejects.toThrow(
      "Unable to load the game page. If you use a game accelerator, enable global, TUN, or system proxy mode, or set a local proxy in Game settings."
    );
    expect(harness.manager.listStatuses()).toEqual([]);
    expect(harness.hosts[0].contentView.removeChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
  });

  it("falls back to external Chrome compatibility mode in auto mode when embedded game load fails", async () => {
    const externalChromeManager = createExternalChromeManager();
    const harness = createHarness({
      externalChromeManager,
      getBrowserLaunchMode: vi.fn().mockResolvedValue("auto"),
      loadUrlHandlers: [
        async () => {
          throw new Error("ERR_FAILED (-2) loading 'https://universe.flyff.com/play'");
        }
      ]
    });

    const status = await harness.manager.launch(role);

    expect(externalChromeManager.launch).toHaveBeenCalledWith(role, {
      notice:
        "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support."
    });
    expect(status).toMatchObject({ roleId: role.id, runtimeMode: "external", state: "running" });
    expect(harness.manager.listStatuses()).toEqual([expect.objectContaining({ runtimeMode: "external" })]);
  });

  it("keeps the selected work area when a workspace falls back to external Chrome", async () => {
    const externalChromeManager = createExternalChromeManager();
    const secondRole = createRole("role-2", "Alt");
    const target = {
      displayId: -22,
      workArea: { x: -984, y: -200, width: 984, height: 1280 }
    };
    const harness = createHarness({
      externalChromeManager,
      getBrowserLaunchMode: vi.fn().mockResolvedValue("auto"),
      getWorkspaceAppearanceSettings: () => ({ background: "black", gap: 16 }),
      loadUrlHandlers: [
        async () => {
          throw new Error("ERR_FAILED (-2) loading 'https://universe.flyff.com/play'");
        },
        async () => {
          throw new Error("ERR_FAILED (-2) loading 'https://universe.flyff.com/play'");
        }
      ]
    });

    const launchItems = [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ];
    await harness.manager.launchWorkspace(
      workspace,
      launchItems,
      target
    );

    expect(harness.createHostWindow).toHaveBeenCalledWith(expect.objectContaining(target.workArea));
    expect(externalChromeManager.launchWorkspace).toHaveBeenCalledWith(
      workspace,
      launchItems,
      expect.objectContaining({ workArea: target.workArea })
    );
    expect(harness.manager.listWorkspaceDisplayReservations()).toEqual([
      { workspaceId: workspace.id, workspaceName: workspace.name, displayId: -22 }
    ]);
  });

  it("does not fall back to external Chrome in embedded-only mode", async () => {
    const externalChromeManager = createExternalChromeManager();
    const harness = createHarness({
      externalChromeManager,
      getBrowserLaunchMode: vi.fn().mockResolvedValue("embedded"),
      loadUrlHandlers: [
        async () => {
          throw new Error("ERR_FAILED (-2) loading 'https://universe.flyff.com/play'");
        }
      ]
    });

    await expect(harness.manager.launch(role)).rejects.toThrow(BrowserGameLoadError);

    expect(externalChromeManager.launch).not.toHaveBeenCalled();
  });

  it("launches external Chrome directly in external mode without creating embedded views", async () => {
    const externalChromeManager = createExternalChromeManager();
    const getBrowserLaunchMode = vi.fn().mockResolvedValue("external");
    const harness = createHarness({
      externalChromeManager,
      getBrowserLaunchMode
    });

    const status = await harness.manager.launch(role);

    expect(getBrowserLaunchMode).toHaveBeenCalledWith(role);
    expect(harness.createHostWindow).not.toHaveBeenCalled();
    expect(harness.createView).not.toHaveBeenCalled();
    expect(externalChromeManager.launch).toHaveBeenCalledWith(role, { notice: undefined });
    expect(status).toMatchObject({ roleId: role.id, runtimeMode: "external" });
  });

  it("ignores the embedded workspace gap in explicit external mode on every platform", async () => {
    const externalChromeManager = createExternalChromeManager();
    const getBrowserLaunchMode = vi.fn().mockResolvedValue("embedded");
    const getWorkspaceAppearanceSettings = vi.fn(() => ({ background: "black" as const, gap: 16 as const }));
    const secondRole = createRole("role-2", "Alt");
    const harness = createHarness({
      externalChromeManager,
      getBrowserLaunchMode,
      getWorkspaceAppearanceSettings
    });
    const launchItems = [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ];

    await harness.manager.launchWorkspace(
      workspace,
      launchItems,
      undefined,
      "external"
    );

    expect(getBrowserLaunchMode).not.toHaveBeenCalled();
    expect(getWorkspaceAppearanceSettings).not.toHaveBeenCalled();
    expect(externalChromeManager.launchWorkspace).toHaveBeenCalledWith(
      workspace,
      launchItems,
      expect.objectContaining({ notice: undefined })
    );
  });

  it("applies browser font preferences before creating a new role view", async () => {
    const applyBrowserFonts = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserFonts });

    await harness.manager.launch(role);

    expect(applyBrowserFonts).toHaveBeenCalledWith(role, createRoleSessionPartition(role.id));
    expect(applyBrowserFonts.mock.invocationCallOrder[0]).toBeLessThan(
      harness.createView.mock.invocationCallOrder[0]
    );
  });

  it("applies browser proxy settings before loading the game page", async () => {
    const applyBrowserProxy = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserProxy });

    await harness.manager.launch(role);

    expect(applyBrowserProxy).toHaveBeenCalledWith(
      role,
      createRoleSessionPartition(role.id),
      harness.views[0].webContents.session
    );
    expect(applyBrowserProxy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]
    );
  });

  it("applies CDN compatibility after the proxy and before loading the game page", async () => {
    const applyBrowserProxy = vi.fn().mockResolvedValue(undefined);
    const applyCdnCompatibility = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserProxy, applyCdnCompatibility });

    await harness.manager.launch(role);

    expect(applyBrowserProxy).toHaveBeenCalledTimes(1);
    expect(applyCdnCompatibility).toHaveBeenCalledTimes(1);
    expect(applyBrowserProxy.mock.invocationCallOrder[0]).toBeLessThan(
      applyCdnCompatibility.mock.invocationCallOrder[0]
    );
    expect(applyCdnCompatibility.mock.invocationCallOrder[0]).toBeLessThan(
      harness.views[0].webContents.loadURL.mock.invocationCallOrder[0]
    );
  });

  it("fails open when CDN compatibility setup fails", async () => {
    const applyCdnCompatibility = vi.fn().mockRejectedValue(new Error("Mirror setup failed."));
    const harness = createHarness({ applyCdnCompatibility });

    await expect(harness.manager.launch(role)).resolves.toMatchObject({ state: "running" });
    expect(harness.views[0].webContents.loadURL).toHaveBeenCalledWith(role.launchUrl);
  });

  it("cleans up the host when browser proxy setup fails", async () => {
    const applyBrowserProxy = vi.fn().mockRejectedValue(new Error("Proxy setup failed."));
    const harness = createHarness({ applyBrowserProxy });

    await expect(harness.manager.launch(role)).rejects.toThrow("Proxy setup failed.");

    expect(harness.manager.listStatuses()).toEqual([]);
    expect(harness.views[0].webContents.loadURL).not.toHaveBeenCalled();
    expect(harness.hosts[0].contentView.removeChildView).toHaveBeenCalledWith(harness.views[0].view);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
  });

  it("focuses an existing single-role host instead of opening another window", async () => {
    const applyBrowserFonts = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserFonts });

    await harness.manager.launch(role);
    applyBrowserFonts.mockClear();
    harness.views[0].webContents.loadURL.mockClear();
    await harness.manager.launch(role);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.createView).toHaveBeenCalledTimes(1);
    expect(applyBrowserFonts).not.toHaveBeenCalled();
    expect(harness.views[0].webContents.loadURL).not.toHaveBeenCalled();
    expect(harness.hosts[0].focus).toHaveBeenCalledTimes(2);
  });

  it("leaves a four-pixel material gap between workspace roles on macOS", async () => {
    const applyBrowserFonts = vi.fn().mockResolvedValue(undefined);
    const harness = createHarness({ applyBrowserFonts, platform: "darwin" });
    const secondRole = createRole("role-2", "Alt");

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: "#000000",
        closable: true,
        maximizable: true,
        minimizable: true,
        resizable: true,
        title: "Party - Main, Alt",
        titleBarStyle: "default",
        vibrancy: "under-window",
        visualEffectState: "followWindow"
      })
    );
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.not.objectContaining({ transparent: true })
    );
    expect(harness.hosts[0].contentView.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 800 });
    expect(harness.views[0].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(harness.views[1].webContents.setZoomFactor).toHaveBeenCalledWith(0.9);
    expect(applyBrowserFonts).toHaveBeenCalledWith(role, createRoleSessionPartition(role.id));
    expect(applyBrowserFonts).toHaveBeenCalledWith(secondRole, createRoleSessionPartition(secondRole.id));
    expect(applyBrowserFonts.mock.invocationCallOrder[0]).toBeLessThan(
      harness.createView.mock.invocationCallOrder[0]
    );
  });

  it("uses an acrylic workspace material on Windows", async () => {
    const harness = createHarness({ platform: "win32" });

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: "#202024",
        backgroundMaterial: "acrylic"
      })
    );
    expect(harness.createHostWindow).toHaveBeenCalledWith(
      expect.not.objectContaining({ transparent: true })
    );
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 800 });
  });

  it("launches workspace roles in batches of two", async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const loadUrlHandlers = Array.from({ length: 4 }, (_, index) => async () => {
      started.push(index);
      await new Promise<void>((resolve) => {
        releases[index] = resolve;
      });
    });
    const harness = createHarness({ loadUrlHandlers });
    const rects = getDefaultWorkspaceRects("quad");
    const roles = Array.from({ length: 4 }, (_, index) => createRole(`role-${index + 1}`, `Role ${index + 1}`));
    const launch = harness.manager.launchWorkspace(
      workspace,
      roles.map((item, index) => ({ role: item, rect: rects[index] }))
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releases[0]();
    releases[1]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases[2]();
    releases[3]();

    await expect(launch).resolves.toHaveLength(4);
  });

  it("falls back a workspace to external Chrome compatibility mode after embedded game load failure", async () => {
    const externalChromeManager = createExternalChromeManager();
    const secondRole = createRole("role-2", "Alt");
    const harness = createHarness({
      externalChromeManager,
      getBrowserLaunchMode: vi.fn().mockResolvedValue("auto"),
      loadUrlHandlers: [
        async () => undefined,
        async () => {
          throw new Error("ERR_FAILED (-2) loading 'https://universe.flyff.com/play'");
        }
      ]
    });
    const target = {
      displayId: 22,
      workArea: { x: 1200, y: 24, width: 1920, height: 1040 }
    };

    const statuses = await harness.manager.launchWorkspace(
      workspace,
      [
        { role, rect: workspace.slots[0].rect },
        { role: secondRole, rect: workspace.slots[1].rect }
      ],
      target
    );

    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
    expect(externalChromeManager.launchWorkspace).toHaveBeenCalledWith(
      workspace,
      [
        { role, rect: workspace.slots[0].rect },
        { role: secondRole, rect: workspace.slots[1].rect }
      ],
      {
        notice:
          "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.",
        workArea: target.workArea
      }
    );
    expect(statuses).toEqual([expect.objectContaining({ runtimeMode: "external" })]);
    expect(harness.manager.listWorkspaceDisplayReservations()).toEqual([
      { workspaceId: workspace.id, workspaceName: workspace.name, displayId: target.displayId }
    ]);
  });

  it.each(["darwin", "win32"] as const)(
    "does not fall back to external Chrome when a %s workspace is closed during launch",
    async (platform) => {
      let rejectLoad!: (error: Error) => void;
      const externalChromeManager = createExternalChromeManager();
      externalChromeManager.hasWorkspace.mockReturnValue(false);
      externalChromeManager.listStatuses.mockReturnValue([]);
      const harness = createHarness({
        externalChromeManager,
        getBrowserLaunchMode: vi.fn().mockResolvedValue("auto"),
        loadUrlHandlers: [
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectLoad = reject;
            })
        ],
        platform
      });
      const launchPromise = harness.manager.launchWorkspace(workspace, [
        { role, rect: { x: 0, y: 0, width: 1, height: 1 } }
      ]);

      await vi.waitFor(() => expect(rejectLoad).toBeTypeOf("function"));
      const closeEvent = { preventDefault: vi.fn() };
      harness.hosts[0].emit("close", closeEvent);
      rejectLoad(new Error("ERR_FAILED (-2) because the view was closed"));

      await expect(launchPromise).resolves.toEqual([]);
      await vi.waitFor(() => expect(harness.manager.listStatuses()).toEqual([]));
      expect(closeEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(externalChromeManager.launchWorkspace).not.toHaveBeenCalled();
    }
  );

  it("draws a four-pixel glass divider that is entirely draggable", async () => {
    const harness = createHarness();

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.createView).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          backgroundThrottling: true,
          preload: "/app/out/preload/divider.cjs"
        })
      })
    );
    expect(harness.views[2].setBounds).toHaveBeenCalledWith({ x: 598, y: 0, width: 4, height: 800 });
    expect(harness.views[2].view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(harness.views[2].view.setBackgroundBlur).not.toHaveBeenCalled();
    const dividerUrl = vi.mocked(harness.views[2].webContents.loadURL).mock.calls[0][0];
    const dividerHtml = decodeURIComponent(dividerUrl.split(",", 2)[1]);
    expect(dividerHtml).toContain("html,body");
    expect(dividerHtml).toContain("background:transparent");
    expect(dividerHtml).not.toContain("class=\"line\"");
    expect(dividerHtml).toContain("cursor:col-resize");
    expect(dividerHtml).not.toContain("body.dragging");
    expect(dividerHtml).toContain("setDragging(true)");
    expect(dividerHtml).toContain('addEventListener("dblclick"');
    expect(dividerHtml).toContain('phase:"reset"');
  });

  it("keeps the divider transparent when reduced transparency is preferred", async () => {
    const harness = createHarness({ prefersReducedTransparency: () => true });

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.views[2].view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(harness.views[2].view.setBackgroundBlur).not.toHaveBeenCalled();
  });

  it("uses a one-pixel gap with a solid black workspace background", async () => {
    const harness = createHarness({
      getWorkspaceAppearanceSettings: () => ({ background: "black", gap: 1 })
    });

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 600, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 601, y: 0, width: 599, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 600, y: 0, width: 1, height: 800 });
    expect(harness.views[2].view.setBackgroundColor).toHaveBeenLastCalledWith("#FF000000");
  });

  it("immediately updates the gap and background of open workspaces", async () => {
    const harness = createHarness();

    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.setWorkspaceAppearanceSettings({ background: "black", gap: 16 });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 592, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 608, y: 0, width: 592, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 592, y: 0, width: 16, height: 800 });
    expect(harness.views[2].view.setBackgroundColor).toHaveBeenLastCalledWith("#FF000000");
  });

  it("resizes adjacent roles when the divider is dragged and enforces minimum cell size", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 720
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 718, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 722, y: 0, width: 478, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 718, y: 0, width: 4, height: 800 });

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 0
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 142, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 146, y: 0, width: 1054, height: 800 });
  });

  it("shows snapped resize ratios during an active divider drag and hides them on end", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);
    const divider = harness.views[2];

    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "start",
      screenPosition: 600
    });
    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "show", label: "50% × 100%" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "show", label: "50% × 100%" }
    );

    const firstRoleLayoutCalls = harness.views[0].setBounds.mock.calls.length;
    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "move",
      screenPosition: 622
    });
    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(firstRoleLayoutCalls);
    expect(harness.views[0].webContents.send).toHaveBeenCalledTimes(1);

    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "move",
      screenPosition: 636
    });
    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 658, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 662, y: 0, width: 538, height: 800 });
    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "update", label: "55% × 100%" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "update", label: "45% × 100%" }
    );

    harness.manager.handleDividerPointer(divider.webContents.id, {
      phase: "end",
      screenPosition: 636
    });
    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
  });

  it("clears active resize indicators when the workspace closes mid-drag", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "start",
      screenPosition: 600
    });
    await harness.manager.stopWorkspace(workspace.id);

    expect(harness.views[0].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
    expect(harness.views[1].webContents.send).toHaveBeenLastCalledWith(
      WORKSPACE_RESIZE_INDICATOR_CHANNEL,
      { type: "hide" }
    );
  });

  it("resets a game divider to its launch position when double-clicked", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
    ]);

    harness.manager.handleDividerPointer(harness.views[2].webContents.id, {
      phase: "move",
      screenPosition: 720
    });
    harness.manager.handleDividerPointer(harness.views[2].webContents.id, { phase: "reset" });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 800 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 598, y: 0, width: 4, height: 800 });
  });

  it("creates crossing resize dividers for a quad workspace", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("quad");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    expect(harness.views).toHaveLength(6);
    expect(harness.views.slice(4).map((view) => vi.mocked(view.setBounds).mock.calls[0][0])).toEqual(
      expect.arrayContaining([
        { x: 598, y: 0, width: 4, height: 800 },
        { x: 0, y: 398, width: 1200, height: 4 }
      ])
    );
  });

  it("creates linked column and row dividers for a six-grid workspace", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("six_grid");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    expect(harness.views).toHaveLength(9);
    expect(harness.views.slice(6).map((view) => vi.mocked(view.setBounds).mock.calls[0][0])).toEqual(
      expect.arrayContaining([
        { x: 398, y: 0, width: 4, height: 800 },
        { x: 798, y: 0, width: 4, height: 800 },
        { x: 0, y: 398, width: 1200, height: 4 }
      ])
    );

    harness.manager.handleDividerPointer(harness.views[6].webContents.id, {
      phase: "start",
      screenPosition: 400
    });
    expect(harness.views.slice(0, 6).map((view) => view.webContents.send.mock.calls.length)).toEqual([
      1,
      1,
      0,
      1,
      1,
      0
    ]);
  });

  it.each(persistedLayoutDividerCases)(
    "creates the complete, non-overlapping divider geometry for persisted %s layouts",
    async (template, expectedDividerBounds) => {
      const harness = createHarness();
      const rects = toLegacyStoredRects(template);

      await harness.manager.launchWorkspace(
        workspace,
        rects.map((rect, index) => ({
          role: createRole(`persisted-${template}-${index + 1}`, `Role ${index + 1}`),
          rect
        }))
      );

      const dividerBounds = harness.views
        .slice(rects.length)
        .map((view) => view.view.getBounds());
      expect(dividerBounds).toHaveLength(expectedDividerBounds.length);
      expect(dividerBounds).toEqual(expect.arrayContaining(expectedDividerBounds));
    }
  );

  it.each([
    ["darwin", 1001, 701],
    ["win32", 5121, 1441]
  ] as const)(
    "keeps persisted six-grid gaps pixel-perfect on %s at %sx%s",
    async (platform, width, height) => {
      const harness = createHarness({ platform });
      const rects = toLegacyStoredRects("six_grid");
      await harness.manager.launchWorkspace(
        workspace,
        rects.map((rect, index) => ({
          role: createRole(`sized-${platform}-${index + 1}`, `Role ${index + 1}`),
          rect
        }))
      );

      harness.hosts[0].contentBounds = { x: 0, y: 0, width, height };
      harness.hosts[0].emit("resize");

      const firstColumnEnd = Math.round(0.3333 * width);
      const secondColumnEnd = Math.round(0.6667 * width);
      const firstRowEnd = Math.round(0.5 * height);
      const columnBounds = [
        { x: 0, width: firstColumnEnd - 2 },
        { x: firstColumnEnd + 2, width: secondColumnEnd - firstColumnEnd - 4 },
        { x: secondColumnEnd + 2, width: width - secondColumnEnd - 2 }
      ];
      const expectedSessionBounds = [0, 1].flatMap((rowIndex) =>
        columnBounds.map((column) => ({
          ...column,
          y: rowIndex === 0 ? 0 : firstRowEnd + 2,
          height: rowIndex === 0 ? firstRowEnd - 2 : height - firstRowEnd - 2
        }))
      );
      expect(harness.views.slice(0, 6).map((view) => view.view.getBounds())).toEqual(expectedSessionBounds);
      expect(harness.views.slice(6).map((view) => view.view.getBounds())).toEqual(expect.arrayContaining([
        { x: firstColumnEnd - 2, y: 0, width: 4, height },
        { x: secondColumnEnd - 2, y: 0, width: 4, height },
        { x: 0, y: firstRowEnd - 2, width, height: 4 }
      ]));
    }
  );

  it.each(["three_top_two_bottom", "two_top_three_bottom"] as const)(
    "keeps every persisted %s divider draggable and scoped to its row",
    async (template) => {
      const harness = createHarness();
      const rects = toLegacyStoredRects(template);
      await harness.manager.launchWorkspace(
        workspace,
        rects.map((rect, index) => ({
          role: createRole(`mixed-${template}-${index + 1}`, `Role ${index + 1}`),
          rect
        }))
      );

      const dividers = harness.views.slice(rects.length);
      const targetVerticalBounds = template === "three_top_two_bottom"
        ? { x: 798, y: 0, width: 4, height: 400 }
        : { x: 798, y: 400, width: 4, height: 400 };
      const verticalDivider = dividers.find((view) =>
        equalPixelBounds(view.view.getBounds(), targetVerticalBounds)
      );
      const horizontalDivider = dividers.find((view) =>
        equalPixelBounds(view.view.getBounds(), { x: 0, y: 398, width: 1200, height: 4 })
      );
      expect(verticalDivider).toBeDefined();
      expect(horizontalDivider).toBeDefined();
      if (!verticalDivider || !horizontalDivider) {
        throw new Error("Expected mixed-layout dividers to exist.");
      }

      harness.manager.handleDividerPointer(verticalDivider.webContents.id, {
        phase: "start",
        screenPosition: 800
      });
      const verticalRoleIndexes = template === "three_top_two_bottom" ? [1, 2] : [3, 4];
      expect(harness.views.slice(0, 5).map((view) => view.webContents.send.mock.calls.length)).toEqual(
        [0, 1, 2, 3, 4].map((index) => verticalRoleIndexes.includes(index) ? 1 : 0)
      );
      harness.manager.handleDividerPointer(verticalDivider.webContents.id, {
        phase: "move",
        screenPosition: 900
      });
      harness.manager.handleDividerPointer(verticalDivider.webContents.id, { phase: "end" });

      const afterVerticalBounds = template === "three_top_two_bottom"
        ? [
            { x: 0, y: 0, width: 398, height: 398 },
            { x: 402, y: 0, width: 496, height: 398 },
            { x: 902, y: 0, width: 298, height: 398 },
            { x: 0, y: 402, width: 598, height: 398 },
            { x: 602, y: 402, width: 598, height: 398 }
          ]
        : [
            { x: 0, y: 0, width: 598, height: 398 },
            { x: 602, y: 0, width: 598, height: 398 },
            { x: 0, y: 402, width: 398, height: 398 },
            { x: 402, y: 402, width: 496, height: 398 },
            { x: 902, y: 402, width: 298, height: 398 }
          ];
      expect(harness.views.slice(0, 5).map((view) => view.view.getBounds())).toEqual(afterVerticalBounds);

      harness.manager.handleDividerPointer(horizontalDivider.webContents.id, {
        phase: "start",
        screenPosition: 400
      });
      harness.views.slice(0, 5).forEach((view) => {
        expect(view.webContents.send).toHaveBeenLastCalledWith(
          WORKSPACE_RESIZE_INDICATOR_CHANNEL,
          expect.objectContaining({ type: "show" })
        );
      });
      harness.manager.handleDividerPointer(horizontalDivider.webContents.id, {
        phase: "move",
        screenPosition: 480
      });
      harness.manager.handleDividerPointer(horizontalDivider.webContents.id, { phase: "end" });

      const topRoleCount = template === "three_top_two_bottom" ? 3 : 2;
      expect(harness.views.slice(0, 5).map((view) => view.view.getBounds())).toEqual(
        afterVerticalBounds.map((bounds, index) => ({
          ...bounds,
          y: index < topRoleCount ? 0 : 482,
          height: index < topRoleCount ? 478 : 318
        }))
      );
      expect(horizontalDivider.view.getBounds()).toEqual({ x: 0, y: 478, width: 1200, height: 4 });
      expect(verticalDivider.view.getBounds()).toEqual(
        template === "three_top_two_bottom"
          ? { x: 898, y: 0, width: 4, height: 480 }
          : { x: 898, y: 480, width: 4, height: 320 }
      );
    }
  );

  it("resets a snapped three-column divider to its exact one-third launch position", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("three_columns");
    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    harness.manager.handleDividerPointer(harness.views[3].webContents.id, {
      phase: "move",
      screenPosition: 540
    });
    harness.manager.handleDividerPointer(harness.views[3].webContents.id, { phase: "reset" });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 398, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 402, y: 0, width: 396, height: 800 });
  });

  it("keeps centered-main row dividers out of the main pane while resizing both side stacks", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("main_center_side_stacks");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    expect(harness.views).toHaveLength(9);
    const dividerViews = harness.views.slice(5);
    const horizontalDividers = dividerViews.filter((view) => {
      const bounds = vi.mocked(view.setBounds).mock.calls[0][0];
      return bounds.height === 4;
    });
    expect(horizontalDividers.map((view) => vi.mocked(view.setBounds).mock.calls[0][0])).toEqual([
      { x: 0, y: 398, width: 360, height: 4 },
      { x: 840, y: 398, width: 360, height: 4 }
    ]);

    harness.manager.handleDividerPointer(horizontalDividers[0].webContents.id, {
      phase: "move",
      screenPosition: 480
    });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 362, y: 0, width: 476, height: 800 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 358, height: 478 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 482, width: 358, height: 318 });
    expect(harness.views[3].setBounds).toHaveBeenLastCalledWith({ x: 842, y: 0, width: 358, height: 478 });
    expect(harness.views[4].setBounds).toHaveBeenLastCalledWith({ x: 842, y: 482, width: 358, height: 318 });
    expect(horizontalDividers[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 478, width: 360, height: 4 });
    expect(horizontalDividers[1].setBounds).toHaveBeenLastCalledWith({ x: 840, y: 478, width: 360, height: 4 });
  });

  it("resets only the double-clicked divider in a multi-divider game workspace", async () => {
    const harness = createHarness();
    const rects = getDefaultWorkspaceRects("quad");

    await harness.manager.launchWorkspace(
      workspace,
      rects.map((rect, index) => ({ role: createRole(`role-${index + 1}`, `Role ${index + 1}`), rect }))
    );

    const verticalDivider = harness.views[4];
    const horizontalDivider = harness.views[5];
    harness.manager.handleDividerPointer(verticalDivider.webContents.id, {
      phase: "move",
      screenPosition: 720
    });
    harness.manager.handleDividerPointer(horizontalDivider.webContents.id, {
      phase: "move",
      screenPosition: 480
    });
    harness.manager.handleDividerPointer(verticalDivider.webContents.id, { phase: "reset" });

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 598, height: 478 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 0, width: 598, height: 478 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 482, width: 598, height: 318 });
    expect(harness.views[3].setBounds).toHaveBeenLastCalledWith({ x: 602, y: 482, width: 598, height: 318 });
    expect(verticalDivider.setBounds).toHaveBeenLastCalledWith({ x: 598, y: 0, width: 4, height: 800 });
    expect(horizontalDivider.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 478, width: 1200, height: 4 });
  });

  it("recalculates every role and popup when the host content size changes", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1000, height: 700 };
    harness.hosts[0].emit("resize");

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 498, height: 700 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 502, y: 0, width: 498, height: 700 });
    expect(popup.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 498, height: 700 });
  });

  it("does not resize game views while the host window is minimized", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    const firstRoleCalls = harness.views[0].setBounds.mock.calls.length;
    const secondRoleCalls = harness.views[1].setBounds.mock.calls.length;
    const dividerCalls = harness.views[2].setBounds.mock.calls.length;
    const popupCalls = popup.setBounds.mock.calls.length;

    harness.hosts[0].minimized = true;
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1, height: 1 };
    harness.hosts[0].emit("resize");

    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(firstRoleCalls);
    expect(harness.views[1].setBounds).toHaveBeenCalledTimes(secondRoleCalls);
    expect(harness.views[2].setBounds).toHaveBeenCalledTimes(dividerCalls);
    expect(popup.setBounds).toHaveBeenCalledTimes(popupCalls);
  });

  it("recalculates game views after a minimized host is restored", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const popup = createOAuthPopup(harness.views[0], harness.views);
    harness.hosts[0].minimized = true;
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1, height: 1 };
    harness.hosts[0].emit("resize");

    harness.hosts[0].minimized = false;
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 900, height: 600 };
    harness.hosts[0].emit("restore");

    expect(harness.views[0].setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 448, height: 600 });
    expect(harness.views[1].setBounds).toHaveBeenLastCalledWith({ x: 452, y: 0, width: 448, height: 600 });
    expect(harness.views[2].setBounds).toHaveBeenLastCalledWith({ x: 448, y: 0, width: 4, height: 600 });
    expect(popup.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 448, height: 600 });
  });

  it("does not resize game views when host content bounds collapse", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    const firstRoleCalls = harness.views[0].setBounds.mock.calls.length;
    const secondRoleCalls = harness.views[1].setBounds.mock.calls.length;
    const dividerCalls = harness.views[2].setBounds.mock.calls.length;

    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 0, height: 0 };
    harness.hosts[0].emit("resize");
    harness.hosts[0].contentBounds = { x: 0, y: 0, width: 1, height: 800 };
    harness.hosts[0].emit("resize");

    expect(harness.views[0].setBounds).toHaveBeenCalledTimes(firstRoleCalls);
    expect(harness.views[1].setBounds).toHaveBeenCalledTimes(secondRoleCalls);
    expect(harness.views[2].setBounds).toHaveBeenCalledTimes(dividerCalls);
  });

  it("allows non-overlapping workspaces to run in separate windows", async () => {
    const harness = createHarness();
    await harness.manager.launchWorkspace(workspace, [{ role, rect: workspace.slots[0].rect }]);
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Second" };
    const secondRole = createRole("role-3", "Third");

    await harness.manager.launchWorkspace(secondWorkspace, [
      { role: secondRole, rect: { x: 0, y: 0, width: 1, height: 1 } }
    ]);

    expect(harness.createHostWindow).toHaveBeenCalledTimes(2);
    expect(harness.manager.listStatuses()).toHaveLength(2);
  });

  it("atomically reserves a target display before async launch work and releases it on stop", async () => {
    let resolveLaunchMode: ((mode: BrowserLaunchMode) => void) | undefined;
    const launchMode = new Promise<BrowserLaunchMode>((resolve) => {
      resolveLaunchMode = resolve;
    });
    const harness = createHarness({ getBrowserLaunchMode: () => launchMode });
    const target = {
      displayId: 22,
      workArea: { x: 1200, y: 24, width: 1920, height: 1040 }
    };
    const firstLaunch = harness.manager.launchWorkspace(
      workspace,
      [{ role, rect: { x: 0, y: 0, width: 1, height: 1 } }],
      target
    );

    expect(harness.manager.listWorkspaceDisplayReservations()).toEqual([
      { workspaceId: workspace.id, workspaceName: workspace.name, displayId: 22 }
    ]);
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Second" };
    await expect(
      harness.manager.launchWorkspace(
        secondWorkspace,
        [{ role: createRole("role-3", "Third"), rect: { x: 0, y: 0, width: 1, height: 1 } }],
        target
      )
    ).rejects.toBeInstanceOf(BrowserWorkspaceDisplayOccupiedError);
    expect(harness.createHostWindow).not.toHaveBeenCalled();

    resolveLaunchMode?.("embedded");
    await firstLaunch;
    expect(harness.createHostWindow).toHaveBeenCalledWith(expect.objectContaining(target.workArea));

    await harness.manager.stopWorkspace(workspace.id);
    expect(harness.manager.listWorkspaceDisplayReservations()).toEqual([]);
  });

  it("releases a target display when workspace launch fails", async () => {
    const harness = createHarness({
      snapshotsByView: [{ bodyText: "Log in with Google", localStorage: {} }]
    });

    await expect(
      harness.manager.launchWorkspace(
        workspace,
        [{ role, rect: { x: 0, y: 0, width: 1, height: 1 } }],
        { displayId: 11, workArea: { x: 0, y: 24, width: 1200, height: 776 } }
      )
    ).rejects.toBeInstanceOf(BrowserLaunchAuthError);
    expect(harness.manager.listWorkspaceDisplayReservations()).toEqual([]);
  });

  it("releases an external workspace display when its last Chrome session exits", async () => {
    const changes = new EventEmitter();
    let workspaceActive = false;
    const status = { roleId: role.id, runtimeMode: "external" as const, state: "running" as const };
    const externalChromeManager = {
      getAutomationSession: vi.fn(() => undefined),
      hasSession: vi.fn(() => false),
      hasWorkspace: vi.fn(() => workspaceActive),
      launch: vi.fn().mockResolvedValue(status),
      launchWorkspace: vi.fn(async () => {
        workspaceActive = true;
        changes.emit("change", [status]);
        return [status];
      }),
      listStatuses: vi.fn(() => (workspaceActive ? [status] : [])),
      on: changes.on.bind(changes),
      setBeforeRoleStop: vi.fn(),
      setMacroOverlayInstaller: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      stopWorkspace: vi.fn().mockResolvedValue(undefined)
    };
    const harness = createHarness({
      externalChromeManager: externalChromeManager as never,
      getBrowserLaunchMode: () => "external"
    });

    await harness.manager.launchWorkspace(
      workspace,
      [{ role, rect: { x: 0, y: 0, width: 1, height: 1 } }],
      { displayId: 22, workArea: { x: 1200, y: 0, width: 1920, height: 1040 } }
    );
    expect(harness.manager.listWorkspaceDisplayReservations()).toHaveLength(1);

    workspaceActive = false;
    changes.emit("change", []);
    expect(harness.manager.listWorkspaceDisplayReservations()).toEqual([]);
  });

  it("blocks an entire workspace before creating a window when a role is already running", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);

    await expect(
      harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
      ])
    ).rejects.toMatchObject({
      code: "ROLE_ALREADY_RUNNING",
      roleNames: ["Main"]
    });
    expect(harness.createHostWindow).toHaveBeenCalledTimes(1);
  });

  it("rolls back the complete workspace when a later role fails auth verification", async () => {
    const harness = createHarness({
      snapshotsByView: [
        { bodyText: "Welcome", localStorage: { authToken: "token-1" } },
        { bodyText: "Log in with Google", localStorage: {} }
      ]
    });

    await expect(
      harness.manager.launchWorkspace(workspace, [
        { role, rect: workspace.slots[0].rect },
        { role: createRole("role-2", "Alt"), rect: workspace.slots[1].rect }
      ])
    ).rejects.toBeInstanceOf(BrowserLaunchAuthError);

    expect(harness.beforeRolesStop).toHaveBeenCalledWith(["role-1", "role-2"]);
    expect(harness.views[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.views[1].webContents.close).toHaveBeenCalledTimes(1);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
  });

  it("stops the actual launched host by workspace id", async () => {
    const harness = createHarness();
    const secondRole = createRole("role-2", "Alt");
    await harness.manager.launchWorkspace(workspace, [
      { role, rect: workspace.slots[0].rect },
      { role: secondRole, rect: workspace.slots[1].rect }
    ]);

    await harness.manager.stopWorkspace(workspace.id);

    expect(harness.beforeRolesStop).toHaveBeenCalledWith(["role-1", "role-2"]);
    expect(harness.hosts[0].close).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toEqual([]);
  });

  it("treats closing the framed host as stopping every contained role", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);
    const event = { preventDefault: vi.fn() };

    harness.hosts[0].emit("close", event);

    await vi.waitFor(() => expect(harness.manager.listStatuses()).toEqual([]));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.beforeRolesStop).toHaveBeenCalledWith([role.id]);
  });

  it("closes the containing host for Cmd/Ctrl+W from a game view", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);
    const event = { preventDefault: vi.fn() };

    harness.views[0].webContents.emit("before-input-event", event, {
      control: true,
      key: "w",
      meta: false,
      type: "keyDown"
    });

    await vi.waitFor(() => expect(harness.hosts[0].close).toHaveBeenCalledTimes(1));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("hosts OAuth popups over the matching role cell", async () => {
    const harness = createHarness();
    await harness.manager.launch(role);

    const popup = createOAuthPopup(harness.views[0], harness.views);

    expect(popup.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
    expect(harness.createView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          backgroundThrottling: false,
          spellcheck: false,
          webgl: true
        })
      })
    );
    expect(harness.hosts[0].contentView.addChildView).toHaveBeenLastCalledWith(popup.view);
  });

  it("keeps a login host open until authentication evidence appears", async () => {
    const harness = createHarness({
      snapshotsByView: [{ bodyText: "Welcome", localStorage: { authToken: "token-1" } }]
    });

    await harness.manager.startLogin({ ...role, authState: "login_required" });
    await expect(harness.manager.waitForAuthentication(role.id)).resolves.toMatchObject({
      authState: "authenticated"
    });
    expect(harness.hosts[0].show).toHaveBeenCalledTimes(1);
    expect(harness.manager.listStatuses()).toMatchObject([{ roleId: role.id, state: "running" }]);
  });

  it("opens the game login URL but verifies persisted cookies against the role launch URL", async () => {
    const loginUrl = "https://accounts.example.com/login";
    const getLoginUrl = vi.fn().mockResolvedValue(loginUrl);
    const harness = createHarness({ getLoginUrl });

    await harness.manager.startLogin({ ...role, authState: "login_required" });
    await harness.views[0].webContents.loadURL(role.launchUrl);
    await expect(harness.manager.waitForAuthentication(role.id)).resolves.toMatchObject({
      authState: "authenticated"
    });

    expect(getLoginUrl).toHaveBeenCalledWith(expect.objectContaining({ id: role.id }));
    expect(harness.views[0].webContents.loadURL).toHaveBeenNthCalledWith(1, loginUrl);
    expect(harness.views[0].webContents.session.cookies.get).toHaveBeenCalledWith({
      url: role.launchUrl
    });
  });
});

describe("normalizedRectToPixelBounds", () => {
  it("uses shared rounded edges so adjacent views have no gap", () => {
    expect(normalizedRectToPixelBounds({ x: 0, y: 0, width: 1 / 3, height: 1 }, { x: 0, y: 0, width: 1000, height: 700 }))
      .toEqual({ x: 0, y: 0, width: 333, height: 700 });
    expect(normalizedRectToPixelBounds({ x: 1 / 3, y: 0, width: 2 / 3, height: 1 }, { x: 0, y: 0, width: 1000, height: 700 }))
      .toEqual({ x: 333, y: 0, width: 667, height: 700 });
  });

  it.each([
    ["three_columns", [
      { x: 0, y: 0, width: 400, height: 800 },
      { x: 400, y: 0, width: 400, height: 800 },
      { x: 800, y: 0, width: 400, height: 800 }
    ]],
    ["main_left_stack_right", [
      { x: 0, y: 0, width: 600, height: 800 },
      { x: 600, y: 0, width: 600, height: 400 },
      { x: 600, y: 400, width: 600, height: 400 }
    ]],
    ["main_right_stack_left", [
      { x: 600, y: 0, width: 600, height: 800 },
      { x: 0, y: 0, width: 600, height: 400 },
      { x: 0, y: 400, width: 600, height: 400 }
    ]],
    ["quad", [
      { x: 0, y: 0, width: 600, height: 400 },
      { x: 600, y: 0, width: 600, height: 400 },
      { x: 0, y: 400, width: 600, height: 400 },
      { x: 600, y: 400, width: 600, height: 400 }
    ]],
    ["four_columns", [
      { x: 0, y: 0, width: 300, height: 800 },
      { x: 300, y: 0, width: 300, height: 800 },
      { x: 600, y: 0, width: 300, height: 800 },
      { x: 900, y: 0, width: 300, height: 800 }
    ]],
    ["three_top_two_bottom", [
      { x: 0, y: 0, width: 400, height: 400 },
      { x: 400, y: 0, width: 400, height: 400 },
      { x: 800, y: 0, width: 400, height: 400 },
      { x: 0, y: 400, width: 600, height: 400 },
      { x: 600, y: 400, width: 600, height: 400 }
    ]],
    ["two_top_three_bottom", [
      { x: 0, y: 0, width: 600, height: 400 },
      { x: 600, y: 0, width: 600, height: 400 },
      { x: 0, y: 400, width: 400, height: 400 },
      { x: 400, y: 400, width: 400, height: 400 },
      { x: 800, y: 400, width: 400, height: 400 }
    ]],
    ["six_grid", [
      { x: 0, y: 0, width: 400, height: 400 },
      { x: 400, y: 0, width: 400, height: 400 },
      { x: 800, y: 0, width: 400, height: 400 },
      { x: 0, y: 400, width: 400, height: 400 },
      { x: 400, y: 400, width: 400, height: 400 },
      { x: 800, y: 400, width: 400, height: 400 }
    ]],
    ["eight_grid", [
      { x: 0, y: 0, width: 300, height: 400 },
      { x: 300, y: 0, width: 300, height: 400 },
      { x: 600, y: 0, width: 300, height: 400 },
      { x: 900, y: 0, width: 300, height: 400 },
      { x: 0, y: 400, width: 300, height: 400 },
      { x: 300, y: 400, width: 300, height: 400 },
      { x: 600, y: 400, width: 300, height: 400 },
      { x: 900, y: 400, width: 300, height: 400 }
    ]]
  ] as const)("maps %s without title or control-bar offsets", (template, expected) => {
    expect(
      getDefaultWorkspaceRects(template).map((rect) =>
        normalizedRectToPixelBounds(rect, { x: 0, y: 0, width: 1200, height: 800 })
      )
    ).toEqual(expected);
  });
});

function createRole(id: string, name: string): Role {
  return { ...role, id, name };
}

function toLegacyStoredRects(template: WorkspaceLayoutTemplate) {
  return getDefaultWorkspaceRects(template).map((rect) => ({
    x: roundLegacyRectValue(rect.x),
    y: roundLegacyRectValue(rect.y),
    width: roundLegacyRectValue(rect.width),
    height: roundLegacyRectValue(rect.height)
  }));
}

function roundLegacyRectValue(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function equalPixelBounds(left: PixelBounds, right: PixelBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function createHarness(options: {
  applyCdnCompatibility?: AnyMock;
  applyBrowserFonts?: AnyMock;
  applyBrowserProxy?: AnyMock;
  externalChromeManager?: ReturnType<typeof createExternalChromeManager>;
  getBrowserLaunchMode?: (role?: Role) => BrowserLaunchMode | Promise<BrowserLaunchMode>;
  getLoginUrl?: (role: Role) => string | Promise<string>;
  getWorkspaceAppearanceSettings?: () =>
    | WorkspaceAppearanceSettings
    | Promise<WorkspaceAppearanceSettings>;
  loadUrlHandlers?: Array<(url: string) => Promise<void>>;
  platform?: NodeJS.Platform;
  prefersReducedTransparency?: () => boolean;
  snapshotsByView?: Array<{ bodyText: string; localStorage: Record<string, string> }>;
} = {}) {
  const hosts: ReturnType<typeof createMockHost>[] = [];
  const views: ReturnType<typeof createMockView>[] = [];
  const defaultSnapshot = { bodyText: "Welcome", localStorage: { authToken: "token-1" } };
  const createHostWindow = vi.fn(() => {
    const host = createMockHost();
    hosts.push(host);
    return host as never;
  });
  const createView = vi.fn(() => {
    const snapshot = options.snapshotsByView?.[views.length] ?? defaultSnapshot;
    const loadUrlHandler = options.loadUrlHandlers?.[views.length];
    const view = createMockView(() => snapshot, loadUrlHandler);
    views.push(view);
    return view.view as never;
  });
  const roleStore = {
    updateAuthState: vi.fn().mockImplementation(async (_id: string, authState: Role["authState"]) => ({
      ...role,
      authState
    }))
  };
  const beforeRolesStop = vi.fn().mockResolvedValue(undefined);
  const manager = new BrowserManager(roleStore, {
    ...(options.applyCdnCompatibility ? { applyCdnCompatibility: options.applyCdnCompatibility } : {}),
    ...(options.applyBrowserFonts ? { applyBrowserFonts: options.applyBrowserFonts } : {}),
    ...(options.applyBrowserProxy ? { applyBrowserProxy: options.applyBrowserProxy } : {}),
    createHostWindow,
    createView,
    dividerPreloadPath: "/app/out/preload/divider.cjs",
    embeddedPreloadPath: "/app/out/preload/embedded.cjs",
    ...(options.externalChromeManager ? { externalChromeManager: options.externalChromeManager as never } : {}),
    ...(options.getBrowserLaunchMode ? { getBrowserLaunchMode: options.getBrowserLaunchMode } : {}),
    ...(options.getLoginUrl ? { getLoginUrl: options.getLoginUrl } : {}),
    ...(options.getWorkspaceAppearanceSettings
      ? { getWorkspaceAppearanceSettings: options.getWorkspaceAppearanceSettings }
      : {}),
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    loginPollIntervalMs: 0,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.prefersReducedTransparency
      ? { prefersReducedTransparency: options.prefersReducedTransparency }
      : {})
  });
  manager.setBeforeRolesStop(beforeRolesStop);

  return { beforeRolesStop, createHostWindow, createView, hosts, manager, roleStore, views };
}

function createExternalChromeManager() {
  const status = {
    roleId: role.id,
    runtimeMode: "external" as const,
    state: "running" as const
  };

  return {
    getAutomationSession: vi.fn(() => undefined),
    hasSession: vi.fn(() => false),
    hasWorkspace: vi.fn(() => true),
    launch: vi.fn().mockResolvedValue(status),
    launchWorkspace: vi.fn().mockResolvedValue([status]),
    listStatuses: vi.fn(() => [status]),
    on: vi.fn(),
    setBeforeRoleStop: vi.fn(),
    setMacroOverlayInstaller: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    stopWorkspace: vi.fn().mockResolvedValue(undefined)
  };
}

function createMockHost() {
  const host = Object.assign(new EventEmitter(), {
    close: vi.fn(),
    contentBounds: { x: 0, y: 0, width: 1200, height: 800 },
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
      setBackgroundColor: vi.fn()
    },
    focus: vi.fn(),
    getContentBounds: vi.fn(() => host.contentBounds),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    minimized: false,
    restore: vi.fn(),
    show: vi.fn()
  });
  host.isMinimized.mockImplementation(() => host.minimized);
  return host;
}

function createMockView(
  readSnapshot: () => { bodyText: string; localStorage: Record<string, string> },
  loadUrlHandler?: (url: string) => Promise<void>
) {
  const emitter = new EventEmitter();
  let bounds = { x: 0, y: 0, width: 1, height: 1 };
  let currentUrl = "about:blank";
  let destroyed = false;
  const webContents = Object.assign(emitter, {
    id: Math.floor(Math.random() * 100_000),
    close: vi.fn(() => {
      destroyed = true;
    }),
    executeJavaScript: vi.fn(async (source: string) => {
      if (source === LOGIN_STORAGE_EXPRESSION) {
        const snapshot = readSnapshot();
        return {
          bodyText: snapshot.bodyText,
          indexedDb: {},
          localStorage: snapshot.localStorage,
          sessionStorage: {}
        };
      }
      return "";
    }),
    focus: vi.fn(),
    getURL: vi.fn(() => currentUrl),
    isDestroyed: vi.fn(() => destroyed),
    loadURL: vi.fn(async (url: string) => {
      if (loadUrlHandler) {
        await loadUrlHandler(url);
      }
      currentUrl = url;
    }),
    mainFrame: { framesInSubtree: [] },
    send: vi.fn(),
    sendInputEvent: vi.fn(),
    session: { cookies: { get: vi.fn().mockResolvedValue([]) }, setProxy: vi.fn().mockResolvedValue(undefined) },
    setWindowOpenHandler: vi.fn(),
    setZoomFactor: vi.fn()
  });
  const setBounds = vi.fn((nextBounds) => {
    bounds = nextBounds;
  });
  const view = {
    getBounds: vi.fn(() => bounds),
    setBackgroundBlur: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBounds,
    webContents
  };

  return { setBounds, view, webContents };
}

function createOAuthPopup(
  opener: ReturnType<typeof createMockView>,
  views: Array<ReturnType<typeof createMockView>>
) {
  const popupIndex = views.length;
  const handler = opener.webContents.setWindowOpenHandler.mock.calls[0][0] as () => {
    action: string;
    createWindow: (options: { webPreferences?: Record<string, unknown> }) => unknown;
  };
  const response = handler();
  response.createWindow({ webPreferences: { javascript: true } });
  return views[popupIndex];
}
