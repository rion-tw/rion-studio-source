export interface ElectronMainWindowRevealPort {
  readonly isDestroyed: () => boolean;
  readonly isVisible: () => boolean;
  readonly webContents: {
    readonly once: (event: "dom-ready", listener: () => void) => unknown;
  };
  readonly once: (event: "ready-to-show", listener: () => void) => unknown;
  readonly show: () => void;
}

/** Reveals the initially hidden shell from Chromium document/paint readiness. */
export function revealElectronMainWindowOnStartupReady(
  window: ElectronMainWindowRevealPort
): void {
  let revealed = false;
  const reveal = (): void => {
    if (revealed || window.isDestroyed() || window.isVisible()) return;
    revealed = true;
    window.show();
  };
  window.webContents.once("dom-ready", reveal);
  window.once("ready-to-show", reveal);
}
