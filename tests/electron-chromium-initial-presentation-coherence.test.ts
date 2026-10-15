import { describe, expect, it } from "vitest";
import { projectCoreAppSnapshot } from "../src/electron/main/appSnapshotProjection";
import { captureChromiumRuntimeSnapshot } from "../src/electron/main/chromiumRuntimeSnapshotCapture";
import { inspectLaunchWindowFence } from "../src/electron/main/chromiumRuntimeLaunchWindowFence";
import { targetMatchesCurrentHost } from "../src/electron/main/chromiumRuntimeEffectExecutorSupport";
import { pendingInitialPresentationMatches } from "../src/electron/main/chromiumRuntimeSnapshot";
import type { ChromiumRuntimeWindowRecord } from "../src/electron/main/chromiumRuntimeAppKitProjection";
import type { ChromiumRuntimeEffectExecutorInput } from "../src/electron/main/chromiumRuntimeEffectExecutor";
import { CAPTURED_AT, emptyCoreSnapshot, topology, WINDOW_ID } from "./support/electronChromiumRuntimeLaunchFixtures";

function fixture(presentation: "maximized" | "fullscreen", platform: "win32" | "darwin") {
  const target = { windowId: WINDOW_ID, displayId: 41, scaleFactor: 2,
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    bounds: { x: 120, y: 90, width: 1080, height: 720 }, presentation };
  const projection = { displayId: 41, bounds: target.bounds, visible: false,
    focused: false, presentation: "normal" as const };
  const host = { id: 71, logicalWindowId: WINDOW_ID,
    ...(platform === "darwin" ? { appKitIdentity: {
      logicalWindowId: WINDOW_ID, launchGeneration: "launch-1", nativeGeneration: 5
    } } : {}),
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

describe.each(["win32", "darwin"] as const)("%s staged initial presentation", platform => {
  describe.each(["maximized", "fullscreen"] as const)("%s coherence", presentation => {
    it("retains the desired mode while native readback remains honestly hidden normal", () => {
      const { core, native, target, host } = fixture(presentation, platform);
      expect(native.windows[0]).toMatchObject({ presentation: "normal", visible: false,
        pendingInitialPresentation: { presentation, nativeHostId: 71,
          windowGeneration: 3, topologyRevision: 7 }, target: { presentation } });
      expect(host.readProjection().presentation).toBe("normal");
      expect(pendingInitialPresentationMatches(native.windows[0]!)).toBe(true);
      if (platform === "darwin") {
        expect(native.windows[0]!.pendingInitialPresentation).toMatchObject({ appKitIdentity: host.appKitIdentity });
        expect(Object.isFrozen(native.windows[0]!.pendingInitialPresentation!.appKitIdentity)).toBe(true);
      }
      expect(targetMatchesCurrentHost(target, host)).toBe(true);
      expect(inspectLaunchWindowFence(core, native, WINDOW_ID).reason).toBeNull();
      expect(projectCoreAppSnapshot(core, native, topology(), CAPTURED_AT)
        .embeddedRuntimeState.windows[0]).toMatchObject({ presentation, visible: false });
    });

    it.each(["visible", "focused", "generation", "revision", "native-host", "target", "core-mode"] as const)(
      "rejects a staged mode with a mismatched %s fence", (mutation) => {
        const { core, native } = fixture(presentation, platform);
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
      const { host, target, projection } = fixture(presentation, platform);
      projection.visible = true;
      expect(targetMatchesCurrentHost(target, host)).toBe(false);
    });
});
});

describe.each(["maximized", "fullscreen"] as const)("AppKit staged %s identity", presentation => {
  it("captures the pending owner independently of the mutable host identity", () => {
    const { host, native } = fixture(presentation, "darwin");
    host.appKitIdentity!.nativeGeneration += 1;
    expect(native.windows[0]!.appKitIdentity!.nativeGeneration).toBe(5);
    expect(native.windows[0]!.pendingInitialPresentation!.appKitIdentity!.nativeGeneration).toBe(5);
  });

  it.each(["empty-launch", "invalid-generation"] as const)("rejects equally malformed %s owners", mutation => {
    const { native } = fixture(presentation, "darwin");
    const window = native.windows[0]!;
    const identity = { ...window.appKitIdentity!,
      ...(mutation === "empty-launch" ? { launchGeneration: " " } : { nativeGeneration: 0 }) };
    expect(pendingInitialPresentationMatches({ ...window, appKitIdentity: identity,
      pendingInitialPresentation: { ...window.pendingInitialPresentation!, appKitIdentity: identity }
    })).toBe(false);
  });

  it.each(["logicalWindowId", "launchGeneration", "nativeGeneration", "missing", "empty-launch", "invalid-generation"] as const)(
    "rejects a mismatched %s in the captured pending owner", mutation => {
      const { core, native } = fixture(presentation, "darwin");
      const window = native.windows[0]!;
      const identity = window.appKitIdentity!;
      const changedIdentity = mutation === "missing" ? undefined : { ...identity,
        ...(mutation === "logicalWindowId" ? { logicalWindowId: "replaced-window" } : {}),
        ...(mutation === "launchGeneration" ? { launchGeneration: "replaced-launch" } : {}),
        ...(mutation === "nativeGeneration" ? { nativeGeneration: identity.nativeGeneration + 1 } : {}),
        ...(mutation === "empty-launch" ? { launchGeneration: " " } : {}),
        ...(mutation === "invalid-generation" ? { nativeGeneration: 0 } : {}),
      };
      const invalid = { ...native, windows: [{ ...window,
        pendingInitialPresentation: { ...window.pendingInitialPresentation!, appKitIdentity: changedIdentity }
      }] };
      expect(pendingInitialPresentationMatches(invalid.windows[0]!)).toBe(false);
      expect(inspectLaunchWindowFence(core, invalid, WINDOW_ID).reason).toBe("initial-presentation");
      expect(() => projectCoreAppSnapshot(core, invalid, topology(), CAPTURED_AT))
        .toThrow(expect.objectContaining({ code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY" }));
    });

  it("rejects an AppKit pending owner on a Windows host", () => {
    const { native } = fixture(presentation, "win32");
    const window = native.windows[0]!;
    expect(pendingInitialPresentationMatches({ ...window,
      pendingInitialPresentation: { ...window.pendingInitialPresentation!, appKitIdentity: {
        logicalWindowId: WINDOW_ID, launchGeneration: "launch-1", nativeGeneration: 5
      } }
    })).toBe(false);
  });
});
