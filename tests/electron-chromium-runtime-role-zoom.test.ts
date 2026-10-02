import { describe, expect, it, vi } from "vitest";
import { applyChromiumRuntimeRoleZoom } from "../src/electron/main/chromiumRuntimeRoleZoom";
import { chromiumRuntimeEffectScopes } from "../src/electron/main/chromiumRuntimeEffectScopes";
import { ChromiumRoleZoomShortcutController } from "../src/electron/main/chromiumRoleZoomShortcutController";
import type { ChromiumRuntimeExecutorSnapshot } from "../src/electron/main/chromiumRuntimeSnapshot";

function fixture(platform: "darwin" | "win32") {
  const role = { roleId: "a", tabId: "tab", workspaceId: "workspace", windowId: "window", generation: 2, ownerGeneration: 3, zoomFactor: 1 };
  const sibling = { ...role, roleId: "b", zoomFactor: 1.25 };
  const values = new Map([["a", 1.2], ["b", 1.5], ["other-window", 0.9]]);
  const window = { windowId: "window", windowGeneration: 4, topologyRevision: 9,
    windowZoomFactor: 1.2, activeTabId: "tab", tabIds: ["tab"], hiddenTabIds: new Set(),
    visible: true, focused: true, parentNativeHostId: 12,
    ...(platform === "darwin" ? { appKitIdentity: { logicalWindowId: "window", launchGeneration: "launch", nativeGeneration: 8 } } : {}),
    host: { isDestroyed: () => false } };
  const request = { operationId: "zoom", windowId: "window", tabId: "tab", roleId: "a",
    windowGeneration: 4, topologyRevision: 9, ownerGeneration: 3, surfaceGeneration: 2,
    previousZoomFactor: 1, action: "in" as const };
  const action = { type: "embeddedSetRuntimeRoleZoom" as const, request, zoomFactor: 1.05, windowZoomFactor: 1.2 };
  const setZoomFactor = vi.fn((id: string, _generation: number, factor: number) => { values.set(id, factor); });
  const input = { action, effect: { action, target: { kind: "app", handleId: "window" }, completionPolicy: "eventBound" },
    ports: { surfaces: { readProjection: (id: string) => ({ zoomFactor: values.get(id) }), setZoomFactor } },
    roles: new Map([["a", role], ["b", sibling]]), windows: new Map([["window", window]]) };
  const apply = () => applyChromiumRuntimeRoleZoom(input as unknown as Parameters<typeof applyChromiumRuntimeRoleZoom>[0]);
  return { role, sibling, window, input, apply, setZoomFactor, values };
}

describe.each(["darwin", "win32"] as const)("%s exact workspace Role zoom", platform => {
  it("changes only the targeted slot and composes its factor with the existing window factor", () => {
    const subject = fixture(platform);
    expect(subject.apply()).toEqual({ request: subject.input.action.request, zoomFactor: 1.05 });
    expect(subject.values).toEqual(new Map([["a", 1.26], ["b", 1.5], ["other-window", 0.9]]));
    expect(subject.role.zoomFactor).toBe(1.05);
    expect(subject.window.windowZoomFactor).toBe(1.2);
    expect(subject.setZoomFactor).toHaveBeenCalledExactlyOnceWith("a", 2, 1.26);
    expect(chromiumRuntimeEffectScopes(subject.input.effect as never, new Map(), new Map())).toEqual(["window:window"]);
  });
  it("rejects a replaced Role before writing to any surface", () => {
    const subject = fixture(platform);
    subject.role.generation++;
    expect(subject.apply).toThrow(expect.objectContaining({ code: "ELECTRON_RUNTIME_ROLE_ZOOM_STALE" }));
    expect(subject.setZoomFactor).not.toHaveBeenCalled();
  });
  it("restores native zoom on failed readback and retains the prior logical mirror", () => {
    const subject = fixture(platform);
    subject.setZoomFactor.mockImplementationOnce(() => { subject.values.set("a", 1.1); });
    expect(subject.apply).toThrow(expect.objectContaining({ code: "ELECTRON_RUNTIME_ROLE_ZOOM_READBACK_FAILED" }));
    expect(subject.values.get("a")).toBe(1.2);
    expect(subject.role.zoomFactor).toBe(1);
    subject.setZoomFactor.mockImplementation(() => { throw new Error("native unavailable"); });
    expect(subject.apply).toThrow(expect.objectContaining({ code: "ELECTRON_RUNTIME_ROLE_ZOOM_COMPENSATION_UNKNOWN" }));
  });
  it("never redirects a queued shortcut to the newly focused sibling", async () => {
    const subject = fixture(platform);
    let focused = subject.role;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const invoke = vi.fn(async ({ request }: { request: typeof subject.input.action.request }) => {
      await blocked;
      return { ...request, status: "applied" };
    });
    const controller = new ChromiumRoleZoomShortcutController({ core: { invoke } as never,
      focusedRole: () => focused, snapshot: () => ({ windows: [subject.window] } as unknown as ChromiumRuntimeExecutorSnapshot) });
    const first = controller.execute(subject.window, "in");
    const second = controller.execute(subject.window, "out");
    focused = subject.sibling;
    release();
    await expect(first).resolves.toBe(true);
    await expect(second).rejects.toMatchObject({ code: "ELECTRON_RUNTIME_ROLE_ZOOM_SHORTCUT_STALE" });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("preserves whole-window shortcuts for standalone tabs and focused window chrome", async () => {
    const subject = fixture(platform);
    const invoke = vi.fn();
    for (const focused of [null, { ...subject.role, workspaceId: undefined }]) {
      const controller = new ChromiumRoleZoomShortcutController({ core: { invoke } as never,
        focusedRole: () => focused, snapshot: () => ({ windows: [subject.window] } as unknown as ChromiumRuntimeExecutorSnapshot) });
      await expect(controller.execute(subject.window, "in")).resolves.toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
