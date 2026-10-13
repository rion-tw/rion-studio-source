// These installed serif families do not necessarily contain CJK glyphs. Keep
// their generic fallback explicit: Chromium cannot infer it from a FontFace
// alias, and an omitted generic can select the application's sans-serif font.
const SERIF_FAMILIES = new Set([
  "georgia", "times", "times new roman", "cambria", "constantia",
  "palatino", "palatino linotype", "book antiqua", "baskerville",
  "garamond", "didot", "iowan old style", "serif", "ui-serif"
]);
const GENERIC_FAMILIES = new Set([
  "cursive", "emoji", "fangsong", "fantasy", "math", "monospace", "sans-serif",
  "serif", "system-ui", "ui-monospace", "ui-rounded", "ui-sans-serif", "ui-serif"
]);

export function browserFontSerifFallback(family: string | undefined): "serif" | undefined {
  return family && SERIF_FAMILIES.has(family.trim().toLowerCase()) ? "serif" : undefined;
}

export function browserSystemFontPreviewStack(family: string): string {
  // Quoting a CSS generic changes it into a literal installed-font name.
  if (GENERIC_FAMILIES.has(family.toLowerCase())) return family.toLowerCase();
  const quoted = `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return [quoted, browserFontSerifFallback(family)].filter(Boolean).join(", ");
}
