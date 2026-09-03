import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  ELECTRON_UPDATER_DARWIN_ISOLATION_EVIDENCE_KIND,
  requireElectronUpdaterDarwinProcessIsolationEvidence
} from "./electronUpdaterDarwinProcessSupervisor.mjs";
import {
  assertDirectChild,
  assertEqual,
  assertExactKeys,
  assertStableReread,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredPositiveInteger,
  requiredRealDirectory,
  requiredRfc3339,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_KIND =
  "rion-electron-updater-darwin-process-isolation-result";
export const ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME =
  "macos-updater-process-isolation-result.json";

const CONTAINMENT_KIND =
  "darwin-seatbelt-detached-cargo-process-group-v1";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_MAIN_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_INVENTORY_EXECUTABLE_BYTES = 16 * 1024 * 1024;

export async function writeElectronUpdaterDarwinProcessIsolationResult(input) {
  const childOutputRoot = await requiredRealDirectory(
    input.childOutputRoot,
    "Darwin isolation child output root"
  );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME,
    "Darwin process isolation result"
  );
  await assertDirectChild(
    outputPath,
    childOutputRoot,
    "Darwin process isolation result"
  );
  const evidence = requireElectronUpdaterDarwinProcessIsolationEvidence(
    input.isolationEvidence
  );
  assertCapabilityPaths(evidence, childOutputRoot);
  const [mainExecutable, inventoryExecutable] = await Promise.all([
    captureExecutableIdentity(
      evidence.mainExecutablePath,
      MAX_MAIN_EXECUTABLE_BYTES,
      "Darwin admitted bundle executable"
    ),
    captureExecutableIdentity(
      evidence.inventoryExecutablePath,
      MAX_INVENTORY_EXECUTABLE_BYTES,
      "Darwin process inventory executable"
    )
  ]);
  const result = assertElectronUpdaterDarwinProcessIsolationResult({
    schemaVersion: 1,
    kind: ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_KIND,
    platform: "darwin",
    attemptNonce: requiredAttemptNonce(input.attemptNonce),
    commandInvocationSha256: requiredDigest(
      input.commandInvocationSha256,
      "Darwin isolation command invocation SHA-256"
    ),
    helperAttemptId: requiredHelperAttemptId(input.helperAttemptId),
    containment: {
      kind: CONTAINMENT_KIND,
      childSandbox: requiredChildSandbox(input.childSandbox),
      sandboxProfileSha256: requiredDigest(
        input.sandboxProfileSha256,
        "Darwin sandbox profile SHA-256"
      ),
      cargoProcessGroupId: requiredPositiveInteger(
        input.cargoProcessGroupId,
        "Darwin Cargo process group ID"
      ),
      cargoProcessGroupOutcome: requiredActiveZero(
        input.cargoProcessGroupOutcome,
        "Darwin Cargo process-group outcome"
      )
    },
    supervisor: {
      kind: evidence.kind,
      outcome: evidence.outcome,
      applicationPath: evidence.applicationPath,
      bundleRoot: evidence.bundleRoot,
      mainExecutable,
      inventoryExecutable,
      helperProcessId: evidence.helperProcessId,
      launchedAfterMilliseconds: evidence.launchedAfterMilliseconds,
      admittedIdentity: { ...evidence.admittedIdentity }
    },
    activeProcessesAfterCleanup: 0,
    cleanupVerified: requiredTrue(
      input.cleanupVerified,
      "Darwin isolation cleanup verification"
    ),
    completedAt: requiredRfc3339(
      input.completedAt ?? new Date().toISOString(),
      "Darwin isolation completion time"
    )
  });
  await writeExclusive(outputPath, serializeCanonicalJson(result));
  const file = await readCanonicalJsonFile(
    outputPath,
    MAX_JSON_BYTES,
    "Darwin process isolation result"
  );
  return Object.freeze({
    result,
    resultIdentity: publicIdentity(outputPath, file),
    resultPath: outputPath
  });
}

export async function readElectronUpdaterDarwinProcessIsolationResult(input) {
  const childOutputRoot = await requiredRealDirectory(
    input.childOutputRoot,
    "Darwin isolation child output root"
  );
  const resultPath = requiredAbsolutePath(
    input.resultPath,
    "Darwin process isolation result"
  );
  await assertDirectChild(
    resultPath,
    childOutputRoot,
    "Darwin process isolation result"
  );
  assertEqual(
    path.basename(resultPath),
    ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME,
    "Darwin process isolation result filename"
  );
  const before = await readCanonicalJsonFile(
    resultPath,
    MAX_JSON_BYTES,
    "Darwin process isolation result"
  );
  assertEqual(
    before.sha256,
    requiredDigest(
      input.expected.resultSha256,
      "expected Darwin isolation result SHA-256"
    ),
    "Darwin process isolation result SHA-256"
  );
  const result = assertElectronUpdaterDarwinProcessIsolationResult(before.value);
  assertCapabilityPaths({
    applicationPath: result.supervisor.applicationPath,
    bundleRoot: result.supervisor.bundleRoot,
    inventoryExecutablePath: result.supervisor.inventoryExecutable.path,
    mainExecutablePath: result.supervisor.mainExecutable.path
  }, childOutputRoot);
  const canonicalApplicationPath = await requiredRealDirectory(
    result.supervisor.applicationPath,
    "Darwin isolated application"
  );
  assertEqual(
    canonicalApplicationPath,
    result.supervisor.applicationPath,
    "Darwin isolated application canonical path"
  );
  assertExpectedBindings(result, input.expected);
  const [mainExecutable, inventoryExecutable] = await Promise.all([
    captureExecutableIdentity(
      result.supervisor.mainExecutable.path,
      MAX_MAIN_EXECUTABLE_BYTES,
      "Darwin admitted bundle executable"
    ),
    captureExecutableIdentity(
      result.supervisor.inventoryExecutable.path,
      MAX_INVENTORY_EXECUTABLE_BYTES,
      "Darwin process inventory executable"
    )
  ]);
  assertExecutableIdentity(
    result.supervisor.mainExecutable,
    mainExecutable,
    "Darwin admitted bundle executable"
  );
  assertExecutableIdentity(
    result.supervisor.inventoryExecutable,
    inventoryExecutable,
    "Darwin process inventory executable"
  );
  const after = await readCanonicalJsonFile(
    resultPath,
    MAX_JSON_BYTES,
    "Darwin process isolation result"
  );
  assertStableReread(before, after, "Darwin process isolation result");
  return Object.freeze({
    result,
    resultIdentity: publicIdentity(resultPath, after)
  });
}

export function assertElectronUpdaterDarwinProcessIsolationResult(value) {
  assertExactKeys(value, [
    "activeProcessesAfterCleanup",
    "attemptNonce",
    "cleanupVerified",
    "commandInvocationSha256",
    "completedAt",
    "containment",
    "helperAttemptId",
    "kind",
    "platform",
    "schemaVersion",
    "supervisor"
  ], "Darwin process isolation result");
  assertEqual(value.schemaVersion, 1, "Darwin isolation result schema version");
  assertEqual(
    value.kind,
    ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_KIND,
    "Darwin isolation result kind"
  );
  assertEqual(value.platform, "darwin", "Darwin isolation result platform");
  requiredAttemptNonce(value.attemptNonce);
  requiredDigest(
    value.commandInvocationSha256,
    "Darwin isolation command invocation SHA-256"
  );
  requiredHelperAttemptId(value.helperAttemptId);
  assertContainment(value.containment);
  assertSupervisor(value.supervisor);
  assertEqual(
    value.activeProcessesAfterCleanup,
    0,
    "Darwin isolation active process count"
  );
  requiredTrue(value.cleanupVerified, "Darwin isolation cleanup verification");
  requiredRfc3339(value.completedAt, "Darwin isolation completion time");
  return deepFreezeResult(value);
}

function assertContainment(value) {
  assertExactKeys(value, [
    "cargoProcessGroupId",
    "cargoProcessGroupOutcome",
    "childSandbox",
    "kind",
    "sandboxProfileSha256"
  ], "Darwin process isolation containment");
  assertEqual(value.kind, CONTAINMENT_KIND, "Darwin isolation containment kind");
  requiredChildSandbox(value.childSandbox);
  requiredDigest(value.sandboxProfileSha256, "Darwin sandbox profile SHA-256");
  requiredPositiveInteger(value.cargoProcessGroupId, "Darwin Cargo process group ID");
  requiredActiveZero(
    value.cargoProcessGroupOutcome,
    "Darwin Cargo process-group outcome"
  );
}

function assertSupervisor(value) {
  assertExactKeys(value, [
    "admittedIdentity",
    "applicationPath",
    "bundleRoot",
    "helperProcessId",
    "inventoryExecutable",
    "kind",
    "launchedAfterMilliseconds",
    "mainExecutable",
    "outcome"
  ], "Darwin process isolation supervisor");
  assertEqual(
    value.kind,
    ELECTRON_UPDATER_DARWIN_ISOLATION_EVIDENCE_KIND,
    "Darwin supervisor isolation kind"
  );
  requiredActiveZero(value.outcome, "Darwin supervisor isolation outcome");
  const applicationPath = requiredAbsolutePath(
    value.applicationPath,
    "Darwin supervisor application"
  );
  assertEqual(value.bundleRoot, applicationPath, "Darwin supervisor bundle root");
  assertExecutableReceipt(value.mainExecutable, "Darwin admitted bundle executable");
  assertExecutableReceipt(
    value.inventoryExecutable,
    "Darwin process inventory executable"
  );
  assertEqual(
    value.mainExecutable.path,
    path.join(applicationPath, "Contents", "MacOS", "Rion Studio"),
    "Darwin supervisor main executable path"
  );
  const helperProcessId = requiredPositiveInteger(
    value.helperProcessId,
    "Darwin helper process ID"
  );
  const launchedAfterMilliseconds = requiredPositiveInteger(
    value.launchedAfterMilliseconds,
    "Darwin helper launch fence"
  );
  assertAdmittedIdentity(
    value.admittedIdentity,
    helperProcessId,
    launchedAfterMilliseconds,
    value.mainExecutable.path
  );
}

function assertAdmittedIdentity(value, helperProcessId, launchFence, executable) {
  assertExactKeys(value, [
    "auditToken",
    "executablePath",
    "parentProcessId",
    "parentProcessUniqueId",
    "processGroupId",
    "processId",
    "processUniqueId",
    "startMicroseconds",
    "startSeconds",
    "userId"
  ], "Darwin admitted process identity");
  if (!/^[a-f0-9]{64}$/u.test(value.auditToken ?? "")) {
    throw new Error("The Darwin admitted audit token is invalid.");
  }
  assertEqual(value.executablePath, executable, "Darwin admitted executable path");
  assertEqual(value.processId, helperProcessId, "Darwin admitted helper process ID");
  requiredPositiveInteger(value.parentProcessId, "Darwin admitted parent process ID");
  requiredPositiveInteger(value.processGroupId, "Darwin admitted process group ID");
  requiredDecimalIdentity(value.processUniqueId, "Darwin admitted process unique ID");
  requiredDecimalIdentity(
    value.parentProcessUniqueId,
    "Darwin admitted parent process unique ID"
  );
  requiredPositiveInteger(value.startSeconds, "Darwin admitted start seconds");
  if (
    !Number.isSafeInteger(value.startMicroseconds) ||
    value.startMicroseconds < 0 ||
    value.startMicroseconds >= 1_000_000 ||
    !Number.isSafeInteger(value.userId) ||
    value.userId < 0
  ) {
    throw new Error("The Darwin admitted process timing or user identity is invalid.");
  }
  const startMilliseconds = value.startSeconds * 1_000 +
    Math.floor(value.startMicroseconds / 1_000);
  if (startMilliseconds < launchFence - 1_000) {
    throw new Error("The Darwin admitted process predates its launch fence.");
  }
}

function assertExpectedBindings(result, expected) {
  assertExactKeys(expected, [
    "attemptNonce",
    "commandInvocationSha256",
    "resultSha256",
    "sandboxProfileSha256"
  ], "expected Darwin isolation bindings");
  assertEqual(
    result.attemptNonce,
    requiredAttemptNonce(expected.attemptNonce),
    "Darwin isolation attempt nonce"
  );
  assertEqual(
    result.commandInvocationSha256,
    requiredDigest(
      expected.commandInvocationSha256,
      "expected Darwin command invocation SHA-256"
    ),
    "Darwin isolation command invocation SHA-256"
  );
  assertEqual(
    result.containment.sandboxProfileSha256,
    requiredDigest(
      expected.sandboxProfileSha256,
      "expected Darwin sandbox profile SHA-256"
    ),
    "Darwin sandbox profile SHA-256"
  );
}

async function captureExecutableIdentity(filePath, maximumBytes, label) {
  const requested = requiredAbsolutePath(filePath, label);
  const [before, canonical] = await Promise.all([
    lstat(requested, { bigint: true }),
    realpath(requested)
  ]);
  if (canonical !== requested || (before.mode & 0o111n) === 0n) {
    throw new Error(`The ${label} must be executable.`);
  }
  const file = await readStableFile(requested, maximumBytes, label);
  const after = await lstat(requested, { bigint: true });
  if (
    (after.mode & 0o111n) === 0n || before.dev !== after.dev ||
    before.ino !== after.ino || before.mode !== after.mode ||
    before.nlink !== after.nlink || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`The ${label} identity changed while read.`);
  }
  return Object.freeze({
    bytes: file.bytes,
    fileName: path.basename(requested),
    path: requested,
    sha256: file.sha256
  });
}

function assertExecutableReceipt(value, label) {
  assertExactKeys(value, ["bytes", "fileName", "path", "sha256"], label);
  requiredPositiveInteger(value.bytes, `${label} bytes`);
  const executablePath = requiredAbsolutePath(value.path, label);
  assertEqual(value.fileName, path.basename(executablePath), `${label} filename`);
  requiredDigest(value.sha256, `${label} SHA-256`);
}

function assertExecutableIdentity(expected, observed, label) {
  for (const field of ["bytes", "fileName", "path", "sha256"]) {
    assertEqual(observed[field], expected[field], `${label} ${field}`);
  }
}

function assertCapabilityPaths(evidence, childOutputRoot) {
  assertEqual(evidence.bundleRoot, evidence.applicationPath, "Darwin bundle root");
  for (const [value, label] of [
    [evidence.applicationPath, "Darwin application"],
    [evidence.mainExecutablePath, "Darwin main executable"],
    [evidence.inventoryExecutablePath, "Darwin inventory executable"]
  ]) {
    const resolved = requiredAbsolutePath(value, label);
    const relation = path.relative(childOutputRoot, resolved);
    if (
      !relation || relation === ".." || relation.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relation)
    ) {
      throw new Error(`The ${label} must stay inside the child output root.`);
    }
  }
}

function requiredAttemptNonce(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    throw new Error("The Darwin isolation attempt nonce is invalid.");
  }
  return value;
}

function requiredHelperAttemptId(value) {
  if (
    typeof value !== "string" ||
    !/^update-install-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw new Error("The Darwin helper attempt ID is invalid.");
  }
  return value;
}

function requiredDecimalIdentity(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredChildSandbox(value) {
  assertEqual(value, "seatbelt-v1", "Darwin child sandbox");
  return value;
}

function requiredActiveZero(value, label) {
  assertEqual(value, "active-zero", label);
  return value;
}

function requiredTrue(value, label) {
  assertEqual(value, true, label);
  return value;
}

function deepFreezeResult(value) {
  Object.freeze(value.containment);
  Object.freeze(value.supervisor.admittedIdentity);
  Object.freeze(value.supervisor.mainExecutable);
  Object.freeze(value.supervisor.inventoryExecutable);
  Object.freeze(value.supervisor);
  return Object.freeze(value);
}
