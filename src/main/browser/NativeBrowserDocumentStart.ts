import type { BrowserFontSettings } from "../../shared/types";

const STYLE_ID = "rion-studio-native-browser-fonts";

/**
 * Builds the best-effort font stylesheet used by System WebViews.
 *
 * WebView2 and WKWebView do not expose the same per-profile font preferences as
 * Electron. Keeping this in a document-start script avoids a post-navigation
 * flash while leaving the capability accurately marked as degraded.
 */
export function createNativeBrowserFontDocumentStartScript(
  fonts: BrowserFontSettings
): string | undefined {
  if (fonts.mode !== "custom" || Object.keys(fonts.families).length === 0) {
    return undefined;
  }

  const rules = [
    fontRule(
      ":where(html,body,button,input,select,textarea)",
      fonts.families.standard ?? fonts.families.sansserif
    ),
    fontRule(
      ":where(button,input,select,textarea)",
      fonts.families.sansserif ?? fonts.families.standard
    ),
    fontRule(":where(article,blockquote,q)", fonts.families.serif),
    fontRule(":where(code,kbd,pre,samp,textarea)", fonts.families.fixed),
    fontRule("math", fonts.families.math)
  ].filter((rule): rule is string => Boolean(rule));

  if (rules.length === 0) return undefined;
  const css = rules.join("\n");
  return `(() => {
  const styleId = ${JSON.stringify(STYLE_ID)};
  const css = ${JSON.stringify(css)};
  const install = () => {
    const root = document.documentElement;
    if (!root || document.getElementById(styleId)) return false;
    try {
      if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in document) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        root.dataset.rionStudioNativeFonts = "adopted";
        return true;
      }
    } catch {}
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = css;
    (document.head || root).appendChild(style);
    root.dataset.rionStudioNativeFonts = "style";
    return true;
  };
  if (!install()) {
    document.addEventListener("readystatechange", install, { once: true });
    document.addEventListener("DOMContentLoaded", install, { once: true });
  }
})();`;
}

function fontRule(selector: string, family: string | undefined): string | undefined {
  return family
    ? `${selector}{font-family:${quoteCssString(family)} !important;}`
    : undefined;
}

function quoteCssString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")}"`;
}
