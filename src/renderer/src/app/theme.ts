import { THEME_STORAGE_KEY, themeModes } from "./constants";
import type { ResolvedTheme, ThemeMode } from "./types";

export function readStoredThemeMode(): ThemeMode {
  const storedThemeMode = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(storedThemeMode) ? storedThemeMode : "system";
}

function isThemeMode(value: string | null): value is ThemeMode {
  return value !== null && themeModes.includes(value as ThemeMode);
}

export function resolveTheme(themeMode: ThemeMode): ResolvedTheme {
  if (themeMode !== "system") {
    return themeMode;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
