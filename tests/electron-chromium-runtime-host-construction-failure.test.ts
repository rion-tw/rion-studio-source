import { describe, expect, it, vi } from "vitest";

import { ChromiumPlatformRuntimeHostFactory } from "../src/electron/main/chromiumRuntimeHostFactory";
import { displays, expectPending, FakeBrowserWindows, FakeWindow, finishCreation,
  runtimeDocumentPath, tab, target } from "./support/windowsRuntimeHostFactoryFixtures";

function fixture(window = new FakeWindow(1)) {
  const windows = new FakeBrowserWindows();
  windows.queue(window);
  const factory = new ChromiumPlatformRuntimeHostFactory({ platform: "win32",
    browserWindows: windows.port, displays, runtimeDocumentPath });
  return { factory, windows, window };
}

function create(factory: ChromiumPlatformRuntimeHostFactory, method: "create" | "createEmpty",
  windowId = "window-1") {
  const launchTarget = target({ windowId });
  return Promise.resolve().then(() => method === "create"
    ? factory.create(launchTarget, tab(launchTarget, {
      tabId: `tab-${windowId}`, attemptGeneration: `launch-${windowId}`
    }))
    : factory.createEmpty(launchTarget, {
      attemptGeneration: `launch-${windowId}`, windowGeneration: 4, topologyRevision: 9
    }));
}

describe("Windows runtime host constructor failure ownership", () => {
  it.each(["create", "createEmpty"] as const)(
    "terminalizes %s only after cleaning the exact new host when native geometry throws",
    async method => {
      const { factory, window } = fixture();
      window.destroyEmitsClosed = false;
      const original = new Error("native restored geometry unavailable");
      vi.spyOn(window, "getNormalBounds").mockImplementation(() => { throw original; });
      const creation = create(factory, method);
      const rejected = expect(creation).rejects.toBe(original);
      await Promise.resolve();
      expect(window.closeCalls).toBe(0);
      expect(window.destroyCalls).toBe(1);
      expect(window.loadedFiles).toEqual([]);
      expect(window.showCalls).toBe(0);
      expect(window.showInactiveCalls).toBe(0);
      expect(window.focusCalls).toBe(0);
      await expectPending(creation);
      window.contents.emit("did-finish-load");
      window.emit("ready-to-show");
      await expectPending(creation);
      window.emit("closed");
      await rejected;
      expect(window.isDestroyed()).toBe(true);
      expect(window.closeCalls + window.destroyCalls).toBe(1);
      expect([...window.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
      expect([...window.contents.listeners.values()].every(listeners => listeners.size === 0)).toBe(true);
    }
  );

  it.each(["create", "createEmpty"] as const)(
    "cleans %s constructor geometry validation failure without publishing an owner",
    async method => {
      const { factory, windows, window } = fixture();
      window.contentBounds.width = 0;
      const creation = create(factory, method);
      const rejected = expect(creation).rejects.toMatchObject({
        code: "ELECTRON_RUNTIME_HOST_BOUNDS_INVALID"
      });
      await Promise.resolve();
      expect(window.closeCalls + window.destroyCalls).toBe(1);
      if (!window.isDestroyed()) {
        await expectPending(creation);
        window.emit("closed");
      }
      await rejected;
      expect(window.isDestroyed()).toBe(true);
      expect(window.loadedFiles).toEqual([]);
      expect(window.focusCalls).toBe(0);
      const replacement = new FakeWindow(2);
      windows.queue(replacement);
      const retry = create(factory, method);
      await Promise.resolve();
      const host = await finishCreation(retry, replacement);
      expect(host.logicalWindowId).toBe("window-1");
      expect(host.isDestroyed()).toBe(false);
    }
  );

  it.each(["same object", "native ID"] as const)(
    "never closes or destroys a %s owner alias while constructor validation fails",
    async aliasKind => {
      const { factory, windows, window } = fixture();
      const first = create(factory, "create");
      await Promise.resolve();
      const owner = await finishCreation(first, window);
      const originalProjection = owner.readProjection();
      const alias = aliasKind === "same object" ? window : new FakeWindow(window.nativeId);
      windows.queue(alias);
      const geometry = vi.spyOn(alias, "getNormalBounds").mockImplementation(() => {
        throw new Error("aliased native geometry must not be captured");
      });
      await expect(create(factory, "create", "window-2")).rejects.toMatchObject({
        code: "ELECTRON_RUNTIME_HOST_NATIVE_ALIAS"
      });
      if (aliasKind === "same object") expect(geometry).not.toHaveBeenCalled();
      else expect(geometry).toHaveBeenCalledOnce();
      expect(window.closeCalls).toBe(0);
      expect(window.destroyCalls).toBe(0);
      expect(alias.closeCalls).toBe(0);
      expect(alias.destroyCalls).toBe(0);
      geometry.mockRestore();
      expect(owner.isDestroyed()).toBe(false);
      expect(owner.readProjection()).toEqual(originalProjection);
      expect(factory.resolveWindowsInputParent(owner)?.logicalParent).toBe(owner);
      owner.showInactive!();
      owner.focus();
      expect(window.focusCalls).toBe(1);
    }
  );

  it("fails a native destroy submission without falling back to close or retrying", async () => {
    const { factory, window } = fixture();
    vi.spyOn(window, "getNormalBounds").mockImplementation(() => {
      throw new Error("construction failed");
    });
    const destroy = vi.spyOn(window, "destroy").mockImplementation(() => {
      throw new Error("native destroy refused");
    });
    await expect(create(factory, "create")).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_SUBMISSION_FAILED"
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(window.closeCalls).toBe(0);
    expect(window.isDestroyed()).toBe(false);
    expect(window.loadedFiles).toEqual([]);
    expect(window.focusCalls).toBe(0);
  });

  it("rejects a closed event without native destruction and never replays cleanup", async () => {
    const { factory, window } = fixture();
    vi.spyOn(window, "getNormalBounds").mockImplementation(() => {
      throw new Error("construction failed");
    });
    const destroy = vi.spyOn(window, "destroy").mockImplementation(() => {
      window.destroyCalls += 1;
      for (const closed of window.listeners.get("closed") ?? []) closed();
    });
    await expect(create(factory, "create")).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_READBACK_STALE"
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(window.closeCalls).toBe(0);
    expect(window.isDestroyed()).toBe(false);
    expect(window.focusCalls).toBe(0);
    expect(window.listeners.get("closed")?.size ?? 0).toBe(0);
  });

  it.each(["native ID", "raw HWND"] as const)(
    "rejects cleanup after its %s changes without closing a replacement host",
    async mismatch => {
      const { factory, window } = fixture();
      vi.spyOn(window, "getNormalBounds").mockImplementation(() => {
        throw new Error("construction failed");
      });
      if (mismatch === "native ID") {
        vi.spyOn(window, "id", "get").mockReturnValueOnce(1).mockReturnValue(99);
      } else {
        const original = window.getNativeWindowHandle();
        const replacement = Buffer.from(original);
        replacement.writeBigUInt64LE(99n);
        vi.spyOn(window, "getNativeWindowHandle").mockReturnValueOnce(original).mockReturnValue(replacement);
      }
      await expect(create(factory, "create")).rejects.toMatchObject({
        code: "ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_FENCE_STALE"
      });
      expect(window.closeCalls).toBe(0);
      expect(window.destroyCalls).toBe(0);
      expect(window.loadedFiles).toEqual([]);
      expect(window.focusCalls).toBe(0);
    }
  );

  it("refuses cleanup when the native window acquires an owner before destruction", async () => {
    const { factory, windows, window } = fixture();
    const geometry = vi.spyOn(window, "getNormalBounds").mockImplementation(() => {
      throw new Error("construction failed");
    });
    const rawHandle = window.getNativeWindowHandle();
    let handleReads = 0;
    let ownerCreation: ReturnType<ChromiumPlatformRuntimeHostFactory["create"]> | undefined;
    vi.spyOn(window, "getNativeWindowHandle").mockImplementation(() => {
      handleReads += 1;
      if (handleReads === 2) {
        geometry.mockRestore();
        windows.queue(window);
        const ownerTarget = target({ windowId: "window-2" });
        ownerCreation = factory.create(ownerTarget, tab(ownerTarget, {
          tabId: "tab-2", attemptGeneration: "launch-window-2"
        }));
      }
      return rawHandle;
    });
    await expect(create(factory, "create")).rejects.toMatchObject({
      code: "ELECTRON_RUNTIME_HOST_CONSTRUCTION_CLEANUP_FENCE_STALE"
    });
    expect(window.closeCalls).toBe(0);
    expect(window.destroyCalls).toBe(0);
    expect(ownerCreation).toBeDefined();
    const owner = await finishCreation(ownerCreation!, window);
    expect(owner.logicalWindowId).toBe("window-2");
    expect(owner.isDestroyed()).toBe(false);
    expect(factory.resolveWindowsInputParent(owner)?.logicalParent).toBe(owner);
  });
});
