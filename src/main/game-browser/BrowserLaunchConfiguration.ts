import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BROWSER_BACKGROUND_FEATURES_TO_DISABLE,
  BROWSER_BASE_SWITCHES,
  getGraphicsModeSwitches,
  mergeCommaSeparatedSwitchValue
} from "../../shared/browserGraphics";
import { normalizeGameBrowserSettings } from "../../shared/browserFonts";
import type { BrowserGraphicsMode } from "../../shared/types";

export interface ChromiumCommandLine {
  appendSwitch: (name: string, value?: string) => void;
  getSwitchValue: (name: string) => string;
}

export function readAppliedBrowserGraphicsMode(userDataDir: string): BrowserGraphicsMode {
  try {
    const value = JSON.parse(readFileSync(join(userDataDir, "game-browser-settings.json"), "utf8"));
    return normalizeGameBrowserSettings(value).graphics.mode;
  } catch {
    return "automatic";
  }
}

export function configureChromiumCommandLine(commandLine: ChromiumCommandLine, mode: BrowserGraphicsMode): void {
  for (const name of BROWSER_BASE_SWITCHES) {
    commandLine.appendSwitch(name);
  }

  for (const name of getGraphicsModeSwitches(mode)) {
    commandLine.appendSwitch(name);
  }

  commandLine.appendSwitch(
    "disable-features",
    mergeCommaSeparatedSwitchValue(
      commandLine.getSwitchValue("disable-features"),
      BROWSER_BACKGROUND_FEATURES_TO_DISABLE
    )
  );
}
