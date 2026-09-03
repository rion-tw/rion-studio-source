import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const specPath = "e2e/desktop/specs/chromium-system-settings.e2e.ts";

describe("Chromium system-settings desktop E2E boundary", () => {
  it("keeps product actions on visible WebDriver UI and bridge evidence read-only", async () => {
    const source = await readFile(specPath, "utf8");

    expect(source).not.toContain("navigate(");
    expect(source).not.toContain("browser.executeAsync");
    expect(source).not.toContain("dispatchEvent");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("window.rionStudio");

    const rendererMethods = [...source.matchAll(/rendererCall\("([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(new Set(rendererMethods)).toEqual(new Set(["getGameBrowserSettings"]));

    const readonlyRendererInspections = source.match(/browser\.execute\(/gu) ?? [];
    expect(readonlyRendererInspections).toHaveLength(2);
    expect(source).toContain("document.documentElement.dataset.platform");
    expect(source).toContain("document.querySelectorAll<HTMLElement>");

    for (const label of [
      "Settings",
      "Interface",
      "Data",
      "Updates",
      "Diagnostics",
      "About & Legal",
      "Export JSON",
      "Export diagnostics",
      "Cancel",
      "Measure presentation FPS",
      "Cancel measurement",
      "Open",
      "Close"
    ]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("cancelVisibleNativeDiagnosticsSaveDialog");
    expect(source).toContain("electronDesktopE2eDiagnosticsExportJournal");
    expect(source).toContain("coreDiagnosticsExportInvocationCount: 0");
    expect(source).toContain("typedOutcome: null");
  });
});
