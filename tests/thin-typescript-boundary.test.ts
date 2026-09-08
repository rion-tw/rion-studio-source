import { readFile, readdir } from "node:fs/promises";
import { readSourceTree } from "./helpers/readSourceTree";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("thin renderer and Electron preload boundary", () => {
  it("keeps Node, Tauri, and browser automation imports out of renderer features", async () => {
    const files = await sourceFiles("src/renderer/src");
    const violations: string[] = [];

    for (const path of files) {
      const source = await readFile(path, "utf8");
      if (/from\s+["'](?:node:|electron|@tauri-apps\/|playwright|puppeteer)/.test(source)) {
        violations.push(path);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps filesystem and topology authority in Rust behind the typed preload", async () => {
    const [bridge, core, shell] = await Promise.all([
      readFile("src/electron/preload/installRionStudioBridge.ts", "utf8"),
      readSourceTree("crates/rion-core/src/app.rs", "utf8"),
      readSourceTree("crates/rion-node/src/lib.rs", "utf8")
    ]);

    expect(bridge).not.toContain('from "node:fs');
    expect(bridge).not.toContain("writeFile(");
    expect(core).toContain("delete_role_saga");
    expect(shell).toContain("AppCore::create");
    expect(shell).toContain("CoreCommand");
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
