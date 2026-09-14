import { buildMacosAppKitRuntimeWindowOptions } from "../src/electron/main/macosAppKitRuntimeWindowOptions";
import { buildWindowsRuntimeHostWindowOptions } from "../src/electron/main/windowsRuntimeHostWindowOptions";
import { target } from "./support/macosAppKitRuntimeHostFactoryFixtures";
import { describe, expect, it, vi } from "vitest";
import { createTransparentRuntimeView } from "../src/electron/main/transparentRuntimeView";
import type { ChromiumWebContentsViewFactoryPort } from "../src/electron/main/chromiumRoleSurfacePorts";

const options = {} as Parameters<ChromiumWebContentsViewFactoryPort["create"]>[0];
describe.each(["darwin", "win32"])("transparent runtime creation on %s", (_platform) => {
  it("uses transparent macOS composition and a resizable non-transparent Windows HWND", () => {
    const options = _platform === "darwin" ? buildMacosAppKitRuntimeWindowOptions(target())
      : buildWindowsRuntimeHostWindowOptions(target());
    expect(options.transparent).toBe(_platform === "darwin");
    expect(options.backgroundColor).toBe("#00000000");
    expect(options.resizable).not.toBe(false);
    if (_platform === "darwin") expect(options.frame).toBe(true);
    else expect(options.backgroundMaterial).toBe("mica");
  });
  it("sets native transparency before the caller can attach or navigate, on every generation", () => {
    const order: string[] = [];
    const views = [1,2].map(() => ({
      setBackgroundColor: vi.fn(color => order.push(color)),
      webContents: { close: vi.fn() }
    }));
    let generation = 0;
    const factory = { create: () => views[generation++] } as unknown as ChromiumWebContentsViewFactoryPort;
    for (let i=0;i<2;i++) {
      createTransparentRuntimeView(factory, options);
      order.push("attach", "navigate");
    }
    expect(order).toEqual(["#00000000","attach","navigate","#00000000","attach","navigate"]);
    expect(views.every(view => view.webContents.close.mock.calls.length === 0)).toBe(true);
  });
  it("closes an unmounted view when transparency setup fails", () => {
    const failure = new Error("native color failed");
    const close = vi.fn();
    const factory = { create: () => ({ setBackgroundColor: () => { throw failure; }, webContents: { close } }) } as unknown as ChromiumWebContentsViewFactoryPort;
    expect(() => createTransparentRuntimeView(factory, options)).toThrow(failure);
    expect(close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });
  it("retains both initialization and destruction failures", () => {
    const failure = new Error("native color failed"), cleanup = new Error("native close failed");
    const factory = { create: () => ({ setBackgroundColor: () => { throw failure; },
      webContents: { close: () => { throw cleanup; } } }) } as unknown as ChromiumWebContentsViewFactoryPort;
    expect(() => createTransparentRuntimeView(factory, options)).toThrow(expect.objectContaining({ errors: [failure, cleanup] }));
  });
});
