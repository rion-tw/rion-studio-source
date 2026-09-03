import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const PRIVATE_ROOT_PREFIX = "rion-packaged-electron-launch-";
const PRIVATE_BUNDLE_TOKEN = Symbol("rion-private-packaged-bundle");
const PRIVATE_BUNDLE_CAPABILITIES = new WeakSet();

export async function createDarwinPrivatePackagedElectronBundle(
  sourceApplicationPath
) {
  const sourcePath = resolve(sourceApplicationPath);
  if (
    sourcePath !== sourceApplicationPath ||
    !basename(sourcePath).endsWith(".app")
  ) {
    throw new Error("The macOS private launch source must be a canonical app bundle.");
  }
  const sourceMetadata = await lstat(sourcePath);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error("The macOS private launch source must be a real app bundle directory.");
  }

  const temporaryDirectory = await realpath(tmpdir());
  const privateRoot = await realpath(await mkdtemp(
    join(temporaryDirectory, PRIVATE_ROOT_PREFIX)
  ));
  await chmod(privateRoot, 0o700);
  const applicationPath = join(privateRoot, basename(sourcePath));
  try {
    await executeFile("/usr/bin/ditto", [
      "--rsrc",
      "--extattr",
      "--acl",
      sourcePath,
      applicationPath
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 5 * 60_000
    });
    const copiedPath = await realpath(applicationPath);
    const copiedMetadata = await lstat(applicationPath);
    if (
      copiedPath !== applicationPath ||
      !copiedMetadata.isDirectory() || copiedMetadata.isSymbolicLink()
    ) {
      throw new Error("The macOS private launch copy is not an exact real bundle root.");
    }
  } catch (error) {
    let cleanupFailure;
    try {
      await removePrivateRoot(privateRoot, temporaryDirectory);
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
    }
    if (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure],
        "The private macOS app copy failed and its root could not be removed.",
        { cause: error }
      );
    }
    throw error;
  }

  const state = { cleanupPromise: undefined };
  const bundle = {
    [PRIVATE_BUNDLE_TOKEN]: true,
    applicationPath,
    exclusiveBundleRoot: applicationPath,
    privateRoot,
    sourceApplicationPath: sourcePath,
    cleanup() {
      if (!state.cleanupPromise) {
        state.cleanupPromise = removePrivateRoot(privateRoot, temporaryDirectory);
        void state.cleanupPromise.catch(() => undefined);
      }
      return state.cleanupPromise;
    }
  };
  const frozenBundle = Object.freeze(bundle);
  PRIVATE_BUNDLE_CAPABILITIES.add(frozenBundle);
  return frozenBundle;
}

export function requireDarwinPrivatePackagedElectronBundle(value) {
  if (
    !value || typeof value !== "object" ||
    value[PRIVATE_BUNDLE_TOKEN] !== true ||
    !PRIVATE_BUNDLE_CAPABILITIES.has(value)
  ) {
    throw new Error(
      "macOS packaged process ownership requires a factory-issued private bundle capability."
    );
  }
  return value;
}

async function removePrivateRoot(privateRoot, temporaryDirectory) {
  if (
    dirname(privateRoot) !== temporaryDirectory ||
    !basename(privateRoot).startsWith(PRIVATE_ROOT_PREFIX)
  ) {
    throw new Error("Refusing to remove an invalid private macOS launch root.");
  }
  await rm(privateRoot, { force: true, recursive: true });
}
