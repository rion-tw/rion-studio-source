export interface RuntimeWindowControlsOverlay extends EventTarget {
  getTitlebarAreaRect: () => DOMRect;
}

export interface RuntimeTabsNavigator {
  windowControlsOverlay?: RuntimeWindowControlsOverlay;
}

export function installRuntimeTitlebarHeightReporter(
  platform: NodeJS.Platform,
  navigatorValue: RuntimeTabsNavigator,
  report: (height: number) => void
): (() => void) | undefined {
  if (platform !== "darwin") return undefined;
  const overlay = navigatorValue.windowControlsOverlay;
  if (!overlay) return undefined;

  const reportHeight = (): void => {
    try {
      report(overlay.getTitlebarAreaRect().height);
    } catch {
      // Electron may temporarily make the overlay geometry unavailable during a transition.
    }
  };

  reportHeight();
  overlay.addEventListener("geometrychange", reportHeight);
  return () => overlay.removeEventListener("geometrychange", reportHeight);
}
