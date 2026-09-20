import { BrowserWindow, screen } from "electron";
import type { DisplayTopologySnapshotRecord } from "../../shared/generated";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { LoadedRionNodeAddon } from "./electronCoreBootstrap";
import type { ChromiumRuntimeBootstrap, MacosAppKitRuntimeBootstrapAdapter } from "./chromiumRuntimeBootstrap";
import { RuntimeTabDragController, type RuntimeTabDragInput, type RuntimeTabDragStart } from "./runtimeTabDragController";

export function createRuntimeTabDragBootstrap(input: {
  core: ElectronCoreCommandPort;
  platform: "darwin" | "win32";
  runtime: () => ChromiumRuntimeBootstrap | null;
  addon: () => LoadedRionNodeAddon | null;
  displays: () => DisplayTopologySnapshotRecord;
  epoch: () => number;
  appKit?: MacosAppKitRuntimeBootstrapAdapter;
  onError: (error: unknown) => void;
}) {
  const runtime = () => {
    const value = input.runtime();
    if (!value) throw new Error("The Chromium drag runtime is unavailable.");
    return value;
  };
  const controller = new RuntimeTabDragController({ core: input.core, platform: input.platform,
    native: () => runtime().snapshot(), displays: input.displays, epoch: input.epoch,
    host: (id, generation) => runtime().tabDragHost(id, generation),
    ...(input.platform === "darwin" && input.appKit?.rendererActions ? {
      appKit: { factory: input.appKit.hostFactory, events: input.appKit.rendererActions }
    } : {}),
    canTarget: (id, point) => {
      if (input.platform !== "win32") return true;
      const snapshot = runtime().snapshot().windows.find(w => w.windowId === id);
      const window = snapshot?.parentNativeHostId === undefined ? null : BrowserWindow.fromId(snapshot.parentNativeHostId);
      if (!window || window.isDestroyed()) return false;
      const physical = screen.dipToScreenPoint(point);
      return input.addon()?.windowsTabDragHitTest(window.getNativeWindowHandle(), physical.x, physical.y) ?? false;
    },
    onTerminal: id => { if (input.platform === "win32") input.addon()?.endWindowsTabDrag(id); },
    onError: input.onError
  });
  return {
    receive: (event: RuntimeTabDragInput) => controller.receive(event),
    observeNativeProjection: () => controller.observeNativeProjection(),
    failEventStream: () => controller.failEventStream(),
    dispose: () => controller.dispose(),
    startWindows(start: RuntimeTabDragStart) {
      const addon = input.addon();
      const source = runtime().snapshot().windows.find(w => w.windowId === start.sourceWindowId);
      const window = source?.parentNativeHostId === undefined ? null : BrowserWindow.fromId(source.parentNativeHostId);
      if (!addon || !window || !source?.tabIds.includes(start.tabId)) throw new Error("The native tab drag source HWND is unavailable.");
      addon.startWindowsTabDrag(window.getNativeWindowHandle(), start.sessionId, id => {
        try {
          const raw = addon.takeWindowsTabDragSample(id);
          if (!raw) return;
          const sample = JSON.parse(raw) as { phase: "move" | "end" | "cancel"; x: number; y: number };
          if (!["move", "end", "cancel"].includes(sample.phase) || ![sample.x, sample.y].every(Number.isFinite)) {
            throw new Error("The native tab drag stream emitted a malformed sample.");
          }
          if (sample.phase !== "move") addon.endWindowsTabDrag(id);
          controller.receive({ sessionId: id, phase: sample.phase,
            point: screen.screenToDipPoint({ x: sample.x, y: sample.y }) });
        } catch (error) {
          addon.endWindowsTabDrag(id);
          controller.receive({ sessionId: id, phase: "cancel", point: start.point });
          input.onError(error);
        }
      });
      controller.receive({ ...start, phase: "start" });
    }
  };
}
