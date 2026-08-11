const WINDOW_CONTROLS_SCROLLED_DATA_ATTRIBUTE = "windowControlsScrolled";

let activeScrollSource: HTMLElement | null = null;

function applyWindowControlsScrollState(scrolled: boolean): void {
  document.documentElement.dataset[WINDOW_CONTROLS_SCROLLED_DATA_ATTRIBUTE] = String(scrolled);
}

export function registerWindowControlsScrollSource(source: HTMLElement): () => void {
  activeScrollSource = source;
  applyWindowControlsScrollState(source.scrollTop > 0);

  return () => {
    if (activeScrollSource !== source) return;
    activeScrollSource = null;
    applyWindowControlsScrollState(false);
  };
}

export function syncWindowControlsScrollSource(source: HTMLElement): void {
  if (activeScrollSource !== source) return;
  applyWindowControlsScrollState(source.scrollTop > 0);
}
