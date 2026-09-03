import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  watch
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve
} from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  assertElectronUpdaterDarwinProcessTreeGone,
  buildElectronUpdaterDarwinProcessInventory,
  completeElectronUpdaterDarwinProcessIsolationEvidence,
  createElectronUpdaterDarwinProcessSupervisor,
  terminateElectronUpdaterDarwinProcessSupervisor,
  waitForElectronUpdaterDarwinProcessSupervisorAdmission
} from "./electronUpdaterDarwinProcessSupervisor.mjs";
import { assertElectronUpdaterMacosVersionTransition } from
  "./electronUpdaterMacosProbeResultContract.mjs";

const HELPER_PROBE =
  "platform_install::macos::tests::packaged_macos_helper_handoff_probe";
const RESULT_NAME = "macos-helper-handoff.json";
const ADMISSION_ACK_NAME = "macos-helper-admission.ack";
const CONTROL_DIRECTORY_NAME = "probe-control";
const CHILD_SANDBOX_POLICY = "seatbelt-v1";
const EXTERNAL_ACK_MILLISECONDS = 120_000;
const GRACEFUL_GROUP_EXIT_MILLISECONDS = 2_000;
const FORCED_GROUP_EXIT_MILLISECONDS = 15_000;
const GROUP_POLL_MILLISECONDS = 25;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_RESULT_BYTES = 64 * 1024;

export async function runElectronUpdaterDarwinHelperProbe(
  input,
  operationOverrides = {}
) {
  if (input?.platform !== "darwin") {
    throw new Error("The updater helper-handoff probe requires macOS.");
  }
  const operations = Object.freeze({
    ...defaultOperations,
    ...operationOverrides
  });
  const fixtureRoot = await canonicalRealDirectory(
    input?.fixtureRoot,
    "fixture root"
  );
  const workingDirectory = await canonicalRealDirectory(
    input?.workingDirectory,
    "working directory"
  );
  const controlRoot = join(fixtureRoot, CONTROL_DIRECTORY_NAME);
  const controlIdentity = await createPrivateControlDirectory(controlRoot);
  const resultPath = join(controlRoot, RESULT_NAME);
  const admissionAckPath = join(controlRoot, ADMISSION_ACK_NAME);
  await Promise.all([
    assertPathMissing(resultPath, "helper result"),
    assertPathMissing(admissionAckPath, "helper admission acknowledgement")
  ]);
  const inventoryRoot = join(
    fixtureRoot,
    "native-tools",
    "process-supervisor"
  );
  const inventoryExecutablePath = await operations.buildProcessInventory(
    inventoryRoot
  );
  const inventoryIdentity = await captureRealExecutable(
    inventoryExecutablePath,
    16 * 1024 * 1024
  );
  const launchedAfterMilliseconds = operations.epochMilliseconds();
  if (
    !Number.isSafeInteger(launchedAfterMilliseconds) ||
    launchedAfterMilliseconds <= 0
  ) {
    throw new Error("The updater helper probe requires an exact launch epoch.");
  }
  let cargoOwner;
  let result;
  let supervisor;
  let primaryFailure;
  let isolationEvidence;
  const cleanupFailures = [];

  try {
    cargoOwner = await operations.spawnCargoProbe({
      environment: {
        ...input.environment,
        RION_UPDATER_PROBE_ADMISSION_ACK: admissionAckPath,
        RION_UPDATER_PROBE_CHILD_SANDBOX: CHILD_SANDBOX_POLICY,
        RION_UPDATER_PROBE_INVENTORY_ROOT: inventoryRoot,
        RION_UPDATER_PROBE_RESULT: resultPath
      },
      testName: HELPER_PROBE,
      workingDirectory
    });
    assertDetachedCargoOwner(cargoOwner);
    const resultPublication = await readResultBeforeCargoExit(
      resultPath,
      cargoOwner.completion,
      operations
    );
    result = await validateHelperResult(
      resultPublication.source,
      fixtureRoot
    );
    await assertUnchangedExecutable(inventoryExecutablePath, inventoryIdentity);
    supervisor = await operations.createSupervisor({
      applicationPath: result.currentApp,
      helperProcessId: result.helperProcessId,
      inventoryExecutablePath,
      launchedAfterMilliseconds,
      platform: "darwin",
      runtimeRoot: fixtureRoot
    });
    await operations.waitForSupervisorAdmission(supervisor);
    await assertUnchangedExecutable(inventoryExecutablePath, inventoryIdentity);
    await assertUnchangedControlDirectory(controlRoot, controlIdentity);
    await assertUnchangedResultPublication(resultPath, resultPublication);
    await operations.writeAdmissionAcknowledgement(
      admissionAckPath,
      `${result.attemptId}\n`
    );
    await cargoOwner.completion;
    await waitForPathRemoval(
      result.journal,
      EXTERNAL_ACK_MILLISECONDS
    );
    await assertRegularNonempty(result.marker, 1024 * 1024);
    await access(join(
      result.currentApp,
      "Contents",
      "Resources",
      "app.asar"
    ));
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (cargoOwner) {
      await captureFailure(cleanupFailures, () =>
        terminateDetachedDarwinProcessGroup(cargoOwner, operations));
      try {
        await operations.waitForCargoClose(cargoOwner);
      } catch (error) {
        cleanupFailures.push(error);
        operations.releaseCargoOwner(cargoOwner);
      }
    }
    if (supervisor) {
      await captureFailure(cleanupFailures, () =>
        operations.terminateSupervisor(supervisor));
      await captureFailure(cleanupFailures, () =>
        operations.assertSupervisorGone(supervisor));
      await captureFailure(cleanupFailures, async () => {
        isolationEvidence = await operations.completeSupervisorIsolationEvidence(
          supervisor
        );
      });
    }
    await captureFailure(cleanupFailures, () =>
      assertUnchangedExecutable(inventoryExecutablePath, inventoryIdentity));
    await captureFailure(cleanupFailures, () =>
      assertUnchangedControlDirectory(controlRoot, controlIdentity));
  }

  if (primaryFailure || cleanupFailures.length > 0) {
    if (!primaryFailure && cleanupFailures.length === 1) {
      throw cleanupFailures[0];
    }
    const failures = [
      ...(primaryFailure ? [primaryFailure] : []),
      ...cleanupFailures
    ];
    throw new AggregateError(
      failures,
      "The macOS updater helper probe or its exact cleanup failed.",
      primaryFailure ? { cause: primaryFailure } : undefined
    );
  }
  return Object.freeze({
    ...result,
    cargoProcessGroupId: cargoOwner.processGroupId,
    cargoProcessGroupOutcome: "active-zero",
    childSandbox: CHILD_SANDBOX_POLICY,
    isolationEvidence
  });
}

async function readResultBeforeCargoExit(resultPath, completion, operations) {
  const abortController = new AbortController();
  const resultPromise = waitForAtomicResultPublication(
    resultPath,
    EXTERNAL_ACK_MILLISECONDS,
    abortController.signal
  );
  void resultPromise.catch(() => undefined);
  const prematureExit = completion.then(() => {
    throw new Error(
      "The helper Cargo root exited before exact process admission."
    );
  });
  void prematureExit.catch(() => undefined);
  try {
    return await Promise.race([resultPromise, prematureExit]);
  } finally {
    abortController.abort();
    await operations.sleep(0);
  }
}

async function waitForAtomicResultPublication(path, timeoutMilliseconds, signal) {
  try {
    return await captureAtomicResultFile(path);
  } catch (error) {
    if (!isPendingAtomicResult(error)) throw error;
  }
  const parent = dirname(path);
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error(
      "Timed out waiting for the atomic macOS helper result."
    )),
    timeoutMilliseconds
  );
  const combined = AbortSignal.any([signal, timeoutController.signal]);
  try {
    const events = watch(parent, { signal: combined });
    try {
      return await captureAtomicResultFile(path);
    } catch (error) {
      if (!isPendingAtomicResult(error)) throw error;
    }
    for await (const _event of events) {
      try {
        return await captureAtomicResultFile(path);
      } catch (error) {
        if (!isPendingAtomicResult(error)) throw error;
      }
    }
    throw combined.reason ?? new Error(
      "The atomic macOS helper result watch ended without publication."
    );
  } catch (error) {
    if (timeoutController.signal.aborted) throw timeoutController.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function validateHelperResult(source, fixtureRoot) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The macOS helper result is invalid JSON.", { cause: error });
  }
  assertExactKeys(value, [
    "attemptId",
    "currentApp",
    "helperProcessId",
    "journal",
    "marker",
    "sourceRuntime",
    "sourceVersion",
    "targetVersion",
    "userData"
  ]);
  if (
    !/^update-install-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value.attemptId ?? "") ||
    !Number.isSafeInteger(value.helperProcessId) ||
    value.helperProcessId <= 1 ||
    value.helperProcessId === process.pid
  ) {
    throw new Error("The macOS helper result has an unsafe attempt or process identity.");
  }
  if (value.sourceRuntime !== "tauri-v22") {
    throw new Error("The macOS helper result must identify the published Tauri v22 source.");
  }
  const transition = assertElectronUpdaterMacosVersionTransition(
    value,
    "macOS helper probe case"
  );
  const currentApp = requiredCanonicalPath(value.currentApp, "current app");
  const transactionRoot = dirname(dirname(currentApp));
  if (
    dirname(transactionRoot) !== fixtureRoot ||
    !/^rion-packaged-updater-handoff-[0-9A-Za-z]{6,64}$/u
      .test(basename(transactionRoot)) ||
    currentApp !== join(
      transactionRoot,
      "installed",
      "Rion Studio.app"
    )
  ) {
    throw new Error("The macOS helper result escaped its exact transaction root.");
  }
  const userData = requiredCanonicalPath(value.userData, "user data");
  const journal = requiredCanonicalPath(value.journal, "journal");
  const marker = requiredCanonicalPath(value.marker, "marker");
  if (
    userData !== join(transactionRoot, "user-data") ||
    journal !== join(userData, "app-update-install-journal.json") ||
    marker !== join(userData, "preserved-user-data-marker")
  ) {
    throw new Error("The macOS helper result paths are not exactly cross-bound.");
  }
  await canonicalRealDirectory(userData, "helper user data");
  await assertRegularNonempty(journal, 1024 * 1024);
  await assertRegularNonempty(marker, 1024 * 1024);
  return Object.freeze({
    attemptId: value.attemptId,
    currentApp,
    helperProcessId: value.helperProcessId,
    journal,
    marker,
    sourceRuntime: "tauri-v22",
    ...transition,
    userData
  });
}

async function writeDurableAdmissionAcknowledgement(path, source) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  const publication = await capturePrivateRegularFile(path, 1024);
  if (!publication.source.equals(Buffer.from(source, "utf8"))) {
    throw new Error("The durable macOS helper admission acknowledgement changed.");
  }
}

async function spawnDetachedCargoProbe(input) {
  const output = boundedOutputCollector();
  const child = spawn("cargo", [
    "test", "--locked", "--offline", "-p", "rion-updater", "--lib",
    input.testName,
    "--", "--ignored", "--exact", "--nocapture"
  ], {
    cwd: input.workingDirectory,
    detached: true,
    env: input.environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => output.append("stdout", chunk));
  child.stderr?.on("data", (chunk) => output.append("stderr", chunk));
  const close = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveClose(Object.freeze({
      code,
      signal,
      ...output.finish()
    })));
  });
  void close.catch(() => undefined);
  await new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  const processGroupId = child.pid;
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
    throw new Error("Cargo did not expose a safe detached process group.");
  }
  const completion = close.then((result) => {
    if (result.oversized || result.code !== 0 || result.signal !== null) {
      throw new Error([
        "The macOS helper Cargo root did not exit successfully.",
        result.stderr,
        result.stdout
      ].filter(Boolean).join("\n"));
    }
    return result;
  });
  void completion.catch(() => undefined);
  return Object.freeze({
    close,
    completion,
    processGroupId,
    release() {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
  });
}

async function terminateDetachedDarwinProcessGroup(owner, operations) {
  assertDetachedCargoOwner(owner);
  if (!operations.isProcessGroupAlive(owner.processGroupId)) return;
  operations.signalProcessGroup(owner.processGroupId, "SIGTERM");
  if (await waitForProcessGroupExit(
    owner.processGroupId,
    operations,
    operations.now() + GRACEFUL_GROUP_EXIT_MILLISECONDS
  )) return;
  operations.signalProcessGroup(owner.processGroupId, "SIGKILL");
  if (await waitForProcessGroupExit(
    owner.processGroupId,
    operations,
    operations.now() + FORCED_GROUP_EXIT_MILLISECONDS
  )) return;
  throw new Error("The exact detached Cargo process group survived SIGKILL.");
}

async function waitForProcessGroupExit(processGroupId, operations, deadline) {
  while (operations.now() < deadline) {
    if (!operations.isProcessGroupAlive(processGroupId)) return true;
    await operations.sleep(Math.min(
      GROUP_POLL_MILLISECONDS,
      deadline - operations.now()
    ));
  }
  return !operations.isProcessGroupAlive(processGroupId);
}

function signalProcessGroup(processGroupId, signal) {
  requireSafeProcessGroupId(processGroupId);
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function isProcessGroupAlive(processGroupId) {
  requireSafeProcessGroupId(processGroupId);
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPathRemoval(path, timeoutMilliseconds) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(new Error(
      `Timed out waiting for updater acknowledgement: ${path}`
    )),
    timeoutMilliseconds
  );
  try {
    for await (const event of watch(dirname(path), {
      signal: abortController.signal
    })) {
      if (event.filename && String(event.filename) !== basename(path)) continue;
      try {
        await access(path);
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) throw abortController.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function capturePrivateRegularFile(path, maximumBytes) {
  return captureStableRegularFile(path, maximumBytes, true);
}

async function captureAtomicResultFile(path) {
  const metadata = await lstat(path, { bigint: true });
  if (
    metadata.isFile() && !metadata.isSymbolicLink() &&
    metadata.nlink > 1n && metadata.nlink <= 2n &&
    metadata.size > 0n && metadata.size <= BigInt(MAXIMUM_RESULT_BYTES) &&
    (metadata.mode & 0o077n) === 0n
  ) {
    const error = new Error(
      "The atomic macOS helper result still has its private publication link."
    );
    error.code = "RION_ATOMIC_RESULT_PENDING";
    throw error;
  }
  return capturePrivateRegularFile(path, MAXIMUM_RESULT_BYTES);
}

function isPendingAtomicResult(error) {
  return error?.code === "ENOENT" ||
    error?.code === "RION_ATOMIC_RESULT_PENDING";
}

async function captureStableRegularFile(path, maximumBytes, requirePrivate) {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
    before.size <= 0n || before.size > BigInt(maximumBytes) ||
    (requirePrivate && (before.mode & 0o077n) !== 0n)
  ) {
    throw new Error(`Expected one bounded regular file: ${path}`);
  }
  const source = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (
    source.length !== Number(before.size) ||
    before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.nlink !== after.nlink ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs
  ) {
    throw new Error(`The private bounded file changed while read: ${path}`);
  }
  return Object.freeze({
    device: before.dev,
    inode: before.ino,
    mode: before.mode,
    modifiedNanoseconds: before.mtimeNs,
    source
  });
}

async function assertUnchangedResultPublication(path, expected) {
  const observed = await capturePrivateRegularFile(path, MAXIMUM_RESULT_BYTES);
  if (
    observed.device !== expected.device || observed.inode !== expected.inode ||
    observed.mode !== expected.mode ||
    observed.modifiedNanoseconds !== expected.modifiedNanoseconds ||
    !observed.source.equals(expected.source)
  ) {
    throw new Error("The macOS helper result changed before admission ACK.");
  }
}

async function captureRealExecutable(path, maximumBytes) {
  const canonical = await realpath(path);
  const identity = await captureStableRegularFile(path, maximumBytes, false);
  const metadata = await lstat(path, { bigint: true });
  if (
    canonical !== path || metadata.isSymbolicLink() ||
    metadata.dev !== identity.device || metadata.ino !== identity.inode ||
    metadata.mode !== identity.mode ||
    (metadata.mode & 0o111n) === 0n
  ) {
    throw new Error("The Darwin inventory helper is not one real executable.");
  }
  return identity;
}

async function assertUnchangedExecutable(path, expected) {
  const observed = await captureRealExecutable(path, 16 * 1024 * 1024);
  if (
    observed.device !== expected.device || observed.inode !== expected.inode ||
    observed.mode !== expected.mode ||
    observed.modifiedNanoseconds !== expected.modifiedNanoseconds ||
    !observed.source.equals(expected.source)
  ) {
    throw new Error("The Darwin inventory executable changed during the probe.");
  }
}

async function assertRegularNonempty(path, maximumBytes) {
  await captureStableRegularFile(path, maximumBytes, false);
}

async function canonicalRealDirectory(value, label) {
  const path = requiredCanonicalPath(value, label);
  const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    canonical !== path || !metadata.isDirectory() || metadata.isSymbolicLink()
  ) {
    throw new Error(`The macOS updater ${label} must be a real directory.`);
  }
  return path;
}

async function createPrivateControlDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  return capturePrivateRealDirectory(path);
}

async function capturePrivateRealDirectory(path) {
  const [metadata, canonical] = await Promise.all([
    lstat(path, { bigint: true }),
    realpath(path)
  ]);
  if (
    canonical !== path || !metadata.isDirectory() ||
    metadata.isSymbolicLink() || (metadata.mode & 0o077n) !== 0n
  ) {
    throw new Error(
      "The macOS updater probe control root must be one private real directory."
    );
  }
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode
  });
}

async function assertUnchangedControlDirectory(path, expected) {
  const observed = await capturePrivateRealDirectory(path);
  if (
    observed.device !== expected.device || observed.inode !== expected.inode ||
    observed.mode !== expected.mode
  ) {
    throw new Error("The macOS updater probe control root changed during the probe.");
  }
}

function requiredCanonicalPath(value, label) {
  if (
    typeof value !== "string" || value.length === 0 ||
    !isAbsolute(value) || resolve(value) !== value ||
    [...value].some((character) => character.charCodeAt(0) <= 0x1f)
  ) {
    throw new Error(`The macOS updater ${label} must be canonical and absolute.`);
  }
  return value;
}

function assertExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The macOS helper result must be one exact object.");
  }
  const observed = Object.keys(value).sort();
  if (
    observed.length !== expected.length ||
    observed.some((name, index) => name !== expected[index])
  ) {
    throw new Error("The macOS helper result has unexpected fields.");
  }
}

function assertDetachedCargoOwner(owner) {
  if (
    !owner || typeof owner !== "object" ||
    typeof owner.close?.then !== "function" ||
    typeof owner.completion?.then !== "function" ||
    typeof owner.release !== "function"
  ) {
    throw new Error("The macOS helper Cargo root was not observable.");
  }
  requireSafeProcessGroupId(owner.processGroupId);
}

function requireSafeProcessGroupId(value) {
  if (
    !Number.isSafeInteger(value) || value <= 1 || value === process.pid
  ) {
    throw new Error("Refusing to target an unsafe detached process group.");
  }
}

function boundedOutputCollector() {
  const chunks = { stderr: [], stdout: [] };
  let bytes = 0;
  let oversized = false;
  return Object.freeze({
    append(name, chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAXIMUM_COMMAND_OUTPUT_BYTES) {
        oversized = true;
        return;
      }
      chunks[name].push(value);
    },
    finish() {
      return Object.freeze({
        oversized,
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        stdout: Buffer.concat(chunks.stdout).toString("utf8")
      });
    }
  });
}

async function assertPathMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`The macOS updater ${label} path must start absent.`);
}

async function captureFailure(failures, operation) {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

async function waitForCargoClose(owner) {
  let timeout;
  try {
    await Promise.race([
      owner.close,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(
            "The detached Cargo process pipes did not close after cleanup."
          )),
          GRACEFUL_GROUP_EXIT_MILLISECONDS
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

const defaultOperations = Object.freeze({
  assertSupervisorGone: assertElectronUpdaterDarwinProcessTreeGone,
  buildProcessInventory: buildElectronUpdaterDarwinProcessInventory,
  completeSupervisorIsolationEvidence:
    completeElectronUpdaterDarwinProcessIsolationEvidence,
  createSupervisor: createElectronUpdaterDarwinProcessSupervisor,
  epochMilliseconds: () => Date.now(),
  isProcessGroupAlive,
  now: () => performance.now(),
  releaseCargoOwner: (owner) => owner.release(),
  signalProcessGroup,
  sleep: (milliseconds) => new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  }),
  spawnCargoProbe: spawnDetachedCargoProbe,
  terminateSupervisor: terminateElectronUpdaterDarwinProcessSupervisor,
  waitForCargoClose,
  waitForSupervisorAdmission:
    waitForElectronUpdaterDarwinProcessSupervisorAdmission,
  writeAdmissionAcknowledgement: writeDurableAdmissionAcknowledgement
});
