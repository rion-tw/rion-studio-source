import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import config from "../electron-builder.config.mjs";
import { DEFAULT_UPDATE_REPOSITORY } from "../src/main/updates/AppUpdateManager";

describe("electron-builder release configuration", () => {
  it("keeps the app updater, release publisher, and public download links on the same repository", async () => {
    const [readme, builderConfigSource, mainSource] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("electron-builder.config.mjs", "utf8"),
      readFile("src/main/index.ts", "utf8")
    ]);
    const [owner, repo] = DEFAULT_UPDATE_REPOSITORY.split("/");

    expect(config.publish).toContainEqual(
      expect.objectContaining({
        owner,
        repo
      })
    );
    expect(readme).toContain(`https://github.com/${DEFAULT_UPDATE_REPOSITORY}/releases/latest`);
    expect(builderConfigSource).toContain("process.env.RION_STUDIO_RELEASE_REPOSITORY");
    expect(builderConfigSource).not.toContain("process.env.GITHUB_REPOSITORY");
    expect(mainSource).not.toContain("process.env.GITHUB_REPOSITORY");
  });

  it("keeps release artifacts and Windows installer target aligned with CI expectations", () => {
    expect(config.artifactName).toBe("Rion.Studio-${os}.${ext}");
    expect(config.directories).toMatchObject({
      output: "release/${version}"
    });
    expect(config.compression).toBe("maximum");
    expect(config.electronLanguages).toEqual([
      "en",
      "en-US",
      "zh_TW",
      "zh-TW",
      "zh_CN",
      "zh-CN",
      "ja"
    ]);
    expect(config.win).toMatchObject({
      target: ["nsis"],
      extraResources: [
        {
          from: "build/native/win32-x64/rion-core.node",
          to: "native/rion-core.node"
        }
      ],
      signExts: ["rion-core.node"]
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
      from: "build/icon.ico",
      to: "icon.ico"
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
      target: ["dmg", "zip"],
      extraResources: expect.arrayContaining([
        {
          from: "build/native/darwin-arm64/rion-core.node",
          to: "native/rion-core.node"
        }
      ])
    });
  });

  it("builds and verifies the Rust core before local and release packaging", async () => {
    const [packageJsonSource, releaseWorkflow] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile(".github/workflows/release.yml", "utf8")
    ]);
    const packageJson = JSON.parse(packageJsonSource) as {
      scripts: Record<string, string>;
    };

    for (const scriptName of ["package", "dist"]) {
      const script = packageJson.scripts[scriptName];
      const buildIndex = script.indexOf("pnpm run build:rust");
      const verifyIndex = script.indexOf("pnpm run verify:rust");
      const builderIndex = script.indexOf("electron-builder");

      expect(buildIndex).toBeGreaterThan(-1);
      expect(verifyIndex).toBeGreaterThan(buildIndex);
      expect(builderIndex).toBeGreaterThan(verifyIndex);
    }

    expect(releaseWorkflow.match(/run: pnpm run build:rust && pnpm run verify:rust/gu)).toHaveLength(1);
    expect(releaseWorkflow.match(/- os: macos-latest/gu)).toHaveLength(1);
    expect(releaseWorkflow.match(/- os: windows-latest/gu)).toHaveLength(1);
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
