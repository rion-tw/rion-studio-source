import { describe, expect, it, vi } from "vitest";

import {
  createMacRuntimeTabsControllerFactory,
  loadMacRuntimeTabsControllerFactory,
  toMacRuntimeTabsNativeState,
  type MacRuntimeTabsNativeAddon
} from "../src/main/browser/MacRuntimeTabsController";
import type { RuntimeTabChromeState } from "../src/shared/runtimeTabs";

const state: RuntimeTabChromeState = {
  alwaysShowToolbarInFullScreen: false,
  displayId: 11,
  displays: [],
  fullscreen: false,
  language: "zh-TW",
  tabIconDataUrls: { role: "data:image/png;base64,aWNvbg==" },
  tabWorkspaceTemplates: { workspace: "quad" },
  tabs: [
    {
      active: true,
      displayId: 11,
      hidden: false,
      id: "role",
      name: "米娜醬",
      roleIds: ["role-1"],
      sourceId: "role-1",
      type: "role",
      audible: true,
      audioMuted: false
    },
    {
      active: false,
      displayId: 11,
      hidden: false,
      id: "workspace",
      name: "四人隊伍",
      roleIds: ["role-1", "role-2", "role-3", "role-4"],
      roleNames: ["米娜醬", "阿爾", "露娜", "凱文"],
      sourceId: "workspace-1",
      type: "workspace",
      audible: false,
      audioMuted: true
    },
    {
      active: false,
      displayId: 22,
      hidden: false,
      id: "other-display",
      name: "Other",
      roleIds: ["role-5"],
      sourceId: "role-5",
      type: "role",
      audible: false,
      audioMuted: false
    },
    {
      active: false,
      displayId: 11,
      hidden: true,
      id: "hidden",
      name: "Hidden",
      roleIds: ["role-6"],
      sourceId: "role-6",
      type: "role",
      audible: false,
      audioMuted: false
    }
  ],
  toolbarVisible: true,
  windowFullscreen: false,
  windows: []
};

describe("MacRuntimeTabsController", () => {
  it("maps only visible tabs on the target display into native system chrome", () => {
    expect(toMacRuntimeTabsNativeState(state)).toEqual({
      displayId: 11,
      labels: {
        add: "開啟角色或工作區",
        audioMuted: "分頁已靜音",
        audioPlaying: "正在播放聲音",
        close: "停止並關閉分頁"
      },
      tabs: [
        {
          active: true,
          audible: true,
          audioMuted: false,
          iconDataUrl: "data:image/png;base64,aWNvbg==",
          id: "role",
          name: "米娜醬",
          tooltip: "米娜醬",
          type: "role"
        },
        {
          active: false,
          audible: false,
          audioMuted: true,
          id: "workspace",
          name: "四人隊伍",
          tooltip: "四人隊伍：米娜醬, 阿爾, 露娜, 凱文",
          type: "workspace",
          workspaceTemplate: "quad"
        }
      ]
    });
  });

  it("owns the native controller lifecycle and accepts validated actions", () => {
    let nativeCallback: ((action: unknown) => void) | undefined;
    let nativeContentLayoutCallback: ((layout: unknown) => void) | undefined;
    const nativeAddon: MacRuntimeTabsNativeAddon = {
      createController: vi.fn((_handle, callback, contentLayoutCallback) => {
        nativeCallback = callback;
        nativeContentLayoutCallback = contentLayoutCallback;
        return 17;
      }),
      destroyController: vi.fn(),
      getContentLayout: vi.fn(() => ({
        heightInset: 8,
        valid: true,
        yOffset: 8
      })),
      prepareFullscreenTransition: vi.fn(),
      protocolVersion: 6,
      setFullscreenPolicy: vi.fn(),
      setRevealLocked: vi.fn(),
      updateController: vi.fn()
    };
    const handle = Buffer.alloc(8);
    const window = { getNativeWindowHandle: vi.fn(() => handle) };
    const onAction = vi.fn();
    const onContentLayoutChange = vi.fn();
    const controller = createMacRuntimeTabsControllerFactory(nativeAddon)(
      window as never,
      onAction,
      onContentLayoutChange
    );

    controller.update(state);
    expect(controller.getContentLayout()).toEqual({
      heightInset: 8,
      valid: true,
      yOffset: 8
    });
    controller.prepareFullscreenTransition(true);
    controller.setFullscreenPolicy("always");
    controller.setRevealLocked(true);
    nativeCallback?.({ type: "activate", tabId: "role" });
    nativeCallback?.({ type: "activate", tabId: "" });
    nativeContentLayoutCallback?.({ heightInset: 8, valid: true, yOffset: 8 });
    nativeContentLayoutCallback?.({ heightInset: 7.5, valid: true, yOffset: 7 });

    expect(nativeAddon.createController).toHaveBeenCalledWith(
      handle,
      expect.any(Function),
      expect.any(Function)
    );
    expect(nativeAddon.updateController).toHaveBeenCalledWith(
      17,
      expect.objectContaining({ displayId: 11, tabs: expect.any(Array) })
    );
    expect(nativeAddon.getContentLayout).toHaveBeenCalledWith(17);
    expect(nativeAddon.prepareFullscreenTransition).toHaveBeenCalledWith(17, true);
    expect(nativeAddon.setFullscreenPolicy).toHaveBeenCalledWith(17, "always");
    expect(nativeAddon.setRevealLocked).toHaveBeenCalledWith(17, true);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith({ type: "activate", tabId: "role" });
    expect(onContentLayoutChange).toHaveBeenCalledOnce();
    expect(onContentLayoutChange).toHaveBeenCalledWith({
      heightInset: 8,
      valid: true,
      yOffset: 8
    });

    controller.destroy();
    controller.destroy();
    controller.update(state);
    nativeCallback?.({ type: "activate", tabId: "after-destroy" });
    nativeContentLayoutCallback?.({ heightInset: 10, valid: true, yOffset: 10 });
    expect(controller.getContentLayout()).toEqual({
      heightInset: 0,
      valid: false,
      yOffset: 0
    });
    expect(nativeAddon.destroyController).toHaveBeenCalledOnce();
    expect(nativeAddon.getContentLayout).toHaveBeenCalledOnce();
    expect(nativeAddon.updateController).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onContentLayoutChange).toHaveBeenCalledOnce();
  });

  it("normalizes an invalid synchronous native content layout", () => {
    const nativeAddon = {
      createController: vi.fn(() => 21),
      destroyController: vi.fn(),
      getContentLayout: vi.fn(() => ({
        heightInset: Number.POSITIVE_INFINITY,
        valid: true,
        yOffset: 1
      })),
      prepareFullscreenTransition: vi.fn(),
      protocolVersion: 6,
      setFullscreenPolicy: vi.fn(),
      setRevealLocked: vi.fn(),
      updateController: vi.fn()
    } satisfies MacRuntimeTabsNativeAddon;
    const controller = createMacRuntimeTabsControllerFactory(nativeAddon)(
      { getNativeWindowHandle: () => Buffer.alloc(8) } as never,
      vi.fn(),
      vi.fn()
    );

    expect(controller.getContentLayout()).toEqual({
      heightInset: 0,
      valid: false,
      yOffset: 0
    });
  });

  it("rejects an incompatible native protocol", () => {
    expect(() => createMacRuntimeTabsControllerFactory({ protocolVersion: 3 } as never))
      .toThrow("Unsupported macOS runtime tabs protocol 3");
  });

  it("logs a clear warning and permits the HTML fallback when the addon is missing", () => {
    const logger = { warn: vi.fn() };

    expect(loadMacRuntimeTabsControllerFactory(
      "/definitely-missing/rion-runtime-tabs.node",
      logger
    )).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("using the HTML fallback")
    );
  });
});
