// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserFontsPreview } from "../src/renderer/src/features/settings/BrowserFontWidgets";
import { browserFontSerifFallback, browserSystemFontPreviewStack } from "../src/shared/browserFontFallback";
import { normalizeGameBrowserSettings } from "../src/shared/browserFonts";

afterEach(cleanup);

describe.each(["macos", "windows"])("%s installed font fallback", () => {
  it.each(["Georgia", "Times New Roman", "Cambria", "Palatino Linotype"])(
    "preserves the serif fallback for %s in the CJK preview", (family) => {
      const selection = { source: "system", family };
      render(<BrowserFontsPreview catalog={[]} cjkVariant="tc" previewFamilies={{}}
        previewEnabled settings={normalizeGameBrowserSettings({ fonts: {
          mode: "custom", slots: { cjk: selection, latin: selection }
        } })} t={(key) => key} />);
      const cjk = screen.getByText("繁體中文 · 简体中文 · 日本語");
      expect(cjk.style.fontFamily).toBe(`"${family}", serif`);
    }
  );
  it("does not classify arbitrary installed fonts as serif", () => {
    for (const family of [undefined, "Arial", "Segoe UI", "Hiragino Sans", "custom font"]) {
      expect(browserFontSerifFallback(family)).toBeUndefined();
    }
    expect(browserFontSerifFallback(" GEORGIA ")).toBe("serif");
  });
  it("preserves CSS generics instead of looking for fonts literally named ui-monospace", () => {
    for (const family of ["ui-monospace", "serif", "sans-serif", "system-ui", "math"]) {
      expect(browserSystemFontPreviewStack(family)).toBe(family);
    }
    expect(browserSystemFontPreviewStack('Quoted "Font"')).toBe('"Quoted \\"Font\\""');
  });
});
