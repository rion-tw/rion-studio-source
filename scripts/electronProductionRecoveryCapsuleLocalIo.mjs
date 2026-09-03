import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

import {
  requiredAbsolutePath
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export async function resolveCreateNewMaterializationRoot(value) {
  const requested = requiredAbsolutePath(value, "recovery capsule output root");
  const outputName = path.basename(requested);
  assertSafeSegment(outputName);
  if (requested === path.dirname(requested)) {
    throw new Error("The recovery capsule output root must have a parent.");
  }
  const requestedParent = path.dirname(requested);
  const requestedParentIdentity = await lstat(requestedParent, { bigint: true });
  if (!requestedParentIdentity.isDirectory() ||
      requestedParentIdentity.isSymbolicLink()) {
    throw new Error("The recovery capsule output parent must be a real directory.");
  }
  const parentPath = await realpath(requestedParent);
  const parentIdentity = await lstat(parentPath, { bigint: true });
  assertSameMetadata(
    requestedParentIdentity,
    parentIdentity,
    "recovery capsule output parent"
  );
  const outputPath = path.join(parentPath, outputName);
  await assertPathMissing(outputPath, "recovery capsule output root");
  return { parentIdentity, parentPath, path: outputPath };
}

export async function captureCreatedDirectoryIdentity(directoryPath, label) {
  const metadata = await lstat(directoryPath, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  return metadata;
}

export async function assertDirectoryNodeIdentity(directoryPath, expected, label) {
  if (expected === undefined) {
    throw new Error(`The ${label} identity is missing.`);
  }
  const actual = await lstat(directoryPath, { bigint: true });
  if (!actual.isDirectory() || actual.isSymbolicLink() ||
      actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`The ${label} identity changed during materialization.`);
  }
}

export async function removeMaterializationRootIfSame(outputRoot, expected) {
  let actual;
  try {
    actual = await lstat(outputRoot, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!actual.isDirectory() || actual.isSymbolicLink() ||
      actual.dev !== expected.dev || actual.ino !== expected.ino) {
    return;
  }
  await rm(outputRoot, { force: false, recursive: true });
}

export function materializedPath(outputRoot, relativePath) {
  if (relativePath === "") return outputRoot;
  assertSafeRelativePath(relativePath);
  return path.join(outputRoot, ...relativePath.split("/"));
}

export function assertSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 ||
      value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error("The recovery capsule contains an unsafe relative path.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." ||
      segment === "..")) {
    throw new Error("The recovery capsule contains path traversal.");
  }
  for (const segment of segments) assertSafeSegment(segment);
}

export function assertSafeSegment(value) {
  if (value === "" || value === "." || value === ".." ||
      value.includes("/") || value.includes("\\") || /[\0\r\n]/u.test(value)) {
    throw new Error("The recovery capsule contains an unsafe path segment.");
  }
}

export function assertSameMetadata(expected, actual, label) {
  for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"]) {
    if (expected[field] !== actual[field]) {
      throw new Error(`The ${label} identity changed during capture.`);
    }
  }
}

export async function assertPathMissing(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`The ${label} must be create-new.`);
}
