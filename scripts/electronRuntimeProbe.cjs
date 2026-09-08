const { writeSync } = require("node:fs");

writeSync(2, "RION_ELECTRON_RUNTIME_STAGE=script-started\n");
const { app } = require("electron");
writeSync(2, "RION_ELECTRON_RUNTIME_STAGE=electron-imported\n");

const PROBE_PREFIX = "RION_ELECTRON_RUNTIME_PROBE=";

void (async () => {
  try {
    const addonPath = process.env.RION_ELECTRON_ADDON_PATH;
    const userDataDirectory = process.env.RION_ELECTRON_PROBE_USER_DATA_DIR;
    if (!addonPath || !userDataDirectory) {
      throw new Error("The Electron runtime probe requires isolated addon and user-data paths.");
    }
    app.setPath("userData", userDataDirectory);
    await app.whenReady();
    writeSync(2, "RION_ELECTRON_RUNTIME_STAGE=app-ready\n");

    writeSync(2, "RION_ELECTRON_RUNTIME_STAGE=addon-load-started\n");
    const addon = require(addonPath);
    writeSync(2, "RION_ELECTRON_RUNTIME_STAGE=addon-loaded\n");
    for (const exportName of [
      "additionalBrowserArguments",
      "appKitRuntimeAbiVersion",
      "coreVersion",
      "createAppCore"
    ]) {
      if (typeof addon[exportName] !== "function") {
        throw new Error(`The Rust Node-API addon is missing ${exportName}.`);
      }
    }

    writeSync(1, `${PROBE_PREFIX}${JSON.stringify({
      arch: process.arch,
      appKitRuntimeAbi: addon.appKitRuntimeAbiVersion(),
      chrome: process.versions.chrome,
      core: addon.coreVersion(),
      electron: process.versions.electron,
      modules: process.versions.modules,
      napi: process.versions.napi,
      node: process.versions.node,
      platform: process.platform
    })}\n`);
    writeSync(2, "RION_ELECTRON_RUNTIME_STAGE=contract-written\n");
    app.exit(0);
  } catch (error) {
    writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  }
})();
