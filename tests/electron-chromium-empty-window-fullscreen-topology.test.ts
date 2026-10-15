import { describe, expect, it, vi } from "vitest";
import type { CoreCommand, EmbeddedLaunchTargetRecord } from "../src/shared/generated";
import { advanceWindowTopology, emptySavedWindow } from "./support/chromiumRuntimeLaunchFixtures";
import { launchHarness, type LaunchHarness } from "./support/electronChromiumRuntimeLaunchHarness";
import { dualDisplayTopology, WINDOW_ID } from "./support/electronChromiumRuntimeLaunchFixtures";

const normalWorkArea = { x: 0, y: 31, width: 1440, height: 809 };
const fullscreenWorkArea = { ...normalWorkArea, height: 869 };
type WaitLane = "native-event" | "projection" | "progress";

function registration(input: Readonly<{
  platform: "macos" | "windows";
  presentation?: EmbeddedLaunchTargetRecord["presentation"];
  change?: (state: LaunchHarness) => void;
  changeWorkArea?: boolean;
  later?: Readonly<{ lane: WaitLane; change: (state: LaunchHarness) => void }>;
}>) {
  let registered: LaunchHarness | undefined;
  const lateChange = vi.fn(() => {
    if (!registered) throw new Error("The target wait preceded its registration.");
    expect(registered.topology.revision).toBe(input.changeWorkArea === false ? 3 : 4);
    expect(registered.nativeSnapshot.windows[0]).toMatchObject({
      windowGeneration: 8, topologyRevision: 8, parentNativeHostId: 71,
      presentation: "fullscreen", visible: true, focused: true,
      appKitIdentity: { logicalWindowId: WINDOW_ID,
        launchGeneration: "fullscreen-reopen", nativeGeneration: 2 }
    });
    input.later!.change(registered);
  });
  const changeAt = (lane: WaitLane): void => {
    if (input.later?.lane === lane && lateChange.mock.calls.length === 0) lateChange();
  };
  const subject = launchHarness({
    ...(input.later ? {
      settleWindowNativeEvents: async () => { changeAt("native-event"); return false; },
      settleWindowProjection: async () => { changeAt("projection"); return false; },
      observeWindowProgress: () => {
        changeAt("progress");
        return { readSequence: () => 0, dispose: () => undefined };
      }
    } : {}),
    onRegister: (_command, state) => {
      state.coreSnapshot.logicalWindows[0]!.windowGeneration = 8;
      state.coreSnapshot.logicalWindows[0]!.revision = 8;
      state.coreSnapshot.runtimeRevision = 8;
      state.nativeSnapshot = { ...state.nativeSnapshot,
        windows: state.nativeSnapshot.windows.map(window => ({ ...window,
          windowGeneration: 8, topologyRevision: 8, parentNativeHostId: 71,
          ...(input.platform === "macos" ? { appKitIdentity: {
            logicalWindowId: WINDOW_ID, launchGeneration: "fullscreen-reopen", nativeGeneration: 2
          } } : {})
        }))
      };
      if (input.changeWorkArea !== false) {
        state.topology = structuredClone(state.topology);
        state.topology.revision = 4;
        state.topology.displays[0]!.workArea = { ...fullscreenWorkArea };
      }
      input.change?.(state);
      registered = state;
    }
  });
  subject.state.topology = dualDisplayTopology();
  subject.state.topology.revision = 3;
  subject.state.topology.displays[0]!.workArea = { ...normalWorkArea };
  const saved = emptySavedWindow();
  saved.placement.presentation = input.presentation ?? "fullscreen";
  saved.placement.savedWorkArea = { ...normalWorkArea };
  subject.state.coreSnapshot.state.gameWindows.push(structuredClone(saved));
  return { ...subject, saved, lateChange };
}

function retireCommands(commands: readonly [CoreCommand, ...unknown[]][]) {
  return commands.filter(([command]) => command.type === "embeddedWindowRetireProvision");
}

describe("macOS empty fullscreen registration display transition", () => {
  it("retains the exact visible host when fullscreen changes only its display work area", async () => {
    const { coordinator, coreInvoke, state, saved } = registration({ platform: "macos" });

    await expect(coordinator.openEmptySavedGameWindow(saved)).resolves.toBeUndefined();

    expect(retireCommands(coreInvoke.mock.calls)).toEqual([]);
    expect(state.coreSnapshot.logicalWindows).toEqual([expect.objectContaining({
      windowId: WINDOW_ID, windowGeneration: 8, revision: 8, presentation: "fullscreen", tabs: []
    })]);
    expect(state.nativeSnapshot.windows).toEqual([expect.objectContaining({
      windowId: WINDOW_ID, windowGeneration: 8, topologyRevision: 8,
      parentNativeHostId: 71, presentation: "fullscreen", visible: true, focused: true,
      activeTabId: "", tabIds: [], bounds: saved.placement.normalBounds,
      appKitIdentity: { logicalWindowId: WINDOW_ID, launchGeneration: "fullscreen-reopen", nativeGeneration: 2 }
    })]);
    expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
    expect(state.topology.revision).toBe(4);
    expect(state.topology.displays[0]!.workArea).toEqual(fullscreenWorkArea);
  });

  it("accepts a fullscreen work-area event first observed in the fresh coherent snapshot", async () => {
    const { coordinator, coreInvoke, state, saved } = registration({
      platform: "macos", changeWorkArea: false
    });
    const invoke = coreInvoke.getMockImplementation()!;
    let registered = false;
    let changed = false;
    coreInvoke.mockImplementation(async command => {
      const result = await invoke(command);
      if (command.type === "embeddedWindowRegister") registered = true;
      else if (command.type === "appSnapshot" && registered && !changed) {
        expect(state.topology.revision).toBe(3);
        state.topology = structuredClone(state.topology);
        state.topology.revision = 4;
        state.topology.displays[0]!.workArea = { ...fullscreenWorkArea };
        changed = true;
      }
      return result;
    });

    await expect(coordinator.openEmptySavedGameWindow(saved)).resolves.toBeUndefined();

    expect(changed).toBe(true);
    expect(retireCommands(coreInvoke.mock.calls)).toEqual([]);
    expect(state.nativeSnapshot.windows[0]).toMatchObject({
      windowGeneration: 8, topologyRevision: 8, parentNativeHostId: 71,
      presentation: "fullscreen", bounds: saved.placement.normalBounds,
      appKitIdentity: { launchGeneration: "fullscreen-reopen", nativeGeneration: 2 }
    });
    expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
  });

  const topologyChanges: ReadonlyArray<Readonly<{
    name: string;
    change: (state: LaunchHarness) => void;
  }>> = [
    { name: "target display fingerprint", change: state => { state.topology.displays[0]!.label = "Different display"; } },
    { name: "target display bounds", change: state => { state.topology.displays[0]!.bounds.width += 1; } },
    { name: "target display resolution", change: state => { state.topology.displays[0]!.resolution.width += 1; } },
    { name: "target display scale", change: state => { state.topology.displays[0]!.scaleFactor = 1; } },
    { name: "target display removal", change: state => {
      state.topology.displays.shift();
      state.topology.displays[0]!.isPrimary = true;
      state.topology.primaryDisplayId = "99";
    } },
    { name: "other display fingerprint", change: state => { state.topology.displays[1]!.label = "Different external"; } },
    { name: "other display work area", change: state => { state.topology.displays[1]!.workArea.height -= 1; } },
    { name: "primary display", change: state => {
      state.topology.displays[0]!.isPrimary = false;
      state.topology.displays[1]!.isPrimary = true;
      state.topology.primaryDisplayId = "99";
    } },
    { name: "topology revision regression", change: state => { state.topology.revision = 2; } }
  ];

  it.each(topologyChanges)("rejects $name drift during fullscreen admission", async ({ change }) => {
    const { coordinator, coreInvoke, state, saved } = registration({ platform: "macos", change });

    await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_DISPLAY_CHANGED"
    });

    expect(retireCommands(coreInvoke.mock.calls)).toHaveLength(1);
    expect(state.nativeSnapshot.windows).toEqual([]);
    expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
  });

  it.each([
    { platform: "macos", presentation: "normal" },
    { platform: "macos", presentation: "maximized" },
    { platform: "windows", presentation: "fullscreen" }
  ] as const)("keeps $platform $presentation work-area changes strict", async input => {
    const { coordinator, coreInvoke, state, saved } = registration(input);

    await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_DISPLAY_CHANGED"
    });

    expect(retireCommands(coreInvoke.mock.calls)).toHaveLength(1);
    expect(state.nativeSnapshot.windows).toEqual([]);
  });

  it.each(["generation", "presentation", "visibility", "malformed normal bounds"] as const)(
    "retains the exact native %s fence after fullscreen registration", async mismatch => {
      const { coordinator, coreInvoke, state, saved } = registration({
        platform: "macos", changeWorkArea: false, change: current => {
          current.nativeSnapshot = { ...current.nativeSnapshot,
            windows: current.nativeSnapshot.windows.map(window => ({ ...window,
              ...(mismatch === "generation" ? { windowGeneration: 9 } : {}),
              ...(mismatch === "presentation" ? { presentation: "normal" as const } : {}),
              ...(mismatch === "visibility" ? { visible: false, focused: false } : {}),
              ...(mismatch === "malformed normal bounds" ? { bounds: { ...window.bounds, width: 0 } } : {})
            }))
          };
        }
      });

      const code = mismatch === "generation" ? "ELECTRON_RUNTIME_PROJECTION_NOT_READY"
        : mismatch === "malformed normal bounds" ? "ELECTRON_CHROMIUM_LIVE_WINDOW_GEOMETRY_INVALID"
        : "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE";
      await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({ code });

      expect(retireCommands(coreInvoke.mock.calls)).toHaveLength(1);
      expect(state.nativeSnapshot.windows).toEqual([]);
      expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
    }
  );

  it("rejects initial fullscreen evidence from another display even if the later host moves back", async () => {
    const { coordinator, coreInvoke, state, saved, lateChange } = registration({
      platform: "macos",
      change: current => {
        current.nativeSnapshot = { ...current.nativeSnapshot, windows: current.nativeSnapshot.windows.map(window =>
          ({ ...window, displayId: 99 })) };
      },
      later: { lane: "native-event", change: current => {
        current.nativeSnapshot = { ...current.nativeSnapshot, windows: current.nativeSnapshot.windows.map(window =>
          ({ ...window, displayId: 41 })) };
      } }
    });

    await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
      code: "ELECTRON_CHROMIUM_EMPTY_WINDOW_DISPLAY_CHANGED"
    });

    expect(lateChange).not.toHaveBeenCalled();
    expect(retireCommands(coreInvoke.mock.calls)).toHaveLength(1);
    expect(state.nativeSnapshot.windows).toEqual([]);
  });

  describe.each(["native-event", "projection", "progress"] as const)("after %s admission", lane => {
    it("accepts a first fullscreen work-area event after the original exact coherent snapshot", async () => {
      const { coordinator, coreInvoke, state, saved, lateChange } = registration({
        platform: "macos", changeWorkArea: false, later: { lane, change: current => {
          current.topology = structuredClone(current.topology);
          current.topology.revision = 4;
          current.topology.displays[0]!.workArea = { ...fullscreenWorkArea };
        } }
      });

      await expect(coordinator.openEmptySavedGameWindow(saved)).resolves.toBeUndefined();

      expect(lateChange).toHaveBeenCalledOnce();
      expect(retireCommands(coreInvoke.mock.calls)).toEqual([]);
      expect(state.topology.revision).toBe(4);
      expect(state.nativeSnapshot.windows[0]).toMatchObject({
        windowGeneration: 8, topologyRevision: 8, parentNativeHostId: 71,
        presentation: "fullscreen", bounds: saved.placement.normalBounds,
        appKitIdentity: { launchGeneration: "fullscreen-reopen", nativeGeneration: 2 }
      });
      expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
    });

    const races: ReadonlyArray<Readonly<{
      name: string;
      code?: string;
      change: (state: LaunchHarness) => void;
    }>> = [
      { name: "same-revision target work area", change: state => {
        state.topology = structuredClone(state.topology);
        state.topology.displays[0]!.workArea.height -= 1;
      } },
      { name: "original topology revision and work area", change: state => {
        state.topology = dualDisplayTopology();
        state.topology.revision = 3;
        state.topology.displays[0]!.workArea = { ...normalWorkArea };
      } },
      { name: "display revision with fullscreen work-area delta retained", change: state => {
        state.topology = structuredClone(state.topology);
        state.topology.revision = 3;
      } },
      { name: "replacement owner with original topology", change: state => {
        state.topology = dualDisplayTopology();
        state.topology.revision = 3;
        state.topology.displays[0]!.workArea = { ...normalWorkArea };
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window =>
          ({ ...window, parentNativeHostId: 72, appKitIdentity: { ...window.appKitIdentity!,
            launchGeneration: "replacement-owner", nativeGeneration: 3 } })) };
      } },
      { name: "other display work area", change: state => {
        state.topology = structuredClone(state.topology);
        state.topology.revision += 1;
        state.topology.displays[1]!.workArea.height -= 1;
      } },
      { name: "native mode", change: state => {
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window =>
          ({ ...window, presentation: "normal" as const })) };
      } },
      { name: "AppKit owner", change: state => {
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window =>
          ({ ...window, appKitIdentity: { ...window.appKitIdentity!,
            launchGeneration: "replacement-owner", nativeGeneration: 3 } })) };
      } },
      { name: "native host ID", change: state => {
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window =>
          ({ ...window, parentNativeHostId: 72 })) };
      } },
      { name: "Core and native generation", change: state => {
        state.coreSnapshot.logicalWindows[0]!.windowGeneration = 9;
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window =>
          ({ ...window, windowGeneration: 9 })) };
      } },
      { name: "pending initial marker", code: "ELECTRON_RUNTIME_PROJECTION_NOT_READY", change: state => {
        state.nativeSnapshot = { ...state.nativeSnapshot, windows: state.nativeSnapshot.windows.map(window =>
          ({ ...window, pendingInitialPresentation: {
            presentation: "fullscreen" as const, nativeHostId: 71, windowGeneration: 8,
            topologyRevision: 8, appKitIdentity: { ...window.appKitIdentity! }
          } })) };
      } }
    ];

    it.each(races)("rejects a late $name replacement before the final receipt", async ({ change, code }) => {
      const { coordinator, coreInvoke, state, saved, lateChange } = registration({
        platform: "macos", later: { lane, change }
      });

      await expect(coordinator.openEmptySavedGameWindow(saved)).rejects.toMatchObject({
        code: code ?? "ELECTRON_CHROMIUM_EMPTY_WINDOW_RECEIPT_STALE"
      });

      expect(lateChange).toHaveBeenCalledOnce();
      expect(retireCommands(coreInvoke.mock.calls)).toHaveLength(1);
      expect(state.nativeSnapshot.windows).toEqual([]);
      expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
    });

    it("accepts a later exact Core/native revision on the same fullscreen owner", async () => {
      const { coordinator, coreInvoke, state, saved, lateChange } = registration({
        platform: "macos", later: { lane, change: current => advanceWindowTopology(current, 1) }
      });

      await expect(coordinator.openEmptySavedGameWindow(saved)).resolves.toBeUndefined();

      expect(lateChange).toHaveBeenCalledOnce();
      expect(retireCommands(coreInvoke.mock.calls)).toEqual([]);
      expect(state.coreSnapshot.logicalWindows[0]).toMatchObject({ windowGeneration: 8, revision: 9 });
      expect(state.nativeSnapshot.windows[0]).toMatchObject({
        windowGeneration: 8, topologyRevision: 9, parentNativeHostId: 71,
        presentation: "fullscreen", bounds: saved.placement.normalBounds,
        appKitIdentity: { launchGeneration: "fullscreen-reopen", nativeGeneration: 2 }
      });
      expect(state.coreSnapshot.state.gameWindows).toEqual([saved]);
    });
  });
});
