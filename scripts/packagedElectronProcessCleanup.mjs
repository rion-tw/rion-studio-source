import { execFile } from "node:child_process";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  assertDarwinExclusiveBundleProcessTreeGone,
  assertDarwinPackagedProcessTreeGone,
  buildDarwinPackagedProcessInventory,
  createDarwinPrivateBundleProcessContainment,
  createDarwinPackagedProcessOwnership,
  terminateDarwinPrivateBundleProcessContainment,
  terminateDarwinPackagedProcessTree,
  waitForDarwinPackagedProcessOwnership
} from "./packagedElectronDarwinProcessOwnership.mjs";
import { runEncodedPowerShellJson } from "./encodedPowerShell.mjs";

const executeFile = promisify(execFile);
const OWNER_TOKEN = Symbol("rion-packaged-electron-process-owner");
const CONTAINMENT_TOKEN = Symbol("rion-packaged-electron-private-bundle-containment");
const POLL_MILLISECONDS = 25;
const OWNERSHIP_CAPTURE_MILLISECONDS = 2_000;
const FORCED_TREE_EXIT_MILLISECONDS = 15_000;
export const PACKAGED_ELECTRON_PROCESS_CLEANUP_MILLISECONDS = 17_000;

export function createPackagedElectronProcessCleanupDeadline() {
  return performance.now() + PACKAGED_ELECTRON_PROCESS_CLEANUP_MILLISECONDS;
}

const WINDOWS_PROCESS_TREE_SCRIPT = String.raw`
function Rion-NormalizedPath([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return [System.IO.Path]::GetFullPath($value).TrimEnd("\").ToLowerInvariant()
}
function Rion-CreationMilliseconds($value) {
  if ($value -is [DateTime]) {
    return ([DateTimeOffset]$value.ToUniversalTime()).ToUnixTimeMilliseconds()
  }
  $converted = [System.Management.ManagementDateTimeConverter]::ToDateTime(
    [string]$value)
  return ([DateTimeOffset]$converted.ToUniversalTime()).ToUnixTimeMilliseconds()
}
$rootPid = [uint32]$payload.rootPid
$minimumCreationMilliseconds = [long]$payload.spawnedAtMilliseconds - 5000
$exactRootCreationMilliseconds = if ($null -eq $payload.rootCreationMilliseconds) {
  $null
} else {
  [long]$payload.rootCreationMilliseconds
}
$expectedExecutable = Rion-NormalizedPath ([string]$payload.executablePath)
$expectedRoot = Rion-NormalizedPath ([string]$payload.executableRoot)
$ownedCreationFloor = if ($null -eq $exactRootCreationMilliseconds) {
  $minimumCreationMilliseconds
} else {
  $exactRootCreationMilliseconds
}
$all = @(Get-CimInstance Win32_Process)
$root = @($all | Where-Object { [uint32]$_.ProcessId -eq $rootPid })
if ($root.Count -gt 1) { throw "duplicate exact packaged Electron root PID" }
$owned = @()
$seen = @{}
if ($root.Count -eq 1) {
  $rootPath = Rion-NormalizedPath ([string]$root[0].ExecutablePath)
  $rootCreated = Rion-CreationMilliseconds $root[0].CreationDate
  if ($rootPath -ne $expectedExecutable -or
      ($null -ne $exactRootCreationMilliseconds -and
       $rootCreated -ne $exactRootCreationMilliseconds) -or
      ($null -eq $exactRootCreationMilliseconds -and
       $rootCreated -lt $minimumCreationMilliseconds)) {
    throw "packaged Electron root process identity changed"
  }
  $owned += [pscustomobject]@{
    processId = [uint32]$root[0].ProcessId
    parentProcessId = [uint32]$root[0].ParentProcessId
    creationMilliseconds = [long]$rootCreated
    executablePath = $rootPath
    depth = 0
  }
  $seen[[string]$rootPid] = $true
}
$queue = [System.Collections.Generic.Queue[object]]::new()
foreach ($candidate in $all) {
  if ([uint32]$candidate.ParentProcessId -eq $rootPid) {
    $queue.Enqueue([pscustomobject]@{ process = $candidate; depth = 1 })
  }
}
while ($queue.Count -gt 0) {
  $entry = $queue.Dequeue()
  $candidate = $entry.process
  $candidatePid = [uint32]$candidate.ProcessId
  if ($seen.ContainsKey([string]$candidatePid)) { continue }
  $candidatePath = Rion-NormalizedPath ([string]$candidate.ExecutablePath)
  $candidateCreated = Rion-CreationMilliseconds $candidate.CreationDate
  $underExpectedRoot = $candidatePath.StartsWith($expectedRoot + "\")
  if (($candidatePath -ne $expectedExecutable -and -not $underExpectedRoot) -or
      $candidateCreated -lt $ownedCreationFloor) {
    throw "packaged Electron descendant process identity changed"
  }
  $seen[[string]$candidatePid] = $true
  $owned += [pscustomobject]@{
    processId = $candidatePid
    parentProcessId = [uint32]$candidate.ParentProcessId
    creationMilliseconds = [long]$candidateCreated
    executablePath = $candidatePath
    depth = [int]$entry.depth
  }
  foreach ($child in $all) {
    if ([uint32]$child.ParentProcessId -eq $candidatePid) {
      $queue.Enqueue([pscustomobject]@{
        process = $child
        depth = [int]$entry.depth + 1
      })
    }
  }
}
ConvertTo-Json -Compress -InputObject @($owned)
`;

export function packagedElectronSpawnOptions(platform = process.platform) {
  if (platform === "darwin") return Object.freeze({ detached: true });
  if (platform === "win32") return Object.freeze({ detached: false });
  throw new Error(`Packaged Electron process ownership does not support ${platform}.`);
}

export { buildDarwinPackagedProcessInventory };

export function createPackagedElectronProcessOwner(input, darwinOperations) {
  if (input?.platform !== "darwin" && input?.platform !== "win32") {
    throw new Error("Packaged Electron process ownership requires macOS or Windows.");
  }
  const processId = input.child?.pid;
  if (
    !Number.isSafeInteger(processId) || processId <= 1 ||
    processId === process.pid
  ) {
    throw new Error("Packaged Electron did not expose a safe owned process ID.");
  }
  if (
    !Number.isSafeInteger(input.spawnedAtMilliseconds) ||
    input.spawnedAtMilliseconds <= 0
  ) {
    throw new Error("Packaged Electron process ownership requires an exact spawn time.");
  }
  if (typeof input.executablePath !== "string" || input.executablePath.length === 0) {
    throw new Error("Packaged Electron process ownership requires its executable path.");
  }
  const executablePath = resolve(input.executablePath);
  const close = observeChildClose(input.child);
  const darwinOwnership = input.platform === "darwin"
      ? createDarwinPackagedProcessOwnership({
        privateBundle: input.privateBundle,
        executablePath,
        inventoryExecutablePath: input.inventoryExecutablePath,
        processGroupId: processId,
        processId,
        spawnedAtMilliseconds: input.spawnedAtMilliseconds
      }, darwinOperations)
    : undefined;
  const owner = {
    [OWNER_TOKEN]: true,
    child: input.child,
    close,
    darwinOwnership,
    executablePath,
    executableRoot: dirname(executablePath),
    platform: input.platform,
    processGroupId: input.platform === "darwin" ? processId : undefined,
    processId,
    spawnedAtMilliseconds: input.spawnedAtMilliseconds
  };
  owner.windowsRootIdentity = input.platform === "win32"
    ? captureWindowsRootIdentity(owner)
    : undefined;
  void owner.windowsRootIdentity?.catch(() => undefined);
  return Object.freeze(owner);
}

export function createPackagedElectronPrivateBundleContainment(input) {
  if (input?.platform !== "darwin") {
    throw new Error("Private-bundle process containment is available only on macOS.");
  }
  const processId = input.child?.pid;
  if (
    !Number.isSafeInteger(processId) || processId <= 1 ||
    processId === process.pid
  ) {
    throw new Error("The private-bundle containment requires a safe owned process ID.");
  }
  const containment = {
    [CONTAINMENT_TOKEN]: true,
    child: input.child,
    close: observeChildClose(input.child),
    darwinContainment: createDarwinPrivateBundleProcessContainment({
      inventoryExecutablePath: input.inventoryExecutablePath,
      privateBundle: input.privateBundle,
      processId,
      spawnedAtMilliseconds: input.spawnedAtMilliseconds
    }),
    platform: "darwin",
    processId
  };
  return Object.freeze(containment);
}

export async function waitForPackagedElectronProcessOwnership(owner) {
  assertOwner(owner);
  if (owner.darwinOwnership) {
    await waitForDarwinPackagedProcessOwnership(owner.darwinOwnership);
  } else {
    await owner.windowsRootIdentity;
  }
}

export async function waitForPackagedElectronProcessClose(
  owner,
  deadlineMilliseconds
) {
  assertOwner(owner);
  if (!Number.isSafeInteger(deadlineMilliseconds) || deadlineMilliseconds <= 0) {
    throw new Error("Packaged Electron close deadline must be a positive integer.");
  }
  return withFailureDeadline(
    owner.close,
    deadlineMilliseconds,
    "Packaged Electron did not close its process pipes."
  );
}

export async function assertPackagedElectronProcessTreeGone(
  owner,
  operations = defaultOperations
) {
  assertOwner(owner);
  if (owner.platform === "darwin") {
    await assertDarwinPackagedProcessTreeGone(owner.darwinOwnership);
    return;
  }
  const tree = await operations.readWindowsOwnedTree(owner);
  if (tree.length > 0) {
    throw new Error(
      `Packaged Electron left ${tree.length} owned Windows process(es) alive.`
    );
  }
}

export async function assertPackagedElectronProcessContainmentGone(
  owner,
  operations = defaultOperations
) {
  assertOwner(owner);
  if (owner.platform === "darwin") {
    await assertDarwinExclusiveBundleProcessTreeGone(owner.darwinOwnership);
    return;
  }
  const tree = await operations.readWindowsOwnedTree(owner);
  if (tree.length > 0) {
    throw new Error(
      `Packaged Electron left ${tree.length} contained Windows process(es) alive.`
    );
  }
}

export async function terminatePackagedElectronProcessTree(
  owner,
  operations = defaultOperations,
  deadlineMilliseconds
) {
  assertOwner(owner);
  const deadline = resolveCleanupDeadline(operations, deadlineMilliseconds);
  const failures = [];
  await captureCleanupFailure(failures, () => owner.platform === "darwin"
    ? terminateDarwinPackagedProcessTree(owner.darwinOwnership, deadline)
    : terminateWindowsProcessTree(owner, operations));
  await captureCleanupFailure(failures, () => withFailureDeadline(
    owner.close,
    remainingCleanupMilliseconds(operations, deadline),
    "Packaged Electron did not close its process pipes."
  ));
  if (owner.platform === "win32") {
    await captureCleanupFailure(failures, () =>
      assertPackagedElectronProcessTreeGone(owner, operations));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Packaged Electron process-tree cleanup was incomplete."
    );
  }
}

export async function terminatePackagedElectronPrivateBundleContainment(
  containment,
  deadlineMilliseconds
) {
  assertContainment(containment);
  const deadline = resolveCleanupDeadline(
    defaultOperations,
    deadlineMilliseconds
  );
  const failures = [];
  await captureCleanupFailure(failures, () =>
    terminateDarwinPrivateBundleProcessContainment(
      containment.darwinContainment,
      deadline
    ));
  await captureCleanupFailure(failures, () => withFailureDeadline(
    containment.close,
    remainingCleanupMilliseconds(defaultOperations, deadline),
    "The contained packaged Electron process did not close its pipes."
  ));
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Packaged Electron private-bundle containment cleanup was incomplete."
    );
  }
}

export function packagedSmokeFailure(primaryError, cleanupErrors) {
  if (!Array.isArray(cleanupErrors)) {
    throw new Error("Packaged Electron cleanup errors must be an array.");
  }
  if (cleanupErrors.length === 0) return primaryError;
  return new AggregateError(
    [primaryError, ...cleanupErrors],
    "Packaged Electron smoke failed and cleanup was incomplete.",
    { cause: primaryError }
  );
}

async function terminateWindowsProcessTree(owner, operations) {
  const deadline = operations.now() + FORCED_TREE_EXIT_MILLISECONDS;
  const terminationErrors = [];
  while (operations.now() <= deadline) {
    const tree = await operations.readWindowsOwnedTree(owner);
    if (tree.length === 0) return;
    const root = tree.find((entry) => entry.processId === owner.processId);
    const targets = root
      ? [root]
      : [...tree].sort((left, right) => right.depth - left.depth);
    for (const target of targets) {
      try {
        await operations.terminateWindowsTree(target.processId);
      } catch (error) {
        terminationErrors.push(error);
      }
    }
    await operations.sleep(POLL_MILLISECONDS);
  }
  const remaining = await operations.readWindowsOwnedTree(owner);
  if (remaining.length === 0) return;
  throw new AggregateError(
    [
      ...terminationErrors,
      new Error(`${remaining.length} owned Windows process(es) survived taskkill.`)
    ],
    "Packaged Electron Windows process-tree cleanup failed."
  );
}

function observeChildClose(child) {
  let exitObserved = child.exitCode !== null || child.signalCode !== null;
  const close = new Promise((resolveClose, reject) => {
    child.once("exit", () => {
      exitObserved = true;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!exitObserved) {
        reject(new Error("Packaged Electron pipes closed before process exit."));
        return;
      }
      resolveClose(Object.freeze({ code, signal }));
    });
  });
  void close.catch(() => undefined);
  return close;
}

function assertOwner(owner) {
  if (
    owner?.[OWNER_TOKEN] !== true ||
    !Number.isSafeInteger(owner.processId) || owner.processId <= 1 ||
    owner.processId === process.pid ||
    (owner.platform !== "darwin" && owner.platform !== "win32") ||
    (owner.platform === "darwin" && owner.processGroupId !== owner.processId)
  ) {
    throw new Error("Refusing to operate on an invalid packaged Electron owner.");
  }
}

function assertContainment(containment) {
  if (
    containment?.[CONTAINMENT_TOKEN] !== true ||
    containment.platform !== "darwin" ||
    !Number.isSafeInteger(containment.processId) ||
    containment.processId <= 1 || containment.processId === process.pid
  ) {
    throw new Error("Refusing to operate on an invalid private-bundle containment.");
  }
}

function withFailureDeadline(promise, milliseconds, message) {
  return new Promise((resolvePromise, reject) => {
    const deadline = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(deadline);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(deadline);
        reject(error);
      }
    );
  });
}

function remainingCleanupMilliseconds(operations, deadlineMilliseconds) {
  const remaining = Math.floor(deadlineMilliseconds - operations.now());
  if (remaining <= 0) {
    throw new Error("The packaged Electron process-tree cleanup deadline was exhausted.");
  }
  return remaining;
}

function resolveCleanupDeadline(operations, value) {
  const now = operations.now();
  if (value === undefined) {
    return now + PACKAGED_ELECTRON_PROCESS_CLEANUP_MILLISECONDS;
  }
  if (!Number.isFinite(value) || value <= now) {
    throw new Error("The packaged Electron process-tree cleanup deadline is invalid or exhausted.");
  }
  return Math.min(
    value,
    now + PACKAGED_ELECTRON_PROCESS_CLEANUP_MILLISECONDS
  );
}

async function captureCleanupFailure(failures, cleanup) {
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
}

async function readWindowsOwnedTree(owner) {
  const rootIdentity = await owner.windowsRootIdentity;
  return readWindowsOwnedTreeSnapshot(
    owner,
    rootIdentity.creationMilliseconds
  );
}

async function captureWindowsRootIdentity(owner) {
  const deadline = performance.now() + OWNERSHIP_CAPTURE_MILLISECONDS;
  while (performance.now() <= deadline) {
    const tree = await readWindowsOwnedTreeSnapshot(owner, undefined);
    const root = tree.find((entry) => entry.processId === owner.processId);
    if (root) {
      if (!Number.isSafeInteger(root.creationMilliseconds)) {
        throw new Error("The Windows packaged root has no exact creation identity.");
      }
      return Object.freeze({
        creationMilliseconds: root.creationMilliseconds,
        executablePath: root.executablePath,
        processId: root.processId
      });
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MILLISECONDS));
  }
  throw new Error("The Windows packaged root identity was not observable after spawn.");
}

async function readWindowsOwnedTreeSnapshot(owner, rootCreationMilliseconds) {
  const stdout = await runEncodedPowerShellJson(
    WINDOWS_PROCESS_TREE_SCRIPT,
    {
      executablePath: owner.executablePath,
      executableRoot: owner.executableRoot,
      rootCreationMilliseconds: rootCreationMilliseconds ?? null,
      rootPid: owner.processId,
      spawnedAtMilliseconds: owner.spawnedAtMilliseconds
    },
    { timeoutMilliseconds: FORCED_TREE_EXIT_MILLISECONDS }
  );
  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

const defaultOperations = Object.freeze({
  now: () => performance.now(),
  readWindowsOwnedTree,
  sleep: (milliseconds) => new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  }),
  terminateWindowsTree: (processId) => executeFile("taskkill.exe", [
    "/PID",
    String(processId),
    "/T",
    "/F"
  ], {
    encoding: "utf8",
    timeout: FORCED_TREE_EXIT_MILLISECONDS,
    windowsHide: true
  })
});
