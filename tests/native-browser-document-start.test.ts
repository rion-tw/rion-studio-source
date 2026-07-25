import { describe, expect, it } from "vitest";

import { createNativeBrowserFontDocumentStartScript } from "../src/main/browser/NativeBrowserDocumentStart";

describe("native browser document-start scripts", () => {
  it("does not install a stylesheet for default font settings", () => {
    expect(createNativeBrowserFontDocumentStartScript({
      families: {},
      mode: "default"
    })).toBeUndefined();
  });

  it("builds a CSP-resistant best-effort stylesheet for each configured font role", () => {
    const script = createNativeBrowserFontDocumentStartScript({
      families: {
        fixed: "JetBrains Mono",
        math: "STIX Two Math",
        sansserif: "Inter",
        serif: "Noto Serif",
        standard: "Noto Sans"
      },
      mode: "custom"
    });

    expect(script).toContain("adoptedStyleSheets");
    expect(script).toContain("rion-studio-native-browser-fonts");
    expect(script).toContain("Noto Sans");
    expect(script).toContain("Noto Serif");
    expect(script).toContain("Inter");
    expect(script).toContain("JetBrains Mono");
    expect(script).toContain("STIX Two Math");
    expect(script).toContain("DOMContentLoaded");
  });

  it("quotes font names without allowing a raw string escape", () => {
    const script = createNativeBrowserFontDocumentStartScript({
      families: {
        standard: "Font \");} window.compromised=true;/*"
      },
      mode: "custom"
    });

    expect(script).toContain("\\\\\\\"");
    expect(script).toContain("const css = ");
    expect(() => Function(script ?? "")).not.toThrow();
  });
});
