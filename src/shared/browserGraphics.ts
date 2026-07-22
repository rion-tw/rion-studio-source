import type { BrowserGraphicsSettings } from "./types";

export const BROWSER_BACKGROUND_FEATURES_TO_DISABLE = ["MediaRouter", "OptimizationHints", "Translate"] as const;

export const BROWSER_BASE_SWITCHES = [
  "no-first-run",
  "no-default-browser-check",
  "disable-default-apps",
  "disable-component-extensions-with-background-pages",
  "metrics-recording-only",
  "no-service-autorun",
  "disable-search-engine-choice-screen"
] as const;

// External compatibility sessions deliberately use Chromium's normal background
// scheduling. When one 2K game is fullscreen, this lets Chromium reduce the
// renderer work performed by the other occluded game windows instead of keeping
// every GPU-heavy renderer at foreground priority.
export const EXTERNAL_CHROME_FOREGROUND_PRIORITY_SWITCHES: readonly string[] = [];

export interface ChromiumSwitch {
  name: string;
  value?: string;
}

export function getGraphicsSwitches(
  settings: BrowserGraphicsSettings,
  platform: string
): ChromiumSwitch[] {
  const switches: ChromiumSwitch[] = [];

  if (settings.preferHighPerformanceGpu) switches.push({ name: "force-high-performance-gpu" });
  if (settings.forceGpuRasterization) switches.push({ name: "enable-gpu-rasterization" });
  if (!settings.gpuBlocklistEnabled) switches.push({ name: "ignore-gpu-blocklist" });
  if (settings.unsafeWebGpuEnabled) switches.push({ name: "enable-unsafe-webgpu" });
  if (!settings.frameRateLimitEnabled) switches.push({ name: "disable-frame-rate-limit" });
  if (!settings.vsyncEnabled) switches.push({ name: "disable-gpu-vsync" });
  if (!settings.driverBugWorkaroundsEnabled) {
    switches.push({ name: "disable-gpu-driver-bug-workarounds" });
  }

  if (platform === "darwin" && settings.backend.macos === "metal") {
    switches.push({ name: "use-angle", value: "metal" });
  }
  if (platform === "win32" && settings.backend.windows !== "automatic") {
    if (settings.backend.windows === "vulkan") {
      switches.push(
        { name: "use-angle", value: "vulkan" },
        { name: "use-vulkan", value: "native" },
        { name: "enable-features", value: "Vulkan" }
      );
    } else {
      switches.push({ name: "use-angle", value: settings.backend.windows });
    }
  }

  return switches;
}

export function formatChromiumSwitch({ name, value }: ChromiumSwitch): string {
  return `--${name}${value === undefined ? "" : `=${value}`}`;
}

export function mergeCommaSeparatedSwitchValue(currentValue: string, additions: readonly string[]): string {
  return [...new Set([...currentValue.split(","), ...additions].map((value) => value.trim()).filter(Boolean))].join(",");
}
