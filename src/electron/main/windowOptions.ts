import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";

export type ElectronDesktopPlatform = "darwin" | "win32";

/** Opaque base for Windows hosts that cannot draw a Mica backdrop. */
const WINDOWS_OPAQUE_BACKGROUND = "#1d1e25";

export function buildMainWindowOptions(
  platform: ElectronDesktopPlatform,
  webPreferences: WebPreferences,
  micaEnabled: boolean,
  applicationIconPath?: string
): BrowserWindowConstructorOptions {
  const platformOptions: BrowserWindowConstructorOptions = platform === "darwin"
    ? {
        title: "",
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 18, y: 18 },
        transparent: true,
        backgroundColor: "#00000000",
        vibrancy: "under-window",
        visualEffectState: "active"
      }
    : {
        frame: false,
        // A transparent Windows host is a layered HWND: DWM then withholds the
        // drop shadow and the Windows 11 rounded corners, and drops the backdrop
        // material outright. Stay opaque, exactly as the Game Window host does,
        // and let DWM draw Mica behind the renderer's translucent surfaces.
        transparent: false,
        backgroundMaterial: micaEnabled ? "mica" : "none",
        backgroundColor: micaEnabled ? "#00000000" : WINDOWS_OPAQUE_BACKGROUND,
        autoHideMenuBar: true,
        ...(applicationIconPath === undefined
          ? {}
          : { icon: applicationIconPath })
      };

  return {
    title: "Rion Studio",
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    center: true,
    show: false,
    ...platformOptions,
    webPreferences
  };
}
