import { EventEmitter } from "node:events";

import type { BaseWindow, BaseWindowConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { CoreEvent, RuntimeVersionRecord } from "../src/shared/generated";
import type { CompatibilityCoreEffectAction } from "../src/main/core/ElectronEffectExecutor";
import type { WebSurfaceLifecycleEvent, WebSurfacePort } from "../src/main/browser/ports/WebSurfacePort";
import type { GameCompatibilityReport } from "../src/shared/types";
import { GameCompatibilityManager } from "../src/main/games/GameCompatibilityManager";

const versions: RuntimeVersionRecord = {
  engine: "wkwebview",
  engineVersion: "14.6",
  shell: "electron",
  shellVersion: "40.0.0"
};

const report: GameCompatibilityReport = {
  gameId: "game-1",
  checkedAt: "2026-07-15T00:00:01.000Z",
  configurationFingerprint: "rust-fingerprint",
  isStale: false,
  load: { state: "available", durationMs: 10, finalOrigin: "https://example.test" },
  graphics: { webgl: "available", webgl2: "available", webgpu: "unavailable" },
  recommendation: { reason: "system_webview_available" },
  observations: {}
};

describe("GameCompatibilityManager", () => {
  it("sends one high-level compatibility intent with system runtime versions", async () => {
    const invoke = vi.fn(async (command: { type: string }) =>
      command.type === "compatibilityStatuses" ? [] : report
    );
    const { manager } = createManager({ invoke });

    await expect(manager.runCheck("game-1")).resolves.toEqual(report);

    expect(invoke).toHaveBeenCalledWith({
      type: "engineCompatibilityCacheDeleteGame",
      gameId: "game-1"
    });
    expect(invoke).toHaveBeenLastCalledWith({
      type: "compatibilityRun",
      gameId: "game-1",
      versions
    });
  });

  it("executes the complete compatibility flow in an isolated System WebView", async () => {
    const windows: FakeCompatibilityWindow[] = [];
    const surfaces: FakeSystemSurface[] = [];
    const cleanup = vi.fn(async () => undefined);
    const { manager, invoke } = createManager({
      createSurface: () => {
        const surface = new FakeSystemSurface();
        surfaces.push(surface);
        return { cleanup, surface: surface.asPort() };
      },
      createWindow: (options) => {
        const window = new FakeCompatibilityWindow(options);
        windows.push(window);
        return window.asBaseWindow();
      }
    });

    await manager.executeEffect(effect({
      type: "compatibilityCreateWindow",
      plan: {
        gameId: "game-1",
        gameName: "Example",
        launchUrl: "https://example.test/play",
        startedAt: "2026-07-15T00:00:00.000Z"
      }
    }));
    const created = windows[0]!;
    const surface = surfaces[0]!;
    await manager.executeEffect(effect({
      type: "compatibilityConfigureSession",
      gameId: "game-1"
    }));
    await expect(manager.executeEffect(effect({
      type: "compatibilityLoadUrl",
      gameId: "game-1",
      url: "https://example.test/play"
    }))).resolves.toEqual({ finalUrl: "https://example.test/play?token=private" });
    await expect(manager.executeEffect(effect({
      type: "compatibilityProbeGraphics",
      gameId: "game-1",
      source: "raw-probe"
    }))).resolves.toMatchObject({ webgl: "available" });
    surface.clearStorage.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(manager.executeEffect(effect({
      type: "compatibilityCleanupWindow",
      gameId: "game-1"
    }))).resolves.toBeUndefined();

    expect(created.options).toMatchObject({
      x: 100,
      y: 50,
      width: 1000,
      height: 700,
      show: false
    });
    expect(created.options).not.toHaveProperty("webPreferences");
    expect(created.show).toHaveBeenCalledOnce();
    expect(surface.addDocumentStartScript).toHaveBeenCalledWith("font-script");
    expect(surface.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1000, height: 700 });
    expect(surface.setVisible).toHaveBeenCalledWith(true);
    expect(surface.loadUrl).toHaveBeenCalledWith("https://example.test/play");
    expect(surface.evaluate).toHaveBeenCalledWith("raw-probe");
    expect(surface.clearStorage).toHaveBeenCalledOnce();
    expect(surface.destroy).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(created.destroy).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith({
      type: "compatibilityCancel",
      gameId: "game-1"
    });
  });

  it("cancels and disposes a compatibility run when its native host closes", async () => {
    let window: FakeCompatibilityWindow | undefined;
    const surface = new FakeSystemSurface();
    const { manager, invoke } = createManager({
      createSurface: () => ({ surface: surface.asPort() }),
      createWindow: (options) => {
        window = new FakeCompatibilityWindow(options);
        return window.asBaseWindow();
      }
    });
    await manager.executeEffect(effect({
      type: "compatibilityCreateWindow",
      plan: {
        gameId: "game-1",
        gameName: "Example",
        launchUrl: "https://example.test/play",
        startedAt: "2026-07-15T00:00:00.000Z"
      }
    }));

    window!.close();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        type: "compatibilityCancel",
        gameId: "game-1"
      });
      expect(surface.destroy).toHaveBeenCalledOnce();
    });
  });

  it("projects Rust statuses and delegates report staleness unchanged", async () => {
    let listener: ((events: CoreEvent[]) => void) | undefined;
    const invoke = vi.fn(async (command: { type: string }) =>
      command.type === "compatibilityStatuses" ? [] : [{ ...report, isStale: true }]
    );
    const { manager } = createManager({
      invoke,
      subscribe: (next) => {
        listener = next;
        return () => undefined;
      }
    });
    listener?.([{
      type: "compatibilityStatuses",
      statuses: [{
        gameId: "game-1",
        phase: "probing",
        startedAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:01.000Z"
      }]
    }]);

    expect(manager.listStatuses()).toMatchObject([{ gameId: "game-1", phase: "probing" }]);
    await expect(manager.listReports()).resolves.toMatchObject([{ isStale: true }]);
  });
});

function createManager(options: {
  createSurface?: ConstructorParameters<typeof GameCompatibilityManager>[0]["createSurface"];
  createWindow?: (options: BaseWindowConstructorOptions) => BaseWindow;
  invoke?: ReturnType<typeof vi.fn>;
  subscribe?: (listener: (events: CoreEvent[]) => void) => () => void;
} = {}) {
  const invoke = options.invoke ?? vi.fn(async (command: { type: string }) =>
    command.type === "compatibilityStatuses" ? [] : report
  );
  const manager = new GameCompatibilityManager({
    core: {
      invoke,
      subscribe: options.subscribe ?? (() => () => undefined)
    } as never,
    createSurface: options.createSurface
      ?? (() => ({ surface: new FakeSystemSurface().asPort() })),
    createWindow: options.createWindow
      ?? ((windowOptions) => new FakeCompatibilityWindow(windowOptions).asBaseWindow()),
    getLaunchWorkArea: () => ({ x: 100, y: 50, width: 1000, height: 700 }),
    getSessionConfiguration: async () => ({
      documentStartScript: "font-script",
      proxyServer: "http://proxy.example:8080"
    }),
    getVersions: async () => versions
  });
  return { invoke, manager };
}

function effect<T extends CompatibilityCoreEffectAction>(action: T) {
  return {
    effectId: "effect-1",
    operationId: "operation-1",
    target: { kind: "app" as const, handleId: "game-1" },
    deadlineMs: 100,
    action
  };
}

class FakeCompatibilityWindow extends EventEmitter {
  readonly show = vi.fn();
  readonly options: BaseWindowConstructorOptions;
  private destroyed = false;

  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("closed");
  });

  constructor(options: BaseWindowConstructorOptions) {
    super();
    this.options = options;
  }

  close(): void {
    this.destroyed = true;
    this.emit("closed");
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  asBaseWindow(): BaseWindow {
    return this as unknown as BaseWindow;
  }
}

class FakeSystemSurface {
  private readonly listeners = new Set<(event: WebSurfaceLifecycleEvent) => void>();

  readonly addDocumentStartScript = vi.fn(async () => undefined);
  readonly clearStorage = vi.fn(async () => undefined);
  readonly destroy = vi.fn(async () => undefined);
  readonly evaluate = vi.fn(async (_source: string) => ({
    webgl: "available",
    webgl2: "available",
    webgpu: "unavailable"
  }));
  readonly focus = vi.fn(async () => undefined);
  readonly loadUrl = vi.fn(async () => {
    this.emit({ type: "navigationCompleted", url: "https://example.test/play?token=private" });
  });
  readonly setAudioMuted = vi.fn(async () => undefined);
  readonly setBounds = vi.fn(async () => undefined);
  readonly setVisible = vi.fn(async () => undefined);
  readonly setZoomFactor = vi.fn(async () => undefined);

  asPort(): WebSurfacePort {
    return {
      addDocumentStartScript: this.addDocumentStartScript,
      clearStorage: this.clearStorage,
      destroy: this.destroy,
      evaluate: <T = unknown>(source: string) => this.evaluate(source) as Promise<T>,
      focus: this.focus,
      loadUrl: this.loadUrl,
      onLifecycleEvent: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      setAudioMuted: this.setAudioMuted,
      setBounds: this.setBounds,
      setVisible: this.setVisible,
      setZoomFactor: this.setZoomFactor
    };
  }

  private emit(event: WebSurfaceLifecycleEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
