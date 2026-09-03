import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolveCargoExecutable } from "./cargoExecutable.mjs";
import { verifyMacosChromiumAddonLinkage } from "./verifyElectronNativeAddon.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const argumentsList = process.argv.slice(2);
if (argumentsList.length > 1 || (argumentsList.length === 1 && argumentsList[0] !== "--release")) {
  throw new Error("Usage: buildElectronRust.mjs [--release]");
}

const release = argumentsList[0] === "--release";
const desktopE2e = process.env.RION_STUDIO_DESKTOP_E2E_BUILD === "1";
if (release && desktopE2e) {
  throw new Error("Release Rust addons must not enable the desktop-e2e feature.");
}
const cargoProfile = release ? "release" : "debug";
const platformDirectory = `${process.platform}-${process.arch}`;
const outputDirectory = join(repositoryRoot, "build", "native", platformDirectory);
const libraryName = process.platform === "win32"
  ? "rion_node.dll"
  : process.platform === "darwin"
    ? "librion_node.dylib"
    : "librion_node.so";
const source = join(repositoryRoot, "target", cargoProfile, libraryName);
const destination = join(outputDirectory, "rion-core.node");

await run(await resolveCargoExecutable(), [
  "build",
  "--locked",
  ...(release ? ["--release"] : []),
  "-p",
  "rion-node",
  ...(desktopE2e ? ["--features=desktop-e2e"] : [])
]);
await mkdir(outputDirectory, { recursive: true });
await copyFile(source, destination);

if (process.platform === "darwin") {
  await run("/usr/bin/install_name_tool", [
    "-id",
    "@rpath/rion-core.node",
    destination
  ]);
  await verifyMacosChromiumAddonLinkage(destination);
  await run("/usr/bin/codesign", ["--force", "--sign", "-", destination]);
}

verifyDesktopE2eAddonSurface(destination, desktopE2e);

console.log(
  `Built Rust Node-API addon (${release ? "release" : desktopE2e ? "desktop-e2e" : "dev"}): ${destination}`
);

function verifyDesktopE2eAddonSurface(addonPath, expected) {
  const require = createRequire(import.meta.url);
  const addon = require(addonPath);
  const corePrototype = addon.NativeAppCore?.prototype;
  if (!corePrototype) {
    throw new Error("The Rust addon does not export the native AppCore class.");
  }
  if (typeof corePrototype.writeRoleSessionTransferVaultInternal === "function") {
    throw new Error(
      "The Chromium target addon exposes the forbidden source-session vault writer."
    );
  }
  if (typeof corePrototype.recoverPendingChromeProfileImportsInternal !== "function") {
    throw new Error(
      "The production Rust addon is missing Chrome-profile import startup recovery."
    );
  }
  const fixtureFactory = "createAppCoreForDesktopE2e";
  const fixtureFactoryPresent = typeof addon[fixtureFactory] === "function";
  if (expected !== fixtureFactoryPresent) {
    throw new Error(expected
      ? "The desktop-E2E Rust addon is missing its retained-v22 Core factory."
      : "The production Rust addon exposes a forbidden desktop-E2E Core factory.");
  }
  const prototype = addon.NativeAppKitRuntimeHost?.prototype;
  if (!prototype) {
    throw new Error("The Rust addon does not export the AppKit runtime-host class.");
  }
  const methods = [
    "desktopE2eAccessibilityPress",
    "desktopE2eAccessibilityClose",
    "desktopE2eAccessibilityShowMenu",
    "desktopE2eTitlebarGeometry",
    "desktopE2eTabAnchor",
    "desktopE2eFullscreenToolbarState",
    "desktopE2eStatusPresentation"
  ];
  const present = methods.filter((method) => typeof prototype[method] === "function");
  if (expected && present.length !== methods.length) {
    throw new Error(
      `The desktop-E2E Rust addon is missing probe methods: ${methods.filter((method) => !present.includes(method)).join(", ")}.`
    );
  }
  if (!expected && present.length > 0) {
    throw new Error(
      `The production Rust addon exposes forbidden desktop-E2E methods: ${present.join(", ")}.`
    );
  }
}

async function run(command, commandArguments) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArguments, {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(signal
        ? `${command} was terminated by ${signal}.`
        : `${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}
