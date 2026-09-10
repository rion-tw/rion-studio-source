import { describe, expect, it, vi } from "vitest";

import type {
  AppKitRuntimeHostObservationRecord,
  CoreAppSnapshotRecord
} from "../src/shared/generated";
import type { AppLanguage } from "../src/shared/types";
import {
  MacosAppKitRuntimeTabMenuController,
  type MacosAppKitRuntimeTabMenuItem
} from "../src/electron/main/macosAppKitRuntimeTabMenu";
import type { ChromiumRuntimeExecutorSnapshot } from
  "../src/electron/main/chromiumRuntimeEffectExecutor";

const sourceIdentity = Object.freeze({
  logicalWindowId: "window-1",
  launchGeneration: "launch-1",
  nativeGeneration: 11
});
const targetIdentity = Object.freeze({
  logicalWindowId: "window-2",
  launchGeneration: "launch-2",
  nativeGeneration: 12
});

function logicalWindow(
  windowId: string,
  revision: number,
  tabIds: readonly string[]
) {
  return {
    windowId,
    windowGeneration: 3,
    revision,
    presentation: "normal" as const,
    tabs: tabIds.map((id) => ({
      id,
      tabType: "role" as const,
      sourceId: `role-${id}`,
      name: id,
      roleSlots: [],
      hidden: false,
      audioMuted: false
    })),
    activeTabId: tabIds[0]
  };
}

function fixtures() {
  const core = {
    revision: 9,
    stateRevision: 9,
    runtimeRevision: 9,
    state: {
      revision: 9,
      games: [],
      roles: [],
      launchWorkspaces: [],
      gameWindows: [
        {
          id: "window-1",
          name: "Source Window",
          targetDisplay: { id: 1 },
          placement: {
            normalBounds: { x: 0, y: 0, width: 900, height: 640 },
            savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
            presentation: "normal" as const
          },
          tabs: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "window-2",
          name: "Target Window",
          targetDisplay: { id: 1 },
          placement: {
            normalBounds: { x: 40, y: 40, width: 900, height: 640 },
            savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
            presentation: "normal" as const
          },
          tabs: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ],
      macros: []
    },
    browserRuntime: {
      revision: 9,
      windows: [],
      tabs: [],
      roleSurfaces: [],
      roleStatuses: [],
      macroStatuses: []
    },
    logicalWindows: [
      logicalWindow("window-1", 7, ["tab-1", "tab-2"]),
      logicalWindow("window-2", 5, ["tab-3"])
    ],
    roleStatuses: [],
    macroStatuses: []
  } as unknown as CoreAppSnapshotRecord;
  const native = {
    windows: [
      {
        windowId: "window-1",
        activeTabId: "tab-1",
        tabIds: ["tab-1", "tab-2"],
        displayId: 1,
        bounds: { x: 0, y: 0, width: 900, height: 600 },
        visible: true,
        focused: true,
        presentation: "normal" as const,
        windowGeneration: 3,
        topologyRevision: 7,
        parentNativeHostId: 41,
        appKitIdentity: sourceIdentity,
        target: {
          windowId: "window-1",
          displayId: 1,
          scaleFactor: 1,
          workArea: { x: 0, y: 0, width: 1440, height: 900 },
          bounds: { x: 0, y: 0, width: 900, height: 600 },
          presentation: "normal" as const
        }
      },
      {
        windowId: "window-2",
        activeTabId: "tab-3",
        tabIds: ["tab-3"],
        displayId: 1,
        bounds: { x: 40, y: 40, width: 900, height: 600 },
        visible: true,
        focused: false,
        presentation: "normal" as const,
        windowGeneration: 3,
        topologyRevision: 5,
        parentNativeHostId: 42,
        appKitIdentity: targetIdentity,
        target: {
          windowId: "window-2",
          persistedName: "Native Target Window",
          displayId: 1,
          scaleFactor: 1,
          workArea: { x: 0, y: 0, width: 1440, height: 900 },
          bounds: { x: 40, y: 40, width: 900, height: 600 },
          presentation: "normal" as const
        }
      }
    ],
    tabs: [
      {
        attemptGeneration: "attempt-1",
        audible: false,
        audioMuted: false as boolean,
        tabId: "tab-1",
        windowId: "window-1"
      },
      {
        attemptGeneration: "attempt-2",
        audible: false,
        audioMuted: false,
        tabId: "tab-2",
        windowId: "window-1"
      },
      {
        attemptGeneration: "attempt-3",
        audible: false,
        audioMuted: false,
        tabId: "tab-3",
        windowId: "window-2"
      }
    ],
    roles: [],
    webSurfaces: []
  } satisfies ChromiumRuntimeExecutorSnapshot;
  const host = {
    identity: sourceIdentity,
    windowGeneration: 3,
    topologyRevision: 7,
    contentBounds: { x: 0, y: 0, width: 900, height: 600 },
    normalBounds: { x: 0, y: 0, width: 900, height: 640 },
    savedWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
    targetDisplay: { id: 1 },
    presentation: "normal" as const,
    focused: true,
    minimized: false,
    visible: true
  } satisfies AppKitRuntimeHostObservationRecord;
  return { core, host, lifecycleEpoch: () => 17, native };
}

function item(
  items: readonly MacosAppKitRuntimeTabMenuItem[],
  id: string
): MacosAppKitRuntimeTabMenuItem {
  const findItem = (
    candidates: readonly MacosAppKitRuntimeTabMenuItem[]
  ): MacosAppKitRuntimeTabMenuItem | undefined => {
    for (const candidate of candidates) {
      if (candidate.id === id) return candidate;
      const nested = candidate.submenu && findItem(candidate.submenu);
      if (nested) return nested;
    }
    return undefined;
  };
  const found = findItem(items);
  if (found) return found;
  throw new Error(`Menu item ${id} is unavailable`);
}

describe("macOS retained AppKit runtime tab menu", () => {
  it.each([
    ["en", "Reload", "Mute Tab", "Hide tab (keeps running)",
      "Move to Game Window", "Move to New Game Window", "Stop and Close"],
    ["zh-TW", "重新整理", "將分頁靜音", "隱藏分頁（保持運行）",
      "移至遊戲視窗", "移至新遊戲視窗", "停止並關閉"],
    ["zh-CN", "重新加载", "将标签页静音", "隐藏标签页（保持运行）",
      "移至游戏窗口", "移至新游戏窗口", "停止并关闭"],
    ["ja", "再読み込み", "タブをミュート", "タブを非表示（実行を継続）",
      "ゲームウィンドウへ移動", "新しいゲームウィンドウへ移動",
      "停止して閉じる"]
  ] as const)(
    "uses the selected %s application language for every native tab action",
    async (language, reload, mute, hide, move, moveNew, stop) => {
      const { core, host, lifecycleEpoch, native } = fixtures();
      const popup = vi.fn();
      const controller = new MacosAppKitRuntimeTabMenuController({
        actions: { execute: vi.fn(async () => undefined) },
        language: () => language,
        lifecycleEpoch,
        nativeMenu: { popup },
        onError: vi.fn(),
        readCoreSnapshot: async () => core,
        readNativeSnapshot: () => native
      });

      await controller.open({
        hosts: [host], identity: sourceIdentity, tabId: "tab-1"
      });
      const items = popup.mock.calls[0]![0]
        .items as readonly MacosAppKitRuntimeTabMenuItem[];
      expect(item(items, "runtime-tab-menu-reload").label).toBe(reload);
      expect(item(items, "runtime-tab-menu-mute").label).toBe(mute);
      expect(item(items, "runtime-tab-menu-hide").label).toBe(hide);
      expect(item(items, "runtime-tab-menu-move").label).toBe(move);
      expect(item(items, "runtime-tab-menu-move-new").label).toBe(moveNew);
      expect(item(items, "runtime-tab-menu-stop").label).toBe(stop);
    }
  );

  it("uses the latest application language when the menu is reopened", async () => {
    const { core, host, lifecycleEpoch, native } = fixtures();
    const popup = vi.fn();
    let language: AppLanguage = "en";
    const controller = new MacosAppKitRuntimeTabMenuController({
      actions: { execute: vi.fn(async () => undefined) },
      language: () => language,
      lifecycleEpoch,
      nativeMenu: { popup },
      onError: vi.fn(),
      readCoreSnapshot: async () => core,
      readNativeSnapshot: () => native
    });

    await controller.open({
      hosts: [host], identity: sourceIdentity, tabId: "tab-1"
    });
    language = "zh-TW";
    await controller.open({
      hosts: [host], identity: sourceIdentity, tabId: "tab-1"
    });

    const first = popup.mock.calls[0]![0]
      .items as readonly MacosAppKitRuntimeTabMenuItem[];
    const second = popup.mock.calls[1]![0]
      .items as readonly MacosAppKitRuntimeTabMenuItem[];
    expect(item(first, "runtime-tab-menu-reload").label).toBe("Reload");
    expect(item(second, "runtime-tab-menu-reload").label).toBe("重新整理");
  });

  it("anchors a native menu to the exact AppKit parent and submits fenced actions", async () => {
    const { core, host, lifecycleEpoch, native } = fixtures();
    const execute = vi.fn(async () => undefined);
    const popup = vi.fn();
    const controller = new MacosAppKitRuntimeTabMenuController({
      actions: { execute },
      language: () => "en",
      lifecycleEpoch,
      nativeMenu: { popup },
      onError: vi.fn(),
      readCoreSnapshot: async () => core,
      readNativeSnapshot: () => native
    });

    await controller.open({ hosts: [host], identity: sourceIdentity, tabId: "tab-1" });
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({
      parentNativeHostId: 41
    }));
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    const reload = item(items, "runtime-tab-menu-reload");
    expect(reload).toMatchObject({
      label: "Reload",
      type: "normal"
    });
    expect(reload.enabled).not.toBe(false);
    expect(item(items, "runtime-tab-menu-mute")).toMatchObject({
      checked: false,
      label: "Mute Tab",
      type: "checkbox"
    });
    expect(item(items, "runtime-tab-menu-stop")).toMatchObject({
      label: "Stop and Close",
      type: "normal"
    });
    reload.click!();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: "reload", tabId: "tab-1" },
      source: expect.objectContaining({
        appKitIdentity: sourceIdentity,
        lifecycleEpoch: 17,
        parentNativeHostId: 41,
        topologyRevision: 7,
        windowGeneration: 3,
        windowId: "window-1"
      })
    }));
  });

  it("toggles mute and stops through the same exact native action fence", async () => {
    const { core, host, lifecycleEpoch, native } = fixtures();
    core.logicalWindows[0]!.tabs[0]!.audioMuted = true;
    const mutedNative = {
      ...native,
      tabs: native.tabs.map((tab, index) => ({
        ...tab,
        audioMuted: index === 0
      }))
    } satisfies ChromiumRuntimeExecutorSnapshot;
    const execute = vi.fn(async () => undefined);
    const popup = vi.fn();
    const controller = new MacosAppKitRuntimeTabMenuController({
      actions: { execute },
      language: () => "en",
      lifecycleEpoch,
      nativeMenu: { popup },
      onError: vi.fn(),
      readCoreSnapshot: async () => core,
      readNativeSnapshot: () => mutedNative
    });

    await controller.open({ hosts: [host], identity: sourceIdentity, tabId: "tab-1" });
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    expect(item(items, "runtime-tab-menu-mute")).toMatchObject({
      checked: true,
      label: "Unmute Tab"
    });
    item(items, "runtime-tab-menu-mute").click!();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      action: { muted: false, tabId: "tab-1", type: "setMuted" }
    }));
    item(items, "runtime-tab-menu-stop").click!();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({
      action: { tabId: "tab-1", type: "stop" }
    }));
  });

  it("carries both exact AppKit parents into an existing-window move", async () => {
    const { core, host, lifecycleEpoch, native } = fixtures();
    const execute = vi.fn(async () => undefined);
    const popup = vi.fn();
    const controller = new MacosAppKitRuntimeTabMenuController({
      actions: { execute },
      language: () => "en",
      lifecycleEpoch,
      nativeMenu: { popup },
      onError: vi.fn(),
      readCoreSnapshot: async () => core,
      readNativeSnapshot: () => native
    });

    await controller.open({ hosts: [host], identity: sourceIdentity, tabId: "tab-2" });
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    expect(item(items, "runtime-tab-menu-move-window-1")).toMatchObject({
      enabled: false,
      label: "Source Window"
    });
    item(items, "runtime-tab-menu-move-window-2").click!();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      action: { type: "move", tabId: "tab-2", windowId: "window-2" },
      source: expect.objectContaining({ parentNativeHostId: 41 }),
      target: expect.objectContaining({
        appKitIdentity: targetIdentity,
        parentNativeHostId: 42,
        topologyRevision: 5,
        windowGeneration: 3,
        windowId: "window-2"
      })
    }));
  });

  it("opens and re-fences a coherent transient Workspace window", async () => {
    const { core, host, lifecycleEpoch, native } = fixtures();
    core.state.gameWindows = [];
    core.logicalWindows[0]!.tabs[0]!.tabType = "workspace";
    core.logicalWindows[0]!.tabs[0]!.sourceId = "workspace-transient";
    const execute = vi.fn(async () => undefined);
    const popup = vi.fn();
    const readCoreSnapshot = vi.fn(async () => core);
    const readNativeSnapshot = vi.fn(() => native);
    const controller = new MacosAppKitRuntimeTabMenuController({
      actions: { execute },
      language: () => "en",
      lifecycleEpoch,
      nativeMenu: { popup },
      onError: vi.fn(),
      readCoreSnapshot,
      readNativeSnapshot
    });

    await controller.open({ hosts: [host], identity: sourceIdentity, tabId: "tab-1" });
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    expect(item(items, "runtime-tab-menu-move-window-1")).toMatchObject({
      enabled: false,
      label: "Game Window"
    });
    expect(item(items, "runtime-tab-menu-move-window-2")).toMatchObject({
      label: "Native Target Window"
    });

    item(items, "runtime-tab-menu-mute").click!();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(readCoreSnapshot).toHaveBeenCalledTimes(2);
    expect(readNativeSnapshot).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      action: { muted: true, tabId: "tab-1", type: "setMuted" },
      source: expect.objectContaining({
        appKitIdentity: sourceIdentity,
        lifecycleEpoch: 17,
        parentNativeHostId: 41,
        topologyRevision: 7,
        windowGeneration: 3,
        windowId: "window-1"
      })
    }));
  });

  it("still rejects a transient window with a mismatched AppKit identity", async () => {
    const { core, host, lifecycleEpoch, native } = fixtures();
    core.state.gameWindows = core.state.gameWindows.filter(
      (candidate) => candidate.id !== "window-1"
    );
    const mismatchedNative = {
      ...native,
      windows: native.windows.map((window, index) => index === 0
        ? {
            ...window,
            appKitIdentity: {
              ...sourceIdentity,
              logicalWindowId: "replacement-window"
            }
          }
        : window)
    } satisfies ChromiumRuntimeExecutorSnapshot;
    const controller = new MacosAppKitRuntimeTabMenuController({
      actions: { execute: vi.fn(async () => undefined) },
      language: () => "en",
      lifecycleEpoch,
      nativeMenu: { popup: vi.fn() },
      onError: vi.fn(),
      readCoreSnapshot: async () => core,
      readNativeSnapshot: () => mismatchedNative
    });

    await expect(controller.open({
      hosts: [host],
      identity: sourceIdentity,
      tabId: "tab-1"
    })).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_TAB_MENU_TOPOLOGY_STALE"
    });
  });

  it("rejects a menu selection after its Core topology revision changes", async () => {
    const { core, host, native } = fixtures();
    let lifecycleEpoch = 17;
    const execute = vi.fn(async () => undefined);
    const onError = vi.fn();
    const popup = vi.fn();
    const controller = new MacosAppKitRuntimeTabMenuController({
      actions: { execute },
      language: () => "en",
      lifecycleEpoch: () => lifecycleEpoch,
      nativeMenu: { popup },
      onError,
      readCoreSnapshot: async () => core,
      readNativeSnapshot: () => native
    });

    await controller.open({ hosts: [host], identity: sourceIdentity, tabId: "tab-1" });
    lifecycleEpoch = 18;
    core.logicalWindows[0]!.revision = 8;
    native.windows[0] = { ...native.windows[0]!, topologyRevision: 8 };
    const items = popup.mock.calls[0]![0].items as readonly MacosAppKitRuntimeTabMenuItem[];
    item(items, "runtime-tab-menu-move-new").click!();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_TAB_MENU_FENCE_STALE"
    }));
    expect(execute).not.toHaveBeenCalled();
  });
});
