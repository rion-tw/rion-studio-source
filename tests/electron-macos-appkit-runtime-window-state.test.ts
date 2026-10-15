import { describe, expect, it, vi } from "vitest";
import type { ChromiumRuntimeWindowStateObservation } from
  "../src/electron/main/chromiumRuntimeHostPorts";

import { Fixture, tab, target } from
  "./support/macosAppKitRuntimeHostFactoryFixtures";

describe("macOS AppKit runtime-window state stream", () => {
  it("preserves the current complete display fingerprint in native placement observations", async () => {
    const fixture = new Fixture();
    const host = await fixture.factory.createEmpty(target(), {
      attemptGeneration: "launch-generation-1", windowGeneration: 1, topologyRevision: 1
    });
    host.applyAppKitPhaseProjection!({ windowId: "window-1", windowGeneration: 1,
      topologyRevision: 1, tabIds: [], hiddenTabIds: [], tabPhases: [] });
    await Promise.resolve();
    const before = fixture.factory.captureHostObservations(["window-1"])[0]!;
    expect(before.targetDisplay).toEqual({
      id: fixture.display.id,
      fingerprint: {
        label: fixture.display.label,
        bounds: fixture.display.bounds,
        resolution: fixture.display.resolution,
        scaleFactor: fixture.display.scaleFactor,
        isPrimary: fixture.display.isPrimary,
        isInternal: fixture.display.isInternal
      }
    });
    fixture.display = { ...fixture.display, id: 8, label: "External Display",
      workArea: { x: 1920, y: 24, width: 1920, height: 1056 },
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1, isPrimary: false, isInternal: false };
    fixture.addon.emit(0, { type: "action", identity: host.appKitIdentity!,
      action: { type: "windowPlacementChanged", sourceWindowId: "window-1" } });
    const current = fixture.onAction.mock.lastCall![0].hosts[0]!;
    expect(current.targetDisplay).toEqual({ id: 8, fingerprint: {
      label: "External Display", bounds: fixture.display.bounds,
      resolution: fixture.display.resolution, scaleFactor: 1,
      isPrimary: false, isInternal: false
    } });
    expect(current.savedWorkArea).toEqual(fixture.display.workArea);
    expect(before.targetDisplay.id).toBe(7);
    expect(Object.isFrozen(current.targetDisplay)).toBe(true);
    expect(Object.isFrozen(current.targetDisplay.fingerprint)).toBe(true);
    expect(Object.isFrozen(current.targetDisplay.fingerprint!.bounds)).toBe(true);
    expect(Object.isFrozen(current.targetDisplay.fingerprint!.resolution)).toBe(true);
    fixture.display.bounds.x = 3000;
    fixture.display.resolution.width = 2560;
    expect(current.targetDisplay.fingerprint!.bounds.x).toBe(1920);
    expect(current.targetDisplay.fingerprint!.resolution.width).toBe(1920);
  });

  it("preserves a key-window event emitted before order-front visibility settles", async () => {
    const fixture = new Fixture();
    const host = await fixture.factory.create(target(), tab(target()));
    const identity = host.appKitIdentity!;
    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    host.bindRuntimeWindowState!((observation) => observations.push(observation));

    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: true,
        minimized: false,
        visible: false
      }
    });

    expect(observations).toEqual([
      expect.objectContaining({
        focused: true,
        foreground: true,
        minimized: false,
        source: "focus",
        visible: false
      })
    ]);
    expect(fixture.onError).not.toHaveBeenCalled();
    expect(host.isDestroyed()).toBe(false);
  });

  it("publishes authoritative AppKit window state in native event order", async () => {
    const fixture = new Fixture();
    fixture.lifecycleEpoch = 7;
    const host = await fixture.factory.create(target(), tab(target()));
    const identity = host.appKitIdentity!;
    const window = fixture.windows[0]!;
    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    const unsubscribe = host.bindRuntimeWindowState!((observation) => {
      observations.push(observation);
    });
    expect(host.readRuntimeWindowState!()).toMatchObject({
      appKitIdentity: identity,
      focused: false,
      foreground: false,
      lifecycleEpoch: 7,
      logicalWindowId: "window-1",
      minimized: false,
      nativeGeneration: 1,
      nativeHostId: 1,
      platform: "macos",
      sequence: 1,
      source: "initial",
      topologyRevision: 1,
      visible: false,
      windowGeneration: 1
    });
    host.showInactive!();
    expect(fixture.order.at(-1)).toBe("window-show-inactive");
    expect(fixture.order).not.toContain("window-focus");
    expect(observations).toEqual([]);
    window.emit("show");
    host.focus();
    // The JS callback may run after AppKit has already moved key-window state
    // again; the synchronously captured native event remains authoritative.
    window.focused = false;
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: true,
        minimized: false,
        visible: true
      }
    });
    window.focused = false;
    fixture.addon.emit(0, {
      type: "action",
      identity,
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: false,
        minimized: false,
        visible: true
      }
    });
    window.minimized = true;
    window.emit("minimize");
    window.minimized = false;
    window.emit("restore");
    host.hide();
    window.emit("hide");
    expect(observations.map(({ source }) => source)).toEqual([
      "show", "focus", "blur", "minimize", "restore", "hide"
    ]);
    expect(observations.map(({ sequence }) => sequence)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(observations[1]).toMatchObject({
      focused: true,
      foreground: true,
      visible: true
    });
    expect(observations[3]).toMatchObject({ minimized: true, visible: true });
    expect(observations.at(-1)).toMatchObject({ visible: false });
    unsubscribe();
    window.visible = true;
    window.emit("show");
    expect(observations).toHaveLength(6);
  });

  it("fails the state stream once when a stale AppKit focus event arrives", async () => {
    const fixture = new Fixture();
    const host = await fixture.factory.create(target(), tab(target()));
    const identity = host.appKitIdentity!;
    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    host.bindRuntimeWindowState!((observation) => observations.push(observation));
    host.readRuntimeWindowState!();
    fixture.addon.emit(0, {
      type: "action",
      identity: { ...identity, nativeGeneration: identity.nativeGeneration + 1 },
      action: {
        type: "windowFocusChanged",
        sourceWindowId: "window-1",
        focused: false,
        minimized: false,
        visible: false
      }
    });
    await vi.waitFor(() => expect(fixture.windows[0]!.destroyCalls).toBe(1));
    fixture.windows[0]!.emit("closed");
    fixture.windows[0]!.emit("closed");
    expect(observations).toEqual([
      expect.objectContaining({
        failureCode: "ELECTRON_MACOS_APPKIT_EVENT_STALE",
        sequence: 2,
        source: "failed"
      })
    ]);
    expect(fixture.onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_EVENT_STALE"
    }));
  });

  it("publishes one closed state before retiring native listeners", async () => {
    const fixture = new Fixture();
    const host = await fixture.factory.create(target(), tab(target()));
    const window = fixture.windows[0]!;
    const observations: ChromiumRuntimeWindowStateObservation[] = [];
    let removedListenerCountAtClose = -1;
    const unsubscribe = host.bindRuntimeWindowState!((observation) => {
      observations.push(observation);
      if (observation.source === "closed") {
        removedListenerCountAtClose = window.removedListeners.length;
      }
    });
    host.readRuntimeWindowState!();
    const close = host.close();
    await vi.waitFor(() => expect(window.destroyCalls).toBe(1));
    window.emit("closed");
    window.emit("closed");
    await close;
    expect(observations).toEqual([
      expect.objectContaining({
        focused: false,
        foreground: false,
        minimized: false,
        sequence: 2,
        source: "closed",
        visible: false
      })
    ]);
    expect(removedListenerCountAtClose).toBe(0);
    expect(window.removedListeners.length).toBeGreaterThan(0);
    expect(() => unsubscribe()).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
    expect(() => host.readRuntimeWindowState!()).toThrow(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_STALE_GENERATION"
    }));
  });
});
