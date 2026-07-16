import { useEffect } from "react";

import type { AppWindowState } from "../../../shared/types";

const WINDOW_FULLSCREEN_DATA_ATTRIBUTE = "windowFullscreen";

export function applyAppWindowState(state: AppWindowState): void {
  document.documentElement.dataset[WINDOW_FULLSCREEN_DATA_ATTRIBUTE] = String(state.fullscreen);
}

export function useAppWindowStateSync(): void {
  useEffect(() => {
    applyAppWindowState({ fullscreen: false });

    const api = window.rionStudio;
    if (!api) return;

    let disposed = false;
    let receivedEvent = false;
    const unsubscribe = api.onCurrentWindowStateChanged((state) => {
      receivedEvent = true;
      applyAppWindowState(state);
    });

    void api.getCurrentWindowState()
      .then((state) => {
        if (!disposed && !receivedEvent) applyAppWindowState(state);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
}
