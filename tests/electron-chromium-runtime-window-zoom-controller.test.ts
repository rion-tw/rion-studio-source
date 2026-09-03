import { describe, expect, it, vi } from "vitest";

import type { CoreEffectRequest } from "../src/shared/generated";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "../src/electron/main/chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeEffectExecutorInput } from
  "../src/electron/main/chromiumRuntimeEffectPorts";
import { applyChromiumRuntimeWindowZoomEffect } from
  "../src/electron/main/chromiumRuntimeWindowZoomController";

const windowId = "10000000-0000-4000-8000-000000000001";
const roleId = "20000000-0000-4000-8000-000000000001";
const webSurfaceId = "50000000-0000-4000-8000-000000000001";

function effect(): CoreEffectRequest {
  return {
    effectId: "30000000-0000-4000-8000-000000000001",
    operationId: "40000000-0000-4000-8000-000000000001",
    completionPolicy: "eventBound",
    target: { kind: "app", handleId: windowId },
    action: {
      type: "embeddedSetRuntimeWindowZoom",
      windowId,
      windowGeneration: 4,
      topologyRevision: 9,
      previousZoomFactor: 1,
      zoomFactor: 1.05
    }
  };
}

function windowRecord(destroyed: () => boolean): ChromiumRuntimeWindowRecord {
  return {
    host: {
      id: 77,
      isDestroyed: destroyed
    } as never,
    hostTarget: {} as never,
    tabIds: ["tab-1"],
    hiddenTabIds: new Set(),
    activeTabId: "tab-1",
    windowGeneration: 4,
    topologyRevision: 9,
    lastAdapterSequence: 0,
    windowZoomFactor: 1
  };
}

function ports(input: Readonly<{
  prepare: ReturnType<typeof vi.fn>;
  roleZoom?: number;
}>): ChromiumRuntimeEffectExecutorInput {
  return {
    popupZoom: { prepareWindowZoomTransaction: input.prepare },
    surfaces: {
      readProjection: () => ({
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        visible: true,
        zoomFactor: input.roleZoom ?? 1
      }),
      setZoomFactor: vi.fn()
    }
  } as unknown as ChromiumRuntimeEffectExecutorInput;
}

function roleRecords(): Map<string, ChromiumRuntimeRoleRecord> {
  return new Map([[roleId, {
    generation: 2,
    ownerGeneration: 3,
    roleId,
    tabId: "tab-1",
    windowId,
    zoomFactor: 1
  }]]);
}

function webRecords(): Map<string, ChromiumRuntimeWebSurfaceRecord> {
  return new Map([[webSurfaceId, {
    generation: 6,
    surfaceId: webSurfaceId,
    slotId: "web-slot-1",
    tabId: "tab-1",
    url: "https://web.example.test/",
    profile: {} as ChromiumRuntimeWebSurfaceRecord["profile"],
    windowId,
    zoomFactor: 0.8
  }]]);
}

describe("Chromium runtime-window zoom native transaction", () => {
  it("rolls back a prepared popup transaction when role readback is stale", async () => {
    const apply = vi.fn();
    const commit = vi.fn();
    const rollback = vi.fn();
    const prepare = vi.fn(async () => ({
      popupSurfaceCount: 1,
      apply,
      commit,
      rollback
    }));
    const request = effect();

    await expect(applyChromiumRuntimeWindowZoomEffect({
      effect: request,
      action: request.action as Extract<
        CoreEffectRequest["action"],
        { type: "embeddedSetRuntimeWindowZoom" }
      >,
      ports: ports({ prepare, roleZoom: 0.9 }),
      roles: roleRecords(),
      webSurfaces: new Map(),
      windows: new Map([[windowId, windowRecord(() => false)]])
    })).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_WINDOW_ZOOM_NATIVE_STALE" });

    expect(rollback).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it("rolls back a prepared popup transaction when the host fence changes", async () => {
    let destroyed = false;
    const apply = vi.fn();
    const commit = vi.fn();
    const rollback = vi.fn();
    const prepare = vi.fn(async () => {
      destroyed = true;
      return { popupSurfaceCount: 0, apply, commit, rollback };
    });
    const request = effect();

    await expect(applyChromiumRuntimeWindowZoomEffect({
      effect: request,
      action: request.action as Extract<
        CoreEffectRequest["action"],
        { type: "embeddedSetRuntimeWindowZoom" }
      >,
      ports: ports({ prepare }),
      roles: new Map(),
      webSurfaces: new Map(),
      windows: new Map([[windowId, windowRecord(() => destroyed)]])
    })).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_WINDOW_ZOOM_FENCE_STALE" });

    expect(rollback).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it("atomically applies Role, global-Web, and popup base zoom with exact receipt counts", async () => {
    let roleZoom = 1.2;
    let webZoom = 0.8;
    let popupZoom = 1.5;
    const commit = vi.fn();
    const rollback = vi.fn(() => { popupZoom = 1.5; });
    const prepare = vi.fn(async () => ({
      popupSurfaceCount: 1,
      apply: () => { popupZoom = 1.575; },
      commit,
      rollback
    }));
    const roleSetZoom = vi.fn((_id: string, _generation: number, zoom: number) => {
      roleZoom = zoom;
    });
    const webSetZoom = vi.fn((_id: string, _generation: number, zoom: number) => {
      webZoom = zoom;
    });
    const request = effect();
    const window = windowRecord(() => false);
    const runtimePorts = {
      popupZoom: { prepareWindowZoomTransaction: prepare },
      surfaces: {
        readProjection: () => ({
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          visible: true,
          zoomFactor: roleZoom
        }),
        setZoomFactor: roleSetZoom
      },
      webSurfaces: {
        readProjection: () => ({
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          visible: true,
          zoomFactor: webZoom
        }),
        setZoomFactor: webSetZoom
      }
    } as unknown as ChromiumRuntimeEffectExecutorInput;

    const receipt = await applyChromiumRuntimeWindowZoomEffect({
      effect: request,
      action: request.action as Extract<
        CoreEffectRequest["action"],
        { type: "embeddedSetRuntimeWindowZoom" }
      >,
      ports: runtimePorts,
      roles: new Map([[roleId, { ...roleRecords().get(roleId)!, zoomFactor: 1.2 }]]),
      webSurfaces: webRecords(),
      windows: new Map([[windowId, window]])
    });

    expect(prepare).toHaveBeenCalledWith({
      windowId,
      windowGeneration: 4,
      topologyRevision: 9,
      previousZoomFactor: 1,
      nextZoomFactor: 1.05
    });
    expect(roleZoom).toBeCloseTo(1.26);
    expect(webZoom).toBeCloseTo(0.84);
    expect(popupZoom).toBeCloseTo(1.575);
    expect(window.windowZoomFactor).toBe(1.05);
    expect(receipt).toEqual({
      windowId,
      windowGeneration: 4,
      topologyRevision: 9,
      previousZoomFactor: 1,
      nextZoomFactor: 1.05,
      roleSurfaceCount: 1,
      globalWebSurfaceCount: 1,
      popupSurfaceCount: 1,
      status: "applied"
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("fully reverses every surface and leaves the mirror unchanged after a later fence failure", async () => {
    let destroyed = false;
    let roleZoom = 1.2;
    let webZoom = 0.8;
    let popupZoom = 1.5;
    const commit = vi.fn();
    const rollback = vi.fn(() => { popupZoom = 1.5; });
    const prepare = vi.fn(async () => ({
      popupSurfaceCount: 1,
      apply: () => {
        popupZoom = 1.575;
        destroyed = true;
      },
      commit,
      rollback
    }));
    const request = effect();
    const window = windowRecord(() => destroyed);
    const runtimePorts = {
      popupZoom: { prepareWindowZoomTransaction: prepare },
      surfaces: {
        readProjection: () => ({
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          visible: true,
          zoomFactor: roleZoom
        }),
        setZoomFactor: (_id: string, _generation: number, zoom: number) => {
          roleZoom = zoom;
        }
      },
      webSurfaces: {
        readProjection: () => ({
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          visible: true,
          zoomFactor: webZoom
        }),
        setZoomFactor: (_id: string, _generation: number, zoom: number) => {
          webZoom = zoom;
        }
      }
    } as unknown as ChromiumRuntimeEffectExecutorInput;

    await expect(applyChromiumRuntimeWindowZoomEffect({
      effect: request,
      action: request.action as Extract<
        CoreEffectRequest["action"],
        { type: "embeddedSetRuntimeWindowZoom" }
      >,
      ports: runtimePorts,
      roles: new Map([[roleId, { ...roleRecords().get(roleId)!, zoomFactor: 1.2 }]]),
      webSurfaces: webRecords(),
      windows: new Map([[windowId, window]])
    })).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_WINDOW_ZOOM_FENCE_STALE" });

    expect(roleZoom).toBeCloseTo(1.2);
    expect(webZoom).toBeCloseTo(0.8);
    expect(popupZoom).toBeCloseTo(1.5);
    expect(window.windowZoomFactor).toBe(1);
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports compensation unknown when a native rollback readback does not restore", async () => {
    let roleZoom = 1;
    let writes = 0;
    const request = effect();
    const window = windowRecord(() => false);
    const runtimePorts = {
      popupZoom: {
        prepareWindowZoomTransaction: vi.fn(async () => ({
          popupSurfaceCount: 0,
          apply: () => { throw new Error("later popup apply failure"); },
          commit: vi.fn(),
          rollback: vi.fn()
        }))
      },
      surfaces: {
        readProjection: () => ({
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          visible: true,
          zoomFactor: roleZoom
        }),
        setZoomFactor: (_id: string, _generation: number, zoom: number) => {
          writes += 1;
          if (writes === 1) roleZoom = zoom;
        }
      }
    } as unknown as ChromiumRuntimeEffectExecutorInput;

    await expect(applyChromiumRuntimeWindowZoomEffect({
      effect: request,
      action: request.action as Extract<
        CoreEffectRequest["action"],
        { type: "embeddedSetRuntimeWindowZoom" }
      >,
      ports: runtimePorts,
      roles: roleRecords(),
      webSurfaces: new Map(),
      windows: new Map([[windowId, window]])
    })).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_WINDOW_ZOOM_COMPENSATION_UNKNOWN"
    });
    expect(roleZoom).toBe(1.05);
    expect(writes).toBe(2);
    expect(window.windowZoomFactor).toBe(1);
  });

  it("accepts an idempotent reverse already at its target without native rewrites", async () => {
    const request = effect();
    if (request.action.type !== "embeddedSetRuntimeWindowZoom") throw new Error("bad fixture");
    request.action.previousZoomFactor = 1.05;
    request.action.zoomFactor = 1;
    const window = windowRecord(() => false);
    const roleSetZoom = vi.fn();
    const webSetZoom = vi.fn();
    const commit = vi.fn();
    const popupApply = vi.fn();
    const runtimePorts = {
      popupZoom: {
        prepareWindowZoomTransaction: vi.fn(async () => ({
          popupSurfaceCount: 1,
          apply: popupApply,
          commit,
          rollback: vi.fn()
        }))
      },
      surfaces: {
        readProjection: () => ({
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          visible: true,
          zoomFactor: 1
        }),
        setZoomFactor: roleSetZoom
      },
      webSurfaces: {
        readProjection: () => ({
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          visible: true,
          zoomFactor: 0.8
        }),
        setZoomFactor: webSetZoom
      }
    } as unknown as ChromiumRuntimeEffectExecutorInput;

    const receipt = await applyChromiumRuntimeWindowZoomEffect({
      effect: request,
      action: request.action,
      ports: runtimePorts,
      roles: roleRecords(),
      webSurfaces: webRecords(),
      windows: new Map([[windowId, window]])
    });

    expect(receipt).toMatchObject({ previousZoomFactor: 1.05, nextZoomFactor: 1 });
    expect(window.windowZoomFactor).toBe(1);
    expect(roleSetZoom).not.toHaveBeenCalled();
    expect(webSetZoom).not.toHaveBeenCalled();
    expect(popupApply).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });
});
