import { createHash } from "node:crypto";
import path from "node:path";

const FORBIDDEN_BRANCH_CHARACTERS = new Set([
  " ", "~", "^", ":", "?", "*", "[", "]", "\\"
]);

export function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)) throw new Error(`The ${label} is invalid.`);
  return value;
}

export function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

export function requiredRepository(value, label) {
  const repository = requiredNonempty(value, label, 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return repository;
}

export function requiredBranch(value, label) {
  const branch = requiredNonempty(value, label, 255);
  if (branch.startsWith("refs/") || branch.includes("..") ||
      branch.endsWith(".") || branch.endsWith("/") ||
      branch.startsWith("/") || branch.includes("//") ||
      [...branch].some((character) =>
        character.codePointAt(0) < 0x20 ||
        FORBIDDEN_BRANCH_CHARACTERS.has(character)
      )) {
    throw new Error(`The ${label} is invalid.`);
  }
  return branch;
}

export function requiredRepositoryPath(value, label) {
  const repositoryPath = requiredNonempty(value, label, 1024);
  if (path.posix.isAbsolute(repositoryPath) || repositoryPath.includes("\\") ||
      repositoryPath.split("/").some((segment) =>
        segment.length === 0 || segment === "." || segment === ".."
      )) throw new Error(`The ${label} is invalid.`);
  return repositoryPath;
}

export function requiredFileName(value, label) {
  const fileName = requiredNonempty(value, label, 255);
  if (path.posix.basename(fileName) !== fileName) {
    throw new Error(`The ${label} is invalid.`);
  }
  return fileName;
}

export function requiredNonempty(value, label, maximumLength) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > maximumLength || value.trim() !== value) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

export function assertTimeDoesNotPrecede(later, earlier, message) {
  if (Date.parse(later) < Date.parse(earlier)) throw new Error(message);
}

export function gitBlobSha(source) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

export function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
