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
      expect(buildMainWindowOptions(platform, webPreferences, false)).toMatchObject({
        width: 1440,
        height: 900,
        minWidth: 960,
        minHeight: 640,
        center: true,
        show: false,
        webPreferences
      });
    }
  );

  it("uses native hidden-inset traffic lights and under-window material on macOS", () => {
    expect(buildMainWindowOptions("darwin", webPreferences, false)).toMatchObject({
      title: "",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 18 },
      transparent: true,
      backgroundColor: "#00000000",
      vibrancy: "under-window",
      visualEffectState: "active"
    });
  });

  it("keeps the Windows host opaque so DWM draws its corners, shadow and Mica", () => {
    expect(buildMainWindowOptions(
      "win32",
      webPreferences,
      true,
      "C:\\Rion Studio\\rion-studio.ico"
    )).toMatchObject({
      title: "Rion Studio",
      frame: false,
      transparent: false,
      backgroundMaterial: "mica",
      backgroundColor: "#00000000",
      autoHideMenuBar: true,
      icon: "C:\\Rion Studio\\rion-studio.ico"
    });
  });

  it("falls back to an opaque background when Windows cannot draw Mica", () => {
    expect(buildMainWindowOptions("win32", webPreferences, false)).toMatchObject({
      frame: false,
      transparent: false,
      backgroundMaterial: "none",
      backgroundColor: "#1d1e25"
    });
  });
});
