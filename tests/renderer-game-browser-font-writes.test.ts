import { describe, expect, it } from "vitest";

import { fontsFromFontRowsSave, fontsWithSmoothing } from "../src/renderer/src/app/gameBrowserFontWrites";
import type { GameBrowserSettings } from "../src/shared/types";

function settings(presetId: string, fontSmoothingEnabled: boolean): GameBrowserSettings {
  return { fonts: { presetId, fontSmoothingEnabled } } as unknown as GameBrowserSettings;
}

describe("game browser font writes", () => {
  it("keeps a smoothing toggle saved while the font rows were downloading fonts", () => {
    // Apply started with smoothing on; the user turned it off before downloads finished.
    const fonts = fontsFromFontRowsSave(settings("high-legibility", true), settings("system-default", false));
    expect(fonts).toMatchObject({ presetId: "high-legibility", fontSmoothingEnabled: false });
  });

  it("keeps fonts applied before a smoothing toggle that was based on older fonts", () => {
    const fonts = fontsWithSmoothing(settings("high-legibility", true), false);
    expect(fonts).toMatchObject({ presetId: "high-legibility", fontSmoothingEnabled: false });
  });
});
