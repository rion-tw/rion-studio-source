export interface ElectronAccessibilityStartupPort {
  readonly commandLine: {
    readonly hasSwitch: (name: string) => boolean;
  };
  readonly setAccessibilitySupportEnabled: (enabled: boolean) => void;
}

/** Applies Chromium's explicit accessibility launch request after Electron is ready. */
export function applyElectronAccessibilityStartupRequest(
  app: ElectronAccessibilityStartupPort
): void {
  if (app.commandLine.hasSwitch("force-renderer-accessibility")) {
    app.setAccessibilitySupportEnabled(true);
  }
}
