import { describe, expect, it } from "vitest";

import { buildMainWindowOptions } from "../src/electron/main/windowOptions";

const webPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false
};

describe("Electron main-window options", () => {
  it.each(["darwin", "win32"] as const)(
    "keeps the shared hidden startup and sizing contract on %s",
    (platform) => {
      expect(buildMainWindowOptions(platform, webPreferences)).toMatchObject({
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        center: true,
        show: false,
        backgroundColor: "#00000000",
        webPreferences
      });
    }
  );

  it("uses native hidden-inset traffic lights and under-window material on macOS", () => {
    expect(buildMainWindowOptions("darwin", webPreferences)).toMatchObject({
      title: "",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      transparent: true,
      vibrancy: "under-window",
      visualEffectState: "active"
    });
  });

  it("uses the renderer-owned caption controls and Mica material on Windows", () => {
    expect(buildMainWindowOptions("win32", webPreferences)).toMatchObject({
      title: "Rion Studio",
      frame: false,
      transparent: true,
      backgroundMaterial: "mica",
      autoHideMenuBar: true
    });
  });
});
