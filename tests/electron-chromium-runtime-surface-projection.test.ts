import { describe, expect, it, vi } from "vitest";
import {
  applyChromiumSurfaceProjection, applyChromiumSurfaceReparent,
  captureChromiumSurfaceProjections, restoreChromiumSurfaceProjections,
  restoreChromiumSurfaceReparents, type ChromiumSurfaceReparent
} from "../src/electron/main/chromiumRuntimeSurfaceProjection";

describe.each(["macos", "windows"] as const)("%s shared Chromium projection", (platform) => {
  it("captures immutable geometry and restores the original generation despite failures", () => {
    const bounds = { x: 1, y: 2, width: 800, height: 600 };
    const failure = new Error(`${platform} zoom failed`);
    const port = {
      readProjection: vi.fn(() => ({ bounds, zoomFactor: 1.25, visible: true })),
      setZoomFactor: vi.fn(() => { throw failure; }),
      setBounds: vi.fn(), setVisible: vi.fn()
    };
    const identities: [string, number][] = [["role", 7]];
    const snapshot = captureChromiumSurfaceProjections(port, identities);
    bounds.width = 900;
    identities[0][1] = 8;
    const failures: unknown[] = [];
    restoreChromiumSurfaceProjections(port, snapshot, failures);
    expect(failures).toEqual([failure]);
    expect(port.setBounds).toHaveBeenCalledWith("role", 7, {
      x: 1, y: 2, width: 800, height: 600
    });
    expect(port.setVisible).toHaveBeenCalledWith("role", 7, true);
  });

  it("does not invoke unchanged Chromium effects but applies changed fields in order", () => {
    const calls: string[] = [];
    const current = { bounds: { x: 0, y: 0, width: 200, height: 100 }, visible: false, zoomFactor: 1 };
    const port = {
      readProjection: () => current,
      setZoomFactor: () => { calls.push("zoom"); },
      setBounds: () => { calls.push("bounds"); },
      setVisible: () => { calls.push("visible"); }
    };
    applyChromiumSurfaceProjection(port, "web", 2, current, current);
    expect(calls).toEqual([]);
    applyChromiumSurfaceProjection(port, "web", 2, {
      bounds: { ...current.bounds, width: 400 }, visible: true, zoomFactor: 2
    }, current);
    expect(calls).toEqual(["zoom", "bounds", "visible"]);
  });

  it("journals only acknowledged moves and compensates in reverse despite a stale host", async () => {
    const events: string[] = [];
    const ports = {
      surfaces: { reparentRole: vi.fn(async (id: string) => { events.push(id); }) },
      webSurfaces: { reparentSurface: vi.fn(async (id: string) => { events.push(id); }) }
    } as unknown as Parameters<typeof applyChromiumSurfaceReparent>[0];
    const target = { isDestroyed: () => false } as Parameters<typeof applyChromiumSurfaceReparent>[2];
    const completed: ChromiumSurfaceReparent[] = [];
    await applyChromiumSurfaceReparent(ports, {
      kind: "role", id: "first", generation: 1, sourceWindowId: "source"
    }, target, completed);
    await applyChromiumSurfaceReparent(ports, {
      kind: "web", id: "second", generation: 2, sourceWindowId: "missing"
    }, target, completed);
    await applyChromiumSurfaceReparent(ports, {
      kind: "web", id: "third", generation: 4, sourceWindowId: "source"
    }, target, completed);
    vi.mocked(ports.surfaces.reparentRole!).mockRejectedValueOnce(new Error("submission failed"));
    await expect(applyChromiumSurfaceReparent(ports, {
      kind: "role", id: "failed", generation: 3, sourceWindowId: "source"
    }, target, completed)).rejects.toThrow("submission failed");
    expect(completed.map((move) => move.id)).toEqual(["first", "second", "third"]);
    const stale = new Error("source unavailable");
    const failures: unknown[] = [];
    await restoreChromiumSurfaceReparents(ports, new Map([["source", { host: target }]]),
      completed, failures, () => stale);
    expect(failures).toEqual([stale]);
    expect(events).toEqual(["first", "second", "third", "third", "first"]);
    expect(ports.surfaces.reparentRole).toHaveBeenLastCalledWith("first", 1, target);
  });
});
