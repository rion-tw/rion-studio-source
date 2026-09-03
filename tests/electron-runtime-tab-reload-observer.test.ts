import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreAddonClient } from "../src/electron/core/coreAddonClient";
import { ElectronDesktopE2eRuntimeTabReloadObserver } from
  "../src/electron/e2e/runtimeTabReloadObserver";
import { WindowsRuntimeHostChromeController } from
  "../src/electron/main/windowsRuntimeHostChromeController";

const WINDOW_ID = "10000000-0000-4000-8000-000000000001";
const TAB_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_TAB_ID = "20000000-0000-4000-8000-000000000002";
const ROLE_ID = "30000000-0000-4000-8000-000000000001";
const OPERATION_ID = "40000000-0000-4000-8000-000000000001";

const originalInvoke = CoreAddonClient.prototype.invoke;
const originalHandleCommand = WindowsRuntimeHostChromeController.prototype.handleCommand;

afterEach(() => {
  CoreAddonClient.prototype.invoke = originalInvoke;
  WindowsRuntimeHostChromeController.prototype.handleCommand = originalHandleCommand;
});

function harness(input: Readonly<{
  activeTabId?: string | null;
  platform?: "darwin" | "win32";
  tabIds?: readonly string[];
  visible?: boolean;
}> = {}) {
  const snapshot = {
    roles: [{
      generation: 5,
      ownerGeneration: 7,
      roleId: ROLE_ID,
      tabId: TAB_ID,
      windowId: WINDOW_ID,
      zoomFactor: 1
    }],
    windows: [{
      activeTabId: input.activeTabId === undefined ? TAB_ID : input.activeTabId,
      tabIds: input.tabIds ?? [TAB_ID],
      topologyRevision: 9,
      visible: input.visible ?? true,
      windowGeneration: 4,
      windowId: WINDOW_ID
    }]
  };
  const registry = {
    currentRolePreloadFrame: vi.fn(() => ({
      documentInstanceId: "50000000-0000-4000-8000-000000000001"
    })),
    readProjection: vi.fn(() => ({ visible: true }))
  };
  const observer = new ElectronDesktopE2eRuntimeTabReloadObserver({
    artifactDirectory: undefined,
    platform: () => input.platform ?? "darwin",
    popupHostOwners: new Map(),
    readRuntime: () => ({ snapshot: () => snapshot as never }),
    roleSurfaceOwners: new Map([[ROLE_ID, {
      generation: 5,
      registry: registry as never,
      tabId: TAB_ID
    }]])
  });
  return { observer, registry, snapshot };
}

function invokeReload(overrides: Readonly<{
  topologyRevision?: number;
  windowGeneration?: number;
}> = {}): Promise<unknown> {
  return Reflect.apply(CoreAddonClient.prototype.invoke, {}, [{
    lifecycleEpoch: 3,
    operationId: OPERATION_ID,
    tabId: TAB_ID,
    topologyRevision: overrides.topologyRevision ?? 9,
    type: "browserRuntimeTabReload",
    windowGeneration: overrides.windowGeneration ?? 4,
    windowId: WINDOW_ID
  }]) as Promise<unknown>;
}

describe("Electron desktop E2E runtime-tab Reload observer", () => {
  it.each([
    ["missing", { tabIds: [] }, OTHER_TAB_ID],
    ["inactive", { activeTabId: OTHER_TAB_ID }, TAB_ID],
    ["hidden", { visible: false }, TAB_ID]
  ] as const)("rejects a %s failure-arm target", (_name, input, tabId) => {
    const { observer } = harness(input);
    expect(() => observer.failNext(WINDOW_ID, tabId)).toThrow(
      "The controlled Reload failure target is not current."
    );
  });

  it("consumes a changed native fence as stale and permits an exact re-arm", async () => {
    const { observer } = harness();
    observer.failNext(WINDOW_ID, TAB_ID);
    observer.install();

    await expect(invokeReload({
      topologyRevision: 10,
      windowGeneration: 5
    })).rejects.toMatchObject({
      code: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_ARM_STALE"
    });
    expect(() => observer.failNext(WINDOW_ID, TAB_ID)).not.toThrow();
  });

  it("clears a Windows arm when no visible menu capture exists", async () => {
    const { observer } = harness({ platform: "win32" });
    observer.failNext(WINDOW_ID, TAB_ID);
    observer.install();

    await expect(invokeReload()).rejects.toMatchObject({
      code: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_CAPTURE_MISSING"
    });
    expect(() => observer.failNext(WINDOW_ID, TAB_ID)).not.toThrow();
  });
});
