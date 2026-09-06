import { isSupportedStrictSemanticVersion } from "./releaseVersionPolicy.mjs";
import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";

export async function readCanonicalJsonFile(
  filePath,
  maximumBytes,
  label
) {
  const file = await readStableFile(filePath, maximumBytes, label);
  let value;
  try {
    value = JSON.parse(file.source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is invalid JSON.`, { cause: error });
  }
  if (!file.source.equals(serializeCanonicalJson(value))) {
    throw new Error(`The ${label} is not canonical JSON.`);
  }
  return Object.freeze({ ...file, value });
}

export async function readStableFile(filePath, maximumBytes, label) {
  const requested = requiredAbsolutePath(filePath, label);
  const initial = await lstat(requested, { bigint: true });
  assertBoundedSingleLinkFile(initial, maximumBytes, label);
  const noFollow = fileConstants.O_NOFOLLOW ?? 0;
  const handle = await open(requested, fileConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameFile(initial, opened, label);
    assertBoundedSingleLinkFile(opened, maximumBytes, label);
    const source = await handle.readFile();
    const completed = await handle.stat({ bigint: true });
    const completedPath = await lstat(requested, { bigint: true });
    assertSameFile(opened, completed, label);
    assertSameFile(completed, completedPath, label);
    return Object.freeze({
      bytes: source.length,
      sha256: createHash("sha256").update(source).digest("hex"),
      source
    });
  } finally {
    await handle.close();
  }
}

export async function canonicalRegularFilePath(
  filePath,
  maximumBytes,
  label
) {
  const requested = requiredAbsolutePath(filePath, label);
  const initial = await lstat(requested, { bigint: true });
  assertBoundedSingleLinkFile(initial, maximumBytes, label);
  const canonical = await realpath(requested);
  const resolved = await lstat(canonical, { bigint: true });
  assertSameFile(initial, resolved, label);
  return canonical;
}

export async function requiredRealDirectory(value, label) {
  const requested = requiredAbsolutePath(value, label);
  const metadata = await lstat(requested, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  return realpath(requested);
}

export async function resolveAbsentSiblingRoot(value, childOutputRoot) {
  const requested = requiredAbsolutePath(value, "sealed output root");
  const parent = await requiredRealDirectory(
    path.dirname(requested),
    "sealed output parent"
  );
  if (parent !== path.dirname(childOutputRoot)) {
    throw new Error("The sealed output root must be a sibling of the child output root.");
  }
  const root = path.join(parent, path.basename(requested));
  if (root === childOutputRoot) {
    throw new Error("The sealed output root must differ from the child output root.");
  }
  try {
    await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ parent, root });
    throw error;
  }
  throw new Error("The sealed output root must be created only after child active-zero.");
}

export async function resolveCreateNewFile(value, expectedName, label) {
  const requested = requiredAbsolutePath(value, label);
  assertEqual(path.basename(requested), expectedName, `${label} filename`);
  const parent = await requiredRealDirectory(path.dirname(requested), `${label} parent`);
  const outputPath = path.join(parent, expectedName);
  try {
    await lstat(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return outputPath;
    throw error;
  }
  throw new Error(`The ${label} must be create-new.`);
}

export async function writeExclusive(filePath, source) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function publicIdentity(filePath, identity) {
  return Object.freeze({
    bytes: identity.bytes,
    fileName: path.basename(filePath),
    sha256: identity.sha256
  });
}

export async function assertDirectChild(filePath, directory, label) {
  const canonicalParent = await realpath(path.dirname(path.resolve(filePath)));
  if (canonicalParent !== path.resolve(directory)) {
    throw new Error(`The ${label} must be a direct child of its sealed root.`);
  }
}

export function assertPathOutsideRoot(filePath, root, label) {
  const relation = path.relative(root, filePath);
  if (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relation))
  ) {
    throw new Error(`The ${label} must stay outside the child-authorized root.`);
  }
}

export function assertStableReread(before, after, label) {
  if (before.bytes !== after.bytes || before.sha256 !== after.sha256) {
    throw new Error(`The ${label} changed between parent verification reads.`);
  }
}

export function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error(`The ${label} has an unexpected schema.`);
  }
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`The ${label} does not match.`);
}

export function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`The ${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

export function requiredDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

export function requiredCommitSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase 40-character commit SHA.`);
  }
  return value;
}

export function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} must be a positive safe integer.`);
  }
  return value;
}

export function requiredSemanticVersion(value, label) {
  if (!isSupportedStrictSemanticVersion(value)) {
    throw new Error(`The ${label} must be strict SemVer without build metadata.`);
  }
  return value;
}

export function compareSemanticVersions(leftValue, rightValue) {
  const left = semanticVersionParts(
    requiredSemanticVersion(leftValue, "left semantic version")
  );
  const right = semanticVersionParts(
    requiredSemanticVersion(rightValue, "right semantic version")
  );
  for (const field of ["major", "minor", "patch"]) {
    const comparison = compareNumericIdentifier(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === rightPart) continue;
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftPart, rightPart);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function assertSemanticVersionIsNewer(target, source, label) {
  if (compareSemanticVersions(target, source) <= 0) {
    throw new Error(`The ${label} must be strictly newer than its source version.`);
  }
}

export function requiredRfc3339(value, label) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value)
    : null;
  if (!match) throw new Error(`The ${label} must be an RFC 3339 timestamp.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  const monthLengths = [
    31,
    isGregorianLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (
    month < 1 || month > 12 || day < 1 ||
    day > (monthLengths[month - 1] ?? 0) || hour > 23 || minute > 59 ||
    second > 59 || offsetHour > 23 || offsetMinute > 59
  ) throw new Error(`The ${label} must be an RFC 3339 timestamp.`);
  return value;
}

function assertBoundedSingleLinkFile(metadata, maximumBytes, label) {
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
    metadata.size <= 0n || metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(
      `The ${label} must be a bounded, nonempty, single-link regular file.`
    );
  }
}

function assertSameFile(expected, observed, label) {
  if (
    !observed.isFile() || expected.dev !== observed.dev ||
    expected.ino !== observed.ino || expected.mode !== observed.mode ||
    expected.nlink !== observed.nlink || expected.size !== observed.size ||
    expected.mtimeNs !== observed.mtimeNs || expected.ctimeNs !== observed.ctimeNs
  ) throw new Error(`The ${label} identity changed while read.`);
}

function isGregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function semanticVersionParts(value) {
  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1
    ? []
    : value.slice(separator + 1).split(".");
  const [major, minor, patch] = core.split(".");
  return { major, minor, patch, prerelease };
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
