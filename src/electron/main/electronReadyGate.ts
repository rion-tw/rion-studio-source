export interface ElectronReadyGatePort {
  whenReady: () => Promise<unknown>;
}

/**
 * Establishes Electron's authoritative ready boundary before any caller may
 * touch screen, session, BaseWindow, BrowserWindow, or WebContentsView.
 */
export async function runElectronReadyPhase<Result>(
  app: ElectronReadyGatePort,
  operation: () => Result | Promise<Result>
): Promise<Result> {
  await app.whenReady();
  return operation();
}
