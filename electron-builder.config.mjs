/**
 * @typedef {import("electron-builder").Configuration} Configuration
 */

import process from "node:process";

import { ELECTRON_RENDERER_DOCUMENTS } from "./scripts/verifyElectronRendererBundle.mjs";

export const ELECTRON_PACKAGE_OUTPUT = "release/electron";
export { ELECTRON_RENDERER_DOCUMENTS };

export const PRODUCTION_ELECTRON_FUSES = Object.freeze({
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true
});

const packageVersion = process.env.RION_STUDIO_ELECTRON_PACKAGE_VERSION?.trim();
if (
  packageVersion !== undefined &&
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)
) {
  throw new Error("RION_STUDIO_ELECTRON_PACKAGE_VERSION must be a semantic version.");
}

/** @satisfies {Configuration} */
const electronBuilderConfiguration = {
  appId: "com.rionstudio.launcher",
  productName: "Rion Studio",
  electronVersion: "43.4.1",
  directories: {
    buildResources: "build",
    output: ELECTRON_PACKAGE_OUTPUT
  },
  files: [
    {
      from: "out/main",
      to: "out/main",
      filter: ["**/*"]
    },
    {
      from: "out/preload",
      to: "out/preload",
      filter: ["**/*"]
    },
    {
      from: "out/renderer",
      to: "out/renderer",
      filter: ["**/*"]
    },
    "package.json",
    "!node_modules/@tauri-apps/api",
    "!node_modules/@tauri-apps/api/**/*",
    "!**/*.map"
  ],
  extraMetadata: {
    main: "out/main/index.js",
    ...(packageVersion ? { version: packageVersion } : {})
  },
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  electronFuses: PRODUCTION_ELECTRON_FUSES,
  publish: null,
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "tar.gz", arch: ["arm64"] }
    ],
    artifactName: "Rion.Studio-mac.app.${ext}",
    extraResources: [{
      from: "build/native/darwin-arm64/rion-core.node",
      to: "native/rion-core.node"
    }],
    icon: "build/icon.icns",
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    minimumSystemVersion: "14.0"
  },
  dmg: {
    artifactName: "Rion.Studio-mac.dmg",
    sign: false,
    writeUpdateInfo: false
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "Rion.Studio-win.${ext}",
    extraResources: [{
      from: "build/native/win32-x64/rion-core.node",
      to: "native/rion-core.node"
    }],
    icon: "build/icon.ico",
    requestedExecutionLevel: "asInvoker",
    signExecutable: false,
    signtoolOptions: null,
    azureSignOptions: null
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    include: "electron-installer.nsh",
    deleteAppDataOnUninstall: false,
    differentialPackage: false
  }
};

export default electronBuilderConfiguration;
