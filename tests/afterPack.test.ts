import { describe, expect, it, vi } from "vitest";

import { signMacApp } from "../build/afterPack.mjs";

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
      app: "/tmp/mac-arm64/Rion Studio.app",
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
