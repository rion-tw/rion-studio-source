export function normalizeEditorTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 80);
}
