import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const rendererSourceExtensions = new Set([".cjs", ".html", ".js", ".mjs"]);
const maximumRendererEntryCount = 5_000;
const maximumRendererSourceBytes = 16 * 1024 * 1024;
const maximumRendererSourceTotalBytes = 96 * 1024 * 1024;

export const ELECTRON_RENDERER_DOCUMENTS = Object.freeze([
  "index.html",
  "runtime-role-placeholder-electron.html",
  "runtime-windows-host.html",
  "runtime-web-chrome-electron.html"
]);

export const TAURI_COMPATIBILITY_RENDERER_DOCUMENTS = Object.freeze([
  "runtime-divider.html",
  "runtime-role-placeholder.html",
  "runtime-tab-status.html",
  "runtime-tabs.html",
  "runtime-web-chrome.html"
]);

export const FORBIDDEN_ELECTRON_RENDERER_MARKERS = Object.freeze([
  "@tauri-apps/api",
  "__TAURI_INTERNALS__"
]);

export function assertElectronRendererSources(sources) {
  for (const source of sources) {
    const normalizedPath = normalizeRelativePath(source.path);
    const bytes = Buffer.isBuffer(source.source)
      ? source.source
      : Buffer.from(source.source, "utf8");
    for (const marker of FORBIDDEN_ELECTRON_RENDERER_MARKERS) {
      if (bytes.includes(Buffer.from(marker, "utf8"))) {
        throw new Error(
          `Electron renderer contains forbidden Tauri marker ${JSON.stringify(marker)} in ${normalizedPath}`
        );
      }
    }
  }
}

export async function verifyElectronRendererBundle(
  rendererRoot = join(repositoryRoot, "out", "renderer")
) {
  const absoluteRoot = resolve(rendererRoot);
  const rootMetadata = await lstat(absoluteRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Electron renderer output is not a real directory: ${absoluteRoot}`);
  }

  const entries = await readdir(absoluteRoot, {
    recursive: true,
    withFileTypes: true
  });
  if (entries.length === 0 || entries.length > maximumRendererEntryCount) {
    throw new Error(
      `Electron renderer entry count is outside the verified bounds: ${entries.length}`
    );
  }
  const symbolicLink = entries.find((entry) => entry.isSymbolicLink());
  if (symbolicLink) {
    throw new Error(
      `Electron renderer output contains a symbolic link: ${symbolicLink.name}`
    );
  }

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      absolutePath: join(entry.parentPath, entry.name),
      path: normalizeRelativePath(
        relative(absoluteRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/")
      )
    }));
  const filePaths = new Set(files.map((file) => file.path));
  for (const document of ELECTRON_RENDERER_DOCUMENTS) {
    if (!filePaths.has(document)) {
      throw new Error(`Electron renderer is missing required document: ${document}`);
    }
  }
  for (const document of TAURI_COMPATIBILITY_RENDERER_DOCUMENTS) {
    if (filePaths.has(document)) {
      throw new Error(
        `Electron renderer contains Tauri compatibility document: ${document}`
      );
    }
  }
  const sourceMap = files.find((file) => file.path.endsWith(".map"));
  if (sourceMap) {
    throw new Error(`Electron renderer must not contain source maps: ${sourceMap.path}`);
  }

  let sourceBytes = 0;
  const sources = [];
  for (const file of files) {
    if (!rendererSourceExtensions.has(extname(file.path))) continue;
    const metadata = await lstat(file.absolutePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > maximumRendererSourceBytes
    ) {
      throw new Error(
        `Electron renderer source size is outside the verified bounds: ${file.path}`
      );
    }
    sourceBytes += metadata.size;
    if (sourceBytes > maximumRendererSourceTotalBytes) {
      throw new Error(
        `Electron renderer sources exceed ${maximumRendererSourceTotalBytes} bytes`
      );
    }
    sources.push({ path: file.path, source: await readFile(file.absolutePath) });
  }
  assertElectronRendererSources(sources);
  return {
    entryCount: entries.length,
    rendererRoot: absoluteRoot,
    sourceBytes,
    sourceCount: sources.length
  };
}

function normalizeRelativePath(rawPath) {
  if (
    typeof rawPath !== "string" ||
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    rawPath.includes("\\")
  ) {
    throw new Error(`Electron renderer contains an invalid path: ${JSON.stringify(rawPath)}`);
  }
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Electron renderer contains an unsafe path: ${rawPath}`);
  }
  return rawPath;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await verifyElectronRendererBundle();
  console.log(
    `Verified pure Electron renderer bundle (${result.sourceCount} sources, ${result.sourceBytes} bytes).`
  );
}
