import { describe, expect, it, vi } from "vitest";

import {
  configureChromiumCommandLine,
  formatChromiumSwitches
} from "../src/main/game-browser/BrowserLaunchConfiguration";

describe("browser launch configuration", () => {
  it("applies only the Rust-generated switch plan", () => {
    const appendSwitch = vi.fn();

    configureChromiumCommandLine({ appendSwitch }, [
      { name: "no-first-run" },
      { name: "enable-features", value: "ExistingFeature,Vulkan" },
      { name: "disable-features", value: "MediaRouter,OptimizationHints,Translate" }
    ]);

    expect(appendSwitch.mock.calls).toEqual([
      ["no-first-run"],
      ["enable-features", "ExistingFeature,Vulkan"],
      ["disable-features", "MediaRouter,OptimizationHints,Translate"]
    ]);
  });

  it("formats the same Rust switch plan for WebView2 environment creation", () => {
    expect(formatChromiumSwitches([
      { name: "force-high-performance-gpu" },
      { name: "use-angle", value: "d3d11on12" },
      { name: "enable-features", value: "Vulkan" }
    ])).toBe(
      "--force-high-performance-gpu --use-angle=d3d11on12 --enable-features=Vulkan"
    );
  });
});
