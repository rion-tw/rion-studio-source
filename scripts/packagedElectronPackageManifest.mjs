import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readlink,
  realpath
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MANIFEST_SCHEMA_VERSION = 1;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PORTABLE_MANIFEST_FIELDS = Object.freeze([
  "directoryCount",
  "entries",
  "entryCount",
  "regularFileBytes",
  "regularFileCount",
  "rootMode",
  "schemaVersion",
  "sha256",
  "symlinkCount"
]);
const PACKAGE_MANIFEST_FIELDS = Object.freeze([
  ...PORTABLE_MANIFEST_FIELDS,
  "packageDirectory"
]);

export const PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS = Object.freeze({
  maximumEntries: 100_000,
  maximumFileBytes: 2 * 1024 * 1024 * 1024,
  maximumSymlinkTargetBytes: 16 * 1024,
  maximumTotalFileBytes: 8 * 1024 * 1024 * 1024
});

export async function capturePackagedElectronPackageManifest(
  packageDirectory,
  limitOverrides = {}
) {
  const limits = resolveLimits(limitOverrides);
  const requestedRoot = resolveRequiredPath(packageDirectory);
  const requestedMetadata = await lstat(requestedRoot, { bigint: true });
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error("The packaged Electron root must be a real directory.");
  }
  const canonicalRoot = await realpath(requestedRoot);
  const rootMetadata = await lstat(canonicalRoot, { bigint: true });
  assertStableMetadata(
    requestedMetadata,
    rootMetadata,
    "packaged Electron root"
  );

  const state = {
    discoveredEntryCount: 0,
    entries: [],
    regularFileBytes: 0,
    stabilityRecords: []
  };
  await traverseDirectory(canonicalRoot, [], rootMetadata, limits, state);
  await revalidateTraversal(canonicalRoot, rootMetadata, state.stabilityRecords);

  const portableManifest = createPortablePackagedElectronPackageManifest(
    state.entries.sort(compareEntryPaths),
    normalizedMode(rootMetadata)
  );
  return Object.freeze({
    ...portableManifest,
    packageDirectory: canonicalRoot
  });
}

export function createPortablePackagedElectronPackageManifest(entries, rootMode) {
  validateMode(rootMode, "portable packaged Electron manifest");
  validateManifestEntries(entries, "portable packaged Electron manifest");
  const clonedEntries = Object.freeze(entries.map((entry) =>
    Object.freeze(publicEntry(entry))));
  const counts = countEntryTypes(clonedEntries);
  const manifest = {
    directoryCount: counts.directoryCount,
    entries: clonedEntries,
    entryCount: clonedEntries.length,
    regularFileBytes: counts.regularFileBytes,
    regularFileCount: counts.regularFileCount,
    rootMode,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sha256: hashManifestEntries(clonedEntries, rootMode),
    symlinkCount: counts.symlinkCount
  };
  validatePortableManifest(manifest, "portable packaged Electron manifest");
  return Object.freeze(manifest);
}

export function toPortablePackagedElectronPackageManifest(manifest) {
  validateManifest(manifest, "packaged Electron manifest");
  return createPortablePackagedElectronPackageManifest(
    manifest.entries,
    manifest.rootMode
  );
}

export function assertPortablePackagedElectronPackageManifest(value) {
  validatePortableManifest(value, "portable packaged Electron manifest");
  return createPortablePackagedElectronPackageManifest(
    value.entries,
    value.rootMode
  );
}

export function removeExactPortablePackagedElectronPackageManifestEntry(
  manifest,
  exactPath
) {
  const portableManifest = assertPortablePackagedElectronPackageManifest(manifest);
  validateRelativePath(exactPath, "portable packaged Electron manifest entry path");
  const entryIndex = portableManifest.entries.findIndex((entry) =>
    entry.path === exactPath);
  if (entryIndex === -1) {
    throw new Error(
      `The portable packaged Electron manifest does not contain exact entry ${JSON.stringify(exactPath)}.`
    );
  }
  return createPortablePackagedElectronPackageManifest(
    portableManifest.entries.filter((_, index) => index !== entryIndex),
    portableManifest.rootMode
  );
}

export function summarizePackagedElectronPackageManifest(manifest) {
  validateManifest(manifest, "packaged Electron manifest");
  return assertPackagedElectronPackageManifestSummary({
    directoryCount: manifest.directoryCount,
    entryCount: manifest.entryCount,
    regularFileBytes: manifest.regularFileBytes,
    regularFileCount: manifest.regularFileCount,
    schemaVersion: manifest.schemaVersion,
    sha256: manifest.sha256,
    symlinkCount: manifest.symlinkCount
  });
}

export function assertPackagedElectronPackageManifestSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The packaged Electron manifest summary must be an object.");
  }
  assertExactKeys(value, [
    "directoryCount",
    "entryCount",
    "regularFileBytes",
    "regularFileCount",
    "schemaVersion",
    "sha256",
    "symlinkCount"
  ], "packaged Electron manifest summary");
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error("The packaged Electron manifest summary schema version is invalid.");
  }
  for (const [count, label] of [
    [value.directoryCount, "directory count"],
    [value.entryCount, "entry count"],
    [value.regularFileBytes, "regular-file bytes"],
    [value.regularFileCount, "regular-file count"],
    [value.symlinkCount, "symlink count"]
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`The packaged Electron manifest summary ${label} is invalid.`);
    }
  }
  if (
    value.entryCount !==
      value.directoryCount + value.regularFileCount + value.symlinkCount
  ) {
    throw new Error("The packaged Electron manifest summary entry count is inconsistent.");
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error("The packaged Electron manifest summary SHA-256 is invalid.");
  }
  return Object.freeze({
    directoryCount: value.directoryCount,
    entryCount: value.entryCount,
    regularFileBytes: value.regularFileBytes,
    regularFileCount: value.regularFileCount,
    schemaVersion: value.schemaVersion,
    sha256: value.sha256,
    symlinkCount: value.symlinkCount
  });
}

export function comparePackagedElectronPackageManifests(expected, actual) {
  validateManifest(expected, "expected packaged Electron manifest");
  validateManifest(actual, "actual packaged Electron manifest");
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const addedPaths = [];
  const changedPaths = expected.rootMode === actual.rootMode ? [] : ["."];
  const removedPaths = [];

  for (const entry of expected.entries) {
    const current = actualByPath.get(entry.path);
    if (!current) removedPaths.push(entry.path);
    else if (!entriesMatch(entry, current)) changedPaths.push(entry.path);
  }
  for (const entry of actual.entries) {
    if (!expectedByPath.has(entry.path)) addedPaths.push(entry.path);
  }

  return Object.freeze({
    addedPaths: Object.freeze(addedPaths),
    changedPaths: Object.freeze(changedPaths),
    matches: addedPaths.length === 0 &&
      changedPaths.length === 0 &&
      removedPaths.length === 0,
    removedPaths: Object.freeze(removedPaths)
  });
}

export function assertPackagedElectronPackageManifestUnchanged(expected, actual) {
  const comparison = comparePackagedElectronPackageManifests(expected, actual);
  if (!comparison.matches) {
    throw new Error(
      "The packaged Electron directory changed: " +
      [
        describePathChanges("added", comparison.addedPaths),
        describePathChanges("removed", comparison.removedPaths),
        describePathChanges("changed", comparison.changedPaths)
      ].filter(Boolean).join("; ")
    );
  }
  return summarizePackagedElectronPackageManifest(actual);
}

async function traverseDirectory(
  root,
  segments,
  initialMetadata,
  limits,
  state
) {
  const directoryPath = segments.length === 0 ? root : join(root, ...segments);
  const names = await readBoundedDirectoryNames(directoryPath, limits, state);
  for (const name of names) {
    const childSegments = [...segments, name];
    const relativePath = childSegments.join("/");
    const childPath = join(root, ...childSegments);
    const metadata = await lstat(childPath, { bigint: true });
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      const captured = await captureRegularFile(
        childPath,
        relativePath,
        metadata,
        limits,
        state.regularFileBytes
      );
      state.regularFileBytes += captured.entry.bytes;
      state.entries.push(captured.entry);
      state.stabilityRecords.push({ metadata: captured.metadata, path: childPath });
      continue;
    }
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      state.entries.push(Object.freeze({
        mode: normalizedMode(metadata),
        path: relativePath,
        type: "directory"
      }));
      await traverseDirectory(root, childSegments, metadata, limits, state);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      const captured = await captureSymbolicLink(
        root,
        childPath,
        relativePath,
        metadata,
        limits
      );
      state.entries.push(captured.entry);
      state.stabilityRecords.push({ metadata: captured.metadata, path: childPath });
      continue;
    }
    throw new Error(
      `Packaged Electron entry ${JSON.stringify(relativePath)} has an unsupported type.`
    );
  }
  const completedMetadata = await stableLstat(
    directoryPath,
    `directory ${manifestLabel(segments)}`
  );
  assertStableMetadata(
    initialMetadata,
    completedMetadata,
    `directory ${manifestLabel(segments)}`
  );
  if (segments.length > 0) {
    state.stabilityRecords.push({ metadata: completedMetadata, path: directoryPath });
  }
}

async function readBoundedDirectoryNames(directoryPath, limits, state) {
  const directory = await opendir(directoryPath);
  const names = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      validatePathSegment(entry.name);
      state.discoveredEntryCount += 1;
      if (state.discoveredEntryCount > limits.maximumEntries) {
        throw new Error(
          `The packaged Electron directory exceeds ${limits.maximumEntries} entries.`
        );
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close();
  }
  return names.sort(compareStrings);
}

async function captureRegularFile(
  filePath,
  relativePath,
  initialMetadata,
  limits,
  priorFileBytes
) {
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assertStableMetadata(initialMetadata, before, `file ${JSON.stringify(relativePath)}`);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Packaged Electron entry ${JSON.stringify(relativePath)} is not a file.`);
    }
    if (before.nlink !== 1n) {
      throw new Error(
        `Packaged Electron file ${JSON.stringify(relativePath)} must have exactly one directory entry.`
      );
    }
    const bytes = boundedFileSize(before.size, relativePath, limits, priorFileBytes);
    const hash = createHash("sha256");
    let hashedBytes = 0;
    if (bytes > 0) {
      const stream = handle.createReadStream({ autoClose: false, end: bytes - 1, start: 0 });
      for await (const chunk of stream) {
        hashedBytes += chunk.length;
        hash.update(chunk);
      }
    }
    const after = await handle.stat({ bigint: true });
    assertStableMetadata(before, after, `file ${JSON.stringify(relativePath)}`);
    if (hashedBytes !== bytes) {
      throw new Error(`Packaged Electron file ${JSON.stringify(relativePath)} changed size.`);
    }
    const completedPathMetadata = await stableLstat(
      filePath,
      `file ${JSON.stringify(relativePath)}`
    );
    assertStableMetadata(after, completedPathMetadata, `file ${JSON.stringify(relativePath)}`);
    return {
      entry: Object.freeze({
        bytes,
        mode: normalizedMode(before),
        path: relativePath,
        sha256: hash.digest("hex"),
        type: "regular-file"
      }),
      metadata: completedPathMetadata
    };
  } finally {
    await handle.close();
  }
}

async function captureSymbolicLink(
  root,
  linkPath,
  relativePath,
  initialMetadata,
  limits
) {
  const targetBytes = await readlink(linkPath, { encoding: "buffer" });
  if (targetBytes.length === 0 || targetBytes.length > limits.maximumSymlinkTargetBytes) {
    throw new Error(
      `Packaged Electron symlink ${JSON.stringify(relativePath)} exceeds its target byte bound.`
    );
  }
  const target = decodeUtf8(targetBytes, relativePath);
  if (isAbsolute(target)) {
    throw new Error(
      `Packaged Electron symlink ${JSON.stringify(relativePath)} has an absolute target.`
    );
  }
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(linkPath);
  } catch (error) {
    throw new Error(
      `Packaged Electron symlink ${JSON.stringify(relativePath)} has an unresolved target.`,
      { cause: error }
    );
  }
  if (!isPathInsideRoot(resolvedTarget, root)) {
    throw new Error(
      `Packaged Electron symlink ${JSON.stringify(relativePath)} escapes the package root.`
    );
  }
  const completedMetadata = await stableLstat(
    linkPath,
    `symlink ${JSON.stringify(relativePath)}`
  );
  assertStableMetadata(
    initialMetadata,
    completedMetadata,
    `symlink ${JSON.stringify(relativePath)}`
  );
  return {
    entry: Object.freeze({
      mode: normalizedMode(completedMetadata),
      path: relativePath,
      target,
      type: "symlink"
    }),
    metadata: completedMetadata
  };
}

async function revalidateTraversal(root, rootMetadata, stabilityRecords) {
  for (const record of stabilityRecords.sort((left, right) =>
    compareStrings(left.path, right.path))) {
    const metadata = await stableLstat(record.path, JSON.stringify(record.path));
    assertStableMetadata(record.metadata, metadata, JSON.stringify(record.path));
  }
  const completedRootMetadata = await stableLstat(root, "packaged Electron root");
  assertStableMetadata(rootMetadata, completedRootMetadata, "packaged Electron root");
}

function boundedFileSize(size, relativePath, limits, priorFileBytes) {
  if (size < 0n || size > BigInt(limits.maximumFileBytes)) {
    throw new Error(
      `Packaged Electron file ${JSON.stringify(relativePath)} exceeds its byte bound.`
    );
  }
  const bytes = Number(size);
  if (priorFileBytes + bytes > limits.maximumTotalFileBytes) {
    throw new Error(
      `The packaged Electron directory exceeds ${limits.maximumTotalFileBytes} file bytes.`
    );
  }
  return bytes;
}

function resolveLimits(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Packaged Electron manifest limits must be an object.");
  }
  const allowed = new Set(Object.keys(PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS));
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key)) throw new Error(`Unknown packaged Electron manifest limit ${key}.`);
  }
  const limits = Object.freeze({
    ...PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS,
    ...overrides
  });
  for (const [name, value] of Object.entries(limits)) {
    const permitsZero = name !== "maximumEntries" &&
      name !== "maximumSymlinkTargetBytes";
    if (!Number.isSafeInteger(value) || value < (permitsZero ? 0 : 1)) {
      throw new Error(`${name} must be a safe ${permitsZero ? "nonnegative" : "positive"} integer.`);
    }
  }
  return limits;
}

function validateManifest(manifest, label) {
  validateManifestValue(manifest, label, PACKAGE_MANIFEST_FIELDS);
  if (typeof manifest.packageDirectory !== "string" || !manifest.packageDirectory) {
    throw new Error(`The ${label} has an invalid package directory.`);
  }
}

function validatePortableManifest(manifest, label) {
  validateManifestValue(manifest, label, PORTABLE_MANIFEST_FIELDS);
}

function validateManifestValue(manifest, label, expectedFields) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`The ${label} must be an object.`);
  }
  assertExactKeys(manifest, expectedFields, label);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`The ${label} has an unsupported schema version.`);
  }
  validateMode(manifest.rootMode, label);
  validateManifestEntries(manifest.entries, label);
  const counts = countEntryTypes(manifest.entries);
  assertCount(manifest.entryCount, manifest.entries.length, `${label} entry count`);
  assertCount(manifest.directoryCount, counts.directoryCount, `${label} directory count`);
  assertCount(
    manifest.regularFileCount,
    counts.regularFileCount,
    `${label} regular-file count`
  );
  assertCount(manifest.symlinkCount, counts.symlinkCount, `${label} symlink count`);
  assertCount(
    manifest.regularFileBytes,
    counts.regularFileBytes,
    `${label} regular-file bytes`
  );
  if (typeof manifest.sha256 !== "string" ||
      !SHA256_PATTERN.test(manifest.sha256) ||
      manifest.sha256 !== hashManifestEntries(manifest.entries, manifest.rootMode)) {
    throw new Error(`The ${label} has an invalid SHA-256.`);
  }
}

function validateManifestEntries(entries, label) {
  if (!Array.isArray(entries)) {
    throw new Error(`The ${label} entries must be an array.`);
  }
  let previousPath;
  for (const entry of entries) {
    validateManifestEntry(entry, label);
    if (previousPath !== undefined && compareStrings(previousPath, entry.path) >= 0) {
      throw new Error(`The ${label} entries must have unique sorted paths.`);
    }
    previousPath = entry.path;
  }
}

function validateManifestEntry(entry, label) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`The ${label} contains a non-object entry.`);
  }
  validateRelativePath(entry.path, label);
  if (entry.type === "directory") {
    assertExactKeys(entry, ["mode", "path", "type"], `${label} directory entry`);
    validateMode(entry.mode, label);
    return;
  }
  if (entry.type === "regular-file") {
    assertExactKeys(
      entry,
      ["bytes", "mode", "path", "sha256", "type"],
      `${label} file entry`
    );
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
        typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`The ${label} contains an invalid regular-file entry.`);
    }
    validateMode(entry.mode, label);
    return;
  }
  if (entry.type === "symlink") {
    assertExactKeys(
      entry,
      ["mode", "path", "target", "type"],
      `${label} symlink entry`
    );
    if (typeof entry.target !== "string" || entry.target.length === 0 ||
        entry.target.includes("\0")) {
      throw new Error(`The ${label} contains an invalid symlink entry.`);
    }
    validateMode(entry.mode, label);
    return;
  }
  throw new Error(`The ${label} contains an unsupported entry type.`);
}

function countEntryTypes(entries) {
  let directoryCount = 0;
  let regularFileBytes = 0;
  let regularFileCount = 0;
  let symlinkCount = 0;
  for (const entry of entries) {
    if (entry.type === "directory") directoryCount += 1;
    else if (entry.type === "regular-file") {
      regularFileBytes += entry.bytes;
      regularFileCount += 1;
    } else if (entry.type === "symlink") symlinkCount += 1;
  }
  return { directoryCount, regularFileBytes, regularFileCount, symlinkCount };
}

function entriesMatch(expected, actual) {
  if (expected.type !== actual.type || expected.mode !== actual.mode) return false;
  if (expected.type === "regular-file") {
    return expected.bytes === actual.bytes && expected.sha256 === actual.sha256;
  }
  if (expected.type === "symlink") return expected.target === actual.target;
  return true;
}

function hashManifestEntries(entries, rootMode) {
  const hash = createHash("sha256");
  hash.update(`rion-packaged-electron-manifest-v${MANIFEST_SCHEMA_VERSION}\n`);
  hash.update(`${JSON.stringify({ mode: rootMode, path: ".", type: "directory" })}\n`);
  for (const entry of entries) hash.update(`${JSON.stringify(publicEntry(entry))}\n`);
  return hash.digest("hex");
}

function publicEntry(entry) {
  if (entry.type === "regular-file") {
    return {
      bytes: entry.bytes,
      mode: entry.mode,
      path: entry.path,
      sha256: entry.sha256,
      type: entry.type
    };
  }
  if (entry.type === "symlink") {
    return {
      mode: entry.mode,
      path: entry.path,
      target: entry.target,
      type: entry.type
    };
  }
  return { mode: entry.mode, path: entry.path, type: entry.type };
}

function assertStableMetadata(before, after, label) {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.nlink !== after.nlink ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`The ${label} changed while its manifest was captured.`);
  }
}

function normalizedMode(metadata) {
  return Number(metadata.mode & 0o7777n);
}

function validateMode(mode, label) {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new Error(`The ${label} contains an invalid permission mode.`);
  }
}

function isPathInsideRoot(path, root) {
  const relation = relative(root, path);
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

async function stableLstat(path, label) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    throw new Error(`The ${label} changed while its manifest was captured.`, {
      cause: error
    });
  }
}

function validatePathSegment(name) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`The packaged Electron directory contains an invalid path segment.`);
  }
}

function validateRelativePath(path, label) {
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") ||
      path.endsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`The ${label} contains an invalid relative path.`);
  }
  for (const segment of path.split("/")) validatePathSegment(segment);
}

function decodeUtf8(value, relativePath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new Error(
      `Packaged Electron symlink ${JSON.stringify(relativePath)} has a non-UTF-8 target.`,
      { cause: error }
    );
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort(compareStrings);
  const required = [...expected].sort(compareStrings);
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new Error(`The ${label} fields must be exactly ${required.join(", ")}.`);
  }
}

function assertCount(actual, expected, label) {
  if (!Number.isSafeInteger(actual) || actual < 0 || actual !== expected) {
    throw new Error(`The ${label} is inconsistent.`);
  }
}

function resolveRequiredPath(value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error("The packaged Electron root path is required.");
  }
  return resolve(value);
}

function describePathChanges(kind, paths) {
  if (paths.length === 0) return "";
  const shown = paths.slice(0, 8).map((path) => JSON.stringify(path)).join(", ");
  const remainder = paths.length > 8 ? `, plus ${paths.length - 8} more` : "";
  return `${kind} ${shown}${remainder}`;
}

function manifestLabel(segments) {
  return segments.length === 0 ? '"."' : JSON.stringify(segments.join("/"));
}

function compareEntryPaths(left, right) {
  return compareStrings(left.path, right.path);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
