import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { assertNoBundledPlaywrightBrowsers, signMacApp } from "../build/afterPack.mjs";

describe("macOS afterPack signing", () => {
  it("ad-hoc signs the complete macOS app bundle", async () => {
    const signer = vi.fn().mockResolvedValue(undefined);

    await signMacApp(
      {
        electronPlatformName: "darwin",
        appOutDir: "/tmp/mac-arm64",
        packager: { appInfo: { productFilename: "Rion Studio" } }
      },
      signer
    );

    expect(signer).toHaveBeenCalledOnce();
    expect(signer).toHaveBeenCalledWith({
      app: join("/tmp/mac-arm64", "Rion Studio.app"),
      identity: "-",
      identityValidation: false,
      platform: "darwin",
      hardenedRuntime: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      strictVerify: false,
      timestamp: "none"
    });
  });

  it("does not sign Windows output", async () => {
    const signer = vi.fn();

    await signMacApp(
      {
        electronPlatformName: "win32",
        appOutDir: "/tmp/win-unpacked",
        packager: { appInfo: { productFilename: "Rion Studio" } }
      },
      signer
    );

    expect(signer).not.toHaveBeenCalled();
  });
});

describe("packaged browser payload guard", () => {
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
