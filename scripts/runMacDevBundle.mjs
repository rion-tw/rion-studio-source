#!/usr/bin/env node

import { chmod, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const [requestedExecutable, ...applicationArguments] = process.argv.slice(2);

if (!requestedExecutable) {
  console.error("The macOS Tauri dev runner requires a compiled application executable.");
  process.exitCode = 1;
} else {
  await runBundled(resolve(requestedExecutable), applicationArguments);
}

async function runBundled(sourceExecutable, applicationArguments) {
  const bundleRoot = join(repositoryRoot, "target", "rion-dev", "Rion Studio Dev.app");
  const contents = join(bundleRoot, "Contents");
  const executableDirectory = join(contents, "MacOS");
  const resourcesDirectory = join(contents, "Resources");
  const executableName = basename(sourceExecutable);
  const bundledExecutable = join(executableDirectory, executableName);
  const temporaryExecutable = join(executableDirectory, `.${executableName}.tmp`);

  await Promise.all([
    mkdir(executableDirectory, { recursive: true }),
    mkdir(resourcesDirectory, { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(contents, "Info.plist"), infoPlist(executableName)),
    copyFile(join(repositoryRoot, "build", "icon.icns"), join(resourcesDirectory, "icon.icns"))
  ]);
  await copyFile(sourceExecutable, temporaryExecutable);
  await chmod(temporaryExecutable, 0o755);
  await rename(temporaryExecutable, bundledExecutable);

  if (typeof process.execve !== "function") {
    throw new Error("The macOS Tauri dev runner requires Node.js process.execve().");
  }
  process.chdir(dirname(sourceExecutable));
  process.execve(bundledExecutable, [bundledExecutable, ...applicationArguments], process.env);
}

function infoPlist(executableName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Rion Studio Dev</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>com.rionstudio.launcher.dev</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Rion Studio Dev</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}
