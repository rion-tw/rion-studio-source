import { createHash } from "node:crypto";
import { constants as fileConstants, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";

import tarStream from "tar-stream";

const DEFAULT_LIMITS = Object.freeze({
  maximumArchiveBytes: 4 * 1024 * 1024 * 1024,
  maximumEntries: 100_000,
  maximumExpandedBytes: 10 * 1024 * 1024 * 1024,
  maximumFileBytes: 2 * 1024 * 1024 * 1024,
  maximumPathBytes: 16 * 1024,
  maximumSymlinkTargetBytes: 16 * 1024,
  maximumTotalFileBytes: 8 * 1024 * 1024 * 1024
});
const READ_ONLY_NO_FOLLOW = fileConstants.O_RDONLY |
  (fileConstants.O_NOFOLLOW ?? 0);
const WRITE_NEW_NO_FOLLOW = fileConstants.O_WRONLY |
  fileConstants.O_CREAT |
  fileConstants.O_EXCL |
  (fileConstants.O_NOFOLLOW ?? 0);
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

export async function extractSafeTarGzipSubtree(input) {
  const limits = resolveLimits(input?.limits ?? {});
  const archivePath = requiredAbsolutePath(input?.archivePath, "archive");
  const destinationPath = requiredAbsolutePath(input?.destinationPath, "destination");
  const archiveRoot = validateArchivePath(input?.archiveRoot, "archive root");
  const destinationParent = path.dirname(destinationPath);
  const destinationName = path.basename(destinationPath);
  validatePathSegment(destinationName, "destination");
  const requestedParentMetadata = await lstat(destinationParent, { bigint: true });
  if (!requestedParentMetadata.isDirectory() || requestedParentMetadata.isSymbolicLink()) {
    throw new Error("The safe-tar destination parent must be a real directory.");
  }
  const canonicalParent = await realpath(destinationParent);
  const canonicalDestination = path.join(canonicalParent, destinationName);
  await assertPathMissing(canonicalDestination, "safe-tar destination");

  const archivePathMetadata = await lstat(archivePath, { bigint: true });
  assertBoundedArchive(archivePathMetadata, limits.maximumArchiveBytes);
  const archiveHandle = await open(archivePath, READ_ONLY_NO_FOLLOW);
  const stagingRoot = await mkdtemp(
    path.join(canonicalParent, `.${destinationName}.safe-tar-`)
  );
  const parentMetadata = await lstat(canonicalParent, { bigint: true });
  const payloadRoot = path.join(stagingRoot, "payload");
  let destinationCreated = false;
  try {
    const openedArchiveMetadata = await archiveHandle.stat({ bigint: true });
    assertSameArchive(archivePathMetadata, openedArchiveMetadata);
    assertBoundedArchive(openedArchiveMetadata, limits.maximumArchiveBytes);
    const state = createExtractionState({
      archiveRoot,
      limits,
      payloadRoot
    });
    const archiveHash = createHash("sha256");
    const hashArchive = new Transform({
      transform(chunk, _encoding, callback) {
        archiveHash.update(chunk);
        callback(null, chunk);
      }
    });
    const limitExpandedBytes = byteLimitTransform(
      limits.maximumExpandedBytes,
      "expanded archive"
    );
    const extractor = tarStream.extract();
    extractor.on("entry", (header, entryStream, next) => {
      void extractEntry(state, header, entryStream).then(
        () => next(),
        (error) => next(error instanceof Error ? error : new Error(String(error)))
      );
    });
    await pipeArchiveToExtractor([
      archiveHandle.createReadStream({ autoClose: false }),
      hashArchive,
      createGunzip(),
      limitExpandedBytes,
      extractor
    ]);
    await finalizeExtractedTree(state);
    const completedArchiveMetadata = await archiveHandle.stat({ bigint: true });
    assertSameArchive(openedArchiveMetadata, completedArchiveMetadata);
    const completedArchivePathMetadata = await lstat(archivePath, { bigint: true });
    assertSameArchive(completedArchiveMetadata, completedArchivePathMetadata);
    const completedParentMetadata = await lstat(canonicalParent, { bigint: true });
    assertSameDirectory(parentMetadata, completedParentMetadata);

    await assertPathMissing(canonicalDestination, "safe-tar destination");
    await mkdir(canonicalDestination, { mode: 0o700 });
    destinationCreated = true;
    for (const childName of await readdir(payloadRoot)) {
      await rename(
        path.join(payloadRoot, childName),
        path.join(canonicalDestination, childName)
      );
    }
    await chmod(canonicalDestination, state.rootMode);
    await rm(stagingRoot, { recursive: true });
    return Object.freeze({
      archiveBytes: Number(completedArchiveMetadata.size),
      archiveRoot,
      archiveSha256: archiveHash.digest("hex"),
      destinationPath: canonicalDestination,
      directoryCount: state.directoryCount,
      entryCount: state.entryCount,
      regularFileBytes: state.regularFileBytes,
      regularFileCount: state.regularFileCount,
      symlinkCount: state.symlinkCount
    });
  } catch (error) {
    if (destinationCreated) {
      await rm(canonicalDestination, { force: true, recursive: true });
    }
    await rm(stagingRoot, { force: true, recursive: true });
    throw error;
  } finally {
    await archiveHandle.close();
  }
}

function createExtractionState({ archiveRoot, limits, payloadRoot }) {
  return {
    archiveRoot,
    caseFoldedPaths: new Map(),
    directoriesToChmod: [],
    directoryCount: 0,
    entryCount: 0,
    limits,
    paths: new Map(),
    payloadRoot,
    regularFileBytes: 0,
    regularFileCount: 0,
    rootMode: undefined,
    symlinkCount: 0
  };
}

async function extractEntry(state, header, entryStream) {
  state.entryCount += 1;
  if (state.entryCount > state.limits.maximumEntries) {
    throw new Error(
      `The safe-tar archive exceeds ${state.limits.maximumEntries} entries.`
    );
  }
  if (!header || typeof header !== "object") {
    throw new Error("The safe-tar archive contains an invalid header.");
  }
  const type = header.type;
  if (type !== "directory" && type !== "file" && type !== "symlink") {
    throw new Error(
      `The safe-tar archive contains unsupported entry type ${JSON.stringify(type)}.`
    );
  }
  const memberPath = validateArchivePath(
    normalizeDirectoryMember(header.name, type),
    "archive member",
    state.limits.maximumPathBytes
  );
  assertMemberIsInsideRoot(memberPath, state.archiveRoot);
  assertUniqueMemberPath(state, memberPath);
  const relativePath = memberPath === state.archiveRoot
    ? ""
    : memberPath.slice(state.archiveRoot.length + 1);
  if (state.entryCount === 1 && (relativePath !== "" || type !== "directory")) {
    throw new Error("The safe-tar archive must begin with its exact root directory.");
  }
  if (relativePath === "" && (state.entryCount !== 1 || type !== "directory")) {
    throw new Error("The safe-tar archive root must occur exactly once as a directory.");
  }
  assertDeclaredDirectoryAncestors(state, memberPath);
  const mode = validateMode(header.mode, memberPath);
  const outputPath = relativePath === ""
    ? state.payloadRoot
    : path.join(state.payloadRoot, ...relativePath.split("/"));

  if (type === "directory") {
    await mkdir(outputPath, { mode: 0o700 });
    state.paths.set(memberPath, "directory");
    state.directoriesToChmod.push({ mode, outputPath });
    state.directoryCount += 1;
    if (relativePath === "") state.rootMode = mode;
    await consumeEmptyEntry(entryStream, header, memberPath);
    return;
  }
  if (type === "symlink") {
    await consumeEmptyEntry(entryStream, header, memberPath);
    const target = validateSymlinkTarget(
      header.linkname,
      memberPath,
      state.archiveRoot,
      state.limits.maximumSymlinkTargetBytes
    );
    await symlink(target, outputPath);
    state.paths.set(memberPath, "symlink");
    state.symlinkCount += 1;
    return;
  }

  const fileBytes = validateFileSize(
    header.size,
    memberPath,
    state.regularFileBytes,
    state.limits
  );
  await pipeEntryToFile(
    entryStream,
    createWriteStream(outputPath, {
      flags: WRITE_NEW_NO_FOLLOW,
      mode: 0o600
    })
  );
  await chmod(outputPath, mode);
  const metadata = await lstat(outputPath, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size !== BigInt(fileBytes)
  ) {
    throw new Error(
      `Safe-tar file ${JSON.stringify(memberPath)} changed while it was written.`
    );
  }
  state.paths.set(memberPath, "file");
  state.regularFileBytes += fileBytes;
  state.regularFileCount += 1;
}

async function consumeEmptyEntry(entryStream, header, memberPath) {
  if (header.size !== 0) {
    throw new Error(
      `Safe-tar non-file ${JSON.stringify(memberPath)} has a nonzero payload.`
    );
  }
  await drainEmptyEntry(entryStream, memberPath);
}

function pipeArchiveToExtractor(streams) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      for (const stream of streams) stream.destroy();
      reject(error);
    };
    for (const stream of streams) stream.once("error", fail);
    streams.at(-1).once("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    for (let index = 0; index < streams.length - 1; index += 1) {
      streams[index].pipe(streams[index + 1]);
    }
  });
}

function pipeEntryToFile(entryStream, outputStream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let finished = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      entryStream.destroy();
      outputStream.destroy();
      reject(error);
    };
    entryStream.once("error", fail);
    outputStream.once("error", fail);
    outputStream.once("finish", () => { finished = true; });
    outputStream.once("close", () => {
      if (settled) return;
      if (!finished) {
        fail(new Error("A safe-tar output file closed before it was complete."));
        return;
      }
      settled = true;
      resolve();
    });
    entryStream.pipe(outputStream);
  });
}

function drainEmptyEntry(entryStream, memberPath) {
  return new Promise((resolve, reject) => {
    entryStream.once("error", reject);
    entryStream.once("data", (chunk) => {
      if (chunk.length > 0) {
        reject(new Error(
          `Safe-tar non-file ${JSON.stringify(memberPath)} contains payload bytes.`
        ));
      }
    });
    entryStream.once("end", resolve);
    entryStream.resume();
  });
}

async function finalizeExtractedTree(state) {
  if (
    state.entryCount < 2 ||
    state.rootMode === undefined ||
    state.regularFileCount === 0
  ) {
    throw new Error("The safe-tar archive does not contain a nonempty rooted package.");
  }
  for (const directory of [...state.directoriesToChmod].reverse()) {
    await chmod(directory.outputPath, directory.mode);
  }
}

function assertDeclaredDirectoryAncestors(state, memberPath) {
  if (memberPath === state.archiveRoot) return;
  const relativeComponents = memberPath
    .slice(state.archiveRoot.length + 1)
    .split("/");
  for (let index = 0; index < relativeComponents.length; index += 1) {
    const ancestor = [
      state.archiveRoot,
      ...relativeComponents.slice(0, index)
    ].join("/");
    if (state.paths.get(ancestor) !== "directory") {
      throw new Error(
        `Safe-tar member ${JSON.stringify(memberPath)} has an undeclared or non-directory ancestor ${JSON.stringify(ancestor)}.`
      );
    }
  }
}

function assertUniqueMemberPath(state, memberPath) {
  if (state.paths.has(memberPath)) {
    throw new Error(`The safe-tar archive repeats member ${JSON.stringify(memberPath)}.`);
  }
  const foldedPath = memberPath.normalize("NFC").toLocaleLowerCase("en-US");
  const priorPath = state.caseFoldedPaths.get(foldedPath);
  if (priorPath !== undefined) {
    throw new Error(
      `Safe-tar members ${JSON.stringify(priorPath)} and ${JSON.stringify(memberPath)} collide on a case-insensitive filesystem.`
    );
  }
  state.caseFoldedPaths.set(foldedPath, memberPath);
}

function assertMemberIsInsideRoot(memberPath, archiveRoot) {
  if (memberPath !== archiveRoot && !memberPath.startsWith(`${archiveRoot}/`)) {
    throw new Error(
      `Safe-tar member ${JSON.stringify(memberPath)} is outside archive root ${JSON.stringify(archiveRoot)}.`
    );
  }
}

function normalizeDirectoryMember(value, type) {
  if (typeof value !== "string") return value;
  if (type === "directory" && value.endsWith("/")) return value.slice(0, -1);
  return value;
}

function validateArchivePath(value, label, maximumBytes = 16 * 1024) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    containsUnsafeText(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`The safe-tar ${label} is not a bounded canonical relative path.`);
  }
  for (const segment of value.split("/")) validatePathSegment(segment, label);
  return value;
}

function validatePathSegment(segment, label) {
  if (
    typeof segment !== "string" ||
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    /[<>:"|?*]/u.test(segment) ||
    /[. ]$/u.test(segment) ||
    WINDOWS_RESERVED_SEGMENT.test(segment)
  ) {
    throw new Error(`The safe-tar ${label} contains unsafe path segment ${JSON.stringify(segment)}.`);
  }
}

function validateSymlinkTarget(value, memberPath, archiveRoot, maximumBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    path.win32.isAbsolute(value) ||
    value.includes("\\") ||
    containsUnsafeText(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(
      `Safe-tar symlink ${JSON.stringify(memberPath)} has an unsafe target.`
    );
  }
  for (const segment of value.split("/")) {
    if (segment.length === 0) {
      throw new Error(
        `Safe-tar symlink ${JSON.stringify(memberPath)} has an unsafe target.`
      );
    }
    if (segment !== "." && segment !== "..") {
      validatePathSegment(segment, "symlink target");
    }
  }
  const resolved = path.posix.normalize(path.posix.join(
    path.posix.dirname(memberPath),
    value
  ));
  assertMemberIsInsideRoot(resolved, archiveRoot);
  return value;
}

function validateMode(value, memberPath) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777) {
    throw new Error(
      `Safe-tar member ${JSON.stringify(memberPath)} has an unsafe permission mode.`
    );
  }
  return value;
}

function containsUnsafeText(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0xfffd) {
      return true;
    }
  }
  return false;
}

function validateFileSize(value, memberPath, priorBytes, limits) {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > limits.maximumFileBytes ||
    priorBytes + value > limits.maximumTotalFileBytes
  ) {
    throw new Error(
      `Safe-tar file ${JSON.stringify(memberPath)} exceeds its byte bound.`
    );
  }
  return value;
}

function byteLimitTransform(maximumBytes, label) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        callback(new Error(`The safe-tar ${label} exceeds ${maximumBytes} bytes.`));
      } else {
        callback(null, chunk);
      }
    }
  });
}

function resolveLimits(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Safe-tar limits must be an object.");
  }
  const allowed = new Set(Object.keys(DEFAULT_LIMITS));
  for (const key of Object.keys(overrides)) {
    if (!allowed.has(key)) throw new Error(`Unknown safe-tar limit ${key}.`);
  }
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function requiredAbsolutePath(value, label) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    !path.isAbsolute(value)
  ) {
    throw new Error(`The safe-tar ${label} path must be absolute.`);
  }
  return path.resolve(value);
}

function assertBoundedArchive(metadata, maximumBytes) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(
      "The safe-tar archive must be a bounded, nonempty, exclusively linked regular file."
    );
  }
}

function assertSameArchive(expected, observed) {
  const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
  if (!observed.isFile() || fields.some((field) => expected[field] !== observed[field])) {
    throw new Error("The safe-tar archive changed while it was read.");
  }
}

function assertSameDirectory(expected, observed) {
  if (
    !observed.isDirectory() ||
    observed.isSymbolicLink() ||
    expected.dev !== observed.dev ||
    expected.ino !== observed.ino ||
    expected.mode !== observed.mode ||
    expected.nlink !== observed.nlink
  ) {
    throw new Error("The safe-tar destination parent changed during extraction.");
  }
}

async function assertPathMissing(value, label) {
  try {
    await lstat(value);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`The ${label} must be create-new.`);
}
