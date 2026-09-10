import { describe, expect, it, vi } from "vitest";

import type {
  AppKitRuntimeHostObservationRecord,
  CoreAppSnapshotRecord,
  DisplayTopologySnapshotRecord
} from "../src/shared/generated";
import {
  MacosAppKitRuntimeLauncherMenuController
} from "../src/electron/main/macosAppKitRuntimeLauncherMenu";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";
import type { MacosAppKitRuntimeTabMenuItem } from
  "../src/electron/main/macosAppKitRuntimeTabMenu";

const identity = Object.freeze({
  logicalWindowId: "window-transient",
  launchGeneration: "launch-1",
  nativeGeneration: 4
});

function fixtures() {
  const core: CoreAppSnapshotRecord = {
    revision: 10,
    stateRevision: 10,
    runtimeRevision: 10,
    state: {
      revision: 10,
      games: [],
      roles: [{
        id: "role-1",
        gameId: "game-1",
        name: "Role One",
        launchUrl: "https://example.test/",
        notes: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }],
      launchWorkspaces: [{
        id: "workspace-1",
        name: "Workspace One",
        template: "single" as const,
        slots: [{
          id: "slot-1",
          roleId: "role-1",
          rect: { x: 0, y: 0, width: 1, height: 1 }
        }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }],
      gameWindows: [],
      macros: []
    },
    browserRuntime: {
      windows: [{
        windowId: "window-transient",
        activeTabId: "tab-1",
        tabIds: ["tab-1"]
      }],
      roles: [],
      tabs: [{
        id: "tab-1",
        audioMuted: false,
        sourceId: "role-1",
        name: "Role One",
        windowId: "window-transient",
        tabType: "role" as const,
        slots: [],
        webSurfaces: [],
        hidden: false
      }],
      workspaces: []
    },
    logicalWindows: [{
      windowId: "window-transient",
      windowGeneration: 3,
      revision: 7,
      presentation: "normal" as const,
      tabs: [{
        id: "tab-1",
        tabType: "role" as const,
        sourceId: "role-1",
        name: "Role One",
        roleSlots: [],
        hidden: false,
        audioMuted: false
      }],
      activeTabId: "tab-1",
      windowZoomFactor: 1
    }],
    roleStatuses: [{
      roleId: "role-1",
      state: "running" as const,
      runtimeMode: "embedded" as const
    }],
    macroStatuses: []
  };
  const native = {
    windows: [{
      windowId: "window-transient",
      activeTabId: "tab-1",
      tabIds: ["tab-1"],
      displayId: 7,
      bounds: { x: 100, y: 80, width: 900, height: 600 },
      visible: true,
      focused: true,
      presentation: "normal" as const,
      windowGeneration: 3,
      topologyRevision: 7,
      parentNativeHostId: 41,
      appKitIdentity: identity,
      target: {
        windowId: "window-transient",
        displayId: 7,
        scaleFactor: 2,
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        bounds: { x: 100, y: 80, width: 900, height: 640 },
        presentation: "normal" as const
      }
    }],
    tabs: [{
      tabId: "tab-1",
      windowId: "window-transient",
      audioMuted: false,
      audible: false,
      attemptGeneration: "attempt-1"
    }],
    roles: [],
    webSurfaces: []
  } satisfies ChromiumRuntimeExecutorSnapshot;
  const host = {
    identity,
    windowGeneration: 3,
    topologyRevision: 7,
    contentBounds: { x: 100, y: 120, width: 900, height: 600 },
    normalBounds: { x: 100, y: 80, width: 900, height: 640 },
    savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
    targetDisplay: { id: 7 },
    presentation: "normal" as const,
    focused: true,
    minimized: false,
    visible: true
  } satisfies AppKitRuntimeHostObservationRecord;
  const display = {
    revision: 2,
    capturedAt: "2026-01-01T00:00:00.000Z",
    cause: "startup",
    primaryDisplayId: "7",
    displays: [{
      id: 7,
      label: "Built-in Display",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      resolution: { width: 2880, height: 1800 },
      scaleFactor: 2,
      isPrimary: true,
      isInternal: true
    }]
  } satisfies DisplayTopologySnapshotRecord;
  return { core, display, host, native };
}

function menuItem(
  items: readonly MacosAppKitRuntimeTabMenuItem[],
  id: string
): MacosAppKitRuntimeTabMenuItem {
  for (const candidate of items) {
    if (candidate.id === id) return candidate;
    if (candidate.submenu) {
      try {
        return menuItem(candidate.submenu, id);
      } catch {
        // Continue through sibling submenus.
      }
    }
  }
  throw new Error(`Menu item ${id} is unavailable`);
}

describe("macOS retained AppKit scoped launcher menu", () => {
  it("restores the transient-window save, Role, and Workspace actions from v8.4", async () => {
    const { core, display, host, native } = fixtures();
    const popup = vi.fn();
    const launchRole = vi.fn(async () => undefined);
    const launchWorkspace = vi.fn(async () => undefined);
    const saveWindow = vi.fn(async () => undefined);
    const activateTab = vi.fn(async () => undefined);
    const controller = new MacosAppKitRuntimeLauncherMenuController({
      actions: { activateTab, launchRole, launchWorkspace, saveWindow },
      language: () => "en",
      lifecycleEpoch: () => 12,
      nativeMenu: { popup },
      onError: vi.fn(),
      readCoreSnapshot: async () => core,
      readDisplayTopology: () => display,
      readNativeSnapshot: () => native
    });

    await controller.open({ hosts: [host], identity });
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({
      parentNativeHostId: 41
    }));
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    expect(menuItem(items, "runtime-launcher-save-window")).toMatchObject({
      label: "Save as New Game Window"
    });
    expect(menuItem(items, "runtime-launcher-role-role-1")).toMatchObject({
      checked: true,
      enabled: true,
      label: "Role One"
    });
    expect(menuItem(items, "runtime-launcher-workspace-workspace-1")).toMatchObject({
      checked: false,
      enabled: true,
      label: "Workspace One"
    });

    menuItem(items, "runtime-launcher-role-role-1").click!();
    await vi.waitFor(() => expect(launchRole).toHaveBeenCalledOnce());
    expect(launchRole).toHaveBeenCalledWith("role-1", "window-transient");
    menuItem(items, "runtime-launcher-workspace-workspace-1").click!();
    await vi.waitFor(() => expect(launchWorkspace).toHaveBeenCalledOnce());
    expect(launchWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      "window-transient"
    );

    menuItem(items, "runtime-launcher-save-window").click!();
    await vi.waitFor(() => expect(saveWindow).toHaveBeenCalledOnce());
    expect(saveWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: "window-transient",
        name: "Game Window 1",
        targetDisplay: expect.objectContaining({ id: 7 }),
        placement: {
          normalBounds: { x: 100, y: 80, width: 900, height: 640 },
          savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
          presentation: "normal"
        },
        activeTabId: "tab-1"
      }),
      identity
    );
  });

  it("fails closed when the AppKit topology changes before selection", async () => {
    const { core, display, host, native } = fixtures();
    const popup = vi.fn();
    const onError = vi.fn();
    const launchRole = vi.fn(async () => undefined);
    const controller = new MacosAppKitRuntimeLauncherMenuController({
      actions: {
        activateTab: vi.fn(async () => undefined),
        launchRole,
        launchWorkspace: vi.fn(async () => undefined),
        saveWindow: vi.fn(async () => undefined)
      },
      language: () => "en",
      lifecycleEpoch: () => 12,
      nativeMenu: { popup },
      onError,
      readCoreSnapshot: async () => core,
      readDisplayTopology: () => display,
      readNativeSnapshot: () => native
    });

    await controller.open({ hosts: [host], identity });
    native.windows[0] = {
      ...native.windows[0]!,
      topologyRevision: 8
    };
    core.logicalWindows[0]!.revision = 8;
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    menuItem(items, "runtime-launcher-role-role-1").click!();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_LAUNCHER_FENCE_STALE"
    }));
    expect(launchRole).not.toHaveBeenCalled();
  });

  it("focuses a checked Role through its exact Workspace owner without relaunching", async () => {
    const { core, display, host, native } = fixtures();
    const popup = vi.fn();
    const activateTab = vi.fn(async () => undefined);
    const launchRole = vi.fn(async () => undefined);
    core.logicalWindows[0]!.tabs[0] = {
      ...core.logicalWindows[0]!.tabs[0]!,
      sourceId: "other-role",
      name: "Other Role"
    };
    core.logicalWindows[0]!.tabs.push({
      id: "tab-2",
      tabType: "workspace",
      sourceId: "workspace-1",
      name: "Workspace One",
      roleSlots: [{
        slotId: "slot-1",
        roleId: "role-1",
        rect: { x: 0, y: 0, width: 1, height: 1 }
      }],
      hidden: false,
      audioMuted: false
    });
    core.browserRuntime.windows[0]!.tabIds.push("tab-2");
    core.browserRuntime.tabs[0] = {
      ...core.browserRuntime.tabs[0]!,
      sourceId: "other-role",
      name: "Other Role"
    };
    core.browserRuntime.tabs.push({
      id: "tab-2",
      audioMuted: false,
      sourceId: "workspace-1",
      name: "Workspace One",
      windowId: "window-transient",
      tabType: "workspace",
      slots: [],
      webSurfaces: [],
      hidden: false
    });
    core.browserRuntime.roles.push({
      roleId: "role-1",
      runtime: "embedded",
      owner: { tabId: "tab-2", slotId: "slot-1", generation: 2 },
      state: "running"
    });
    native.windows[0]!.tabIds.push("tab-2");
    const controller = new MacosAppKitRuntimeLauncherMenuController({
      actions: {
        activateTab,
        launchRole,
        launchWorkspace: vi.fn(async () => undefined),
        saveWindow: vi.fn(async () => undefined)
      },
      language: () => "en",
      lifecycleEpoch: () => 12,
      nativeMenu: { popup },
      onError: vi.fn(),
      readCoreSnapshot: async () => core,
      readDisplayTopology: () => display,
      readNativeSnapshot: () => native
    });

    await controller.open({ hosts: [host], identity });
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    menuItem(items, "runtime-launcher-role-role-1").click!();
    await vi.waitFor(() => expect(activateTab).toHaveBeenCalledOnce());

    expect(activateTab).toHaveBeenCalledWith("tab-2");
    expect(launchRole).not.toHaveBeenCalled();
  });
});
