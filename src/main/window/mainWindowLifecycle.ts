interface CloseEvent {
  preventDefault: () => void;
}

interface HideableWindow {
  hide: () => void;
}

export function handleMainWindowClose(
  event: CloseEvent,
  window: HideableWindow,
  isApplicationQuitting: boolean
): void {
  if (isApplicationQuitting) {
    return;
  }

  event.preventDefault();
  window.hide();
}
