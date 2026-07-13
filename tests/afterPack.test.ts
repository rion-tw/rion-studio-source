import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import afterPack, { assertNoBundledPlaywrightBrowsers } from "../build/afterPack.mjs";

describe("packaged browser payload guard", () => {
  it("uses the Playwright browser payload guard as the afterPack hook", () => {
    expect(afterPack).toBe(assertNoBundledPlaywrightBrowsers);
  });

  it("does not inspect non-macOS output", () => {
    expect(() =>
      assertNoBundledPlaywrightBrowsers({
        electronPlatformName: "win32",
        appOutDir: "/tmp/win-unpacked",
        packager: { appInfo: { productFilename: "Rion Studio" } }
      })
    ).not.toThrow();
  });

  it("allows macOS output without Playwright browser payload", () => {
    expect(() =>
      assertNoBundledPlaywrightBrowsers({
        electronPlatformName: "darwin",
        appOutDir: "/tmp/mac-arm64",
        packager: { appInfo: { productFilename: "Rion Studio" } }
      })
    ).not.toThrow();
  });

  it("rejects macOS output that includes Playwright browser payload", async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), "rion-afterpack-"));
    const browserPayloadPath = join(
      appOutDir,
      "Rion Studio.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "playwright-core",
      ".local-browsers"
    );
    await mkdir(browserPayloadPath, { recursive: true });

    expect(() =>
      assertNoBundledPlaywrightBrowsers({
        electronPlatformName: "darwin",
        appOutDir,
        packager: { appInfo: { productFilename: "Rion Studio" } }
      })
    ).toThrow("Packaged app must not include Playwright browser payload");
  });
});
