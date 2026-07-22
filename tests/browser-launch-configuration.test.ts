import { describe, expect, it, vi } from "vitest";

import {
  configureChromiumCommandLine,
  normalizeAppliedBrowserGraphicsSettings
} from "../src/main/game-browser/BrowserLaunchConfiguration";
import {
  DEFAULT_BROWSER_GRAPHICS_SETTINGS,
  LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS
} from "../src/shared/browserFonts";

describe("browser launch configuration", () => {
  it("normalizes flattened and legacy graphics settings at the Electron command-line boundary", () => {
    expect(normalizeAppliedBrowserGraphicsSettings(undefined)).toEqual(DEFAULT_BROWSER_GRAPHICS_SETTINGS);
    expect(normalizeAppliedBrowserGraphicsSettings({ mode: "unsafe" })).toEqual(
      LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS
    );
    expect(normalizeAppliedBrowserGraphicsSettings({ mode: "experimental" })).toMatchObject({
      gpuBlocklistEnabled: false,
      preferHighPerformanceGpu: true,
      unsafeWebGpuEnabled: true
    });
  });

  it("preserves existing disabled features and applies the safe high-performance switches", () => {
    const appendSwitch = vi.fn();
    configureChromiumCommandLine(
      {
        appendSwitch,
        getSwitchValue: vi.fn(() => "ExistingFeature,MediaRouter")
      },
      { ...LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS, preferHighPerformanceGpu: true },
      "darwin"
    );

    expect(appendSwitch).toHaveBeenCalledWith("force-high-performance-gpu");
    expect(appendSwitch).not.toHaveBeenCalledWith("ignore-gpu-blocklist");
    expect(appendSwitch).toHaveBeenCalledWith(
      "disable-features",
      "ExistingFeature,MediaRouter,OptimizationHints,Translate"
    );
  });

  it("applies each selected aggressive switch without changing background scheduling", () => {
    const appendSwitch = vi.fn();
    configureChromiumCommandLine(
      { appendSwitch, getSwitchValue: vi.fn(() => "") },
      DEFAULT_BROWSER_GRAPHICS_SETTINGS,
      "win32"
    );

    expect(appendSwitch).toHaveBeenCalledWith("force-high-performance-gpu");
    expect(appendSwitch).toHaveBeenCalledWith("enable-gpu-rasterization");
    expect(appendSwitch).toHaveBeenCalledWith("ignore-gpu-blocklist");
    expect(appendSwitch).toHaveBeenCalledWith("enable-unsafe-webgpu");
    expect(appendSwitch).toHaveBeenCalledWith("disable-frame-rate-limit");
    expect(appendSwitch).toHaveBeenCalledWith("disable-gpu-vsync");
    expect(appendSwitch).not.toHaveBeenCalledWith("disable-gpu-driver-bug-workarounds");
    expect(appendSwitch).not.toHaveBeenCalledWith("disable-background-timer-throttling");
    expect(appendSwitch).not.toHaveBeenCalledWith("disable-renderer-backgrounding");
    expect(appendSwitch).not.toHaveBeenCalledWith("disable-backgrounding-occluded-windows");
    expect(appendSwitch).not.toHaveBeenCalledWith("enable-zero-copy");
  });

  it("disables GPU driver workarounds only when explicitly requested", () => {
    const appendSwitch = vi.fn();
    configureChromiumCommandLine(
      { appendSwitch, getSwitchValue: vi.fn(() => "") },
      {
        ...LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
        driverBugWorkaroundsEnabled: false
      },
      "darwin"
    );

    expect(appendSwitch).toHaveBeenCalledWith("disable-gpu-driver-bug-workarounds");
  });

  it("merges Vulkan with existing enabled features on Windows", () => {
    const appendSwitch = vi.fn();
    configureChromiumCommandLine(
      {
        appendSwitch,
        getSwitchValue: vi.fn((name) => name === "enable-features" ? "ExistingFeature" : "")
      },
      {
        ...LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
        backend: { macos: "automatic", windows: "vulkan" }
      },
      "win32"
    );

    expect(appendSwitch).toHaveBeenCalledWith("use-angle", "vulkan");
    expect(appendSwitch).toHaveBeenCalledWith("use-vulkan", "native");
    expect(appendSwitch).toHaveBeenCalledWith("enable-features", "ExistingFeature,Vulkan");
  });
});
