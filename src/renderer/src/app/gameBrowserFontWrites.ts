import type { GameBrowserSettings } from "../../../shared/types";

type Fonts = GameBrowserSettings["fonts"];

/**
 * The font rows never edit smoothing, so a smoothing toggle saved while their
 * fonts were downloading stays as saved.
 */
export function fontsFromFontRowsSave(saved: GameBrowserSettings, latest: GameBrowserSettings): Fonts {
  return {
    ...saved.fonts,
    fontSmoothingEnabled: latest.fonts?.fontSmoothingEnabled ?? saved.fonts.fontSmoothingEnabled
  };
}

/** The smoothing toggle changes only smoothing on the newest saved fonts. */
export function fontsWithSmoothing(latest: GameBrowserSettings, fontSmoothingEnabled: boolean): Fonts {
  return { ...latest.fonts, fontSmoothingEnabled };
}
