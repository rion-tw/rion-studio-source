import { describe, expect, it, vi } from "vitest";

import type {
  AppKitRuntimeProjectionEffectRecord,
  CoreEffectRequest,
  EmbeddedTabEffectRecord
} from "../src/shared/generated";
import {
  applyChromiumRuntimeAppKitProjection,
  type ChromiumRuntimeRoleRecord,
  type ChromiumRuntimeTabRecord,
  type ChromiumRuntimeWebSurfaceRecord,
  type ChromiumRuntimeWindowRecord
} from "../src/electron/main/chromiumRuntimeAppKitProjection";
import type {
  ChromiumRuntimeEffectExecutorInput,
  ChromiumRuntimeGlobalWebSurfacePort,
  ChromiumRuntimeHostPort,
  ChromiumRuntimeSurfacePort
} from "../src/electron/main/chromiumRuntimeEffectExecutor";

interface HostBehavior {
  readonly commitError?: Error;
  readonly commitRequiresQuarantine?: boolean;
  readonly finalize?: () => void;
  readonly rollbackError?: Error;
}

type TestHost = ChromiumRuntimeHostPort & Readonly<{
  projectionTransactions: Array<Readonly<{
    commit: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
    requiresQuarantine: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
  }>>;
}>;

function host(
  windowId: string,
  generation: number,
  behavior: HostBehavior = {}
): TestHost {
  const projectionTransactions: TestHost["projectionTransactions"] = [];
  const prepareAppKitProjection = vi.fn(() => {
    let quarantineRequired = false;
    const transaction = {
      commit: vi.fn(() => {
        if (behavior.commitError) {
          quarantineRequired = behavior.commitRequiresQuarantine ?? true;
          throw behavior.commitError;
        }
      }),
      finalize: vi.fn(() => behavior.finalize?.()),
      requiresQuarantine: vi.fn(() => quarantineRequired),
      rollback: vi.fn(() => {
        if (behavior.rollbackError) {
          quarantineRequired = true;
          throw behavior.rollbackError;
        }
      })
    };
    projectionTransactions.push(transaction);
    return transaction;
  });
  const prepareWorkspaceDividerProjection = vi.fn(() => ({
    commit: vi.fn(),
    requiresQuarantine: vi.fn(() => false),
    rollback: vi.fn()
  }));
  return {
    id: generation,
    logicalWindowId: windowId,
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn()
    } as ChromiumRuntimeHostPort["contentView"],
    close: vi.fn(async () => undefined),
    focus: vi.fn(),
    hide: vi.fn(),
    getContentBounds: () => ({ x: 0, y: 44, width: 1000, height: 656 }),
    readProjection: () => ({
      displayId: 101,
      bounds: { x: 120, y: 80, width: 1152, height: 720 },
      visible: true,
      focused: false,
      presentation: "normal"
    }),
    isDestroyed: () => false,
    isVisible: () => true,
    show: vi.fn(),
    appKitIdentity: {
      logicalWindowId: windowId,
      launchGeneration: `launch-${windowId}`,
      nativeGeneration: generation
    },
    prepareAppKitProjection,
    prepareWorkspaceDividerProjection,
    projectionTransactions
  };
}

function windowRecord(
  nativeHost: ChromiumRuntimeHostPort,
  tabIds: string[]
): ChromiumRuntimeWindowRecord {
  return {
    host: nativeHost,
    hostTarget: {
      windowId: nativeHost.logicalWindowId,
      displayId: 101,
      scaleFactor: 2,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 120, y: 80, width: 1152, height: 720 },
      presentation: "normal"
    },
    tabIds,
    hiddenTabIds: new Set(),
    activeTabId: tabIds[0] ?? "",
    windowGeneration: 3,
    topologyRevision: 7,
    lastAdapterSequence: 0,
    windowZoomFactor: nativeHost.id === 1 ? 0.8 : 1.25
  };
}

function tabRecord(
  tabId: string,
  windowId: string,
  attemptGeneration = `${tabId}-attempt-1`
): ChromiumRuntimeTabRecord {
  return {
    specification: {
      tabId,
      attemptGeneration
    } as EmbeddedTabEffectRecord,
    windowId,
    roleViews: new Map(),
    webViews: new Map(),
    audioMuted: false
  };
}

function roleRecord(
  roleId: string,
  tabId: string,
  windowId: string
): ChromiumRuntimeRoleRecord {
  return {
    roleId,
    tabId,
    windowId,
    generation: 1,
    ownerGeneration: 1,
    zoomFactor: 1.2
  };
}

function webRecord(
  surfaceId: string,
  tabId: string,
  windowId: string
): ChromiumRuntimeWebSurfaceRecord {
  return {
    surfaceId,
    slotId: "web-slot-1",
    tabId,
    windowId,
    generation: 1,
    url: `https://${surfaceId}.example.test/`,
    profile: {
      profileKey: "global-web",
      chromiumUserDataDir: "/RionData/web-profiles/global-web/chromium"
    },
    zoomFactor: 1
  };
}

function ports() {
  const reparentRole = vi.fn(async () => undefined);
  const setBounds = vi.fn();
  const setVisible = vi.fn();
  const setZoomFactor = vi.fn();
  const surfaces: ChromiumRuntimeSurfacePort = {
    audioMuted: () => false,
    isCurrentlyAudible: () => false,
    create: vi.fn(async () => { throw new Error("not used"); }),
    closeRole: vi.fn(async () => true),
    dispose: vi.fn(async () => undefined),
    reparentRole,
    readProjection: vi.fn(() => ({
      bounds: { x: 0, y: 44, width: 500, height: 656 },
      visible: true,
      zoomFactor: 0.96
    })),
    setBounds,
    setAudioMuted: vi.fn(),
    setVisible,
    setZoomFactor
  };
  const reparentWebSurface = vi.fn(async () => undefined);
  const setWebBounds = vi.fn();
  const setWebVisible = vi.fn();
  const setWebZoomFactor = vi.fn();
  const webSurfaces: ChromiumRuntimeGlobalWebSurfacePort = {
    audioMuted: () => false,
    isCurrentlyAudible: () => false,
    create: vi.fn(async () => { throw new Error("not used"); }),
    closeSurface: vi.fn(async () => true),
    dispose: vi.fn(async () => undefined),
    reparentSurface: reparentWebSurface,
    readProjection: vi.fn(() => ({
      bounds: { x: 0, y: 44, width: 1000, height: 656 },
      visible: true,
      zoomFactor: 0.8
    })),
    setBounds: setWebBounds,
    setAudioMuted: vi.fn(),
    setVisible: setWebVisible,
    setZoomFactor: setWebZoomFactor
  };
  const executorPorts: ChromiumRuntimeEffectExecutorInput = {
    browserDataClear: { clear: vi.fn(async () => { throw new Error("not used"); }) },
    chromeProfileImport: {
      execute: vi.fn(async () => { throw new Error("not used"); })
    },
    globalWebBrowserDataClear: {
      clear: vi.fn(async () => { throw new Error("not used"); })
    },
    hosts: {
      create: vi.fn(async () => { throw new Error("not used"); }),
      createEmpty: vi.fn(async () => { throw new Error("not used"); })
    },
    layout: { resolveRoleBounds: vi.fn(async () => new Map()) },
    lifecycleEpoch: () => 1,
    onError: vi.fn(),
    preloadPath: "/Rion/app/out/preload/role.cjs",
    rolePaths: { resolve: vi.fn(async () => { throw new Error("not used"); }) },
    shellEffects: { copyCoordinate: vi.fn(), openMacroPage: vi.fn() },
    surfaces,
    webSurfaces
  };
  return {
    executorPorts,
    reparentRole,
    setBounds,
    setVisible,
    setZoomFactor,
    reparentWebSurface,
    setWebBounds,
    setWebVisible,
    setWebZoomFactor
  };
}

function effect(
  handleId: string,
  projection: AppKitRuntimeProjectionEffectRecord
): CoreEffectRequest {
  return {
    effectId: projection.eventId,
    operationId: `${projection.eventId}-operation`,
    target: { kind: "app", handleId },
    completionPolicy: "eventBound",
    action: { type: "embeddedApplyAppKitProjection", projection }
  };
}

function applyProjection(
  input: Omit<
    Parameters<typeof applyChromiumRuntimeAppKitProjection>[0],
    "quarantineWindows"
  >
) {
  return applyChromiumRuntimeAppKitProjection({
    ...input,
    quarantineWindows: async (windowIds) => {
      const results = await Promise.allSettled(windowIds.map((windowId) =>
        input.windows.get(windowId)!.host.close()
      ));
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  });
}

describe("Chromium AppKit projection transaction", () => {
  it("does not rewrite unchanged Chromium surface projections", async () => {
    const nativeHost = host("window-1", 1);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(nativeHost, ["tab-1"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")]
    ]);
    const roles = new Map<string, ChromiumRuntimeRoleRecord>([
      ["role-1", roleRecord("role-1", "tab-1", "window-1")]
    ]);
    const subject = ports();
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-idempotent-layout",
      windows: [{
        identity: nativeHost.appKitIdentity!, adapterSequence: 1,
        windowGeneration: 3, topologyRevision: 8,
        logicalTabIds: ["tab-1"], hiddenTabIds: [],
        tabs: [{ tabId: "tab-1", name: "tab-1", phase: "ready",
          tabType: "role", audioMuted: false }],
        activeTabId: "tab-1",
        roles: [{ roleId: "role-1", tabId: "tab-1", ownerGeneration: 1,
          bounds: { x: 0, y: 44, width: 500, height: 656 } }],
        webSurfaces: [], workspaceDividers: [], windowVisible: true
      }]
    };

    await applyProjection({
      effect: effect("window-1", projection), projection,
      ports: subject.executorPorts, windows, tabs, roles,
      webSurfaces: new Map()
    });

    expect(subject.setZoomFactor).not.toHaveBeenCalled();
    expect(subject.setBounds).not.toHaveBeenCalled();
    expect(subject.setVisible).not.toHaveBeenCalled();
  });

  it("retains the full logical cohort while AppKit projects only visible tabs", async () => {
    const nativeHost = host("window-1", 1);
    const window = windowRecord(nativeHost, ["tab-1", "tab-2"]);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([["window-1", window]]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")],
      ["tab-2", tabRecord("tab-2", "window-1")]
    ]);
    const roles = new Map<string, ChromiumRuntimeRoleRecord>([
      ["role-1", roleRecord("role-1", "tab-1", "window-1")],
      ["role-2", roleRecord("role-2", "tab-2", "window-1")]
    ]);
    const subject = ports();
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-hidden-tab",
      windows: [{
        identity: nativeHost.appKitIdentity!, adapterSequence: 1,
        windowGeneration: 3, topologyRevision: 8,
        logicalTabIds: ["tab-1", "tab-2"], hiddenTabIds: ["tab-2"],
        tabs: [{ tabId: "tab-1", name: "tab-1", phase: "ready",
          tabType: "role", audioMuted: false }],
        activeTabId: "tab-1",
        roles: [{ roleId: "role-1", tabId: "tab-1", ownerGeneration: 1,
          bounds: { x: 0, y: 44, width: 500, height: 656 } }],
        webSurfaces: [], workspaceDividers: [], windowVisible: true
      }]
    };

    await applyProjection({
      effect: effect("window-1", projection), projection,
      ports: subject.executorPorts, windows, tabs, roles,
      webSurfaces: new Map()
    });

    expect(window.tabIds).toEqual(["tab-1", "tab-2"]);
    expect([...window.hiddenTabIds]).toEqual(["tab-2"]);
    expect(window.activeTabId).toBe("tab-1");
    expect(nativeHost.prepareAppKitProjection).toHaveBeenCalledWith(
      projection.windows[0]
    );
    expect(subject.setVisible).toHaveBeenCalledWith("role-2", 1, false);
  });

  it("reparents exact role ownership and commits the full two-window projection", async () => {
    const sourceHost = host("window-1", 1, {
      finalize: () => expect(sourceWindow.topologyRevision).toBe(8)
    });
    const targetHost = host("window-2", 2, {
      finalize: () => expect(targetWindow.topologyRevision).toBe(8)
    });
    const sourceWindow = windowRecord(sourceHost, ["tab-1"]);
    const targetWindow = windowRecord(targetHost, ["tab-2"]);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", sourceWindow],
      ["window-2", targetWindow]
    ]);
    const firstTab = tabRecord("tab-1", "window-1");
    const secondTab = tabRecord("tab-2", "window-2");
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", firstTab],
      ["tab-2", secondTab]
    ]);
    const firstRole = roleRecord("role-1", "tab-1", "window-1");
    const secondRole = roleRecord("role-2", "tab-2", "window-2");
    const roles = new Map<string, ChromiumRuntimeRoleRecord>([
      ["role-1", firstRole],
      ["role-2", secondRole]
    ]);
    const subject = ports();
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-event-1",
      windows: [
        {
          identity: sourceHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: [], hiddenTabIds: [], tabs: [], roles: [],
          webSurfaces: [], workspaceDividers: [], windowVisible: true
        },
        {
          identity: targetHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["tab-2", "tab-1"], hiddenTabIds: [],
          tabs: ["tab-2", "tab-1"].map((tabId) => ({
            tabId, name: tabId, phase: "ready" as const,
            tabType: "role" as const, audioMuted: false
          })),
          activeTabId: "tab-1",
          roles: [
            {
              roleId: "role-2", tabId: "tab-2", ownerGeneration: 1,
              bounds: { x: 0, y: 44, width: 500, height: 656 }
            },
            {
              roleId: "role-1", tabId: "tab-1", ownerGeneration: 1,
              bounds: { x: 500, y: 44, width: 500, height: 656 }
            }
          ],
          webSurfaces: [], workspaceDividers: [], windowVisible: true
        }
      ]
    };

    await expect(applyProjection({
      effect: effect("window-1", projection), projection,
      ports: subject.executorPorts, windows, tabs, roles, webSurfaces: new Map()
    })).resolves.toEqual({
      eventId: "appkit-event-1",
      windowIds: ["window-1", "window-2"]
    });

    expect(subject.reparentRole).toHaveBeenCalledWith("role-1", 1, targetHost);
    expect(subject.setZoomFactor).toHaveBeenCalledWith("role-1", 1, 1.5);
    expect(subject.setBounds).toHaveBeenCalledWith(
      "role-1", 1, { x: 500, y: 44, width: 500, height: 656 }
    );
    expect(subject.setVisible).toHaveBeenCalledWith("role-2", 1, false);
    expect(subject.setVisible).toHaveBeenCalledTimes(1);
    expect(sourceHost.prepareAppKitProjection).toHaveBeenCalledWith(
      projection.windows[0]
    );
    expect(targetHost.prepareAppKitProjection).toHaveBeenCalledWith(
      projection.windows[1]
    );
    expect(sourceWindow).toMatchObject({
      activeTabId: "", tabIds: [], windowGeneration: 3, topologyRevision: 8
    });
    expect(targetWindow).toMatchObject({
      activeTabId: "tab-1", tabIds: ["tab-2", "tab-1"],
      windowGeneration: 3, topologyRevision: 8
    });
    expect(firstTab.windowId).toBe("window-2");
    expect(secondTab.windowId).toBe("window-2");
    expect(firstRole).toMatchObject({
      roleId: "role-1", tabId: "tab-1", windowId: "window-2",
      generation: 1, ownerGeneration: 1
    });
    expect(secondRole).toMatchObject({
      roleId: "role-2", tabId: "tab-2", windowId: "window-2",
      generation: 1, ownerGeneration: 1
    });
    const sourceTransaction = sourceHost.projectionTransactions[0]!;
    const targetTransaction = targetHost.projectionTransactions[0]!;
    expect(sourceTransaction.finalize).toHaveBeenCalledOnce();
    expect(targetTransaction.finalize).toHaveBeenCalledOnce();
    const lastCommitOrder = Math.max(
      sourceTransaction.commit.mock.invocationCallOrder[0]!,
      targetTransaction.commit.mock.invocationCallOrder[0]!
    );
    expect(sourceTransaction.finalize.mock.invocationCallOrder[0]).toBeGreaterThan(
      lastCommitOrder
    );
    expect(targetTransaction.finalize.mock.invocationCallOrder[0]).toBeGreaterThan(
      lastCommitOrder
    );
  });

  it("keeps AppKit as owner while reparenting an exact global Web surface", async () => {
    const sourceHost = host("web-window-1", 1);
    const targetHost = host("web-window-2", 2);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["web-window-1", windowRecord(sourceHost, ["web-tab-1"])],
      ["web-window-2", windowRecord(targetHost, ["web-tab-2"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["web-tab-1", tabRecord("web-tab-1", "web-window-1")],
      ["web-tab-2", tabRecord("web-tab-2", "web-window-2")]
    ]);
    const webSurfaces = new Map<string, ChromiumRuntimeWebSurfaceRecord>([
      ["web-surface-1", webRecord("web-surface-1", "web-tab-1", "web-window-1")],
      ["web-surface-2", webRecord("web-surface-2", "web-tab-2", "web-window-2")]
    ]);
    const subject = ports();
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-web-event-1",
      windows: [
        {
          identity: sourceHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: [], hiddenTabIds: [], tabs: [], roles: [],
          webSurfaces: [], workspaceDividers: [], windowVisible: true
        },
        {
          identity: targetHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["web-tab-1", "web-tab-2"], hiddenTabIds: [],
          tabs: ["web-tab-1", "web-tab-2"].map((tabId) => ({
            tabId, name: tabId, phase: "ready" as const,
            tabType: "workspace" as const, audioMuted: false
          })),
          activeTabId: "web-tab-1", roles: [],
          webSurfaces: [
            {
              surfaceId: "web-surface-1", slotId: "web-slot-1",
              tabId: "web-tab-1", attemptGeneration: "web-tab-1-attempt-1",
              bounds: { x: 40, y: 52, width: 920, height: 604 }, visible: true
            },
            {
              surfaceId: "web-surface-2", slotId: "web-slot-1",
              tabId: "web-tab-2", attemptGeneration: "web-tab-2-attempt-1",
              bounds: { x: 0, y: 44, width: 1000, height: 656 }, visible: false
            }
          ],
          workspaceDividers: [],
          windowVisible: true
        }
      ]
    };

    await expect(applyProjection({
      effect: effect("web-window-1", projection), projection,
      ports: subject.executorPorts, windows, tabs, roles: new Map(), webSurfaces
    })).resolves.toEqual({
      eventId: "appkit-web-event-1",
      windowIds: ["web-window-1", "web-window-2"]
    });
    expect(subject.reparentWebSurface).toHaveBeenCalledWith(
      "web-surface-1", 1, targetHost
    );
    expect(subject.setWebBounds).toHaveBeenCalledWith(
      "web-surface-1", 1, { x: 40, y: 52, width: 920, height: 604 }
    );
    expect(subject.setWebVisible).toHaveBeenCalledWith("web-surface-2", 1, false);
    expect(subject.setWebVisible).toHaveBeenCalledTimes(1);
    expect(webSurfaces.get("web-surface-1")!.windowId).toBe("web-window-2");

    subject.reparentWebSurface.mockClear();
    subject.setWebBounds.mockClear();
    const confused = structuredClone(projection);
    confused.eventId = "appkit-web-event-confused";
    for (const item of confused.windows) {
      item.adapterSequence = 2;
      item.topologyRevision = 9;
    }
    confused.windows[1]!.webSurfaces[0]!.slotId = "wrong-slot";
    await expect(applyProjection({
      effect: effect("web-window-1", confused), projection: confused,
      ports: subject.executorPorts, windows, tabs, roles: new Map(), webSurfaces
    })).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_WEB_LAYOUT_OWNER_STALE"
    });
    expect(subject.reparentWebSurface).not.toHaveBeenCalled();
    expect(subject.setWebBounds).not.toHaveBeenCalled();
  });

  it("rolls back a role move when a later Web reparent fails", async () => {
    const sourceHost = host("window-1", 1);
    const targetHost = host("window-2", 2);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(sourceHost, ["mixed-tab-1"])],
      ["window-2", windowRecord(targetHost, ["role-tab-2"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["mixed-tab-1", tabRecord("mixed-tab-1", "window-1")],
      ["role-tab-2", tabRecord("role-tab-2", "window-2")]
    ]);
    const roles = new Map<string, ChromiumRuntimeRoleRecord>([
      ["role-1", roleRecord("role-1", "mixed-tab-1", "window-1")],
      ["role-2", roleRecord("role-2", "role-tab-2", "window-2")]
    ]);
    const webSurfaces = new Map<string, ChromiumRuntimeWebSurfaceRecord>([
      ["web-surface-1", webRecord("web-surface-1", "mixed-tab-1", "window-1")]
    ]);
    const subject = ports();
    subject.reparentWebSurface.mockRejectedValueOnce(
      new Error("target Web capture failed")
    );
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-mixed-rollback",
      windows: [
        {
          identity: sourceHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: [], hiddenTabIds: [], tabs: [], roles: [],
          webSurfaces: [], workspaceDividers: [], windowVisible: true
        },
        {
          identity: targetHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["role-tab-2", "mixed-tab-1"], hiddenTabIds: [],
          tabs: ["role-tab-2", "mixed-tab-1"].map((tabId) => ({
            tabId, name: tabId, phase: "ready" as const,
            tabType: "workspace" as const, audioMuted: false
          })),
          activeTabId: "mixed-tab-1",
          roles: [
            { roleId: "role-2", tabId: "role-tab-2", ownerGeneration: 1,
              bounds: { x: 0, y: 44, width: 500, height: 656 } },
            { roleId: "role-1", tabId: "mixed-tab-1", ownerGeneration: 1,
              bounds: { x: 500, y: 44, width: 500, height: 656 } }
          ],
          webSurfaces: [{
            surfaceId: "web-surface-1", slotId: "web-slot-1",
            tabId: "mixed-tab-1", attemptGeneration: "mixed-tab-1-attempt-1",
            bounds: { x: 500, y: 44, width: 500, height: 656 }, visible: true
          }],
          workspaceDividers: [],
          windowVisible: true
        }
      ]
    };

    await expect(applyProjection({
      effect: effect("window-1", projection), projection,
      ports: subject.executorPorts, windows, tabs, roles, webSurfaces
    })).rejects.toThrow("target Web capture failed");
    expect(subject.reparentRole.mock.calls).toEqual([
      ["role-1", 1, targetHost],
      ["role-1", 1, sourceHost]
    ]);
    expect(subject.reparentWebSurface).toHaveBeenCalledWith(
      "web-surface-1", 1, targetHost
    );
    expect(roles.get("role-1")!.windowId).toBe("window-1");
    expect(webSurfaces.get("web-surface-1")!.windowId).toBe("window-1");
    expect(subject.setBounds).not.toHaveBeenCalled();
    expect(subject.setWebBounds).not.toHaveBeenCalled();
    expect(sourceHost.prepareAppKitProjection).toHaveBeenCalledOnce();
    expect(targetHost.prepareAppKitProjection).toHaveBeenCalledOnce();
  });

  it("rolls back prior native commits and quarantines both AppKit hosts when the second commit is unverified", async () => {
    const sourceHost = host("window-1", 1);
    const targetHost = host("window-2", 2, {
      commitError: new Error("second native projection receipt failed")
    });
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(sourceHost, ["tab-1"])],
      ["window-2", windowRecord(targetHost, ["tab-2"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")],
      ["tab-2", tabRecord("tab-2", "window-2")]
    ]);
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-second-host-failure",
      windows: [
        {
          identity: sourceHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["tab-1"], hiddenTabIds: [],
          tabs: [{ tabId: "tab-1", name: "tab-1", phase: "ready", tabType: "role",
            audioMuted: false }],
          activeTabId: "tab-1", roles: [], webSurfaces: [],
          workspaceDividers: [], windowVisible: true
        },
        {
          identity: targetHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["tab-2"], hiddenTabIds: [],
          tabs: [{ tabId: "tab-2", name: "tab-2", phase: "ready", tabType: "role",
            audioMuted: false }],
          activeTabId: "tab-2", roles: [], webSurfaces: [],
          workspaceDividers: [], windowVisible: true
        }
      ]
    };

    await expect(applyProjection({
      effect: effect("window-1", projection), projection,
      ports: ports().executorPorts, windows, tabs,
      roles: new Map(), webSurfaces: new Map()
    })).rejects.toMatchObject({
      code: "MACOS_APPKIT_CHROMIUM_PROJECTION_HOST_QUARANTINED"
    });
    expect(sourceHost.projectionTransactions[0]!.rollback).toHaveBeenCalledOnce();
    expect(sourceHost.projectionTransactions[0]!.finalize).not.toHaveBeenCalled();
    expect(targetHost.projectionTransactions[0]!.finalize).not.toHaveBeenCalled();
    expect(sourceHost.close).toHaveBeenCalledOnce();
    expect(targetHost.close).toHaveBeenCalledOnce();
    expect(windows.get("window-1")!.topologyRevision).toBe(7);
    expect(windows.get("window-2")!.topologyRevision).toBe(7);
  });

  it("keeps both hosts live when the failing native commit restores its last verified projection", async () => {
    const sourceHost = host("window-1", 1);
    const targetHost = host("window-2", 2, {
      commitError: new Error("native receipt rejected after exact restoration"),
      commitRequiresQuarantine: false
    });
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(sourceHost, ["tab-1"])],
      ["window-2", windowRecord(targetHost, ["tab-2"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")],
      ["tab-2", tabRecord("tab-2", "window-2")]
    ]);
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-second-host-restored",
      windows: [
        {
          identity: sourceHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["tab-1"], hiddenTabIds: [],
          tabs: [{ tabId: "tab-1", name: "tab-1", phase: "ready", tabType: "role",
            audioMuted: false }],
          activeTabId: "tab-1", roles: [], webSurfaces: [],
          workspaceDividers: [], windowVisible: true
        },
        {
          identity: targetHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["tab-2"], hiddenTabIds: [],
          tabs: [{ tabId: "tab-2", name: "tab-2", phase: "ready", tabType: "role",
            audioMuted: false }],
          activeTabId: "tab-2", roles: [], webSurfaces: [],
          workspaceDividers: [], windowVisible: true
        }
      ]
    };

    await expect(applyProjection({
      effect: effect("window-1", projection), projection,
      ports: ports().executorPorts, windows, tabs,
      roles: new Map(), webSurfaces: new Map()
    })).rejects.toThrow("native receipt rejected after exact restoration");
    expect(sourceHost.projectionTransactions[0]!.rollback).toHaveBeenCalledOnce();
    expect(sourceHost.close).not.toHaveBeenCalled();
    expect(targetHost.close).not.toHaveBeenCalled();
  });

  it("restores surface geometry and native tab state after a bounds readback failure", async () => {
    const nativeHost = host("window-1", 1);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(nativeHost, ["tab-1"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")]
    ]);
    const roles = new Map<string, ChromiumRuntimeRoleRecord>([
      ["role-1", roleRecord("role-1", "tab-1", "window-1")]
    ]);
    const subject = ports();
    subject.setBounds.mockImplementationOnce(() => {
      throw new Error("Chromium bounds readback failed");
    });
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-bounds-rollback",
      windows: [{
        identity: nativeHost.appKitIdentity!, adapterSequence: 1,
        windowGeneration: 3, topologyRevision: 8,
        logicalTabIds: ["tab-1"], hiddenTabIds: [],
        tabs: [{ tabId: "tab-1", name: "tab-1", phase: "ready", tabType: "role",
          audioMuted: false }],
        activeTabId: "tab-1",
        roles: [{ roleId: "role-1", tabId: "tab-1", ownerGeneration: 1,
          bounds: { x: 30, y: 52, width: 800, height: 540 } }],
        webSurfaces: [], workspaceDividers: [], windowVisible: true
      }]
    };

    await expect(applyProjection({
      effect: effect("window-1", projection), projection,
      ports: subject.executorPorts, windows, tabs, roles,
      webSurfaces: new Map()
    })).rejects.toThrow("Chromium bounds readback failed");
    expect(subject.setBounds.mock.calls).toEqual([
      ["role-1", 1, { x: 30, y: 52, width: 800, height: 540 }],
      ["role-1", 1, { x: 0, y: 44, width: 500, height: 656 }]
    ]);
    expect(subject.setVisible).toHaveBeenLastCalledWith("role-1", 1, true);
    expect(nativeHost.projectionTransactions[0]!.rollback).toHaveBeenCalledOnce();
    expect(nativeHost.projectionTransactions[0]!.finalize).not.toHaveBeenCalled();
    expect(nativeHost.close).not.toHaveBeenCalled();
    expect(windows.get("window-1")!.topologyRevision).toBe(7);
  });

  it("quarantines AppKit when exact zoom rollback after projection is unknown", async () => {
    const nativeHost = host("window-1", 1);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(nativeHost, ["tab-1"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")]
    ]);
    const roles = new Map<string, ChromiumRuntimeRoleRecord>([
      ["role-1", roleRecord("role-1", "tab-1", "window-1")]
    ]);
    roles.get("role-1")!.zoomFactor = 1.3;
    const subject = ports();
    subject.setZoomFactor
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("native zoom rollback readback failed");
      });
    subject.setBounds.mockImplementationOnce(() => {
      throw new Error("native bounds result unknown");
    });
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-zoom-rollback-unknown",
      windows: [{
        identity: nativeHost.appKitIdentity!, adapterSequence: 1,
        windowGeneration: 3, topologyRevision: 8,
        logicalTabIds: ["tab-1"], hiddenTabIds: [],
        tabs: [{ tabId: "tab-1", name: "tab-1", phase: "ready", tabType: "role",
          audioMuted: false }],
        activeTabId: "tab-1",
        roles: [{ roleId: "role-1", tabId: "tab-1", ownerGeneration: 1,
          bounds: { x: 30, y: 52, width: 800, height: 540 } }],
        webSurfaces: [], workspaceDividers: [], windowVisible: true
      }]
    };

    await expect(applyProjection({
      effect: effect("window-1", projection), projection,
      ports: subject.executorPorts, windows, tabs, roles,
      webSurfaces: new Map()
    })).rejects.toMatchObject({
      code: "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED"
    });
    expect(nativeHost.close).toHaveBeenCalledOnce();
  });

  it("fails closed when native projection compensation cannot restore the first host", async () => {
    const sourceHost = host("window-1", 1, {
      rollbackError: new Error("source native rollback failed")
    });
    const targetHost = host("window-2", 2, {
      commitError: new Error("target native commit failed")
    });
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(sourceHost, ["tab-1"])],
      ["window-2", windowRecord(targetHost, ["tab-2"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")],
      ["tab-2", tabRecord("tab-2", "window-2")]
    ]);
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-compensation-failure",
      windows: [
        {
          identity: sourceHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["tab-1"], hiddenTabIds: [],
          tabs: [{ tabId: "tab-1", name: "tab-1", phase: "ready", tabType: "role",
            audioMuted: false }],
          activeTabId: "tab-1", roles: [], webSurfaces: [],
          workspaceDividers: [], windowVisible: true
        },
        {
          identity: targetHost.appKitIdentity!, adapterSequence: 1,
          windowGeneration: 3, topologyRevision: 8,
          logicalTabIds: ["tab-2"], hiddenTabIds: [],
          tabs: [{ tabId: "tab-2", name: "tab-2", phase: "ready", tabType: "role",
            audioMuted: false }],
          activeTabId: "tab-2", roles: [], webSurfaces: [],
          workspaceDividers: [], windowVisible: true
        }
      ]
    };

    await expect(applyProjection({
      effect: effect("window-1", projection), projection,
      ports: ports().executorPorts, windows, tabs,
      roles: new Map(), webSurfaces: new Map()
    })).rejects.toMatchObject({
      code: "MACOS_APPKIT_CHROMIUM_PROJECTION_COMPENSATION_FAILED"
    });
    expect(sourceHost.close).toHaveBeenCalledOnce();
    expect(targetHost.close).toHaveBeenCalledOnce();
  });

  it("rejects stale or destroyed AppKit hosts before native mutation", async () => {
    const nativeHost = host("window-1", 1);
    const windows = new Map<string, ChromiumRuntimeWindowRecord>([
      ["window-1", windowRecord(nativeHost, ["tab-1"])]
    ]);
    const tabs = new Map<string, ChromiumRuntimeTabRecord>([
      ["tab-1", tabRecord("tab-1", "window-1")]
    ]);
    const subject = ports();
    const projection: AppKitRuntimeProjectionEffectRecord = {
      eventId: "appkit-stale-event",
      windows: [{
        identity: nativeHost.appKitIdentity!,
        adapterSequence: 1,
        windowGeneration: 3,
        topologyRevision: 8,
        logicalTabIds: ["tab-1"],
        hiddenTabIds: [],
        tabs: [{
          tabId: "tab-1",
          name: "tab-1",
          phase: "ready",
          tabType: "role",
          audioMuted: false
        }],
        activeTabId: "tab-1",
        roles: [],
        webSurfaces: [],
        workspaceDividers: [],
        windowVisible: true
      }]
    };
    const request = () => applyProjection({
      effect: effect("window-1", projection),
      projection,
      ports: subject.executorPorts,
      windows,
      tabs,
      roles: new Map(),
      webSurfaces: new Map()
    });
    await expect(request()).resolves.toMatchObject({ eventId: projection.eventId });
    vi.mocked(nativeHost.prepareAppKitProjection!).mockClear();

    await expect(request()).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_STALE"
    });
    projection.windows[0]!.adapterSequence = 2;
    projection.windows[0]!.topologyRevision = 7;
    await expect(request()).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_SUPERSEDED"
    });
    nativeHost.isDestroyed = () => true;
    projection.windows[0]!.adapterSequence = 2;
    projection.windows[0]!.topologyRevision = 9;
    await expect(request()).rejects.toMatchObject({
      code: "ELECTRON_MACOS_APPKIT_PROJECTION_STALE"
    });
    expect(nativeHost.prepareAppKitProjection).not.toHaveBeenCalled();
    expect(subject.reparentRole).not.toHaveBeenCalled();
    expect(subject.reparentWebSurface).not.toHaveBeenCalled();
  });
});
