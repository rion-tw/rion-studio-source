import { describe, expect, it, vi } from "vitest";

import { configureChromiumCommandLine } from "../src/main/game-browser/BrowserLaunchConfiguration";

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
});
