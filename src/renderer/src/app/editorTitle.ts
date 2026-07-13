export function normalizeEditorTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 80);
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
