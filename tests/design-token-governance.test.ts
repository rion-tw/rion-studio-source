import { readFile, readdir } from "node:fs/promises";
import { readSourceTree } from "./helpers/readSourceTree";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const sharedTokensPath = path.join(root, "src", "shared", "designTokens.css");
const productCssPaths = [
  path.join(root, "src", "renderer", "src", "styles.css"),
  path.join(root, "src", "renderer", "src", "boot.css"),
  path.join(root, "src", "renderer", "runtime-tabs.css"),
  path.join(root, "src", "shared", "browser-overlay", "macroOverlay.css"),
  path.join(root, "src", "shared", "browser-overlay", "runtimeIndicators.css")
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:tsx|css|html)$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

describe("design token governance", () => {
  it("provides one canonical token source to every product-owned document", async () => {
    const [tokens, renderer, boot, runtimeTabs, shell] = await Promise.all([
      readSourceTree(sharedTokensPath, "utf8"),
      readSourceTree(path.join(root, "src", "renderer", "src", "styles.css"), "utf8"),
      readSourceTree(path.join(root, "src", "renderer", "src", "boot.css"), "utf8"),
      readSourceTree(path.join(root, "src", "renderer", "runtime-tabs.css"), "utf8"),
      readSourceTree(path.join(root, "src-tauri", "src", "system_runtime.rs"), "utf8")
    ]);

    for (const token of [
      "--font-ui", "--type-page-title-size", "--space-14", "--control-height",
      "--radius-pill", "--activity", "--success", "--warning", "--destructive",
      "--layer-modal", "--layer-browser-overlay", "--blur-surface", "--scrim"
    ]) {
      expect(tokens, token).toContain(token);
    }
    expect(renderer).toContain('@import "../../shared/designTokens.css"');
    expect(boot).toContain('@import "../../shared/designTokens.css"');
    expect(runtimeTabs).toContain('@import "../shared/designTokens.css"');
    expect(shell).toContain('const DESIGN_TOKENS_CSS: &str = include_str!("../../../src/shared/designTokens.css")');
  });

  it("rejects direct palette colors and arbitrary type, radius, or numeric layers in renderer markup", async () => {
    const files = (await sourceFiles(path.join(root, "src", "renderer", "src")))
      .filter((file) => file.endsWith(".tsx"));
    const violations: string[] = [];
    const directPalette = /(?:bg|text|border|ring|outline|fill|stroke)-(?:slate|gray|zinc|neutral|stone|blue|sky|cyan|teal|green|emerald|lime|yellow|amber|orange|red|rose|pink|purple|violet|indigo|fuchsia)-\d+|(?:bg-black|text-white|border-white|ring-white)(?:\b|\/)/g;
    const arbitraryType = /text-\[\s*\d+(?:\.\d+)?px\s*\]/g;
    const arbitraryRadius = /rounded-\[\s*\d/g;
    const numericLayer = /\bz-(?:\[\s*-?\d+\s*\]|-?\d+)\b/g;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const [rule, pattern] of Object.entries({ directPalette, arbitraryType, arbitraryRadius, numericLayer })) {
        for (const match of source.matchAll(pattern)) {
          violations.push(`${relative(file)}: ${rule}: ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps warning surface tokens out of text colors", async () => {
    const files = (await sourceFiles(path.join(root, "src", "renderer", "src")))
      .filter((file) => file.endsWith(".tsx"));
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\btext-warning(?!-foreground)\b/g)) {
        violations.push(`${relative(file)}: warning surface used as text: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("rejects raw visual values outside the canonical CSS token source", async () => {
    const violations: string[] = [];
    const rules = {
      rawColor: /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(\s*\d|hsl\(\s*\d/gi,
      rawFontSize: /font-size:\s*\d/gi,
      rawRadius: /border-radius:\s*\d/gi,
      rawLayer: /z-index:\s*-?\d/gi
    };

    for (const file of productCssPaths) {
      const source = await readFile(file, "utf8");
      for (const [rule, pattern] of Object.entries(rules)) {
        const inspected = rule === "rawColor"
          ? source.split("\n").map((line) => line.includes("{") ? line.slice(line.indexOf("{") + 1) : line).join("\n")
          : source;
        for (const match of inspected.matchAll(pattern)) {
          if (rule === "rawColor" && match[0].toLowerCase() === "#add") continue;
          violations.push(`${relative(file)}: ${rule}: ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
