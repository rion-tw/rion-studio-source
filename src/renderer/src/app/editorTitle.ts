export function normalizeEditorTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 80);
}

export function syncEditorTitle(element: HTMLElement, value: string): void {
  const hasEmptyBrowserContent = value.length === 0 && element.childNodes.length > 0;

  if (element.textContent !== value || hasEmptyBrowserContent) {
    element.textContent = value;
  }
}
