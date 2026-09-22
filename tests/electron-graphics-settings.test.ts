import { describe, expect, it, vi } from "vitest";
import { applyGraphicsStartup } from "../src/electron/main/graphicsStartup";
import { GraphicsDiagnostics } from "../src/electron/main/graphicsDiagnostics";
import { defaultGraphicsSettings } from "../src/shared/graphicsSettings";
import { ElectronMainLifecycle } from "../src/electron/main/lifecycle";
import { createGraphicsApiDispatcher } from "../src/electron/main/graphicsApiDispatcher";
import type { ElectronCoreCommandPort } from "../src/electron/main/coreApiDispatcher";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe.each(["darwin", "win32"] as const)("%s graphics settings", (platform) => {
  it.each(["complete", "reject"] as const)("awaits clipboard %s before settling the report request", async (outcome) => {
    const write = deferred<void>();
    const started = deferred<void>();
    const copyReport = vi.fn((_report: string) => { started.resolve(); return write.promise; });
    const saved = { revision: 1, settings: { ...defaultGraphicsSettings, hardwareAcceleration: false } };
    const core = { invoke: vi.fn(async () => saved) as ElectronCoreCommandPort["invoke"] };
    const diagnostics = new GraphicsDiagnostics({
      on: vi.fn(), removeListener: vi.fn(), isHardwareAccelerationEnabled: () => true,
      getGPUFeatureStatus: () => ({}), getGPUInfo: async () => ({})
    }, defaultGraphicsSettings, { os: platform }, vi.fn());
    const dispatcher = createGraphicsApiDispatcher(core, diagnostics, vi.fn(), {
      invoke: async () => { throw new Error("Unexpected fallback"); }
    }, copyReport);
    const identity = { kind: "main-renderer" as const, windowId: 1, webContentsId: 2, generation: 3 };
    const copy = dispatcher.invoke(identity, "copyGraphicsReport", []);
    const settled = vi.fn();
    void copy.then(settled, settled);
    await started.promise;
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(core.invoke).toHaveBeenCalledWith({ type: "graphicsSettingsGet" });
    expect(JSON.parse(copyReport.mock.calls[0]![0])).toEqual({
      saved, pendingRestart: true, current: diagnostics.snapshot()
    });
    if (outcome === "complete") {
      write.resolve();
      await expect(copy).resolves.toBeUndefined();
    } else {
      const error = new Error("Clipboard write failed");
      write.reject(error);
      await expect(copy).rejects.toBe(error);
    }
    diagnostics.dispose();
  });

  it("applies only selected startup switches and respects the acceleration master switch", () => {
    const app = { isReady: () => false, disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn(), removeSwitch: vi.fn() } };
    const read = (settings = defaultGraphicsSettings) => () => JSON.stringify({ revision: 1, settings });
    applyGraphicsStartup(app, read(), platform);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    applyGraphicsStartup(app, read({ ...defaultGraphicsSettings, rasterization: "enabled", videoDecode: "disabled" }), platform);
    expect(app.commandLine.appendSwitch.mock.calls).toEqual([["enable-gpu-rasterization"], ["disable-accelerated-video-decode"]]);
    app.commandLine.appendSwitch.mockClear();
    applyGraphicsStartup(app, read({ ...defaultGraphicsSettings, hardwareAcceleration: false, rasterization: "enabled" }), platform);
    expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce();
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
    expect(() => applyGraphicsStartup({ ...app, isReady: () => true }, read(), platform)).toThrow("before Electron ready");
    expect(() => applyGraphicsStartup(app, () => "{}", platform)).toThrow("Invalid Rust");
  });

  it("relaunches only after exact clean shutdown and never after a failed drain", async () => {
    const drain = deferred<void>();
    const app = { whenReady: async () => undefined, on: vi.fn(), removeListener: vi.fn(), quit: vi.fn(), relaunch: vi.fn() };
    const lifecycle = new ElectronMainLifecycle({ app, platform, core: { shutdown: () => drain.promise },
      createMainWindow: vi.fn(), requestRendererQuitConfirmation: () => true, onError: vi.fn() });
    const restart = lifecycle.confirmRestart();
    expect(app.relaunch).not.toHaveBeenCalled();
    drain.resolve();
    await restart;
    await lifecycle.confirmRestart();
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    app.relaunch.mockClear();
    const failed = new ElectronMainLifecycle({ app, platform, core: { shutdown: async () => { throw new Error("drain failed"); } },
      createMainWindow: vi.fn(), requestRendererQuitConfirmation: () => true, onError: vi.fn() });
    await expect(failed.confirmRestart()).rejects.toThrow("drain failed");
    expect(app.relaunch).not.toHaveBeenCalled();
  });
});

describe("GPU diagnostics", () => {
  it("waits for the authoritative event, handles failure and rejects stale complete results", async () => {
    let update!: () => void;
    const pending = deferred<unknown>();
    const app = { on: vi.fn((_event, callback) => { update = callback; }), removeListener: vi.fn(),
      isHardwareAccelerationEnabled: () => false, getGPUFeatureStatus: () => ({ rasterization: "disabled_software" }),
      getGPUInfo: vi.fn<() => Promise<unknown>>().mockReturnValueOnce(pending.promise).mockResolvedValue({ gpuDevice: [{ vendorId: 123, active: true }], auxAttributes: { glRenderer: "ANGLE" } }) };
    const publish = vi.fn();
    const service = new GraphicsDiagnostics(app, defaultGraphicsSettings, { os: "win32" }, publish);
    expect((await service.refresh()).initialized).toBe(false);
    expect(app.getGPUInfo).not.toHaveBeenCalled();
    update();
    const newer = await service.refresh();
    pending.resolve({ gpuDevice: [{ vendorId: "stale" }] });
    await pending.promise;
    expect(service.snapshot().devices).toEqual(newer.devices);
    expect(newer.devices).toEqual([{ vendorId: "123", active: "true" }]);
    app.getGPUInfo.mockRejectedValueOnce(new Error("GPU unavailable"));
    expect((await service.refresh()).error).toBe("GPU unavailable");
    const count = publish.mock.calls.length;
    service.dispose(); update();
    expect(publish).toHaveBeenCalledTimes(count);
    expect(app.removeListener).toHaveBeenCalledOnce();
  });
});
