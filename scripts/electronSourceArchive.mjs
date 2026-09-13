import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import tar from "tar-stream";

export const ELECTRON_SOURCE_ARCHIVE_NAME = "Rion.Studio-source.tar.gz";
const REQUIRED_SOURCE_PATHS = Object.freeze([
  "LICENSE",
  "TRADEMARKS.md",
  "package.json",
  "third_party/electron-chrome-extensions/LICENSE-GPL",
  "third_party/electron-chrome-extensions/RION-PROVENANCE.md",
  "third_party/electron-chrome-extensions/src/browser/rion.ts",
  "third_party/electron-chrome-extensions/src/rion-preload.ts"
]);

function assertVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error("Electron source archive requires a semantic version.");
  }
}

function assertRelativeSourcePath(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 512 ||
    value.startsWith("/") || value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Electron source archive path is unsafe: ${value}`);
  }
  return value;
}

async function trackedSourcePaths(root) {
  const child = spawn("git", ["ls-files", "-z", "--cached"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = [];
  const errors = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => errors.push(chunk));
  await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolveExit();
      else reject(new Error(`Unable to list release sources: ${Buffer.concat(errors)}`));
    });
  });
  return Buffer.concat(output).toString("utf8").split("\0").filter(Boolean);
}

function writeEntry(pack, header, contents) {
  return new Promise((resolveEntry, reject) => {
    pack.entry(header, contents, (error) => error ? reject(error) : resolveEntry());
  });
}

export async function createElectronSourceArchive({
  outputPath,
  root = resolve(import.meta.dirname, ".."),
  trackedPaths,
  version
}) {
  assertVersion(version);
  const sourceRoot = resolve(root);
  const paths = [...new Set(trackedPaths ?? await trackedSourcePaths(sourceRoot))]
    .map(assertRelativeSourcePath)
    .sort();
  const missing = REQUIRED_SOURCE_PATHS.filter((path) => !paths.includes(path));
  if (missing.length > 0) {
    throw new Error(`Electron source archive is missing corresponding source: ${missing.join(", ")}`);
  }
  const destination = resolve(outputPath ?? join(
    sourceRoot, "release/electron", ELECTRON_SOURCE_ARCHIVE_NAME
  ));
  await mkdir(dirname(destination), { recursive: true });
  const pack = tar.pack();
  const output = createWriteStream(destination, { flags: "w", mode: 0o644 });
  pack.pipe(createGzip({ level: 9, mtime: 0 })).pipe(output);
  const completed = finished(output);
  const prefix = `rion-studio-source-${version}`;
  for (const path of paths) {
    const absolute = resolve(sourceRoot, path);
    if (relative(sourceRoot, absolute).startsWith("..")) {
      throw new Error(`Electron source archive path escapes its root: ${path}`);
    }
    const details = await lstat(absolute);
    const header = {
      gid: 0,
      mode: details.mode & 0o777,
      mtime: new Date(0),
      name: `${prefix}/${path}`,
      uid: 0
    };
    if (details.isSymbolicLink()) {
      await writeEntry(pack, { ...header, linkname: await readlink(absolute), type: "symlink" });
    } else if (details.isFile()) {
      await writeEntry(pack, { ...header, size: details.size }, await readFile(absolute));
    } else {
      throw new Error(`Electron source archive supports only files and symlinks: ${path}`);
    }
  }
  pack.finalize();
  await completed;
  await verifyElectronSourceArchive(destination, version);
  return Object.freeze({ name: basename(destination), path: destination, sourceCount: paths.length });
}

export async function verifyElectronSourceArchive(archivePath, version) {
  assertVersion(version);
  const prefix = `rion-studio-source-${version}/`;
  const names = new Set();
  let packagedVersion;
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    try {
      const name = header.name;
      if (!name.startsWith(prefix)) {
        throw new Error(`Electron source archive entry has an invalid root: ${name}`);
      }
      const path = assertRelativeSourcePath(name.slice(prefix.length));
      if (names.has(path)) {
        throw new Error(`Electron source archive entry is duplicated: ${path}`);
      }
      names.add(path);
      if (path === "package.json") {
        const chunks = [];
        let bytes = 0;
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            extract.destroy(new Error("Archived package.json is too large."));
          } else chunks.push(chunk);
        });
        stream.on("end", () => {
          try {
            packagedVersion = JSON.parse(Buffer.concat(chunks).toString("utf8")).version;
            next();
          } catch (error) {
            extract.destroy(error);
          }
        });
        return;
      }
      stream.on("end", next);
      stream.resume();
    } catch (error) {
      stream.resume();
      extract.destroy(error);
    }
  });
  await pipeline(createReadStream(archivePath), createGunzip(), extract);
  const missing = REQUIRED_SOURCE_PATHS.filter((path) => !names.has(path));
  if (missing.length > 0) {
    throw new Error(`Electron source archive lacks required source: ${missing.join(", ")}`);
  }
  if (packagedVersion !== version) {
    throw new Error(`Electron source archive version ${packagedVersion ?? "<missing>"} does not match ${version}.`);
  }
  return Object.freeze({ sourceCount: names.size, version });
}
