export function normalizeEditorTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 80);
}

export function syncEditorTitle(element: HTMLElement, value: string): void {
  const hasEmptyBrowserContent = value.length === 0 && element.childNodes.length > 0;

  if (element.textContent !== value || hasEmptyBrowserContent) {
    element.textContent = value;
  }
}

export function focusEditorTitle(
  element: HTMLElement,
  selection: Selection | null = window.getSelection(),
  createRange: () => Range = () => document.createRange()
): void {
  element.focus({ preventScroll: true });

  if (!selection) {
    return;
  }

  const range = createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
