import { describe, expect, it } from "vitest";

import { ChromiumNewWindowTargetResolver } from
  "../src/electron/main/chromiumNewWindowTargetResolver";
import type { DisplayTopologySnapshotRecord } from
  "../src/shared/generated";

function topology(
  workArea = { x: 0, y: 0, width: 1440, height: 900 }
): DisplayTopologySnapshotRecord {
  return {
    revision: 1,
    capturedAt: "2026-08-30T12:00:00.000Z",
    cause: "electron-initial",
    displays: [{
      id: 41,
      label: "Primary",
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea,
      resolution: { width: 2880, height: 1800 },
      scaleFactor: 2,
      isPrimary: true,
      isInternal: true
    }]
  };
}

function resolveInput(displayId = 41) {
  return {
    operationId: "move-one",
    tabId: "tab-one",
    sourceWindow: {
      windowId: "source-window",
      windowGeneration: 3,
      revision: 8,
      windowZoomFactor: 1,
      tabs: [],
      activeTabId: undefined
    },
    sourceNative: {
      windowId: "source-window",
      activeTabId: "tab-one",
      tabIds: ["tab-one"],
      displayId,
      bounds: { x: 100, y: 80, width: 900, height: 640 },
      visible: true,
      focused: true,
      presentation: "normal" as const,
      windowGeneration: 3,
      topologyRevision: 8
    }
  };
}

describe("Chromium new-window target resolver", () => {
  it("offsets a detached target inside the exact source display", async () => {
    const resolver = new ChromiumNewWindowTargetResolver({
      readDisplayTopology: () => topology()
    });

    await expect(resolver.resolve(resolveInput())).resolves.toEqual({
      displayId: 41,
      scaleFactor: 2,
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      bounds: { x: 132, y: 112, width: 900, height: 640 },
      presentation: "normal"
    });
  });

  it("uses the exact primary projection when the source display was removed", async () => {
    const resolver = new ChromiumNewWindowTargetResolver({
      readDisplayTopology: () => topology()
    });

    const target = await resolver.resolve(resolveInput(99));
    expect(target.displayId).toBe(41);
    expect(target.bounds).toEqual({
      x: 132,
      y: 112,
      width: 900,
      height: 640
    });
  });

  it("fails closed when no display can contain a native Game Window", async () => {
    const resolver = new ChromiumNewWindowTargetResolver({
      readDisplayTopology: () => topology({
        x: 0,
        y: 0,
        width: 600,
        height: 400
      })
    });

    await expect(resolver.resolve(resolveInput())).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_NEW_WINDOW_WORK_AREA_TOO_SMALL"
    });
  });
});
