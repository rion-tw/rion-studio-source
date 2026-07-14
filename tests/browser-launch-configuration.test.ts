import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  configureChromiumCommandLine,
  readAppliedBrowserGraphicsMode
} from "../src/main/game-browser/BrowserLaunchConfiguration";

describe("browser launch configuration", () => {
  it("uses automatic mode for missing or invalid startup settings", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-graphics-launch-"));
    expect(readAppliedBrowserGraphicsMode(userDataDir)).toBe("automatic");

    await writeFile(join(userDataDir, "game-browser-settings.json"), "{invalid", "utf8");
    expect(readAppliedBrowserGraphicsMode(userDataDir)).toBe("automatic");
  });

  it("reads the persisted mode synchronously before Electron becomes ready", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "rion-graphics-launch-"));
    await writeFile(
      join(userDataDir, "game-browser-settings.json"),
      JSON.stringify({ graphics: { mode: "experimental" } }),
      "utf8"
    );

    expect(readAppliedBrowserGraphicsMode(userDataDir)).toBe("experimental");
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
