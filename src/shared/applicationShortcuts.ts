import type { ApplicationShortcutCommand } from "./types";

export interface ApplicationShortcutKeyEvent {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  isComposing: boolean;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
}

export function applicationShortcutForKeyEvent(
  event: ApplicationShortcutKeyEvent
): ApplicationShortcutCommand | undefined {
  if (event.isComposing || event.altKey || event.metaKey) return undefined;

  if (event.code === "F11") {
    return !event.ctrlKey && !event.shiftKey && !event.repeat
      ? "toggleFullscreen"
      : undefined;
  }
  if (!event.ctrlKey) return undefined;
  if (event.code === "KeyN") {
    return !event.shiftKey && !event.repeat ? "newGameWindow" : undefined;
  }
  if ((event.code === "Digit0" || event.code === "Numpad0") && !event.shiftKey) {
    return "zoomReset";
  }
  if ((event.code === "Minus" || event.code === "NumpadSubtract") && !event.shiftKey) {
    return "zoomOut";
  }
  if (event.code === "Equal" || (event.code === "NumpadAdd" && !event.shiftKey)) {
    return "zoomIn";
  }
  return undefined;
}
