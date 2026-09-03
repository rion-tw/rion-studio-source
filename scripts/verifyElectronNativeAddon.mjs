import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { sanitizeUpdaterRuntimeEnvironment } from
  "./runtimeEnvironmentPolicy.mjs";

const execFileAsync = promisify(execFile);
const PORTABLE_ADDON_ID = "@rpath/rion-core.node";
const REQUIRED_MACOS_ARCHITECTURES = Object.freeze(["arm64"]);
const EXPECTED_APPLICATION_IDENTIFIER = "com.rionstudio.launcher";
const EXPECTED_ELECTRON_FRAMEWORK_IDENTIFIER = "com.github.Electron.framework";

export function assertMacosChromiumAddonLinkage(output) {
  const dependencies = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasFramework = (name) => dependencies.some((line) =>
    line.includes(`/Frameworks/${name}.framework/`)
  );

  if (!hasFramework("AppKit") || !hasFramework("QuartzCore")) {
    throw new Error(
      "The macOS Chromium addon must retain the AppKit and QuartzCore runtime host."
    );
  }
  if (hasFramework("WebKit")) {
    throw new Error(
      "The macOS Chromium addon must not link the v22 WebKit compatibility runtime."
    );
  }
}

export function assertMacosChromiumAddonLoadCommands(output) {
  const commands = parseDylibCommands(output);
  const identities = commands
    .filter((command) => command.command === "LC_ID_DYLIB")
    .map((command) => command.path);
  if (identities.length !== 1 || identities[0] !== PORTABLE_ADDON_ID) {
    throw new Error(
      `The macOS Chromium addon must use the portable install name ${PORTABLE_ADDON_ID}.`
    );
  }

  const loaded = commands.filter((command) => command.command !== "LC_ID_DYLIB");
  const unsafe = loaded.find((command) =>
    !command.path.startsWith("/System/Library/") &&
    !command.path.startsWith("/usr/lib/")
  );
  if (unsafe) {
    throw new Error(
      `The macOS Chromium addon contains a non-system dynamic dependency: ${unsafe.path}`
    );
  }
  const hasFramework = (name) => loaded.some((command) =>
    command.path.includes(`/Frameworks/${name}.framework/`)
  );
  if (!hasFramework("AppKit") || !hasFramework("QuartzCore")) {
    throw new Error(
      "The macOS Chromium addon load commands must retain AppKit and QuartzCore."
    );
  }
  if (hasFramework("WebKit")) {
    throw new Error(
      "The macOS Chromium addon load commands must not include the v22 WebKit runtime."
    );
  }

  const rpaths = parseRpathCommands(output);
  if (rpaths.length > 0) {
    throw new Error(
      `The macOS Chromium addon must not depend on runtime search paths: ${rpaths.join(", ")}`
    );
  }
}

export function assertMacosChromiumAddonArchitectures(output) {
  const architectures = String(output).trim().split(/\s+/u).filter(Boolean);
  if (
    architectures.length !== REQUIRED_MACOS_ARCHITECTURES.length ||
    architectures.some((architecture, index) =>
      architecture !== REQUIRED_MACOS_ARCHITECTURES[index]
    )
  ) {
    throw new Error(
      `The macOS Chromium addon must contain exactly ${REQUIRED_MACOS_ARCHITECTURES.join(", ")}; received ${architectures.join(", ") || "none"}.`
    );
  }
}

export function assertMacosAdHocSignature(output, expectedIdentifier) {
  const details = String(output);
  if (!/^Signature=adhoc$/mu.test(details) || !/^TeamIdentifier=not set$/mu.test(details)) {
    throw new Error(
      "The macOS Chromium package must use the owner-locked ad-hoc identity with no team identifier."
    );
  }
  if (
    expectedIdentifier !== undefined &&
    !new RegExp(`^Identifier=${escapeRegularExpression(expectedIdentifier)}$`, "mu")
      .test(details)
  ) {
    throw new Error(
      `The macOS Chromium signature must identify ${expectedIdentifier}.`
    );
  }
}

export function assertMacosAdHocBundleSignatureRelationship(details) {
  assertMacosAdHocSignature(
    details.application,
    EXPECTED_APPLICATION_IDENTIFIER
  );
  assertMacosAdHocSignature(
    details.framework,
    EXPECTED_ELECTRON_FRAMEWORK_IDENTIFIER
  );
  assertMacosAdHocSignature(details.addon);
}

export async function verifyMacosChromiumAddonLinkage(addonPath) {
  const options = {
    encoding: "utf8",
    env: sanitizeUpdaterRuntimeEnvironment(process.env),
    maxBuffer: 1024 * 1024
  };
  const [linkage, loadCommands, architectures] = await Promise.all([
    execFileAsync("/usr/bin/otool", ["-L", addonPath], options),
    execFileAsync("/usr/bin/otool", ["-l", addonPath], options),
    execFileAsync("/usr/bin/lipo", ["-archs", addonPath], options)
  ]);
  assertMacosChromiumAddonLinkage(linkage.stdout);
  assertMacosChromiumAddonLoadCommands(loadCommands.stdout);
  assertMacosChromiumAddonArchitectures(architectures.stdout);
}

export async function verifyMacosAdHocBundleSignature(
  applicationPath,
  frameworkPath,
  addonPath
) {
  const options = {
    encoding: "utf8",
    env: sanitizeUpdaterRuntimeEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024
  };
  await Promise.all([
    execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", applicationPath],
      options
    ),
    execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=2", frameworkPath],
      options
    ),
    execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=2", addonPath],
      options
    )
  ]);
  const [applicationDetails, frameworkDetails, addonDetails] = await Promise.all([
    execFileAsync(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", applicationPath],
      options
    ),
    execFileAsync(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", frameworkPath],
      options
    ),
    execFileAsync(
      "/usr/bin/codesign",
      ["--display", "--verbose=4", addonPath],
      options
    )
  ]);
  assertMacosAdHocBundleSignatureRelationship({
    addon: `${addonDetails.stdout}\n${addonDetails.stderr}`,
    application: `${applicationDetails.stdout}\n${applicationDetails.stderr}`,
    framework: `${frameworkDetails.stdout}\n${frameworkDetails.stderr}`
  });
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseDylibCommands(output) {
  const lines = String(output).split(/\r?\n/u);
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const command = lines[index]?.trim();
    if (!/^cmd LC_(?:ID|LOAD|LOAD_WEAK|LOAD_UPWARD|REEXPORT)_DYLIB$/u.test(command)) {
      continue;
    }
    const nameLine = lines.slice(index + 1, index + 5).find((line) =>
      /^\s*name .+ \(offset \d+\)\s*$/u.test(line)
    );
    const match = nameLine?.match(/^\s*name (.+) \(offset \d+\)\s*$/u);
    if (!match) {
      throw new Error(`The macOS Chromium addon has a malformed ${command.slice(4)} command.`);
    }
    commands.push({ command: command.slice(4), path: match[1] });
  }
  return commands;
}

function parseRpathCommands(output) {
  const lines = String(output).split(/\r?\n/u);
  const paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") continue;
    const pathLine = lines.slice(index + 1, index + 5).find((line) =>
      /^\s*path .+ \(offset \d+\)\s*$/u.test(line)
    );
    const match = pathLine?.match(/^\s*path (.+) \(offset \d+\)\s*$/u);
    if (!match) {
      throw new Error("The macOS Chromium addon has a malformed LC_RPATH command.");
    }
    paths.push(match[1]);
  }
  return paths;
}
