import { useEffect } from "react";

import type { AppWindowState } from "../../../shared/types";

const WINDOW_FULLSCREEN_DATA_ATTRIBUTE = "windowFullscreen";
const WINDOW_MAXIMIZED_DATA_ATTRIBUTE = "windowMaximized";
const WINDOW_FOCUSED_DATA_ATTRIBUTE = "windowFocused";

function applyAppWindowState(state: AppWindowState): void {
  document.documentElement.dataset[WINDOW_FULLSCREEN_DATA_ATTRIBUTE] = String(state.fullscreen);
  document.documentElement.dataset[WINDOW_MAXIMIZED_DATA_ATTRIBUTE] = String(state.maximized);
  document.documentElement.dataset[WINDOW_FOCUSED_DATA_ATTRIBUTE] = String(state.focused);
}

export function useAppWindowStateSync(): void {
  useEffect(() => {
    document.documentElement.dataset[WINDOW_FULLSCREEN_DATA_ATTRIBUTE] = "false";
    document.documentElement.dataset[WINDOW_MAXIMIZED_DATA_ATTRIBUTE] = "false";
    document.documentElement.dataset[WINDOW_FOCUSED_DATA_ATTRIBUTE] = "true";

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
