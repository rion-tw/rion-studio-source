import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import config from "../electron-builder.config.mjs";

describe("electron-builder release configuration", () => {
  it("keeps release artifacts and Windows installer target aligned with CI expectations", () => {
    expect(config.artifactName).toBe("Rion.Studio-${os}.${ext}");
    expect(config.directories).toMatchObject({
      output: "release/${version}"
    });
    expect(config.win).toMatchObject({
      target: ["nsis"]
    });
    expect(config.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true
    });
    expect(config.extraResources).not.toContainEqual({
      from: "resources/cdn-compat-extension",
      to: "cdn-compat-extension"
    });
    expect(config.extraResources).toContainEqual({
      from: "docs/legal",
      to: "legal"
    });
    expect(config.extraResources).toContainEqual({
      from: "node_modules/electron/dist/LICENSE",
      to: "legal/LICENSE.electron.txt"
    });
    expect(config.extraResources).toContainEqual({
      from: "node_modules/electron/dist/LICENSES.chromium.html",
      to: "legal/LICENSES.chromium.html"
    });
  });

  it("uses electron-builder-managed ad-hoc signing with explicit hardened runtime entitlements", () => {
    expect(config.afterPack).toBeUndefined();
    expect(config.files).toEqual(["out", "package.json"]);
    expect(config.mac).toMatchObject({
      identity: "-",
      hardenedRuntime: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist",
      notarize: false,
      sign: "build/signMacAdHoc.mjs",
      target: ["dmg", "zip"]
    });
  });

  it("includes the entitlements required for ad-hoc hardened runtime Electron bundles", async () => {
    const [mainEntitlements, inheritedEntitlements] = await Promise.all([
      readFile("build/entitlements.mac.plist", "utf8"),
      readFile("build/entitlements.mac.inherit.plist", "utf8")
    ]);

    for (const entitlements of [mainEntitlements, inheritedEntitlements]) {
      expect(entitlements).toContain("<key>com.apple.security.cs.allow-jit</key>");
      expect(entitlements).toContain("<key>com.apple.security.cs.disable-library-validation</key>");
    }

    expect(mainEntitlements).toContain("<key>com.apple.security.device.camera</key>");
    expect(mainEntitlements).toContain("<key>com.apple.security.device.audio-input</key>");
    expect(inheritedEntitlements).toContain("<key>com.apple.security.cs.allow-unsigned-executable-memory</key>");
  });
});
