import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("thin renderer and Tauri bridge boundary", () => {
  it("keeps Node, Tauri, and browser automation imports out of renderer features", async () => {
    const files = await sourceFiles("src/renderer/src");
    const violations: string[] = [];

    for (const path of files) {
      if (path.replaceAll("\\", "/").endsWith("/tauri/installTauriBridge.ts")) continue;
      const source = await readFile(path, "utf8");
      if (/from\s+["'](?:node:|@tauri-apps\/|playwright|puppeteer)/.test(source)) {
        violations.push(path);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps filesystem and system WebView ownership in Rust", async () => {
    const [bridge, core, shell] = await Promise.all([
      readFile("src/renderer/src/tauri/installTauriBridge.ts", "utf8"),
      readFile("crates/rion-core/src/app.rs", "utf8"),
      readFile("src-tauri/src/system_runtime.rs", "utf8")
    ]);

    expect(bridge).not.toContain('from "node:fs');
    expect(bridge).not.toContain("writeFile(");
    expect(core).toContain("delete_role_saga");
    expect(shell).toContain("SystemRuntimeExecutor");
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}
