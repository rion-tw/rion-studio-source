import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { createEncodedPowerShellJsonInvocation } from "./encodedPowerShell.mjs";
import {
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_FILE,
  ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
  assertElectronProductionUpdaterEvidenceNativeHostObservationBindings,
  observeElectronProductionUpdaterEvidenceNativeHost
} from "./electronProductionUpdaterEvidenceNativeHostObservation.mjs";
import {
  createElectronUpdaterDarwinProcessSupervisor,
  waitForElectronUpdaterDarwinProcessSupervisorAdmission
} from "./electronUpdaterDarwinProcessSupervisor.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readStableFile,
  requiredAbsolutePath,
  requiredDigest,
  requiredPositiveInteger,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const execFileAsync = promisify(execFile);

export const ELECTRON_PRODUCTION_UPDATER_TARGET_PROCESS_OBSERVATION_KIND =
  "rion-electron-production-updater-target-process-observation";

const MAX_JSON_BYTES = 1024 * 1024;
const PLATFORM_HOSTS = Object.freeze({
  "darwin-aarch64": "darwin",
  "windows-x86_64": "win32"
});
const WINDOWS_DISCOVERY_SCRIPT = String.raw`
function Rion-CreationMilliseconds($value) {
  if ($value -is [DateTime]) {
    return ([DateTimeOffset]$value.ToUniversalTime()).ToUnixTimeMilliseconds()
  }
  $converted = [System.Management.ManagementDateTimeConverter]::ToDateTime(
    [string]$value)
  return ([DateTimeOffset]$converted.ToUniversalTime()).ToUnixTimeMilliseconds()
}
$expectedPath = [System.IO.Path]::GetFullPath([string]$payload.expectedExecutablePath).TrimEnd("\")
$launchedAfter = [long]$payload.launchedAfterMilliseconds
$matches = @(
  Get-CimInstance Win32_Process |
    Where-Object {
      -not [String]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and
      [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).TrimEnd("\") -ieq $expectedPath -and
      (Rion-CreationMilliseconds $_.CreationDate) -ge ($launchedAfter - 1000)
    }
)
if ($matches.Count -ne 1) {
  throw "the exact post-fence target process is unavailable or ambiguous"
}
$candidate = $matches[0]
$commandLine = [string]$candidate.CommandLine
if ([String]::IsNullOrWhiteSpace($commandLine)) {
  throw "the exact target command line is unavailable"
}
[pscustomobject]@{
  arguments = @($commandLine)
  identity = [ordered]@{
    creationMilliseconds = [long](Rion-CreationMilliseconds $candidate.CreationDate)
    executablePath = $expectedPath
    processId = [uint32]$candidate.ProcessId
  }
} | ConvertTo-Json -Compress -Depth 4
`;

export async function discoverAndObserveElectronProductionUpdaterTargetProcess(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "bindings",
    "expectedExecutablePath",
    "launchArgumentsOutputPath",
    "launchedAfterMilliseconds",
    "nativeHostObservationOutputPath",
    "platformProcess",
    "signal"
  ], "updater target-process observation input");
  const bindings =
    assertElectronProductionUpdaterEvidenceNativeHostObservationBindings(
      input.bindings
    );
  const dependencies = resolveDependencies(dependencyOverrides);
  const hostPlatform = PLATFORM_HOSTS[bindings.context.platform];
  assertEqual(dependencies.hostPlatform, hostPlatform,
    "updater target-process observation host platform");
  const signal = requiredAbortSignal(input.signal);
  throwIfAborted(signal);
  const expectedExecutablePath = requiredAbsolutePath(
    input.expectedExecutablePath,
    "updater target executable"
  );
  const launchedAfterMilliseconds = requiredPositiveInteger(
    input.launchedAfterMilliseconds,
    "updater target launch fence"
  );
  const platformProcess = assertPlatformProcess(
    input.platformProcess,
    bindings.context.platform
  );
  if (hostPlatform === "darwin") {
    assertCanonicalDarwinTargetExecutable(expectedExecutablePath);
  }
  const discovery = hostPlatform === "darwin"
    ? await dependencies.discoverDarwinTarget({
        expectedExecutablePath,
        inventoryExecutablePath: platformProcess.inventoryExecutablePath,
        launchedAfterMilliseconds,
        signal
      })
    : await dependencies.discoverWindowsTarget({
        expectedExecutablePath,
        launchedAfterMilliseconds,
        signal
      });
  throwIfAborted(signal);
  const observed = assertDiscovery(
    discovery,
    bindings.context.platform,
    expectedExecutablePath,
    launchedAfterMilliseconds,
    platformProcess
  );
  const launchArgumentsPath = await resolveCreateNewFile(
    input.launchArgumentsOutputPath,
    ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_FILE,
    "updater target launch-arguments seal"
  );
  const launchArguments = createLaunchArgumentsSeal(
    bindings,
    expectedExecutablePath,
    observed
  );
  await writeExclusive(launchArgumentsPath, serializeCanonicalJson(launchArguments));
  const launchFile = await readStableFile(
    launchArgumentsPath,
    MAX_JSON_BYTES,
    "updater target launch-arguments seal"
  );
  const nativeHost = await dependencies.observeNativeHost({
    bindings,
    expectedExecutablePath,
    launchArgumentsPath,
    launchArgumentsSha256: launchFile.sha256,
    outputPath: requiredAbsolutePath(
      input.nativeHostObservationOutputPath,
      "updater target native-host observation"
    ),
    process: observed.processBinding,
    signal
  }, nativeObservationDependencies(dependencies));
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_TARGET_PROCESS_OBSERVATION_KIND,
    platform: bindings.context.platform,
    process: observed.identity,
    launchArguments: publicIdentity(launchArgumentsPath, launchFile),
    nativeHostObservation: nativeHost.observationIdentity
  });
}

async function defaultDiscoverDarwinTarget(input) {
  if (process.platform !== "darwin") {
    throw new Error("Darwin target discovery requires a macOS host.");
  }
  let result;
  try {
    result = await execFileAsync("/bin/ps", ["-axo", "pid=,command=", "-ww"], {
      encoding: "utf8",
      maxBuffer: MAX_JSON_BYTES,
      signal: input.signal
    });
  } catch {
    if (input.signal.aborted) throw cancelled(input.signal.reason);
    throw new Error("The Darwin target process snapshot failed.");
  }
  const candidates = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*([1-9]\d*)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const processId = Number(match[1]);
    const commandLine = match[2];
    if (Number.isSafeInteger(processId) && processId > 1 &&
        (commandLine === input.expectedExecutablePath ||
         commandLine.startsWith(`${input.expectedExecutablePath} `))) {
      candidates.push({ processId, commandLine });
    }
  }
  if (candidates.length !== 1) {
    throw new Error("The exact post-fence Darwin target process is unavailable or ambiguous.");
  }
  const applicationPath = input.expectedExecutablePath.slice(
    0,
    -"/Contents/MacOS/Rion Studio".length
  );
  const supervisor = await createElectronUpdaterDarwinProcessSupervisor({
    applicationPath,
    helperProcessId: candidates[0].processId,
    inventoryExecutablePath: input.inventoryExecutablePath,
    launchedAfterMilliseconds: input.launchedAfterMilliseconds,
    platform: "darwin",
    runtimeRoot: applicationPath.slice(0, -"/Rion Studio.app".length)
  });
  const identity = await waitForElectronUpdaterDarwinProcessSupervisorAdmission(
    supervisor
  );
  return Object.freeze({
    arguments: Object.freeze([candidates[0].commandLine]),
    identity
  });
}

async function defaultDiscoverWindowsTarget(input) {
  if (process.platform !== "win32") {
    throw new Error("Windows target discovery requires a Windows host.");
  }
  const invocation = createEncodedPowerShellJsonInvocation(
    WINDOWS_DISCOVERY_SCRIPT,
    {
      expectedExecutablePath: input.expectedExecutablePath,
      launchedAfterMilliseconds: input.launchedAfterMilliseconds
    }
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
    if (input.signal.aborted) throw cancelled(input.signal.reason);
    throw new Error("The Windows target process snapshot failed.");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("The Windows target process snapshot returned invalid JSON.");
  }
}

function assertDiscovery(value, platform, executablePath, launchedAfter, platformProcess) {
  assertExactKeys(value, ["arguments", "identity"],
    "updater target process discovery");
  if (!Array.isArray(value.arguments) || value.arguments.length !== 1 ||
      typeof value.arguments[0] !== "string" || value.arguments[0].length === 0) {
    throw new Error("The updater target process command line is invalid.");
  }
  const identity = value.identity;
  const isDarwin = platform === "darwin-aarch64";
  const expectedIdentityKeys = isDarwin
    ? [
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
      ]
    : ["creationMilliseconds", "executablePath", "processId"];
  assertExactKeys(identity, expectedIdentityKeys, "updater target process identity");
  assertEqual(identity.executablePath, executablePath,
    "updater target process executable path");
  const processId = requiredProcessId(identity.processId);
  if (isDarwin) {
    const startedAt = requiredPositiveInteger(identity.startSeconds,
      "Darwin target start seconds") * 1000 +
      Math.floor(requiredNonnegativeInteger(
        identity.startMicroseconds,
        "Darwin target start microseconds"
      ) / 1000);
    if (startedAt < launchedAfter - 1000) {
      throw new Error("The Darwin target process predates its launch fence.");
    }
    return deepFreeze({
      arguments: [...value.arguments],
      identity: { ...identity },
      processBinding: {
        inventoryExecutablePath: platformProcess.inventoryExecutablePath,
        inventoryExecutableSha256: platformProcess.inventoryExecutableSha256,
        launchedAfterMilliseconds: launchedAfter,
        platform: "darwin",
        processId
      }
    });
  }
  const creationMilliseconds = requiredPositiveInteger(
    identity.creationMilliseconds,
    "Windows target creation milliseconds"
  );
  if (creationMilliseconds < launchedAfter - 1000) {
    throw new Error("The Windows target process predates its launch fence.");
  }
  return deepFreeze({
    arguments: [...value.arguments],
    identity: { ...identity },
    processBinding: {
      creationMilliseconds,
      platform: "win32",
      processId
    }
  });
}

function createLaunchArgumentsSeal(bindings, executablePath, observed) {
  const isDarwin = bindings.context.platform === "darwin-aarch64";
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_EVIDENCE_NATIVE_HOST_LAUNCH_ARGUMENTS_KIND,
    arguments: observed.arguments,
    context: bindings.context,
    executablePath,
    hostClaim: {
      browserWindowOnlySubstitute: false,
      htmlChromeSubstitute: false,
      nativeHostKind: isDarwin ? "appkit-chromium" : "bundled-chromium",
      retainedAppKitHost: isDarwin
    },
    process: observed.identity,
    target: {
      candidateReceiptSha256: bindings.target.candidateReceiptSha256,
      sourceSha: bindings.target.sourceSha,
      version: bindings.target.version
    },
    targetRunningImageSha256: bindings.targetRunningImageSha256
  });
}

function assertPlatformProcess(value, platform) {
  if (platform === "darwin-aarch64") {
    assertExactKeys(value, [
      "inventoryExecutablePath",
      "inventoryExecutableSha256"
    ], "Darwin target-process support");
    return Object.freeze({
      inventoryExecutablePath: requiredAbsolutePath(
        value.inventoryExecutablePath,
        "Darwin process inventory executable"
      ),
      inventoryExecutableSha256: requiredDigest(
        value.inventoryExecutableSha256,
        "Darwin process inventory executable SHA-256"
      )
    });
  }
  assertExactKeys(value, [], "Windows target-process support");
  return Object.freeze({});
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Updater target-process observation dependencies must be an object.");
  }
  const allowed = new Set([
    "discoverDarwinTarget",
    "discoverWindowsTarget",
    "hostPlatform",
    "now",
    "observeDarwinProcess",
    "observeNativeHost",
    "queryWindowsProcess"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown updater target-process dependency ${key}.`);
    }
  }
  const result = {
    discoverDarwinTarget: value.discoverDarwinTarget ?? defaultDiscoverDarwinTarget,
    discoverWindowsTarget: value.discoverWindowsTarget ?? defaultDiscoverWindowsTarget,
    hostPlatform: value.hostPlatform ?? process.platform,
    now: value.now,
    observeDarwinProcess: value.observeDarwinProcess,
    observeNativeHost: value.observeNativeHost ??
      observeElectronProductionUpdaterEvidenceNativeHost,
    queryWindowsProcess: value.queryWindowsProcess
  };
  for (const key of [
    "discoverDarwinTarget",
    "discoverWindowsTarget",
    "observeNativeHost"
  ]) {
    if (typeof result[key] !== "function") {
      throw new Error(`The updater target-process dependency ${key} is invalid.`);
    }
  }
  return Object.freeze(result);
}

function nativeObservationDependencies(value) {
  return Object.fromEntries([
    ["hostPlatform", value.hostPlatform],
    ["now", value.now],
    ["observeDarwinProcess", value.observeDarwinProcess],
    ["queryWindowsProcess", value.queryWindowsProcess]
  ].filter(([, entry]) => entry !== undefined));
}

function requiredAbortSignal(value) {
  if (!value || typeof value !== "object" ||
      typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The updater target-process observer requires an AbortSignal.");
  }
  return value;
}

function assertCanonicalDarwinTargetExecutable(value) {
  if (!value.endsWith("/Rion Studio.app/Contents/MacOS/Rion Studio")) {
    throw new Error(
      "The Darwin target executable must be the canonical Rion Studio app member."
    );
  }
}

function requiredProcessId(value) {
  if (!Number.isSafeInteger(value) || value <= 1) {
    throw new Error("The updater target process ID is invalid.");
  }
  return value;
}

function requiredNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal.aborted) throw cancelled(signal.reason);
}

function cancelled(reason) {
  const detail = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(`The updater target-process observation was cancelled${detail}.`);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
