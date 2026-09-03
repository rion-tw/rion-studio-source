import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ChromiumRuntimeWindowRecord } from
  "../src/electron/main/chromiumRuntimeAppKitProjection";
import { drainEmptyChromiumRuntimeHosts } from
  "../src/electron/main/chromiumRuntimeHostDrain";
import { tab } from "./support/electronChromiumRuntimeEffectFixtures";
import { FakeChromiumRuntimeEffectHost } from
  "./support/electronChromiumRuntimeEffectHostFixture";

function emptyWindow(windowId: string, nativeId: number): Readonly<{
  host: FakeChromiumRuntimeEffectHost;
  record: ChromiumRuntimeWindowRecord;
}> {
  const target = tab(`unused-${windowId}`, windowId, []).target;
  const host = new FakeChromiumRuntimeEffectHost(
    windowId,
    nativeId,
    target,
    `empty-${windowId}`,
    false
  );
  return {
    host,
    record: {
      host,
      hostTarget: target,
      tabIds: [],
      hiddenTabIds: new Set(),
      activeTabId: "",
      windowGeneration: 1,
      topologyRevision: 1,
      lastAdapterSequence: 0,
      windowZoomFactor: 1
    }
  };
}

describe("Chromium zero-tab native host drain", () => {
  it("awaits exact AppKit host destruction before removing the window record", async () => {
    const { host, record } = emptyWindow("empty-window", 41);
    const windows = new Map([[host.logicalWindowId, record]]);

    await drainEmptyChromiumRuntimeHosts(windows);

    expect(host.appKitIdentity).toMatchObject({
      logicalWindowId: "empty-window",
      launchGeneration: "empty-empty-window",
      nativeGeneration: 41
    });
    expect(host.close).toHaveBeenCalledOnce();
    expect(host.isDestroyed()).toBe(true);
    expect(windows).toHaveLength(0);
  });

  it("retains and retries a host whose close lacks exact destruction", async () => {
    const { host, record } = emptyWindow("retry-window", 42);
    const windows = new Map([[host.logicalWindowId, record]]);
    host.close.mockImplementationOnce(async () => undefined);

    await expect(drainEmptyChromiumRuntimeHosts(windows)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_RUNTIME_HOST_CLOSE_NOT_OBSERVED"
    });
    expect(windows.get("retry-window")).toBe(record);

    await drainEmptyChromiumRuntimeHosts(windows);
    expect(host.close).toHaveBeenCalledTimes(2);
    expect(windows).toHaveLength(0);
  });

  it("fails closed instead of bypassing a remaining tab-backed host", async () => {
    const { host, record } = emptyWindow("nonempty-window", 43);
    record.tabIds.push("unretired-tab");
    const windows = new Map([[host.logicalWindowId, record]]);

    await expect(drainEmptyChromiumRuntimeHosts(windows)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_RUNTIME_HOST_TOPOLOGY_UNVERIFIED"
    });
    expect(host.close).not.toHaveBeenCalled();
    expect(windows.get("nonempty-window")).toBe(record);
  });

  it("still retires independent empty hosts when one close fails", async () => {
    const failed = emptyWindow("failed-window", 44);
    const retired = emptyWindow("retired-window", 45);
    const windows = new Map([
      [failed.host.logicalWindowId, failed.record],
      [retired.host.logicalWindowId, retired.record]
    ]);
    failed.host.close.mockRejectedValueOnce(new Error("native close failed"));

    await expect(drainEmptyChromiumRuntimeHosts(windows)).rejects.toThrow(
      "native close failed"
    );
    expect(windows.get("failed-window")).toBe(failed.record);
    expect(windows.has("retired-window")).toBe(false);
    expect(retired.host.isDestroyed()).toBe(true);
  });

  it("is ordered after tab teardown and before registry disposal", async () => {
    const source = await readFile(
      "src/electron/main/chromiumRuntimeEffectExecutor.ts",
      "utf8"
    );
    const tabDrain = source.indexOf("tabIds.map((tabId) => this.#destroyTab(tabId))");
    const hostDrain = source.indexOf("await drainEmptyChromiumRuntimeHosts(this.#windows)");
    const surfaceDrain = source.indexOf("await this.#input.surfaces.dispose()");

    expect(tabDrain).toBeGreaterThanOrEqual(0);
    expect(tabDrain).toBeLessThan(hostDrain);
    expect(hostDrain).toBeLessThan(surfaceDrain);
  });
});
