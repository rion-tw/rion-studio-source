import { describe, expect, it } from "vitest";
import { projectCoreAppSnapshot } from "../src/electron/main/appSnapshotProjection";
import { captureChromiumRuntimeSnapshot } from "../src/electron/main/chromiumRuntimeSnapshotCapture";
import { inspectLaunchWindowFence } from "../src/electron/main/chromiumRuntimeLaunchWindowFence";
import { targetMatchesCurrentHost } from "../src/electron/main/chromiumRuntimeEffectExecutorSupport";
import type { ChromiumRuntimeWindowRecord } from "../src/electron/main/chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeEffectExecutorInput } from "../src/electron/main/chromiumRuntimeEffectExecutor";
import { CAPTURED_AT, emptyCoreSnapshot, topology, WINDOW_ID } from "./support/electronChromiumRuntimeLaunchFixtures";

function fixture(presentation: "maximized" | "fullscreen") {
  const target = { windowId: WINDOW_ID, displayId: 41, scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    bounds: { x: 120, y: 90, width: 1080, height: 720 }, presentation };
  const projection = { displayId: 41, bounds: target.bounds, visible: false,
    focused: false, presentation: "normal" as const };
  const host = { id: 71, logicalWindowId: WINDOW_ID,
    readProjection: () => projection, readPendingInitialPresentation: () => presentation,
  } as ChromiumRuntimeWindowRecord["host"];
  const record: ChromiumRuntimeWindowRecord = { host, hostTarget: target, tabIds: [],
    hiddenTabIds: new Set(), activeTabId: "", windowGeneration: 3,
    topologyRevision: 7, lastAdapterSequence: 0, windowZoomFactor: 1 };
  const native = captureChromiumRuntimeSnapshot({
    windows: new Map([[WINDOW_ID, record]]), tabs: new Map(), roles: new Map(),
    webSurfaces: new Map(), closingRoleGenerations: new Map(), closingWebSurfaceGenerations: new Map(),
    ports: {} as ChromiumRuntimeEffectExecutorInput,
  });
  const core = emptyCoreSnapshot();
  core.browserRuntime.windows = [{ windowId: WINDOW_ID, tabIds: [] }];
  core.logicalWindows = [{ windowId: WINDOW_ID, windowGeneration: 3, revision: 7,
    tabs: [], windowZoomFactor: 1, presentation }];
  return { core, native, target, host, projection };
}

describe.each(["maximized", "fullscreen"] as const)("staged Windows initial %s coherence", presentation => {
  it("retains the desired mode while native readback remains honestly hidden normal", () => {
    const { core, native, target, host } = fixture(presentation);
    expect(native.windows[0]).toMatchObject({ presentation: "normal", visible: false,
      pendingInitialPresentation: { presentation, nativeHostId: 71,
        windowGeneration: 3, topologyRevision: 7 }, target: { presentation } });
    expect(host.readProjection().presentation).toBe("normal");
    expect(targetMatchesCurrentHost(target, host)).toBe(true);
    expect(inspectLaunchWindowFence(core, native, WINDOW_ID).reason).toBeNull();
    expect(projectCoreAppSnapshot(core, native, topology(), CAPTURED_AT)
      .embeddedRuntimeState.windows[0]).toMatchObject({ presentation, visible: false });
  });

  it.each(["visible", "focused", "generation", "revision", "native-host", "target", "core-mode"] as const)(
    "rejects a staged mode with a mismatched %s fence", (mutation) => {
      const { core, native } = fixture(presentation);
      if (mutation === "core-mode") {
        core.logicalWindows[0]!.presentation = presentation === "maximized" ? "fullscreen" : "maximized";
      }
      const window = native.windows[0]!;
      const pending = window.pendingInitialPresentation!;
      const changed = { ...window,
        ...(mutation === "visible" ? { visible: true } : {}),
        ...(mutation === "focused" ? { focused: true } : {}),
        ...(mutation === "target" ? { target: { ...window.target!, presentation: "normal" as const } } : {}),
        pendingInitialPresentation: { ...pending,
          ...(mutation === "generation" ? { windowGeneration: pending.windowGeneration + 1 } : {}),
          ...(mutation === "revision" ? { topologyRevision: pending.topologyRevision + 1 } : {}),
          ...(mutation === "native-host" ? { nativeHostId: pending.nativeHostId + 1 } : {}),
        },
      };
      const invalid = { ...native, windows: [changed] };
      expect(inspectLaunchWindowFence(core, invalid, WINDOW_ID).reason).toBe("initial-presentation");
      expect(() => projectCoreAppSnapshot(core, invalid, topology(), CAPTURED_AT))
        .toThrow(expect.objectContaining({ code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY" }));
    });

  it("never treats a visible normal host as a staged native target", () => {
    const { host, target, projection } = fixture(presentation);
    projection.visible = true;
    expect(targetMatchesCurrentHost(target, host)).toBe(false);
  });
});
