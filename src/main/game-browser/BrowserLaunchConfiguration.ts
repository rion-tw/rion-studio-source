import type { ChromiumSwitchRecord } from "../../shared/generated";

export interface ChromiumCommandLine {
  appendSwitch: (name: string, value?: string) => void;
}

export function configureChromiumCommandLine(
  commandLine: ChromiumCommandLine,
  switches: ChromiumSwitchRecord[]
): void {
  // Rust filters platform-incompatible switches before Electron starts.
  for (const chromiumSwitch of switches) {
    if (chromiumSwitch.value === undefined) {
      commandLine.appendSwitch(chromiumSwitch.name);
    } else {
      commandLine.appendSwitch(chromiumSwitch.name, chromiumSwitch.value);
    }
  }
}

export function formatChromiumSwitches(
  switches: ChromiumSwitchRecord[]
): string {
  return switches
    .map(({ name, value }) => value === undefined
      ? `--${name}`
      : `--${name}=${value}`)
    .join(" ");
}
