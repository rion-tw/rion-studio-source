import type {
  EmbeddedRuntimeWindowProjectionRecord,
  EmbeddedTabEffectRecord
} from "../src/shared/generated";
import { describe, expect, it, vi } from "vitest";
import type {
  ChromiumRuntimeEffectExecutorInput,
  ChromiumRuntimeHostPort
} from "../src/electron/main/chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeTabRecord,
  ChromiumRuntimeWindowRecord
} from "../src/electron/main/chromiumRuntimeAppKitProjection";
import { applyChromiumRuntimeWindowsProjection } from
  "../src/electron/main/chromiumRuntimeWindowsProjection";

function host(windowId: string, appKit = false): ChromiumRuntimeHostPort {
  return {
    id: windowId === "window-1" ? 1 : 2,
    logicalWindowId: windowId,
    contentView: { id: windowId } as unknown as ChromiumRuntimeHostPort["contentView"],
    close: vi.fn(async () => undefined),
    focus: vi.fn(),
    hide: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }),
    readProjection: () => ({
      displayId: 1,
      bounds: { x: 0, y: 0, width: 900, height: 600 },
      visible: true,
      focused: false,
      presentation: "normal"
    }),
    isDestroyed: () => false,
    isVisible: () => true,
    show: vi.fn(),
    applyWindowsChromeProjection: vi.fn(async () => undefined),
    ...(appKit ? { appKitIdentity: {
      logicalWindowId: windowId,
      launchGeneration: `launch-${windowId}`,
      nativeGeneration: 1
    } } : {})
  };
}

function windowRecord(nativeHost: ChromiumRuntimeHostPort): ChromiumRuntimeWindowRecord {
  const windowId = nativeHost.logicalWindowId;
  const tabId = windowId === "window-1" ? "tab-1" : "tab-2";
  return {
    host: nativeHost,
    hostTarget: {
      windowId,
      displayId: 1,
      scaleFactor: 2,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 0, y: 0, width: 900, height: 600 },
      presentation: "normal"
    },
    tabIds: [tabId],
    hiddenTabIds: new Set(),
    activeTabId: tabId,
    windowGeneration: 3,
    topologyRevision: 7,
    lastAdapterSequence: 0,
    windowZoomFactor: windowId === "window-1" ? 0.8 : 1.25
  };
}

function tabRecord(tabId: string, windowId: string): ChromiumRuntimeTabRecord {
  return {
    specification: { tabId } as EmbeddedTabEffectRecord,
    windowId,
    roleViews: new Map(),
    webViews: new Map(),
    audioMuted: false
  };
}

function projection(
  windowId: string,
  tabIds: string[],
  activeTabId?: string,
  hiddenTabIds: string[] = []
): EmbeddedRuntimeWindowProjectionRecord {
  return {
    windowId,
    windowGeneration: 3,
    topologyRevision: 8,
    tabIds,
    tabPhases: tabIds.map((tabId) => ({ phase: "ready", tabId })),
    hiddenTabIds,
    ...(activeTabId === undefined ? {} : { activeTabId })
  };
}

function harness(appKit = false) {
  const firstHost = host("window-1", appKit);
  const secondHost = host("window-2", appKit);
  const windows = new Map([
    ["window-1", windowRecord(firstHost)],
    ["window-2", windowRecord(secondHost)]
  ]);
  const tabs = new Map([
    ["tab-1", tabRecord("tab-1", "window-1")],
    ["tab-2", tabRecord("tab-2", "window-2")]
  ]);
  const roles = new Map<string, ChromiumRuntimeRoleRecord>([
    ["role-1", {
      roleId: "role-1", tabId: "tab-1", windowId: "window-1",
      generation: 1, ownerGeneration: 1, zoomFactor: 1.2
    }],
    ["role-2", {
      roleId: "role-2", tabId: "tab-2", windowId: "window-2",
      generation: 1, ownerGeneration: 1, zoomFactor: 1
    }]
  ]);
  const reparentRole = vi.fn(async () => undefined);
  const setBounds = vi.fn();
  const setVisible = vi.fn();
  const setZoomFactor = vi.fn();
  const quarantineWindows = vi.fn(async () => undefined);
  const ports = {
    layout: {
      resolveRoleBounds: vi.fn(async (tab: EmbeddedTabEffectRecord) => new Map([
        [tab.tabId === "tab-1" ? "role-1" : "role-2",
          { x: 0, y: 0, width: 900, height: 600 }]
      ])),
      resolveWorkspaceLayout: vi.fn(async (tab: EmbeddedTabEffectRecord) => ({
        contentBounds: { x: 0, y: 0, width: 900, height: 600 },
        dividers: [],
        roles: new Map([
          [tab.tabId === "tab-1" ? "role-1" : "role-2",
            { x: 0, y: 0, width: 900, height: 600 }]
        ]),
        visible: true
      }))
    },
    surfaces: {
      readProjection: vi.fn((roleId: string) => ({
        parentId: 1,
        bounds: { x: 0, y: 0, width: 900, height: 600 },
        visible: true,
        zoomFactor: roleId === "role-1" ? 0.96 : 1.25
      })),
      reparentRole,
      setBounds,
      setVisible,
      setZoomFactor
    },
    webSurfaces: {
      readProjection: vi.fn(),
      reparentSurface: vi.fn(),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      setZoomFactor: vi.fn()
    }
  } as unknown as ChromiumRuntimeEffectExecutorInput;
  const input = {
    ports,
    windows,
    tabs,
    roles,
    webSurfaces: new Map(),
    quarantineWindows
  };
  return {
    firstHost, input, quarantineWindows, reparentRole, roles,
    setBounds, setVisible, setZoomFactor, tabs, windows
  };
}

describe("Windows Chromium runtime topology projection", () => {
  it("applies one exact cross-window move and commits ownership after reparent", async () => {
    const subject = harness();
    await expect(applyChromiumRuntimeWindowsProjection({
      ...subject.input,
      projections: [
        projection("window-1", []),
        projection("window-2", ["tab-2", "tab-1"], "tab-1")
      ]
    })).resolves.toEqual(["window-1", "window-2"]);

    expect(subject.reparentRole).toHaveBeenCalledWith(
      "role-1", 1, subject.windows.get("window-2")!.host
    );
    expect(subject.setZoomFactor).toHaveBeenCalledWith("role-1", 1, 1.5);
    expect(subject.tabs.get("tab-1")!.windowId).toBe("window-2");
    expect(subject.roles.get("role-1")!.windowId).toBe("window-2");
    expect(subject.windows.get("window-1")!.tabIds).toEqual([]);
    expect(subject.windows.get("window-2")!.tabIds).toEqual(["tab-2", "tab-1"]);
  });

  it("rejects stale and duplicate projections before native reparent", async () => {
    const subject = harness();
    await expect(applyChromiumRuntimeWindowsProjection({
      ...subject.input,
      projections: [
        { ...projection("window-1", ["tab-1"], "tab-1"), windowGeneration: 2 },
        projection("window-2", ["tab-2"], "tab-2")
      ]
    })).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_STALE" });
    await expect(applyChromiumRuntimeWindowsProjection({
      ...subject.input,
      projections: [
        projection("window-1", ["tab-1"], "tab-1"),
        projection("window-2", ["tab-2", "tab-1"], "tab-2")
      ]
    })).rejects.toMatchObject({ code: "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_TAB_INVALID" });
    expect(subject.reparentRole).not.toHaveBeenCalled();
  });

  it("rejects a missing or forged Core activation-phase projection", async () => {
    const subject = harness();
    for (const tabPhases of [
      [],
      [{ phase: "ready" as const, tabId: "missing-tab" }]
    ]) {
      await expect(applyChromiumRuntimeWindowsProjection({
        ...subject.input,
        projections: [
          { ...projection("window-1", ["tab-1"], "tab-1"), tabPhases },
          projection("window-2", ["tab-2"], "tab-2")
        ]
      })).rejects.toMatchObject({
        code: "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_SELECTION_INVALID"
      });
    }
  });

  it("supports an all-hidden last tab without inventing an active owner", async () => {
    const subject = harness();
    await applyChromiumRuntimeWindowsProjection({
      ...subject.input,
      projections: [
        projection("window-1", ["tab-1"], undefined, ["tab-1"]),
        projection("window-2", ["tab-2"], "tab-2")
      ]
    });
    expect(subject.windows.get("window-1")!.activeTabId).toBe("");
    expect(subject.windows.get("window-1")!.hiddenTabIds).toEqual(new Set(["tab-1"]));
    expect(subject.setVisible).toHaveBeenCalledWith("role-1", 1, false);
  });

  it("never applies the generic Windows projector to retained AppKit hosts", async () => {
    const subject = harness(true);
    await expect(applyChromiumRuntimeWindowsProjection({
      ...subject.input,
      projections: [
        projection("window-1", []),
        projection("window-2", ["tab-2", "tab-1"], "tab-1")
      ]
    })).resolves.toEqual([]);
    expect(subject.reparentRole).not.toHaveBeenCalled();
    expect(subject.tabs.get("tab-1")!.windowId).toBe("window-1");
  });

  it("compensates a partial move and quarantines if rollback is unknown", async () => {
    const subject = harness();
    subject.reparentRole
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("source host rejected rollback"));
    subject.setBounds.mockImplementationOnce(() => {
      throw new Error("native bounds result unknown");
    });
    await expect(applyChromiumRuntimeWindowsProjection({
      ...subject.input,
      projections: [
        projection("window-1", []),
        projection("window-2", ["tab-2", "tab-1"], "tab-1")
      ]
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_COMPENSATION_FAILED"
    });
    expect(subject.quarantineWindows).toHaveBeenCalledWith(["window-1", "window-2"]);
    expect(subject.tabs.get("tab-1")!.windowId).toBe("window-1");
  });

  it("quarantines when exact zoom rollback after a partial move is unknown", async () => {
    const subject = harness();
    subject.setZoomFactor
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("native zoom rollback readback failed");
      });
    subject.setBounds.mockImplementationOnce(() => {
      throw new Error("native bounds result unknown");
    });
    await expect(applyChromiumRuntimeWindowsProjection({
      ...subject.input,
      projections: [
        projection("window-1", []),
        projection("window-2", ["tab-2", "tab-1"], "tab-1")
      ]
    })).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_WINDOWS_PROJECTION_COMPENSATION_FAILED"
    });
    expect(subject.quarantineWindows).toHaveBeenCalledWith(["window-1", "window-2"]);
  });
});
