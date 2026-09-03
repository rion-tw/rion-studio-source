import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";

export const WINDOWS_ISOLATED_PROFILE_RESULT_KIND =
  "rion-windows-isolated-profile-result";
export const WINDOWS_ISOLATED_PROFILE_RESULT_NAME =
  "windows-isolated-profile-result.json";
export const WINDOWS_ISOLATED_PROFILE_KIND =
  "temporary-local-windows-user-profile-v1";
export const WINDOWS_ISOLATED_PROFILE_COMMAND_INVOCATION_KIND =
  "rion-windows-isolated-command-invocation-v1";

const RESULT_FIELDS = Object.freeze([
  "activeProcessesAfterRootExit",
  "attemptNonce",
  "attestedInputs",
  "cleanupVerified",
  "commandExitCode",
  "commandInvocationSha256",
  "expectedTotalProcesses",
  "isolationKind",
  "kind",
  "schemaVersion",
  "totalProcesses"
]);

export function assertWindowsIsolatedProfileResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Windows isolated-profile result must be an object.");
  }
  const actualFields = Object.keys(value).sort();
  const expectedFields = [...RESULT_FIELDS].sort();
  if (!isDeepStrictEqual(actualFields, expectedFields)) {
    throw new Error("The Windows isolated-profile result has an unexpected schema.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("The Windows isolated-profile result schema version is invalid.");
  }
  if (value.kind !== WINDOWS_ISOLATED_PROFILE_RESULT_KIND) {
    throw new Error("The Windows isolated-profile result kind is invalid.");
  }
  if (value.isolationKind !== WINDOWS_ISOLATED_PROFILE_KIND) {
    throw new Error("The Windows isolated-profile result isolation kind is invalid.");
  }
  if (value.commandExitCode !== 0) {
    throw new Error("The Windows isolated-profile result command exit code is invalid.");
  }
  if (value.activeProcessesAfterRootExit !== 0) {
    throw new Error("The Windows isolated-profile result did not reach active-zero.");
  }
  if (value.cleanupVerified !== true) {
    throw new Error("The Windows isolated-profile result cleanup is not verified.");
  }
  if (typeof value.attemptNonce !== "string" || !/^[a-f0-9]{32}$/u.test(value.attemptNonce)) {
    throw new Error("The Windows isolated-profile result attempt nonce is invalid.");
  }
  requiredDigest(value.commandInvocationSha256, "command invocation SHA-256");
  assertExactObject(
    value.attestedInputs,
    ["commandExecutable", "commandHarness", "forbiddenSourceList", "installer"],
    "attested inputs"
  );
  const attestedInputs = Object.freeze({
    commandExecutable: assertArtifactIdentity(
      value.attestedInputs.commandExecutable,
      "command executable"
    ),
    commandHarness: assertArtifactIdentity(
      value.attestedInputs.commandHarness,
      "command harness"
    ),
    forbiddenSourceList: assertArtifactIdentity(
      value.attestedInputs.forbiddenSourceList,
      "forbidden source list"
    ),
    installer: assertArtifactIdentity(value.attestedInputs.installer, "installer")
  });
  assertNonnegativeInteger(
    value.expectedTotalProcesses,
    "expected total process count"
  );
  assertPositiveInteger(value.totalProcesses, "total process count");
  if (
    value.expectedTotalProcesses !== 0 &&
    value.totalProcesses !== value.expectedTotalProcesses
  ) {
    throw new Error(
      "The Windows isolated-profile result total process count does not match its expectation."
    );
  }
  return Object.freeze({
    activeProcessesAfterRootExit: value.activeProcessesAfterRootExit,
    attemptNonce: value.attemptNonce,
    attestedInputs,
    cleanupVerified: value.cleanupVerified,
    commandExitCode: value.commandExitCode,
    commandInvocationSha256: value.commandInvocationSha256,
    expectedTotalProcesses: value.expectedTotalProcesses,
    isolationKind: value.isolationKind,
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    totalProcesses: value.totalProcesses
  });
}

export function createWindowsIsolatedProfileCommandInvocationSha256(input) {
  const commandPath = requiredString(input?.commandPath, "command path");
  const workingDirectory = requiredString(input?.workingDirectory, "working directory");
  if (!Array.isArray(input?.arguments)) {
    throw new Error("The Windows isolated-profile command arguments are invalid.");
  }
  const parts = [
    WINDOWS_ISOLATED_PROFILE_COMMAND_INVOCATION_KIND,
    commandPath,
    workingDirectory,
    ...input.arguments.map((value, index) => requiredString(
      value,
      `command argument ${index}`
    ))
  ];
  if (parts.some((value) => value.includes("\0"))) {
    throw new Error("The Windows isolated-profile command invocation contains NUL.");
  }
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

export function serializeWindowsIsolatedProfileResult(value) {
  return serializeCanonicalJson(assertWindowsIsolatedProfileResult(value));
}

function assertArtifactIdentity(value, label) {
  assertExactObject(value, ["bytes", "fileName", "sha256"], label);
  assertPositiveInteger(value.bytes, `${label} byte length`);
  const fileName = requiredString(value.fileName, `${label} filename`);
  if (fileName === "." || fileName === ".." || /[\\/\0]/u.test(fileName)) {
    throw new Error(`The Windows isolated-profile result ${label} filename is invalid.`);
  }
  requiredDigest(value.sha256, `${label} SHA-256`);
  return Object.freeze({
    bytes: value.bytes,
    fileName,
    sha256: value.sha256
  });
}

function assertExactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The Windows isolated-profile result ${label} is invalid.`);
  }
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) {
    throw new Error(`The Windows isolated-profile result ${label} has an unexpected schema.`);
  }
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`The Windows isolated-profile result ${label} is invalid.`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The Windows isolated-profile result ${label} is invalid.`);
  }
  return value;
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The Windows isolated-profile result ${label} is invalid.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The Windows isolated-profile result ${label} is invalid.`);
  }
}
