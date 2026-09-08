import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function rustSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return rustSources(target);
    return entry.isFile() && entry.name.endsWith(".rs") ? [target] : [];
  });
}

describe("native child-process policy", () => {
  it("routes app-owned commands through the no-console command builder", () => {
    const roots = ["crates/rion-core/src", "crates/rion-platform/src"];
    const helper = path.resolve("crates/rion-platform/src/background_command.rs");
    const directSpawns = roots
      .flatMap((root) => rustSources(path.resolve(root)))
      .filter((file) => file !== helper)
      .filter((file) => /(?:std::process::)?Command::new\(/.test(readFileSync(file, "utf8")));

    expect(directSpawns).toEqual([]);
    const helperSource = readFileSync(helper, "utf8");
    expect(helperSource).toContain("CREATE_NO_WINDOW");
    expect(helperSource).toContain("command.creation_flags(CREATE_NO_WINDOW)");
  });

  it("uses Electron native dialogs and Chromium font enumeration", () => {
    const dialogs = readFileSync("src/electron/main/index.ts", "utf8");
    const fonts = readFileSync("src/electron/main/chromiumSystemFonts.ts", "utf8");

    expect(dialogs).toContain("dialog.showOpenDialog(activeMainWindow(),");
    expect(dialogs).not.toContain("System.Windows.Forms");
    expect(dialogs).not.toContain("run_windows_dialog");
    expect(fonts).toContain("window.queryLocalFonts()");
    expect(fonts).not.toContain("powershell.exe");
  });
});
