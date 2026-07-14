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
