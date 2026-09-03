import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { extractFile, listPackage, statFile } from "@electron/asar";
import {
  FuseState,
  FuseV1Options,
  getCurrentFuseWire
} from "@electron/fuses";

import {
  verifyMacosAdHocBundleSignature,
  verifyMacosChromiumAddonLinkage
} from "./verifyElectronNativeAddon.mjs";
import {
  assertElectronRendererSources,
  ELECTRON_RENDERER_DOCUMENTS,
  TAURI_COMPATIBILITY_RENDERER_DOCUMENTS
} from "./verifyElectronRendererBundle.mjs";
import { sanitizeUpdaterRuntimeEnvironment } from
  "./runtimeEnvironmentPolicy.mjs";

const PRODUCT_NAME = "Rion Studio";
const PRODUCT_IDENTIFIER = "com.rionstudio.launcher";
const MINIMUM_MACOS_VERSION = "14.0";
const MACOS_ELECTRON_FRAMEWORK_RELATIVE_PATH = join(
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
  "Versions",
  "A",
  "Electron Framework"
);
const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const EXPECTED_ARCHIVE_MAIN = "out/main/index.js";
const REQUIRED_ARCHIVE_FILES = Object.freeze([
  "package.json",
  EXPECTED_ARCHIVE_MAIN,
  "out/preload/index.cjs",
  "out/preload/role.cjs",
  "out/preload/runtimeWindowsHost.cjs",
  "out/preload/workspaceWebChrome.cjs",
  ...ELECTRON_RENDERER_DOCUMENTS.map((document) => `out/renderer/${document}`)
]);
const EXPECTED_NATIVE_ADDON_PATH = "native/rion-core.node";
const execFileAsync = promisify(execFile);
const RUNTIME_SOURCE_EXTENSIONS = new Set([".cjs", ".html", ".js", ".mjs"]);
const MAX_ARCHIVE_ENTRY_COUNT = 10_000;
const MAX_RUNTIME_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024;
const FORBIDDEN_RUNTIME_MARKERS = Object.freeze([
  "@wdio/electron-service",
  "@wdio/tauri-plugin",
  "__rionStudioDesktopE2eNavigate",
  "chromium-shell-smoke",
  "rion:e2e:invoke",
  "rionStudioDesktopE2e",
  "retainedV22Precondition"
]);
const FORBIDDEN_RENDERER_MARKERS = Object.freeze([
  "TAURI_WEBDRIVER_PORT",
  "desktop_e2e_",
  "wdioTauri"
]);
const REQUIRED_FUSES = Object.freeze([
  [FuseV1Options.RunAsNode, FuseState.DISABLE, "RunAsNode"],
  [
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseState.DISABLE,
    "EnableNodeOptionsEnvironmentVariable"
  ],
  [
    FuseV1Options.EnableNodeCliInspectArguments,
    FuseState.DISABLE,
    "EnableNodeCliInspectArguments"
  ],
  [
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseState.ENABLE,
    "EnableEmbeddedAsarIntegrityValidation"
  ],
  [
    FuseV1Options.OnlyLoadAppFromAsar,
    FuseState.ENABLE,
    "OnlyLoadAppFromAsar"
  ]
]);

export function assertProductionElectronFuses(fuseWire) {
  const failures = [];
  for (const [option, expected, name] of REQUIRED_FUSES) {
    const actual = fuseWire[option];
    if (actual !== expected) {
      failures.push(`${name}: expected ${expected}, received ${actual ?? "missing"}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Packaged Electron fuse verification failed:\n- ${failures.join("\n- ")}`);
  }
}

export function assertProductionElectronArchiveSources(sources) {
  assertElectronRendererSources(sources
    .filter((source) => normalizeArchiveEntryPath(source.path).startsWith("out/renderer/"))
    .map((source) => ({
      path: normalizeArchiveEntryPath(source.path),
      source: source.source
    })));
  for (const source of sources) {
    const normalizedPath = normalizeArchiveEntryPath(source.path);
    const bytes = Buffer.isBuffer(source.source)
      ? source.source
      : Buffer.from(source.source, "utf8");
    const markers = normalizedPath.startsWith("out/renderer/")
      ? [...FORBIDDEN_RUNTIME_MARKERS, ...FORBIDDEN_RENDERER_MARKERS]
      : FORBIDDEN_RUNTIME_MARKERS;
    for (const marker of markers) {
      if (bytes.includes(Buffer.from(marker, "utf8"))) {
        throw new Error(
          `Production Electron archive contains desktop E2E marker ${JSON.stringify(marker)} in ${normalizedPath}`
        );
      }
    }
    if (normalizedPath.startsWith("out/preload/") &&
        /\b(?:import|require)\s*\(\s*["']\.\.?\//u.test(bytes.toString("utf8"))) {
      throw new Error(
        `Production Electron preload must be self-contained: ${normalizedPath}`
      );
    }
  }
}

export function verifyProductionElectronArchive(archivePath) {
  const rawEntries = listPackage(archivePath, { isPack: false });
  if (rawEntries.length === 0 || rawEntries.length > MAX_ARCHIVE_ENTRY_COUNT) {
    throw new Error(
      `Packaged Electron ASAR entry count is outside the verified bounds: ${rawEntries.length}`
    );
  }

  const normalizedEntries = rawEntries.map(normalizeArchiveEntryPath);
  const uniqueEntries = new Set(normalizedEntries);
  if (uniqueEntries.size !== normalizedEntries.length) {
    throw new Error("Packaged Electron ASAR contains duplicate normalized paths");
  }
  for (const requiredPath of REQUIRED_ARCHIVE_FILES) {
    if (!uniqueEntries.has(requiredPath)) {
      throw new Error(`Packaged Electron ASAR is missing required file: ${requiredPath}`);
    }
  }
  for (const document of TAURI_COMPATIBILITY_RENDERER_DOCUMENTS) {
    const forbiddenPath = `out/renderer/${document}`;
    if (uniqueEntries.has(forbiddenPath)) {
      throw new Error(
        `Packaged Electron ASAR contains Tauri compatibility document: ${forbiddenPath}`
      );
    }
  }
  const tauriApiEntry = normalizedEntries.find((entryPath) =>
    entryPath === "node_modules/@tauri-apps/api" ||
    entryPath.startsWith("node_modules/@tauri-apps/api/")
  );
  if (tauriApiEntry) {
    throw new Error(
      `Packaged Electron ASAR contains the Tauri compatibility API: ${tauriApiEntry}`
    );
  }
  const sourceMap = normalizedEntries.find((entryPath) => entryPath.endsWith(".map"));
  if (sourceMap) {
    throw new Error(`Packaged Electron ASAR must not contain source maps: ${sourceMap}`);
  }
  const preloadChunk = normalizedEntries.find((entryPath) =>
    entryPath.startsWith("out/preload/chunks/")
  );
  if (preloadChunk) {
    throw new Error(
      `Packaged Electron preload entries must be self-contained: ${preloadChunk}`
    );
  }
  const nativeAddon = normalizedEntries.find((entryPath) =>
    entryPath.toLowerCase().endsWith(".node")
  );
  if (nativeAddon) {
    throw new Error(`Packaged Electron native addon must remain outside ASAR: ${nativeAddon}`);
  }

  const packageJsonBytes = extractBoundedArchiveFile(
    archivePath,
    "package.json",
    1024 * 1024
  );
  let packageMetadata;
  try {
    packageMetadata = JSON.parse(packageJsonBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Packaged Electron ASAR package.json is invalid", { cause: error });
  }
  if (packageMetadata?.main !== EXPECTED_ARCHIVE_MAIN) {
    throw new Error(
      `Packaged Electron ASAR main must be ${EXPECTED_ARCHIVE_MAIN}; received ${String(packageMetadata?.main)}`
    );
  }
  if (
    typeof packageMetadata?.version !== "string" ||
    !SEMANTIC_VERSION_PATTERN.test(packageMetadata.version)
  ) {
    throw new Error(
      "Packaged Electron ASAR package.json must contain a semantic version"
    );
  }

  const runtimeSources = [];
  let totalSourceBytes = 0;
  for (const entryPath of normalizedEntries) {
    if (!entryPath.startsWith("out/") || !RUNTIME_SOURCE_EXTENSIONS.has(extname(entryPath))) {
      continue;
    }
    const source = extractBoundedArchiveFile(
      archivePath,
      entryPath,
      MAX_RUNTIME_SOURCE_BYTES,
      entryPath === "out/preload/role.cjs"
    );
    totalSourceBytes += source.length;
    if (totalSourceBytes > MAX_RUNTIME_SOURCE_TOTAL_BYTES) {
      throw new Error(
        `Packaged Electron runtime sources exceed ${MAX_RUNTIME_SOURCE_TOTAL_BYTES} bytes`
      );
    }
    runtimeSources.push({ path: entryPath, source });
  }
  assertProductionElectronArchiveSources(runtimeSources);
  return {
    archivePath,
    entryCount: normalizedEntries.length,
    packageVersion: packageMetadata.version,
    runtimeSourceBytes: totalSourceBytes,
    runtimeSourceCount: runtimeSources.length
  };
}

export function resolveElectronPackageLayout(applicationPath) {
  const absolutePath = resolve(applicationPath);
  if (basename(absolutePath).endsWith(".app")) {
    return {
      executablePath: join(absolutePath, "Contents", "MacOS", PRODUCT_NAME),
      resourcesPath: join(absolutePath, "Contents", "Resources")
    };
  }
  return {
    executablePath: join(absolutePath, `${PRODUCT_NAME}.exe`),
    resourcesPath: join(absolutePath, "resources")
  };
}

export function resolveMacosElectronFrameworkBinaryPath(applicationPath) {
  return join(resolve(applicationPath), MACOS_ELECTRON_FRAMEWORK_RELATIVE_PATH);
}

export function assertMacosElectronBundleInfo(info, expectedVersion) {
  if (!SEMANTIC_VERSION_PATTERN.test(String(expectedVersion))) {
    throw new Error("macOS bundle verification requires a semantic version.");
  }
  const expected = Object.freeze({
    CFBundleDisplayName: PRODUCT_NAME,
    CFBundleExecutable: PRODUCT_NAME,
    CFBundleIdentifier: PRODUCT_IDENTIFIER,
    CFBundleName: PRODUCT_NAME,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: expectedVersion,
    CFBundleVersion: expectedVersion,
    LSMinimumSystemVersion: MINIMUM_MACOS_VERSION
  });
  const failures = Object.entries(expected).flatMap(([name, value]) =>
    info?.[name] === value
      ? []
      : [`${name}: expected ${value}, received ${String(info?.[name] ?? "missing")}`]
  );
  if (failures.length > 0) {
    throw new Error(
      `Packaged Electron macOS Info.plist verification failed:\n- ${failures.join("\n- ")}`
    );
  }
}

export function assertMacosElectronFrameworkArchitectures(output) {
  const architectures = String(output).trim().split(/\s+/u).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new Error(
      `The packaged Electron Framework must contain exactly arm64; received ${architectures.join(", ") || "none"}.`
    );
  }
}

export function assertElectronNativeAddonInventory(entryPaths) {
  const normalizedPaths = entryPaths
    .map((entryPath) => String(entryPath).replaceAll("\\", "/"))
    .sort();
  if (
    normalizedPaths.length !== 1 ||
    normalizedPaths[0] !== EXPECTED_NATIVE_ADDON_PATH
  ) {
    throw new Error(
      `Packaged Electron resources must contain exactly ${EXPECTED_NATIVE_ADDON_PATH}; received ${normalizedPaths.join(", ") || "none"}.`
    );
  }
}

export function assertWindowsAuthenticodeStatus(output) {
  const status = String(output).trim();
  if (status !== "NotSigned") {
    throw new Error(
      `The Windows Chromium executable must remain Authenticode-unsigned; received ${status || "no status"}.`
    );
  }
}

export async function verifyPackagedElectron(applicationPath) {
  const absoluteApplicationPath = resolve(applicationPath);
  const applicationMetadata = await lstat(absoluteApplicationPath);
  if (!applicationMetadata.isDirectory() || applicationMetadata.isSymbolicLink()) {
    throw new Error(
      `Packaged Electron application root is not a real directory: ${absoluteApplicationPath}`
    );
  }
  const { executablePath, resourcesPath } = resolveElectronPackageLayout(
    absoluteApplicationPath
  );
  const nativeAddonPath = join(resourcesPath, "native", "rion-core.node");
  assertElectronNativeAddonInventory(await nativeAddonInventory(resourcesPath));
  const requiredFiles = [
    executablePath,
    join(resourcesPath, "app.asar"),
    nativeAddonPath
  ];
  for (const path of requiredFiles) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
      throw new Error(`Packaged Electron file is missing or empty: ${path}`);
    }
  }
  const archiveVerification = verifyProductionElectronArchive(
    join(resourcesPath, "app.asar")
  );
  if (basename(absoluteApplicationPath).endsWith(".app")) {
    const frameworkPath = await verifyMacosFinalBundleMetadata(
      absoluteApplicationPath,
      archiveVerification.packageVersion
    );
    await verifyMacosChromiumAddonLinkage(nativeAddonPath);
    await verifyMacosAdHocBundleSignature(
      absoluteApplicationPath,
      frameworkPath,
      nativeAddonPath
    );
  } else {
    await verifyWindowsUnsignedExecutable(executablePath);
  }
  assertProductionElectronFuses(await getCurrentFuseWire(executablePath));
  return { executablePath, resourcesPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const applicationPath = parseApplicationPath(process.argv.slice(2));
  const layout = await verifyPackagedElectron(applicationPath);
  console.log(`Verified packaged Electron application: ${layout.executablePath}`);
}

function parseApplicationPath(argumentsList) {
  const normalizedArguments = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  if (normalizedArguments.length !== 2 || normalizedArguments[0] !== "--app") {
    throw new Error("Usage: verifyElectronPackage.mjs --app <application bundle or unpacked directory>");
  }
  return normalizedArguments[1];
}

function extractBoundedArchiveFile(
  archivePath,
  entryPath,
  maximumBytes,
  allowEmpty = false
) {
  const metadata = statFile(archivePath, entryPath, false);
  if (!("size" in metadata) || metadata.unpacked === true) {
    throw new Error(`Packaged Electron ASAR entry is not an in-archive file: ${entryPath}`);
  }
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < (allowEmpty ? 0 : 1) ||
    metadata.size > maximumBytes
  ) {
    throw new Error(
      `Packaged Electron ASAR file size is outside the verified bounds: ${entryPath} (${String(metadata.size)} bytes)`
    );
  }
  const source = extractFile(archivePath, entryPath, false);
  if (source.length !== metadata.size) {
    throw new Error(
      `Packaged Electron ASAR file size changed while verifying: ${entryPath}`
    );
  }
  return source;
}

function normalizeArchiveEntryPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.includes("\0")) {
    throw new Error(`Packaged Electron ASAR contains an invalid path: ${JSON.stringify(rawPath)}`);
  }
  const archivePath = rawPath.replaceAll("\\", "/");
  const normalizedPath = archivePath.startsWith("/") ? archivePath.slice(1) : archivePath;
  const pathSegments = normalizedPath.split("/");
  if (
    normalizedPath.length === 0 ||
    normalizedPath.startsWith("/") ||
    pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Packaged Electron ASAR contains an unsafe path: ${rawPath}`);
  }
  return normalizedPath;
}

async function nativeAddonInventory(resourcesPath) {
  const entries = await readdir(resourcesPath, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".node"))
    .map((entry) => relative(
      resourcesPath,
      join(entry.parentPath, entry.name)
    ).replaceAll("\\", "/"));
}

async function verifyMacosFinalBundleMetadata(applicationPath, expectedVersion) {
  const infoPath = join(applicationPath, "Contents", "Info.plist");
  const frameworkPath = resolveMacosElectronFrameworkBinaryPath(applicationPath);
  for (const path of [infoPath, frameworkPath]) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
      throw new Error(`Packaged Electron macOS bundle file is missing or empty: ${path}`);
    }
  }
  const options = {
    encoding: "utf8",
    env: sanitizeUpdaterRuntimeEnvironment(process.env),
    maxBuffer: 4 * 1024 * 1024
  };
  const [plist, architectures] = await Promise.all([
    execFileAsync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", infoPath],
      options
    ),
    execFileAsync("/usr/bin/lipo", ["-archs", frameworkPath], options)
  ]);
  let info;
  try {
    info = JSON.parse(plist.stdout);
  } catch (error) {
    throw new Error("Packaged Electron macOS Info.plist is invalid", {
      cause: error
    });
  }
  assertMacosElectronBundleInfo(info, expectedVersion);
  assertMacosElectronFrameworkArchitectures(architectures.stdout);
  return frameworkPath;
}

async function verifyWindowsUnsignedExecutable(executablePath) {
  const result = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:RION_ELECTRON_VERIFY_PATH; [Console]::Out.Write($signature.Status.ToString())"
    ],
    {
      encoding: "utf8",
      env: {
        ...sanitizeUpdaterRuntimeEnvironment(process.env),
        RION_ELECTRON_VERIFY_PATH: executablePath
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  );
  assertWindowsAuthenticodeStatus(result.stdout);
}
