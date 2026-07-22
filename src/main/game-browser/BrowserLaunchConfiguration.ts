import {
  BROWSER_BACKGROUND_FEATURES_TO_DISABLE,
  BROWSER_BASE_SWITCHES,
  getGraphicsSwitches,
  mergeCommaSeparatedSwitchValue
} from "../../shared/browserGraphics";
import { normalizeBrowserGraphicsSettings } from "../../shared/browserFonts";
import type { BrowserGraphicsSettings } from "../../shared/types";

export interface ChromiumCommandLine {
  appendSwitch: (name: string, value?: string) => void;
  getSwitchValue: (name: string) => string;
}

export function normalizeAppliedBrowserGraphicsSettings(value: unknown): BrowserGraphicsSettings {
  return normalizeBrowserGraphicsSettings(value);
}

export function configureChromiumCommandLine(
  commandLine: ChromiumCommandLine,
  settings: BrowserGraphicsSettings,
  platform: NodeJS.Platform = process.platform
): void {
  for (const name of BROWSER_BASE_SWITCHES) {
    commandLine.appendSwitch(name);
  }

  for (const chromiumSwitch of getGraphicsSwitches(settings, platform)) {
    if (chromiumSwitch.name === "enable-features" && chromiumSwitch.value) {
      commandLine.appendSwitch(
        chromiumSwitch.name,
        mergeCommaSeparatedSwitchValue(commandLine.getSwitchValue(chromiumSwitch.name), [chromiumSwitch.value])
      );
    } else if (chromiumSwitch.value === undefined) {
      commandLine.appendSwitch(chromiumSwitch.name);
    } else {
      commandLine.appendSwitch(chromiumSwitch.name, chromiumSwitch.value);
    }
  }

  commandLine.appendSwitch(
    "disable-features",
    mergeCommaSeparatedSwitchValue(
      commandLine.getSwitchValue("disable-features"),
      BROWSER_BACKGROUND_FEATURES_TO_DISABLE
    )
  );
}
