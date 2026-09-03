import { useEffect } from "react";

import { applicationShortcutForKeyEvent } from "../../../shared/applicationShortcuts";

export function useWindowsApplicationShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (
      !enabled ||
      document.documentElement.dataset.platform !== "windows"
    ) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      const command = applicationShortcutForKeyEvent(event);
      if (!command) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void window.rionStudio.executeApplicationShortcut(command)
        .catch((error) => console.error("Application shortcut failed.", error));
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled]);
}
