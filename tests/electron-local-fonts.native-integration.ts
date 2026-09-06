import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { build } from "vite";

const executeFile = promisify(execFile);
const require = createRequire(import.meta.url);

it("probes bundled Chromium fonts and exact frame permission on the native platform", async () => {
  expect(["darwin", "win32"]).toContain(process.platform);
  const directory = await mkdtemp(join(tmpdir(), "rion-local-fonts-"));
  try {
    const reportDirectory = process.env.RION_LOCAL_FONTS_REPORT_DIR ?? directory;
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = join(reportDirectory, `local-fonts-${process.platform}.json`);
    await build({ configFile: false, logLevel: "error", build: {
      outDir: directory, emptyOutDir: false,
      lib: { entry: "src/electron/main/chromiumSystemFonts.ts", formats: ["cjs"], fileName: () => "font-provider.cjs" }
    } });
    await executeFile(require("electron") as string, [
      "scripts/probeChromiumLocalFonts.cjs", reportPath, join(directory, "data"), join(directory, "font-provider.cjs")
    ], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.platform).toBe(process.platform);
    expect(report.electron).toBe(require("electron/package.json").version);
    expect(report.outcomes.automatic.activation).toBe(false);
    expect(report.outcomes.automatic.secure).toBe(true);
    expect(report.outcomes.automatic.faces).toBeGreaterThan(0);
    expect(report.outcomes.automatic.fontFaces).toHaveLength(report.outcomes.automatic.faces);
    for (const face of report.outcomes.automatic.fontFaces) {
      for (const key of ["family", "fullName", "postscriptName", "style"]) {
        expect(typeof face[key]).toBe("string");
      }
    }
    for (const key of ["shown", "reload"]) {
      expect(report.outcomes[key].families).toEqual(report.outcomes.automatic.families);
    }
    for (const key of ["denied", "subframe", "navigated", "otherOwner"]) {
      expect(report.outcomes[key].families).toEqual([]);
      expect(report.outcomes[key].fontFaces).toEqual([]);
    }
    expect(report.productionFamilies.map((font: { family: string }) => font.family).sort())
      .toEqual([...report.outcomes.automatic.families].sort());
    expect(report.productionReload).toEqual(report.outcomes.automatic.families);
    expect(report.productionOtherOwner.families).toEqual([]);
    expect(report.productionSubframe.families).toEqual([]);
    expect(report.productionDenied).toEqual([]);
    expect(report.productionNavigated).toEqual({ status: "rejected",
      message: "The application font request belongs to a retired document." });
    expect(report.permissionChecks.some((check: { admitted: boolean }) => check.admitted)).toBe(true);
    console.info(JSON.stringify({ platform: report.platform, electron: report.electron,
      families: report.productionFamilies.length, productionProvider: true }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
