import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";

export type ElectronDesktopPlatform = "darwin" | "win32";

export function buildMainWindowOptions(
  platform: ElectronDesktopPlatform,
  webPreferences: WebPreferences
): BrowserWindowConstructorOptions {
  const platformOptions: BrowserWindowConstructorOptions = platform === "darwin"
    ? {
        title: "",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 18, y: 18 },
        transparent: true,
        vibrancy: "under-window",
        visualEffectState: "active"
      }
    : {
        frame: false,
        transparent: true,
        backgroundMaterial: "mica",
        autoHideMenuBar: true
      };

  return {
    title: "Rion Studio",
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    center: true,
    show: false,
    backgroundColor: "#00000000",
    ...platformOptions,
    webPreferences
  };
}
