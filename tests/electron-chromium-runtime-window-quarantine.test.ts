import { describe, expect, it, vi } from "vitest";

import type { EmbeddedTabEffectRecord } from "../src/shared/generated";
import type {
  ChromiumRuntimeEffectExecutorInput,
  ChromiumRuntimeHostPort
} from "../src/electron/main/chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "../src/electron/main/chromiumRuntimeAppKitProjection";
import { quarantineChromiumRuntimeWindows } from
  "../src/electron/main/chromiumRuntimeWindowQuarantine";

function fixture(options: Readonly<{
  closeRole?: boolean;
  failHostOnce?: boolean;
}> = {}) {
  const order: string[] = [];
  let hostFailurePending = options.failHostOnce ?? false;
  const host: ChromiumRuntimeHostPort = {
    id: 1,
    logicalWindowId: "window-1",
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } as
      ChromiumRuntimeHostPort["contentView"],
    close: vi.fn(async () => {
      order.push("host-close");
      if (hostFailurePending) {
        hostFailurePending = false;
        throw new Error("host close failed");
      }
    }),
    focus: vi.fn(),
    hide: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 44, width: 900, height: 556 }),
    readProjection: () => ({
      displayId: 1,
      bounds: { x: 50, y: 50, width: 900, height: 600 },
      visible: true,
      focused: false,
      presentation: "normal"
    }),
    isDestroyed: () => false,
    isVisible: () => true,
    show: vi.fn()
  };
  const windowRecord: ChromiumRuntimeWindowRecord = {
    host,
    hostTarget: {
      windowId: "window-1", displayId: 1, scaleFactor: 2,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 50, y: 50, width: 900, height: 600 },
      presentation: "normal"
    },
    tabIds: ["tab-1"], hiddenTabIds: new Set(), activeTabId: "tab-1",
    windowGeneration: 1, topologyRevision: 1, lastAdapterSequence: 0
  };
  const tab: ChromiumRuntimeTabRecord = {
    specification: { tabId: "tab-1" } as EmbeddedTabEffectRecord,
    windowId: "window-1", roleViews: new Map(), webViews: new Map(),
    audioMuted: false
  };
  const role: ChromiumRuntimeRoleRecord = {
    roleId: "role-1", tabId: "tab-1", windowId: "window-1",
    generation: 1, ownerGeneration: 1, zoomFactor: 1
  };
  const web: ChromiumRuntimeWebSurfaceRecord = {
    surfaceId: "web-1", slotId: "slot-1", tabId: "tab-1",
    windowId: "window-1", generation: 1, url: "https://web.test/",
    profile: {
      profileKey: "global-web",
      chromiumUserDataDir: "/Rion/web-profiles/global-web/chromium"
    },
    zoomFactor: 1
  };
  const retireOverlay = vi.fn(() => order.push("overlay-retire"));
  const closeRole = vi.fn(async () => {
    order.push("role-close");
    return options.closeRole ?? true;
  });
  const closeSurface = vi.fn(async () => {
    order.push("web-close");
    return true;
  });
  const reconcilePlaceholders = vi.fn(async () => {
    order.push("placeholder-reconcile");
  });
  const ports = {
    browserDataClear: { clear: vi.fn() },
    chromeProfileImport: { execute: vi.fn() },
    globalWebBrowserDataClear: { clear: vi.fn() },
    hosts: { create: vi.fn() },
    layout: { resolveRoleBounds: vi.fn() },
    overlays: { install: vi.fn(), retire: retireOverlay },
    preloadPath: "/Rion/role.cjs",
    rolePaths: { resolve: vi.fn() },
    rolePlaceholders: {
      dispose: vi.fn(),
      readEvidence: vi.fn(),
      reconcile: reconcilePlaceholders
    },
    shellEffects: { copyCoordinate: vi.fn(), openMacroPage: vi.fn() },
    surfaces: {
      audioMuted: vi.fn(), isCurrentlyAudible: vi.fn(), create: vi.fn(),
      closeRole, dispose: vi.fn(), readProjection: vi.fn(),
      setBounds: vi.fn(), setAudioMuted: vi.fn(), setVisible: vi.fn(),
      setZoomFactor: vi.fn()
    },
    trustedInput: {
      execute: vi.fn(),
      retireSurface: vi.fn(async () => { order.push("input-retire"); return true; }),
      resumeAfterDocumentReplacement: vi.fn(async () => false),
      dispose: vi.fn()
    },
    webSurfaces: {
      audioMuted: vi.fn(), isCurrentlyAudible: vi.fn(), create: vi.fn(),
      closeSurface, dispose: vi.fn(), readProjection: vi.fn(),
      setBounds: vi.fn(), setAudioMuted: vi.fn(), setVisible: vi.fn(),
      setZoomFactor: vi.fn()
    }
  } as unknown as ChromiumRuntimeEffectExecutorInput;
  return {
    input: {
      ports,
      roles: new Map([[role.roleId, role]]),
      tabs: new Map([["tab-1", tab]]),
      webSurfaces: new Map([[web.surfaceId, web]]),
      windows: new Map([["window-1", windowRecord]]),
      windowIds: ["window-1"]
    },
    closeRole,
    host,
    order,
    reconcilePlaceholders,
    retireOverlay
  };
}

describe("Chromium AppKit window quarantine", () => {
  it("retires every surface before closing and forgetting the exact host", async () => {
    const subject = fixture();
    await quarantineChromiumRuntimeWindows(subject.input);

    expect(subject.order.indexOf("host-close")).toBeGreaterThan(
      subject.order.indexOf("role-close")
    );
    expect(subject.order.indexOf("host-close")).toBeGreaterThan(
      subject.order.indexOf("web-close")
    );
    expect(subject.input.roles.size).toBe(0);
    expect(subject.input.webSurfaces.size).toBe(0);
    expect(subject.input.tabs.size).toBe(0);
    expect(subject.input.windows.size).toBe(0);
    expect(subject.retireOverlay).toHaveBeenCalledWith("role-1", 1);
    expect(subject.reconcilePlaceholders).toHaveBeenCalledWith([]);
    expect(subject.order.indexOf("placeholder-reconcile")).toBeGreaterThan(
      subject.order.indexOf("host-close")
    );
  });

  it("keeps the host and logical owner when a surface lacks close evidence", async () => {
    const subject = fixture({ closeRole: false });
    await expect(quarantineChromiumRuntimeWindows(subject.input))
      .rejects.toMatchObject({
        code: "ELECTRON_MACOS_APPKIT_QUARANTINE_SURFACE_NOT_CLOSED"
      });

    expect(subject.host.close).not.toHaveBeenCalled();
    expect(subject.input.roles.has("role-1")).toBe(true);
    expect(subject.input.tabs.has("tab-1")).toBe(true);
    expect(subject.input.windows.has("window-1")).toBe(true);
  });

  it("retains a failed host close and completes an exact retry", async () => {
    const subject = fixture({ failHostOnce: true });
    await expect(quarantineChromiumRuntimeWindows(subject.input))
      .rejects.toThrow("host close failed");
    expect(subject.input.tabs.has("tab-1")).toBe(true);
    expect(subject.input.windows.has("window-1")).toBe(true);

    await quarantineChromiumRuntimeWindows(subject.input);
    expect(subject.host.close).toHaveBeenCalledTimes(2);
    expect(subject.input.tabs.size).toBe(0);
    expect(subject.input.windows.size).toBe(0);
  });
});
