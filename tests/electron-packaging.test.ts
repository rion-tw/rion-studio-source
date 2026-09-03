import { createPackage } from "@electron/asar";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FuseState, FuseV1Options } from "@electron/fuses";
import type { Configuration } from "electron-builder";
import { describe, expect, it } from "vitest";

import {
  assertElectronNativeAddonInventory,
  assertMacosElectronBundleInfo,
  assertMacosElectronFrameworkArchitectures,
  assertProductionElectronArchiveSources,
  assertProductionElectronFuses,
  assertWindowsAuthenticodeStatus,
  resolveElectronPackageLayout,
  resolveMacosElectronFrameworkBinaryPath,
  verifyProductionElectronArchive
} from "../scripts/verifyElectronPackage.mjs";
import {
  assertMacosAdHocBundleSignatureRelationship,
  assertMacosAdHocSignature,
  assertMacosChromiumAddonArchitectures,
  assertMacosChromiumAddonLinkage,
  assertMacosChromiumAddonLoadCommands
} from "../scripts/verifyElectronNativeAddon.mjs";

interface ElectronBuilderConfigurationModule {
  default: Configuration;
  ELECTRON_PACKAGE_OUTPUT: string;
  ELECTRON_RENDERER_DOCUMENTS: readonly string[];
  PRODUCTION_ELECTRON_FUSES: Readonly<{
    runAsNode: boolean;
    enableNodeOptionsEnvironmentVariable: boolean;
    enableNodeCliInspectArguments: boolean;
    enableEmbeddedAsarIntegrityValidation: boolean;
    onlyLoadAppFromAsar: boolean;
  }>;
}

const configurationModulePath: string = "../electron-builder.config.mjs";
const {
  default: electronBuilderConfiguration,
  ELECTRON_PACKAGE_OUTPUT,
  ELECTRON_RENDERER_DOCUMENTS,
  PRODUCTION_ELECTRON_FUSES
} = await import(configurationModulePath) as ElectronBuilderConfigurationModule;

describe("Electron packaging contract", () => {
  it("keeps packaging additive and pins the fuse verifier", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packagePreparation = packageJson.scripts?.["package:electron:prepare"] ?? "";
    expect(packageJson.devDependencies?.["@electron/asar"]).toBe("4.3.0");
    expect(packageJson.devDependencies?.["@electron/fuses"]).toBe("2.1.3");
    expect(packageJson.scripts?.package).toBe("node scripts/packageTauri.mjs");
    expect(packageJson.scripts?.dist).toBe("node scripts/buildTauriRelease.mjs");
    expect(packagePreparation).toContain("build:electron:rust:release");
    expect(packagePreparation).toContain("pnpm run verify:electron-runtime");
    expect(packagePreparation.indexOf("build:electron:rust:release"))
      .toBeLessThan(packagePreparation.indexOf("pnpm run verify:electron-runtime"));
    expect(packagePreparation.indexOf("pnpm run verify:electron-runtime"))
      .toBeLessThan(packagePreparation.indexOf("electron-vite build"));
    expect(packageJson.scripts?.["package:electron:mac"])
      .toContain("--mac --arm64 --publish never");
    expect(packageJson.scripts?.["package:electron:win"])
      .toContain("--win --x64 --publish never");
    expect(packageJson.scripts?.["verify:electron-package"])
      .toBe("node scripts/verifyElectronPackage.mjs");
    expect(packageJson.scripts?.["verify:electron-renderer"])
      .toBe("node scripts/verifyElectronRendererBundle.mjs");
    expect(packageJson.scripts?.["build:electron"])
      .toContain("pnpm run verify:electron-renderer");
    expect(packageJson.scripts?.["package:electron:prepare"])
      .toContain("pnpm run verify:electron-renderer");
    expect(packageJson.scripts?.["test:e2e:desktop:electron:packaged"])
      .toBe("node scripts/runPackagedElectronSmoke.mjs");
    expect(packageJson.scripts?.["prepare:electron-updater:ci"])
      .toBe("node scripts/prepareElectronUpdaterCiFixture.mjs");
    expect(packageJson.scripts?.["verify:tauri-v22-updater-input"])
      .toBe("node scripts/verifyTauriV22UpdaterInput.mjs");
    expect(packageJson.scripts?.["build:electron-updater:previous-fixtures"])
      .toBe("node scripts/buildElectronUpdaterPreviousFixtures.mjs");
    expect(packageJson.scripts?.["test:electron-updater:packaged"])
      .toBe("node scripts/runElectronUpdaterTransactionProbe.mjs");
  });

  it("packages every production Chromium runtime document", async () => {
    expect(ELECTRON_RENDERER_DOCUMENTS).toEqual([
      "index.html",
      "runtime-role-placeholder-electron.html",
      "runtime-windows-host.html",
      "runtime-web-chrome-electron.html"
    ]);
    expect(electronBuilderConfiguration.asar).toBe(true);
    expect(electronBuilderConfiguration.directories?.output)
      .toBe(ELECTRON_PACKAGE_OUTPUT);
    expect(electronBuilderConfiguration.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "out/main", to: "out/main" }),
      expect.objectContaining({ from: "out/preload", to: "out/preload" }),
      expect.objectContaining({ from: "out/renderer", to: "out/renderer" }),
      "!node_modules/@tauri-apps/api",
      "!node_modules/@tauri-apps/api/**/*"
    ]));

    const viteConfiguration = await readFile("electron.vite.config.ts", "utf8");
    for (const document of ELECTRON_RENDERER_DOCUMENTS) {
      expect(viteConfiguration).toContain(`"src/renderer/${document}"`);
    }
  });

  it("places exactly one platform-native addon outside ASAR", () => {
    expect(electronBuilderConfiguration.mac?.extraResources).toEqual([{
      from: "build/native/darwin-arm64/rion-core.node",
      to: "native/rion-core.node"
    }]);
    expect(electronBuilderConfiguration.win?.extraResources).toEqual([{
      from: "build/native/win32-x64/rion-core.node",
      to: "native/rion-core.node"
    }]);
    expect(electronBuilderConfiguration.asarUnpack).toBeUndefined();
  });

  it("retains AppKit while excluding the v22 WebKit runtime from the macOS addon", () => {
    const chromiumAddon = [
      "rion-core.node:",
      "  /System/Library/Frameworks/AppKit.framework/Versions/C/AppKit",
      "  /System/Library/Frameworks/QuartzCore.framework/Versions/A/QuartzCore"
    ].join("\n");
    expect(() => assertMacosChromiumAddonLinkage(chromiumAddon)).not.toThrow();
    expect(() => assertMacosChromiumAddonLinkage(
      `${chromiumAddon}\n  /System/Library/Frameworks/WebKit.framework/Versions/A/WebKit`
    )).toThrow("must not link");
    expect(() => assertMacosChromiumAddonLinkage("rion-core.node:\n  /usr/lib/libSystem.B.dylib"))
      .toThrow("must retain");

    const portableCommands = dylibCommands([
      ["LC_ID_DYLIB", "@rpath/rion-core.node"],
      ["LC_LOAD_DYLIB", "/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit"],
      ["LC_LOAD_DYLIB", "/System/Library/Frameworks/QuartzCore.framework/Versions/A/QuartzCore"],
      ["LC_LOAD_DYLIB", "/usr/lib/libSystem.B.dylib"]
    ]);
    expect(() => assertMacosChromiumAddonLoadCommands(portableCommands)).not.toThrow();
    expect(() => assertMacosChromiumAddonLoadCommands(portableCommands.replace(
      "@rpath/rion-core.node",
      "/Users/developer/work/target/release/librion_node.dylib"
    ))).toThrow("portable install name");
    expect(() => assertMacosChromiumAddonLoadCommands(`${portableCommands}\n${dylibCommands([
      ["LC_LOAD_DYLIB", "@rpath/libunexpected.dylib"]
    ])}`)).toThrow("non-system dynamic dependency");
    expect(() => assertMacosChromiumAddonLoadCommands(`${portableCommands}\n${rpathCommand(
      "/Users/developer/work/target/release"
    )}`)).toThrow("runtime search paths");
    expect(() => assertMacosChromiumAddonArchitectures("arm64\n")).not.toThrow();
    expect(() => assertMacosChromiumAddonArchitectures("x86_64 arm64\n"))
      .toThrow("exactly arm64");
    expect(() => assertMacosAdHocSignature([
      "Identifier=com.rionstudio.launcher",
      "Signature=adhoc",
      "TeamIdentifier=not set"
    ].join("\n"), "com.rionstudio.launcher")).not.toThrow();
    expect(() => assertMacosAdHocSignature([
      "Identifier=com.example.repacked",
      "Signature=adhoc",
      "TeamIdentifier=not set"
    ].join("\n"), "com.rionstudio.launcher"))
      .toThrow("must identify com.rionstudio.launcher");
    expect(() => assertMacosAdHocSignature([
      "Signature=Developer ID Application: Example",
      "TeamIdentifier=ABCDE12345"
    ].join("\n"))).toThrow("ad-hoc identity");
    const adHocDetails = (identifier: string) => [
      `Identifier=${identifier}`,
      "Signature=adhoc",
      "TeamIdentifier=not set"
    ].join("\n");
    expect(() => assertMacosAdHocBundleSignatureRelationship({
      addon: adHocDetails("rion-core-local"),
      application: adHocDetails("com.rionstudio.launcher"),
      framework: adHocDetails("com.github.Electron.framework")
    })).not.toThrow();
    expect(() => assertMacosAdHocBundleSignatureRelationship({
      addon: adHocDetails("rion-core-local"),
      application: adHocDetails("com.rionstudio.launcher"),
      framework: adHocDetails("com.example.repacked-framework")
    })).toThrow("must identify com.github.Electron.framework");
  });

  it("preserves the normalized cross-platform artifact names and owner signing policy", () => {
    expect(electronBuilderConfiguration.mac).toMatchObject({
      artifactName: "Rion.Studio-mac.app.${ext}",
      identity: "-",
      hardenedRuntime: false,
      minimumSystemVersion: "14.0",
      notarize: false
    });
    expect(electronBuilderConfiguration.mac?.target).toEqual([
      { target: "dmg", arch: ["arm64"] },
      { target: "tar.gz", arch: ["arm64"] }
    ]);
    expect(electronBuilderConfiguration.dmg).toMatchObject({
      artifactName: "Rion.Studio-mac.dmg",
      sign: false,
      writeUpdateInfo: false
    });
    expect(electronBuilderConfiguration.win).toMatchObject({
      artifactName: "Rion.Studio-win.${ext}",
      signExecutable: false
    });
    expect(electronBuilderConfiguration.win?.target)
      .toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(electronBuilderConfiguration.nsis).toMatchObject({
      differentialPackage: false,
      include: "electron-installer.nsh"
    });
    expect(electronBuilderConfiguration.publish).toBeNull();
  });

  it("replaces the exact Tauri v22 currentUser NSIS layout", async () => {
    const installerHook = await readFile("build/electron-installer.nsh", "utf8");
    expect(installerHook).toContain(
      '!define RION_TAURI_V22_INSTALL_REGISTRY_KEY "Software\\rionstudio\\Rion Studio"'
    );
    expect(installerHook).toContain(
      '!define RION_TAURI_V22_UNINSTALL_REGISTRY_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Rion Studio"'
    );
    expect(installerHook).toContain(
      '!define INSTALL_REGISTRY_KEY "${RION_TAURI_V22_INSTALL_REGISTRY_KEY}"'
    );
    expect(installerHook).toContain(
      '!define UNINSTALL_REGISTRY_KEY_2 "${RION_TAURI_V22_UNINSTALL_REGISTRY_KEY}"'
    );
    expect(installerHook).toContain("SetRegView 32");
    expect(installerHook).toContain("SetRegView 64");
    expect(installerHook).toContain('ReadRegStr $R6 HKCU');
    expect(installerHook).toContain('$R6 == "rion-tauri.exe"');
    expect(installerHook).toContain('$R5 == "rionstudio"');
    expect(installerHook).toContain('$R4 == $R0');
    expect(installerHook).toContain(
      '$R3 == "$\\"$R8\\rion-tauri.exe$\\""'
    );
    expect(installerHook).toContain(
      '$R2 == "$\\"$R8\\uninstall.exe$\\""'
    );
    expect(installerHook).toContain(
      'WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$R8"'
    );
    expect(installerHook).toContain('Delete "$INSTDIR\\rion-tauri.exe"');
    expect(installerHook).toContain('Delete "$INSTDIR\\uninstall.exe"');
    expect(installerHook).toContain("rion_tauri_v22_migration_failed:");
    expect(installerHook).toContain("SetErrorLevel 1");
    expect(installerHook).toContain(
      '${IfNot} ${FileExists} "$INSTDIR\\${PRODUCT_FILENAME}.exe"'
    );
    expect(installerHook).toContain(
      'ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" ""'
    );
    expect(installerHook).toContain("$R0 != $INSTDIR");
    expect(installerHook).toContain(
      'DeleteRegKey HKCU "${RION_TAURI_V22_INSTALL_REGISTRY_KEY}"'
    );
    expect(installerHook).not.toContain("RION_STUDIO_USER_DATA_DIR");
    expect(installerHook).not.toContain("RmDir /r");
  });

  it("locks the production Electron attack-surface fuses", () => {
    expect(PRODUCTION_ELECTRON_FUSES).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    });
    expect(electronBuilderConfiguration.electronFuses)
      .toBe(PRODUCTION_ELECTRON_FUSES);

    expect(() => assertProductionElectronFuses({
      [FuseV1Options.RunAsNode]: FuseState.DISABLE,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
      [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
      [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE
    })).not.toThrow();
    expect(() => assertProductionElectronFuses({
      [FuseV1Options.RunAsNode]: FuseState.ENABLE
    })).toThrow("RunAsNode");
  });

  it("resolves macOS and Windows unpacked layouts without host-platform inference", () => {
    expect(resolveElectronPackageLayout("release/electron/mac-arm64/Rion Studio.app"))
      .toEqual({
        executablePath: join(
          process.cwd(),
          "release/electron/mac-arm64/Rion Studio.app/Contents/MacOS/Rion Studio"
        ),
        resourcesPath: join(
          process.cwd(),
          "release/electron/mac-arm64/Rion Studio.app/Contents/Resources"
        )
      });
    expect(resolveElectronPackageLayout("release/electron/win-unpacked"))
      .toEqual({
        executablePath: join(process.cwd(), "release/electron/win-unpacked/Rion Studio.exe"),
        resourcesPath: join(process.cwd(), "release/electron/win-unpacked/resources")
      });
    expect(resolveMacosElectronFrameworkBinaryPath(
      "release/electron/mac-arm64/Rion Studio.app"
    )).toBe(join(
      process.cwd(),
      "release/electron/mac-arm64/Rion Studio.app/Contents/Frameworks/" +
        "Electron Framework.framework/Versions/A/Electron Framework"
    ));
  });

  it("binds the final macOS bundle identity and versions to its ASAR", () => {
    const info = {
      CFBundleDisplayName: "Rion Studio",
      CFBundleExecutable: "Rion Studio",
      CFBundleIdentifier: "com.rionstudio.launcher",
      CFBundleName: "Rion Studio",
      CFBundlePackageType: "APPL",
      CFBundleShortVersionString: "23.4.5",
      CFBundleVersion: "23.4.5",
      LSMinimumSystemVersion: "14.0"
    };
    expect(() => assertMacosElectronBundleInfo(info, "23.4.5"))
      .not.toThrow();
    expect(() => assertMacosElectronBundleInfo({
      ...info,
      CFBundleIdentifier: "com.example.repacked"
    }, "23.4.5")).toThrow("CFBundleIdentifier");
    expect(() => assertMacosElectronBundleInfo({
      ...info,
      CFBundleShortVersionString: "23.4.4"
    }, "23.4.5")).toThrow("CFBundleShortVersionString");
    expect(() => assertMacosElectronBundleInfo({
      ...info,
      CFBundleVersion: "23.4.4"
    }, "23.4.5")).toThrow("CFBundleVersion");
    expect(() => assertMacosElectronBundleInfo({
      ...info,
      LSMinimumSystemVersion: "13.0"
    }, "23.4.5")).toThrow("LSMinimumSystemVersion");
    expect(() => assertMacosElectronBundleInfo(info, "not-semver"))
      .toThrow("requires a semantic version");
  });

  it("requires the final Electron Framework binary to be arm64-only", () => {
    expect(() => assertMacosElectronFrameworkArchitectures("arm64\n"))
      .not.toThrow();
    expect(() => assertMacosElectronFrameworkArchitectures("x86_64 arm64\n"))
      .toThrow("exactly arm64");
    expect(() => assertMacosElectronFrameworkArchitectures("\n"))
      .toThrow("received none");
  });

  it("requires exactly one external native addon and preserves unsigned Windows policy", () => {
    expect(() => assertElectronNativeAddonInventory(["native/rion-core.node"]))
      .not.toThrow();
    expect(() => assertElectronNativeAddonInventory([])).toThrow("exactly");
    expect(() => assertElectronNativeAddonInventory([
      "native/rion-core.node",
      "out/main/rion-core.node"
    ])).toThrow("out/main/rion-core.node");
    expect(() => assertWindowsAuthenticodeStatus("NotSigned\r\n")).not.toThrow();
    expect(() => assertWindowsAuthenticodeStatus("Valid"))
      .toThrow("Authenticode-unsigned");
  });

  it("rejects desktop E2E controls from production runtime sources", () => {
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/renderer/assets/main.js",
      source: "window.__rionStudioDesktopE2eNavigate = navigate"
    }])).toThrow("desktop E2E marker");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/main/index.js",
      source: "import service from '@wdio/electron-service'"
    }])).toThrow("@wdio/electron-service");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/main/index.js",
      source: "ipcMain.handle('rion:e2e:invoke', handler)"
    }])).toThrow("rion:e2e:invoke");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/preload/index.cjs",
      source: "contextBridge.exposeInMainWorld('rionStudioDesktopE2e', api)"
    }])).toThrow("rionStudioDesktopE2e");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/preload/index.cjs",
      source: "require('./chunks/workspaceWebChrome-deadbeef.cjs')"
    }])).toThrow("preload must be self-contained");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/preload/workspaceWebChrome.cjs",
      source: "import('./chunks/shared-deadbeef.cjs')"
    }])).toThrow("preload must be self-contained");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/main/index.js",
      source: "const retainedV22Precondition = await seedRetainedV22Role()"
    }])).toThrow("retainedV22Precondition");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/renderer/assets/main.js",
      source: "window.rionStudio = Object.freeze({ invoke() {} })"
    }])).not.toThrow();
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/renderer/assets/main.js",
      source: "globalThis.__TAURI_INTERNALS__.invoke()"
    }])).toThrow("forbidden Tauri marker");
    expect(() => assertProductionElectronArchiveSources([{
      path: "out/renderer/assets/vendor.js",
      source: "export * from '@tauri-apps/api/core'"
    }])).toThrow("forbidden Tauri marker");
  });

  it("reads the final ASAR and verifies its production entry points", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "rion-electron-asar-"));
    const sourceRoot = join(fixtureRoot, "source");
    const archivePath = join(fixtureRoot, "app.asar");
    try {
      await Promise.all([
        mkdir(join(sourceRoot, "out/main"), { recursive: true }),
        mkdir(join(sourceRoot, "out/preload"), { recursive: true }),
        mkdir(join(sourceRoot, "out/renderer/assets"), { recursive: true })
      ]);
      await Promise.all([
        writeFile(join(sourceRoot, "package.json"), JSON.stringify({
          main: "out/main/index.js",
          name: "rion-studio",
          version: "23.4.5"
        })),
        writeFile(join(sourceRoot, "out/main/index.js"), "export const main = true;"),
        writeFile(join(sourceRoot, "out/preload/index.cjs"), "module.exports = {};"),
        writeFile(join(sourceRoot, "out/preload/role.cjs"), ""),
        writeFile(
          join(sourceRoot, "out/preload/runtimeWindowsHost.cjs"),
          "module.exports = {};"
        ),
        writeFile(
          join(sourceRoot, "out/preload/workspaceWebChrome.cjs"),
          "module.exports = {};"
        ),
        ...ELECTRON_RENDERER_DOCUMENTS.map((document) => writeFile(
          join(sourceRoot, "out/renderer", document),
          "<!doctype html><main></main>"
        )),
        writeFile(
          join(sourceRoot, "out/renderer/assets/main.js"),
          "window.rionStudioReady = true;"
        )
      ]);
      await createPackage(sourceRoot, archivePath);

      expect(verifyProductionElectronArchive(archivePath)).toMatchObject({
        archivePath,
        packageVersion: "23.4.5",
        runtimeSourceCount: ELECTRON_RENDERER_DOCUMENTS.length + 6
      });

      const runtimeWindowsHostPreload = join(
        sourceRoot,
        "out/preload/runtimeWindowsHost.cjs"
      );
      const missingRuntimeHostPreloadArchive = join(
        fixtureRoot,
        "missing-runtime-host-preload.asar"
      );
      await rm(runtimeWindowsHostPreload);
      await createPackage(sourceRoot, missingRuntimeHostPreloadArchive);
      expect(() => verifyProductionElectronArchive(missingRuntimeHostPreloadArchive))
        .toThrow("missing required file: out/preload/runtimeWindowsHost.cjs");

      const workspaceWebChromePreload = join(
        sourceRoot,
        "out/preload/workspaceWebChrome.cjs"
      );
      const missingWorkspacePreloadArchive = join(
        fixtureRoot,
        "missing-workspace-preload.asar"
      );
      await writeFile(runtimeWindowsHostPreload, "module.exports = {};");
      await rm(workspaceWebChromePreload);
      await createPackage(sourceRoot, missingWorkspacePreloadArchive);
      expect(() => verifyProductionElectronArchive(missingWorkspacePreloadArchive))
        .toThrow("missing required file: out/preload/workspaceWebChrome.cjs");
      await writeFile(workspaceWebChromePreload, "module.exports = {};");

      const runtimeRolePlaceholder = join(
        sourceRoot,
        "out/renderer/runtime-role-placeholder-electron.html"
      );
      const missingRolePlaceholderArchive = join(
        fixtureRoot,
        "missing-role-placeholder.asar"
      );
      await rm(runtimeRolePlaceholder);
      await createPackage(sourceRoot, missingRolePlaceholderArchive);
      expect(() => verifyProductionElectronArchive(missingRolePlaceholderArchive))
        .toThrow(
          "missing required file: out/renderer/runtime-role-placeholder-electron.html"
        );
      await writeFile(runtimeRolePlaceholder, "<!doctype html><main></main>");

      const runtimeWindowsHost = join(
        sourceRoot,
        "out/renderer/runtime-windows-host.html"
      );
      const missingDocumentArchive = join(fixtureRoot, "missing-document.asar");
      await rm(runtimeWindowsHost);
      await createPackage(sourceRoot, missingDocumentArchive);
      expect(() => verifyProductionElectronArchive(missingDocumentArchive))
        .toThrow("missing required file: out/renderer/runtime-windows-host.html");

      const tauriDocument = join(sourceRoot, "out/renderer/runtime-tabs.html");
      const tauriDocumentArchive = join(fixtureRoot, "tauri-document.asar");
      await Promise.all([
        writeFile(runtimeWindowsHost, "<!doctype html><main></main>"),
        writeFile(tauriDocument, "<!doctype html><main></main>")
      ]);
      await createPackage(sourceRoot, tauriDocumentArchive);
      expect(() => verifyProductionElectronArchive(tauriDocumentArchive))
        .toThrow("Tauri compatibility document");

      const tauriApiArchive = join(fixtureRoot, "tauri-api.asar");
      const tauriApiSource = join(
        sourceRoot,
        "node_modules/@tauri-apps/api/core.js"
      );
      await Promise.all([
        rm(tauriDocument),
        mkdir(join(sourceRoot, "node_modules/@tauri-apps/api"), { recursive: true })
      ]);
      await writeFile(tauriApiSource, "globalThis.__TAURI_INTERNALS__.invoke();");
      await createPackage(sourceRoot, tauriApiArchive);
      expect(() => verifyProductionElectronArchive(tauriApiArchive))
        .toThrow("contains the Tauri compatibility API");

      const embeddedAddonArchive = join(fixtureRoot, "embedded-addon.asar");
      await Promise.all([
        rm(join(sourceRoot, "node_modules"), { recursive: true }),
        writeFile(join(sourceRoot, "out/main/embedded.node"), "native-binary")
      ]);
      await createPackage(sourceRoot, embeddedAddonArchive);
      expect(() => verifyProductionElectronArchive(embeddedAddonArchive))
        .toThrow("native addon must remain outside ASAR");

      const invalidVersionArchive = join(fixtureRoot, "invalid-version.asar");
      await Promise.all([
        rm(join(sourceRoot, "out/main/embedded.node")),
        writeFile(join(sourceRoot, "package.json"), JSON.stringify({
          main: "out/main/index.js",
          name: "rion-studio",
          version: "not-semver"
        }))
      ]);
      await createPackage(sourceRoot, invalidVersionArchive);
      expect(() => verifyProductionElectronArchive(invalidVersionArchive))
        .toThrow("must contain a semantic version");
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});

function dylibCommands(commands: ReadonlyArray<readonly [string, string]>): string {
  return commands.map(([command, path]) => [
    "Load command 0",
    `          cmd ${command}`,
    "      cmdsize 48",
    `         name ${path} (offset 24)`
  ].join("\n")).join("\n");
}

function rpathCommand(path: string): string {
  return [
    "Load command 0",
    "          cmd LC_RPATH",
    "      cmdsize 48",
    `         path ${path} (offset 12)`
  ].join("\n");
}
