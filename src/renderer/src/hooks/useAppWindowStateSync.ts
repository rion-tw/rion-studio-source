import { useEffect } from "react";

import type { AppWindowState } from "../../../shared/types";

const WINDOW_FULLSCREEN_DATA_ATTRIBUTE = "windowFullscreen";

function applyAppWindowState(state: AppWindowState): void {
  document.documentElement.dataset[WINDOW_FULLSCREEN_DATA_ATTRIBUTE] = String(state.fullscreen);
}

export function useAppWindowStateSync(): void {
  useEffect(() => {
    document.documentElement.dataset[WINDOW_FULLSCREEN_DATA_ATTRIBUTE] = "false";

    const api = window.rionStudio;
    if (!api) return;

    let disposed = false;
    let latestRevision = 0;
    const applyRevisionedState = (state: AppWindowState): void => {
      if (state.revision <= latestRevision) return;
      latestRevision = state.revision;
      applyAppWindowState(state);
    };
    const unsubscribe = api.onCurrentWindowStateChanged((state) => {
      applyRevisionedState(state);
    });

    void api.getCurrentWindowState()
      .then((state) => {
        if (!disposed) applyRevisionedState(state);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
}
