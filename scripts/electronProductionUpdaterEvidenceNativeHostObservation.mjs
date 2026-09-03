import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isDeepStrictEqual, promisify } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { createEncodedPowerShellJsonInvocation } from "./encodedPowerShell.mjs";
import {
  createElectronUpdaterDarwinProcessSupervisor,
  waitForElectronUpdaterDarwinProcessSupervisorAdmission
} from "./electronUpdaterDarwinProcessSupervisor.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertStableReread,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const execFileAsync = promisify(execFile);

export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_KIND =
  "rion-production-updater-native-host-observation";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND =
  "rion-production-updater-native-host-observation-bindings";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND =
  "rion-production-updater-native-host-launch-arguments";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_FILE =
  "native-host-observation.json";
export const ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_FILE =
  "native-host-launch-arguments.json";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TARGET_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const MAX_INVENTORY_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_CHALLENGE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_LAUNCH_ARGUMENTS = 256;
const MAX_LAUNCH_ARGUMENT_BYTES = 8192;
const MAX_LAUNCH_ARGUMENTS_BYTES = 64 * 1024;
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const PLATFORM_TARGETS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    hostPlatform: "darwin",
    nativeHostKind: "appkit-chromium",
    retainedAppKitHost: true,
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  }),
  "windows-x86_64": Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    hostPlatform: "win32",
    nativeHostKind: "bundled-chromium",
    retainedAppKitHost: false,
    signatureName: "Rion.Studio-win.exe.sig"
  })
});

const WINDOWS_PROCESS_QUERY_SCRIPT = String.raw`
function Rion-CreationMilliseconds($value) {
  if ($value -is [DateTime]) {
    return ([DateTimeOffset]$value.ToUniversalTime()).ToUnixTimeMilliseconds()
  }
  $converted = [System.Management.ManagementDateTimeConverter]::ToDateTime(
    [string]$value)
  return ([DateTimeOffset]$converted.ToUniversalTime()).ToUnixTimeMilliseconds()
}
$targetPid = [uint32]$payload.processId
if ($targetPid -le 1) { throw "invalid exact target process ID" }
$matches = @(Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $targetPid))
if ($matches.Count -ne 1) { throw "exact target process is unavailable or ambiguous" }
$candidate = $matches[0]
$executablePath = [string]$candidate.ExecutablePath
if ([String]::IsNullOrWhiteSpace($executablePath)) {
  throw "exact target executable path is unavailable"
}
$canonicalPath = [System.IO.Path]::GetFullPath($executablePath).TrimEnd("\")
$creationMilliseconds = Rion-CreationMilliseconds $candidate.CreationDate
[pscustomobject]@{
  creationMilliseconds = [long]$creationMilliseconds
  executablePath = $canonicalPath
  processId = [uint32]$candidate.ProcessId
} | ConvertTo-Json -Compress
`;

export async function observeElectronProductionUpdaterEvidenceNativeHost(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "bindings",
    "expectedExecutablePath",
    "launchArgumentsPath",
    "launchArgumentsSha256",
    "outputPath",
    "process",
    "signal"
  ], "updater evidence native-host observation input");
  const bindings =
    assertElectronProductionUpdaterEvidenceNativeHostObservationBindings(
      input.bindings
    );
  const dependencies = resolveDependencies(dependencyOverrides);
  const signal = requiredAbortSignal(input.signal);
  throwIfAborted(signal);
  const platform = PLATFORM_TARGETS[bindings.context.platform];
  assertEqual(
    dependencies.hostPlatform,
    platform.hostPlatform,
    "native-host observer execution platform"
  );
  const expectedExecutablePath = requiredCanonicalAbsolutePath(
    input.expectedExecutablePath,
    "target executable"
  );
  const processBinding = assertProcessBinding(input.process, bindings.context.platform);
  const captureStartedAt = requiredCurrentDate(dependencies.now()).toISOString();
  assertWithinChallenge(captureStartedAt, bindings.context.challenge);
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_FILE,
    "updater evidence native-host observation output"
  );
  const launchArgumentsPath = requiredCanonicalAbsolutePath(
    input.launchArgumentsPath,
    "native-host launch-arguments seal"
  );
  assertEqual(
    path.basename(launchArgumentsPath),
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_FILE,
    "native-host launch-arguments seal filename"
  );
  const launchArgumentsSha256 = requiredDigest(
    input.launchArgumentsSha256,
    "native-host launch-arguments seal SHA-256"
  );
  const launchBefore = await readCanonicalJsonFile(
    launchArgumentsPath,
    MAX_JSON_BYTES,
    "native-host launch-arguments seal"
  );
  assertEqual(
    launchBefore.sha256,
    launchArgumentsSha256,
    "native-host launch-arguments seal SHA-256"
  );

  const inventoryBefore = processBinding.platform === "darwin"
    ? await captureStableExecutable(
        processBinding.inventoryExecutablePath,
        MAX_INVENTORY_EXECUTABLE_BYTES,
        "Darwin process inventory executable",
        true
      )
    : undefined;
  if (inventoryBefore) {
    assertEqual(
      inventoryBefore.sha256,
      processBinding.inventoryExecutableSha256,
      "Darwin process inventory executable SHA-256"
    );
  }

  const liveBefore = await observeLiveProcess(
    processBinding,
    expectedExecutablePath,
    signal,
    dependencies
  );
  const processStartedAt = nativeProcessStartedAt(liveBefore);
  assertWithinChallenge(processStartedAt, bindings.context.challenge);
  const launchArguments = assertLaunchArgumentsSeal(
    launchBefore.value,
    bindings,
    expectedExecutablePath,
    liveBefore
  );
  assertNoRemoteDebuggingArguments(launchArguments.arguments);
  throwIfAborted(signal);

  const executableBefore = await captureStableExecutable(
    expectedExecutablePath,
    MAX_TARGET_EXECUTABLE_BYTES,
    "live target executable",
    processBinding.platform === "darwin"
  );
  assertEqual(
    executableBefore.sha256,
    bindings.targetRunningImageSha256,
    "live target executable SHA-256"
  );

  const liveAfter = await observeLiveProcess(
    processBinding,
    expectedExecutablePath,
    signal,
    dependencies
  );
  assertSameLiveProcess(liveBefore, liveAfter, processBinding.platform);
  const executableAfter = await captureStableExecutable(
    expectedExecutablePath,
    MAX_TARGET_EXECUTABLE_BYTES,
    "live target executable",
    processBinding.platform === "darwin"
  );
  assertStableReread(executableBefore, executableAfter, "live target executable");
  assertEqual(
    executableAfter.sha256,
    bindings.targetRunningImageSha256,
    "live target executable SHA-256"
  );

  if (processBinding.platform === "darwin") {
    const inventoryAfter = await captureStableExecutable(
      processBinding.inventoryExecutablePath,
      MAX_INVENTORY_EXECUTABLE_BYTES,
      "Darwin process inventory executable",
      true
    );
    assertStableReread(
      inventoryBefore,
      inventoryAfter,
      "Darwin process inventory executable"
    );
    assertEqual(
      inventoryAfter.sha256,
      processBinding.inventoryExecutableSha256,
      "Darwin process inventory executable SHA-256"
    );
  }

  const launchAfter = await readCanonicalJsonFile(
    launchArgumentsPath,
    MAX_JSON_BYTES,
    "native-host launch-arguments seal"
  );
  assertStableReread(
    launchBefore,
    launchAfter,
    "native-host launch-arguments seal"
  );
  assertEqual(
    launchAfter.sha256,
    launchArgumentsSha256,
    "native-host launch-arguments seal SHA-256"
  );
  throwIfAborted(signal);

  const capturedAt = requiredCurrentDate(dependencies.now()).toISOString();
  assertWithinChallenge(capturedAt, bindings.context.challenge);
  if (Date.parse(capturedAt) < Date.parse(captureStartedAt)) {
    throw new Error("The native-host observation clock moved backwards.");
  }
  if (Date.parse(capturedAt) < Date.parse(processStartedAt)) {
    throw new Error("The native-host capture precedes the target process start.");
  }
  const observation =
    assertElectronProductionUpdaterEvidenceNativeHostObservation({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_KIND,
      ...bindings.context,
      capturedAt,
      observedAt: processStartedAt,
      runtime: {
        nativeHostKind: platform.nativeHostKind,
        remoteDebugging: false,
        retainedAppKitHost: platform.retainedAppKitHost,
        targetVersionObserved: bindings.target.version
      },
      target: bindings.target,
      targetRunningImageSha256: bindings.targetRunningImageSha256
    }, bindings);
  throwIfAborted(signal);
  await writeExclusive(outputPath, serializeCanonicalJson(observation));
  return readElectronProductionUpdaterEvidenceNativeHostObservation({
    bindings,
    observationPath: outputPath
  });
}

export async function readElectronProductionUpdaterEvidenceNativeHostObservation(
  input
) {
  const expectedKeys = input?.expectedSha256 === undefined
    ? ["bindings", "observationPath"]
    : ["bindings", "expectedSha256", "observationPath"];
  assertExactKeys(
    input,
    expectedKeys,
    "updater evidence native-host observation read input"
  );
  const bindings =
    assertElectronProductionUpdaterEvidenceNativeHostObservationBindings(
      input.bindings
    );
  const observationPath = requiredCanonicalAbsolutePath(
    input.observationPath,
    "updater evidence native-host observation"
  );
  assertEqual(
    path.basename(observationPath),
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_FILE,
    "updater evidence native-host observation filename"
  );
  const file = await readCanonicalJsonFile(
    observationPath,
    MAX_JSON_BYTES,
    "updater evidence native-host observation"
  );
  if (input.expectedSha256 !== undefined) {
    assertEqual(
      file.sha256,
      requiredDigest(
        input.expectedSha256,
        "updater evidence native-host observation SHA-256"
      ),
      "updater evidence native-host observation SHA-256"
    );
  }
  return deepFreeze({
    observation: assertElectronProductionUpdaterEvidenceNativeHostObservation(
      file.value,
      bindings
    ),
    observationIdentity: publicIdentity(observationPath, file),
    observationPath
  });
}

export async function readElectronProductionUpdaterEvidenceNativeHostBindings(
  bindingsPath
) {
  const canonicalPath = requiredCanonicalAbsolutePath(
    bindingsPath,
    "updater evidence native-host bindings"
  );
  const file = await readCanonicalJsonFile(
    canonicalPath,
    MAX_JSON_BYTES,
    "updater evidence native-host bindings"
  );
  return deepFreeze({
    bindings:
      assertElectronProductionUpdaterEvidenceNativeHostObservationBindings(
        file.value
      ),
    bindingsIdentity: publicIdentity(canonicalPath, file),
    bindingsPath: canonicalPath
  });
}

export function assertElectronProductionUpdaterEvidenceNativeHostObservationBindings(
  value
) {
  assertExactKeys(value, [
    "context",
    "kind",
    "schemaVersion",
    "target",
    "targetRunningImageSha256"
  ], "updater evidence native-host observation bindings");
  assertEqual(
    value.schemaVersion,
    1,
    "updater evidence native-host bindings schema version"
  );
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND,
    "updater evidence native-host bindings kind"
  );
  const context = assertContext(value.context);
  const target = assertTarget(value.target, context.platform);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_BINDINGS_KIND,
    context,
    target,
    targetRunningImageSha256: requiredDigest(
      value.targetRunningImageSha256,
      "target running-image SHA-256"
    )
  });
}

export function assertElectronProductionUpdaterEvidenceNativeHostObservation(
  value,
  bindingsValue
) {
  const bindings =
    assertElectronProductionUpdaterEvidenceNativeHostObservationBindings(
      bindingsValue
    );
  assertExactKeys(value, [
    "capturedAt",
    "challenge",
    "evidenceAttemptId",
    "kind",
    "observedAt",
    "platform",
    "runtime",
    "schemaVersion",
    "sourceInstallAttemptId",
    "target",
    "targetRunningImageSha256",
    "transitionKind"
  ], "updater evidence native-host observation");
  assertEqual(
    value.schemaVersion,
    1,
    "updater evidence native-host observation schema version"
  );
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_KIND,
    "updater evidence native-host observation kind"
  );
  const context = assertContext({
    challenge: value.challenge,
    evidenceAttemptId: value.evidenceAttemptId,
    platform: value.platform,
    sourceInstallAttemptId: value.sourceInstallAttemptId,
    transitionKind: value.transitionKind
  });
  assertDeepEqual(context, bindings.context, "native-host observation context");
  assertDeepEqual(value.target, bindings.target, "native-host observation target");
  assertEqual(
    value.targetRunningImageSha256,
    bindings.targetRunningImageSha256,
    "native-host observation running-image SHA-256"
  );
  assertExactKeys(value.runtime, [
    "nativeHostKind",
    "remoteDebugging",
    "retainedAppKitHost",
    "targetVersionObserved"
  ], "native-host runtime observation");
  const platform = PLATFORM_TARGETS[context.platform];
  assertEqual(
    value.runtime.nativeHostKind,
    platform.nativeHostKind,
    "native-host runtime kind"
  );
  assertEqual(
    value.runtime.retainedAppKitHost,
    platform.retainedAppKitHost,
    "native-host retained AppKit claim"
  );
  assertEqual(
    value.runtime.remoteDebugging,
    false,
    "native-host remote-debugging verdict"
  );
  assertEqual(
    value.runtime.targetVersionObserved,
    bindings.target.version,
    "native-host observed target version"
  );
  const observedAt = requiredRfc3339(
    value.observedAt,
    "native-host process start time"
  );
  assertWithinChallenge(observedAt, context.challenge);
  const capturedAt = requiredRfc3339(
    value.capturedAt,
    "native-host capture time"
  );
  assertWithinChallenge(capturedAt, context.challenge);
  if (Date.parse(capturedAt) < Date.parse(observedAt)) {
    throw new Error("The native-host capture precedes the target process start.");
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_OBSERVATION_KIND,
    ...context,
    capturedAt,
    observedAt,
    runtime: {
      nativeHostKind: platform.nativeHostKind,
      remoteDebugging: false,
      retainedAppKitHost: platform.retainedAppKitHost,
      targetVersionObserved: bindings.target.version
    },
    target: bindings.target,
    targetRunningImageSha256: bindings.targetRunningImageSha256
  });
}

function assertLaunchArgumentsSeal(value, bindings, executablePath, liveProcess) {
  assertExactKeys(value, [
    "arguments",
    "context",
    "executablePath",
    "hostClaim",
    "kind",
    "process",
    "schemaVersion",
    "target",
    "targetRunningImageSha256"
  ], "native-host launch-arguments seal");
  assertEqual(value.schemaVersion, 1, "native-host launch seal schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
    "native-host launch seal kind"
  );
  const context = assertContext(value.context);
  assertDeepEqual(context, bindings.context, "native-host launch seal context");
  assertEqual(
    value.executablePath,
    executablePath,
    "native-host launch seal executable path"
  );
  assertExactKeys(value.target, [
    "candidateReceiptSha256",
    "sourceSha",
    "version"
  ], "native-host launch seal target identity");
  const targetIdentity = Object.freeze({
    candidateReceiptSha256: requiredDigest(
      value.target.candidateReceiptSha256,
      "native-host launch target candidate receipt SHA-256"
    ),
    sourceSha: requiredCommitSha(
      value.target.sourceSha,
      "native-host launch target source SHA"
    ),
    version: requiredSemanticVersion(
      value.target.version,
      "native-host launch target version"
    )
  });
  assertDeepEqual(targetIdentity, {
    candidateReceiptSha256: bindings.target.candidateReceiptSha256,
    sourceSha: bindings.target.sourceSha,
    version: bindings.target.version
  }, "native-host launch target identity");
  assertEqual(
    value.targetRunningImageSha256,
    bindings.targetRunningImageSha256,
    "native-host launch running-image SHA-256"
  );
  const hostClaim = assertHostClaim(value.hostClaim, bindings.context.platform);
  const sealedProcess = bindings.context.platform === "darwin-aarch64"
    ? assertDarwinProcessIdentity(value.process, "sealed Darwin process identity")
    : assertWindowsProcessIdentity(value.process, "sealed Windows process identity");
  assertSameLiveProcess(sealedProcess, liveProcess, liveProcess.platform);
  const argumentsList = assertLaunchArguments(value.arguments);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
    arguments: argumentsList,
    context,
    executablePath,
    hostClaim,
    process: sealedProcess,
    target: targetIdentity,
    targetRunningImageSha256: bindings.targetRunningImageSha256
  });
}

function assertHostClaim(value, platformName) {
  assertExactKeys(value, [
    "browserWindowOnlySubstitute",
    "htmlChromeSubstitute",
    "nativeHostKind",
    "retainedAppKitHost"
  ], "native-host launch host claim");
  const platform = PLATFORM_TARGETS[platformName];
  assertEqual(
    value.nativeHostKind,
    platform.nativeHostKind,
    "native-host launch host kind"
  );
  assertEqual(
    value.retainedAppKitHost,
    platform.retainedAppKitHost,
    "native-host launch retained AppKit claim"
  );
  assertEqual(
    value.browserWindowOnlySubstitute,
    false,
    "native-host BrowserWindow-only substitute verdict"
  );
  assertEqual(
    value.htmlChromeSubstitute,
    false,
    "native-host HTML chrome substitute verdict"
  );
  return Object.freeze({
    browserWindowOnlySubstitute: false,
    htmlChromeSubstitute: false,
    nativeHostKind: platform.nativeHostKind,
    retainedAppKitHost: platform.retainedAppKitHost
  });
}

function assertLaunchArguments(value) {
  if (!Array.isArray(value) || value.length > MAX_LAUNCH_ARGUMENTS) {
    throw new Error("The native-host launch arguments are invalid or oversized.");
  }
  let totalBytes = 0;
  const argumentsList = value.map((argument, index) => {
    if (typeof argument !== "string" || argument.includes("\0") ||
        Buffer.byteLength(argument, "utf8") > MAX_LAUNCH_ARGUMENT_BYTES) {
      throw new Error(`The native-host launch argument ${index + 1} is invalid.`);
    }
    totalBytes += Buffer.byteLength(argument, "utf8");
    return argument;
  });
  if (totalBytes > MAX_LAUNCH_ARGUMENTS_BYTES) {
    throw new Error("The native-host launch arguments exceed their byte bound.");
  }
  return Object.freeze(argumentsList);
}

function assertNoRemoteDebuggingArguments(argumentsList) {
  for (const argument of argumentsList) {
    const normalized = argument.toLowerCase();
    if (
      normalized.includes("remote-debugging") ||
      normalized.includes("remote-allow-origins") ||
      /(?:^|[=,\s])--inspect(?:$|[-=])/u.test(normalized) ||
      normalized.includes("devtools") ||
      normalized.includes("dev-tools")
    ) {
      throw new Error(
        "The sealed target launch arguments enable remote debugging or DevTools."
      );
    }
  }
}

function nativeProcessStartedAt(identity) {
  const milliseconds = identity.platform === "darwin"
    ? identity.startSeconds * 1000 + Math.floor(identity.startMicroseconds / 1000)
    : identity.creationMilliseconds;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("The native-host target process start time is invalid.");
  }
  return new Date(milliseconds).toISOString();
}

async function observeLiveProcess(
  processBinding,
  expectedExecutablePath,
  signal,
  dependencies
) {
  throwIfAborted(signal);
  if (processBinding.platform === "darwin") {
    const observed = await abortable(
      dependencies.observeDarwinProcess({
        expectedExecutablePath,
        inventoryExecutablePath: processBinding.inventoryExecutablePath,
        launchedAfterMilliseconds: processBinding.launchedAfterMilliseconds,
        processId: processBinding.processId,
        signal
      }),
      signal
    );
    const identity = assertDarwinProcessIdentity(
      observed,
      "observed Darwin process identity"
    );
    assertEqual(identity.processId, processBinding.processId, "Darwin target PID");
    assertObservedExecutablePath(
      identity.executablePath,
      expectedExecutablePath,
      "darwin"
    );
    const startMilliseconds = identity.startSeconds * 1000 +
      Math.floor(identity.startMicroseconds / 1000);
    if (startMilliseconds < processBinding.launchedAfterMilliseconds - 1000) {
      throw new Error("The Darwin target process predates its admission fence.");
    }
    return identity;
  }
  const observed = await abortable(
    dependencies.queryWindowsProcess({
      processId: processBinding.processId,
      signal
    }),
    signal
  );
  const identity = assertWindowsProcessIdentity(
    observed,
    "observed Windows process identity"
  );
  assertEqual(identity.processId, processBinding.processId, "Windows target PID");
  assertEqual(
    identity.creationMilliseconds,
    processBinding.creationMilliseconds,
    "Windows target creation identity"
  );
  assertObservedExecutablePath(
    identity.executablePath,
    expectedExecutablePath,
    "win32"
  );
  return identity;
}

async function defaultObserveDarwinProcess(input) {
  if (process.platform !== "darwin") {
    throw new Error("Darwin process admission requires a macOS host.");
  }
  const applicationPath = darwinApplicationPath(input.expectedExecutablePath);
  const supervisor = await createElectronUpdaterDarwinProcessSupervisor({
    applicationPath,
    helperProcessId: input.processId,
    inventoryExecutablePath: input.inventoryExecutablePath,
    launchedAfterMilliseconds: input.launchedAfterMilliseconds,
    platform: "darwin",
    runtimeRoot: path.dirname(applicationPath)
  });
  return waitForElectronUpdaterDarwinProcessSupervisorAdmission(supervisor);
}

async function defaultQueryWindowsProcess(input) {
  if (process.platform !== "win32") {
    throw new Error("Windows process identity requires a Windows host.");
  }
  const invocation = createEncodedPowerShellJsonInvocation(
    WINDOWS_PROCESS_QUERY_SCRIPT,
    { processId: input.processId }
  );
  let result;
  try {
    result = await execFileAsync("powershell.exe", invocation.arguments, {
      encoding: "utf8",
      env: { ...process.env, ...invocation.environment },
      maxBuffer: MAX_JSON_BYTES,
      signal: input.signal,
      windowsHide: true
    });
  } catch {
    if (input.signal.aborted) throw cancelledObservation(input.signal.reason);
    throw new Error("The exact Windows target process query failed.");
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("The exact Windows target process query returned invalid JSON.");
  }
  assertWindowsProcessIdentity(value, "Windows native process query");
  return value;
}

function darwinApplicationPath(executablePath) {
  const executableDirectory = path.dirname(executablePath);
  const contentsPath = path.dirname(executableDirectory);
  const applicationPath = path.dirname(contentsPath);
  if (path.basename(executablePath) !== "Rion Studio" ||
      path.basename(executableDirectory) !== "MacOS" ||
      path.basename(contentsPath) !== "Contents" ||
      path.basename(applicationPath) !== "Rion Studio.app") {
    throw new Error(
      "The Darwin target executable must be the exact retained AppKit bundle executable."
    );
  }
  return applicationPath;
}

function assertProcessBinding(value, platformName) {
  if (platformName === "darwin-aarch64") {
    assertExactKeys(value, [
      "inventoryExecutablePath",
      "inventoryExecutableSha256",
      "launchedAfterMilliseconds",
      "platform",
      "processId"
    ], "Darwin native-host process binding");
    assertEqual(value.platform, "darwin", "Darwin native-host process platform");
    return Object.freeze({
      inventoryExecutablePath: requiredCanonicalAbsolutePath(
        value.inventoryExecutablePath,
        "Darwin process inventory executable"
      ),
      inventoryExecutableSha256: requiredDigest(
        value.inventoryExecutableSha256,
        "Darwin process inventory executable SHA-256"
      ),
      launchedAfterMilliseconds: requiredPositiveInteger(
        value.launchedAfterMilliseconds,
        "Darwin target launch fence"
      ),
      platform: "darwin",
      processId: requiredSafeProcessId(value.processId, "Darwin target PID")
    });
  }
  assertExactKeys(value, [
    "creationMilliseconds",
    "platform",
    "processId"
  ], "Windows native-host process binding");
  assertEqual(value.platform, "win32", "Windows native-host process platform");
  return Object.freeze({
    creationMilliseconds: requiredPositiveInteger(
      value.creationMilliseconds,
      "Windows target creation identity"
    ),
    platform: "win32",
    processId: requiredSafeProcessId(value.processId, "Windows target PID")
  });
}

function assertDarwinProcessIdentity(value, label) {
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
  ], label);
  if (typeof value.auditToken !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.auditToken)) {
    throw new Error(`The ${label} audit token is invalid.`);
  }
  if (typeof value.processUniqueId !== "string" ||
      !/^[1-9]\d*$/u.test(value.processUniqueId) ||
      typeof value.parentProcessUniqueId !== "string" ||
      !/^[1-9]\d*$/u.test(value.parentProcessUniqueId)) {
    throw new Error(`The ${label} unique process identity is invalid.`);
  }
  if (!Number.isSafeInteger(value.startMicroseconds) ||
      value.startMicroseconds < 0 || value.startMicroseconds >= 1_000_000 ||
      !Number.isSafeInteger(value.startSeconds) ||
      value.startSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000) ||
      !Number.isSafeInteger(value.userId) || value.userId < 0) {
    throw new Error(`The ${label} timing or user identity is invalid.`);
  }
  return deepFreeze({
    auditToken: value.auditToken,
    executablePath: requiredCanonicalAbsolutePath(
      value.executablePath,
      `${label} executable path`
    ),
    parentProcessId: requiredPositiveInteger(
      value.parentProcessId,
      `${label} parent process ID`
    ),
    parentProcessUniqueId: value.parentProcessUniqueId,
    platform: "darwin",
    processGroupId: requiredPositiveInteger(
      value.processGroupId,
      `${label} process group ID`
    ),
    processId: requiredSafeProcessId(value.processId, `${label} process ID`),
    processUniqueId: value.processUniqueId,
    startMicroseconds: value.startMicroseconds,
    startSeconds: requiredPositiveInteger(
      value.startSeconds,
      `${label} start seconds`
    ),
    userId: value.userId
  });
}

function assertWindowsProcessIdentity(value, label) {
  assertExactKeys(value, [
    "creationMilliseconds",
    "executablePath",
    "processId"
  ], label);
  if (typeof value.executablePath !== "string" ||
      value.executablePath.length === 0 || value.executablePath.includes("\0")) {
    throw new Error(`The ${label} executable path is invalid.`);
  }
  return Object.freeze({
    creationMilliseconds: requiredPositiveInteger(
      value.creationMilliseconds,
      `${label} creation identity`
    ),
    executablePath: value.executablePath,
    platform: "win32",
    processId: requiredSafeProcessId(value.processId, `${label} process ID`)
  });
}

function assertSameLiveProcess(before, after, platform) {
  if (before.platform !== platform || after.platform !== platform ||
      !isDeepStrictEqual(before, after)) {
    throw new Error(
      `The ${platform === "darwin" ? "Darwin" : "Windows"} target process ` +
      "identity changed between live observations."
    );
  }
}

function assertObservedExecutablePath(observed, expected, platform) {
  const matches = platform === "win32"
    ? windowsPathKey(observed) === windowsPathKey(expected)
    : observed === expected;
  if (!matches) {
    throw new Error("The live target executable path does not match the expected path.");
  }
}

function windowsPathKey(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("The observed Windows executable path is invalid.");
  }
  return /^(?:[a-z]:\\|\\\\)/iu.test(value)
    ? path.win32.normalize(value).replace(/\\+$/u, "").toLowerCase()
    : value;
}

async function captureStableExecutable(filePath, maximumBytes, label, executable) {
  const file = await readStableFile(filePath, maximumBytes, label);
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size !== file.bytes || (executable && (metadata.mode & 0o111) === 0)) {
    throw new Error(`The ${label} is not an exact stable single-link executable.`);
  }
  return file;
}

function assertContext(value) {
  assertExactKeys(value, [
    "challenge",
    "evidenceAttemptId",
    "platform",
    "sourceInstallAttemptId",
    "transitionKind"
  ], "updater evidence native-host context");
  const transitionKind = requiredEnum(
    value.transitionKind,
    TRANSITIONS,
    "updater evidence transition kind"
  );
  return deepFreeze({
    challenge: assertChallenge(value.challenge),
    evidenceAttemptId: requiredUuid(
      value.evidenceAttemptId,
      "updater evidence attempt ID"
    ),
    platform: requiredEnum(
      value.platform,
      Object.keys(PLATFORM_TARGETS),
      "updater evidence platform"
    ),
    sourceInstallAttemptId: requiredSourceAttemptId(
      value.sourceInstallAttemptId,
      transitionKind
    ),
    transitionKind
  });
}

function assertChallenge(value) {
  assertExactKeys(value, ["expiresAt", "id", "issuedAt", "nonceSha256"],
    "updater evidence challenge");
  const challenge = Object.freeze({
    expiresAt: requiredRfc3339(value.expiresAt, "updater evidence challenge expiry"),
    id: requiredUuid(value.id, "updater evidence challenge ID"),
    issuedAt: requiredRfc3339(value.issuedAt, "updater evidence challenge issue time"),
    nonceSha256: requiredDigest(
      value.nonceSha256,
      "updater evidence challenge nonce SHA-256"
    )
  });
  const duration = Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt);
  if (duration <= 0 || duration > MAX_CHALLENGE_LIFETIME_MS) {
    throw new Error(
      "The updater evidence challenge lifetime must be positive and at most 24 hours."
    );
  }
  return challenge;
}

function assertTarget(value, platformName) {
  assertExactKeys(value, [
    "artifactName",
    "artifactSha256",
    "candidateReceiptSha256",
    "embeddedUpdaterEndpoint",
    "manifestName",
    "runtime",
    "servedManifestSha256",
    "signatureName",
    "signatureSha256",
    "sourceSha",
    "version"
  ], "updater evidence native-host target");
  const platform = PLATFORM_TARGETS[platformName];
  assertEqual(value.artifactName, platform.artifactName, "target artifact name");
  assertEqual(value.signatureName, platform.signatureName, "target signature name");
  assertEqual(value.manifestName, "latest.json", "target manifest name");
  assertEqual(value.runtime, "electron-v23", "target runtime");
  return Object.freeze({
    artifactName: platform.artifactName,
    artifactSha256: requiredDigest(value.artifactSha256, "target artifact SHA-256"),
    candidateReceiptSha256: requiredDigest(
      value.candidateReceiptSha256,
      "target candidate receipt SHA-256"
    ),
    embeddedUpdaterEndpoint: requiredHttpsEndpoint(
      value.embeddedUpdaterEndpoint,
      "target embedded updater endpoint"
    ),
    manifestName: "latest.json",
    runtime: "electron-v23",
    servedManifestSha256: requiredDigest(
      value.servedManifestSha256,
      "target served manifest SHA-256"
    ),
    signatureName: platform.signatureName,
    signatureSha256: requiredDigest(
      value.signatureSha256,
      "target signature SHA-256"
    ),
    sourceSha: requiredCommitSha(value.sourceSha, "target source SHA"),
    version: requiredSemanticVersion(value.version, "target version")
  });
}

function requiredHttpsEndpoint(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8192) {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || !url.pathname.endsWith("/latest.json") ||
      url.href !== value) {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`);
  }
  return value;
}

function assertWithinChallenge(observedAt, challenge) {
  const observed = Date.parse(observedAt);
  if (observed < Date.parse(challenge.issuedAt) ||
      observed > Date.parse(challenge.expiresAt)) {
    throw new Error("The native-host observation falls outside its challenge window.");
  }
}

function requiredSourceAttemptId(value, transitionKind) {
  if (typeof value !== "string") {
    throw new Error("The source updater install attempt ID is invalid.");
  }
  if (transitionKind === "tauri-v22-to-electron-v23") {
    const match = /^update-install-([1-9]\d*)$/u.exec(value);
    if (!match || BigInt(match[1]) > 18_446_744_073_709_551_615n) {
      throw new Error("The source updater install attempt ID is not a Tauri v22 sequence.");
    }
  } else {
    const prefix = "update-install-";
    if (!value.startsWith(prefix)) {
      throw new Error("The source updater install attempt ID is not an Electron v23 UUID.");
    }
    requiredUuid(value.slice(prefix.length), "source updater install attempt ID");
  }
  return value;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function requiredEnum(value, values, label) {
  if (!values.includes(value)) throw new Error(`The ${label} is unsupported.`);
  return value;
}

function requiredCanonicalAbsolutePath(value, label) {
  const canonical = requiredAbsolutePath(value, label);
  assertEqual(value, canonical, `${label} canonical path`);
  return canonical;
}

function requiredSafeProcessId(value, label) {
  const processId = requiredPositiveInteger(value, label);
  if (processId <= 1 || processId > 0xffff_ffff || processId === process.pid) {
    throw new Error(`The ${label} is unsafe.`);
  }
  return processId;
}

function requiredAbortSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function" ||
      typeof value.removeEventListener !== "function") {
    throw new Error("The native-host observer requires a caller-owned AbortSignal.");
  }
  return value;
}

function requiredCurrentDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("The native-host observation clock is invalid.");
  }
  return new Date(value.getTime());
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native-host observation dependencies must be an object.");
  }
  const allowed = new Set([
    "hostPlatform",
    "now",
    "observeDarwinProcess",
    "queryWindowsProcess"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown native-host observation dependency ${key}.`);
    }
  }
  const hostPlatform = value.hostPlatform ?? process.platform;
  if (hostPlatform !== "darwin" && hostPlatform !== "win32") {
    throw new Error("The native-host observation platform is unsupported.");
  }
  for (const key of ["now", "observeDarwinProcess", "queryWindowsProcess"]) {
    if (value[key] !== undefined && typeof value[key] !== "function") {
      throw new Error(`The native-host observation dependency ${key} is invalid.`);
    }
  }
  return Object.freeze({
    hostPlatform,
    now: value.now ?? (() => new Date()),
    observeDarwinProcess: value.observeDarwinProcess ?? defaultObserveDarwinProcess,
    queryWindowsProcess: value.queryWindowsProcess ?? defaultQueryWindowsProcess
  });
}

function throwIfAborted(signal) {
  if (signal.aborted) throw cancelledObservation(signal.reason);
}

function cancelledObservation(reason) {
  const suffix = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(`The native-host observation was cancelled${suffix}.`);
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelledObservation(signal.reason));
  return new Promise((resolvePromise, reject) => {
    const cancel = () => reject(cancelledObservation(signal.reason));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      }
    );
  });
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
