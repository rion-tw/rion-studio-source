import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { electronPackageScript } from "../scripts/packageElectron.mjs";

describe("sole Electron package entry", () => {
  it.each([
    ["darwin", "package:electron:mac"],
    ["win32", "package:electron:win"]
  ])("selects the native package for %s", (platform, script) => {
    expect(electronPackageScript(platform)).toBe(script);
  });
  it("rejects an unsupported native target", () => {
    expect(() => electronPackageScript("linux")).toThrow("only on macOS and Windows");
  });
  it("routes default entries to Electron and keeps only the updater signer tool", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    expect(manifest.scripts.dev).toBe("pnpm run dev:electron");
    expect(manifest.scripts.build).toBe("pnpm run build:electron");
    expect(manifest.scripts.package).toBe("node scripts/packageElectron.mjs");
    expect(manifest.scripts.dist).toBe("node scripts/buildElectronRelease.mjs");
    expect(manifest.scripts).not.toHaveProperty("performance:webkit:experiment");
    expect(manifest.scripts["build:e2e:desktop"]).toBe("node scripts/buildElectronDesktopE2e.mjs");
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const retired of ["@tauri-apps/api", "@wdio/tauri-plugin", "@wdio/tauri-service"]) {
      expect(dependencies).not.toHaveProperty(retired);
    }
    expect(dependencies["@tauri-apps/cli"]).toBe("2.11.4");
  });
});
