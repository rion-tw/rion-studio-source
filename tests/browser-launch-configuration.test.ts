import { describe, expect, it, vi } from "vitest";

import {
  configureChromiumCommandLine,
  normalizeAppliedBrowserGraphicsMode
} from "../src/main/game-browser/BrowserLaunchConfiguration";

describe("browser launch configuration", () => {
  it("accepts only Rust-validated graphics modes at the Electron command-line boundary", () => {
    expect(normalizeAppliedBrowserGraphicsMode(undefined)).toBe("automatic");
    expect(normalizeAppliedBrowserGraphicsMode("unsafe")).toBe("automatic");
    expect(normalizeAppliedBrowserGraphicsMode("experimental")).toBe("experimental");
  });

  it("preserves existing disabled features and applies the safe high-performance switches", () => {
    const appendSwitch = vi.fn();
    configureChromiumCommandLine(
      {
        appendSwitch,
        getSwitchValue: vi.fn(() => "ExistingFeature,MediaRouter")
      },
      "high_performance"
    );

    expect(appendSwitch).toHaveBeenCalledWith("force-high-performance-gpu");
    expect(appendSwitch).not.toHaveBeenCalledWith("ignore-gpu-blocklist");
    expect(appendSwitch).toHaveBeenCalledWith(
      "disable-features",
      "ExistingFeature,MediaRouter,OptimizationHints,Translate"
    );
  });

  it("limits unsafe switches to explicitly selected experimental mode", () => {
    const appendSwitch = vi.fn();
    configureChromiumCommandLine(
      { appendSwitch, getSwitchValue: vi.fn(() => "") },
      "experimental"
    );

    expect(appendSwitch).toHaveBeenCalledWith("force-high-performance-gpu");
    expect(appendSwitch).toHaveBeenCalledWith("ignore-gpu-blocklist");
    expect(appendSwitch).toHaveBeenCalledWith("enable-unsafe-webgpu");
  });
});
