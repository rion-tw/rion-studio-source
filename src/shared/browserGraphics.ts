import type { BrowserGraphicsMode } from "./types";

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

export function getGraphicsModeSwitches(mode: BrowserGraphicsMode): string[] {
  if (mode === "automatic") {
    return [];
  }

  return [
    "force-high-performance-gpu",
    ...(mode === "experimental" ? ["ignore-gpu-blocklist", "enable-unsafe-webgpu"] : [])
  ];
}

export function mergeCommaSeparatedSwitchValue(currentValue: string, additions: readonly string[]): string {
  return [...new Set([...currentValue.split(","), ...additions].map((value) => value.trim()).filter(Boolean))].join(",");
}
