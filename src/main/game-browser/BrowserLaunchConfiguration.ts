import {
  BROWSER_BACKGROUND_FEATURES_TO_DISABLE,
  BROWSER_BASE_SWITCHES,
  getGraphicsModeSwitches,
  mergeCommaSeparatedSwitchValue
} from "../../shared/browserGraphics";
import type { BrowserGraphicsMode } from "../../shared/types";

export interface ChromiumCommandLine {
  appendSwitch: (name: string, value?: string) => void;
  getSwitchValue: (name: string) => string;
}

export function normalizeAppliedBrowserGraphicsMode(value: unknown): BrowserGraphicsMode {
  return value === "high_performance" || value === "experimental" ? value : "automatic";
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
