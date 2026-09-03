import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { promisify } from "node:util";

import { requireDarwinPrivatePackagedElectronBundle } from
  "./packagedElectronDarwinPrivateBundle.mjs";

const executeFile = promisify(execFile);
const INVENTORY_SOURCE = join(
  import.meta.dirname,
  "native",
  "macos",
  "packaged_process_inventory.c"
);
const MINIMUM_START_ENVIRONMENT_KEY =
  "RION_STUDIO_PACKAGED_PROCESS_MINIMUM_START";
const ROOT_PID_ENVIRONMENT_KEY = "RION_STUDIO_PACKAGED_PROCESS_ROOT_PID";
const BUNDLE_ROOT_ENVIRONMENT_KEY =
  "RION_STUDIO_PACKAGED_PROCESS_BUNDLE_ROOT";
const KNOWN_FENCES_ENVIRONMENT_KEY =
  "RION_STUDIO_PACKAGED_PROCESS_KNOWN_FENCES";
const INVENTORY_DEADLINE_MILLISECONDS = 10_000;
const CAPTURE_DEADLINE_MILLISECONDS = 2_000;
const GRACEFUL_EXIT_MILLISECONDS = 2_000;
const FORCED_EXIT_MILLISECONDS = 15_000;
const TOTAL_CLEANUP_MILLISECONDS =
  GRACEFUL_EXIT_MILLISECONDS + FORCED_EXIT_MILLISECONDS;
const POLL_MILLISECONDS = 25;

export async function buildDarwinPackagedProcessInventory(outputDirectory) {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const executablePath = join(directory, "packaged-process-inventory");
  await executeFile("/usr/bin/xcrun", [
    "clang",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=14.0",
    INVENTORY_SOURCE,
    "-o",
    executablePath
  ], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000
  });
  const metadata = await lstat(executablePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0) {
    throw new Error("The macOS packaged-process inventory helper is not a regular executable.");
  }
  return executablePath;
}

export function createDarwinPackagedProcessOwnership(input, operations = defaultOperations) {
  const processId = requireSafeProcessId(input?.processId, "root process");
  const processGroupId = requireSafeProcessId(
    input?.processGroupId,
    "process group"
  );
  if (processGroupId !== processId) {
    throw new Error("The macOS packaged root must own its exact process group.");
  }
  if (
    !Number.isSafeInteger(input?.spawnedAtMilliseconds) ||
    input.spawnedAtMilliseconds <= 0
  ) {
    throw new Error("The macOS packaged root requires an exact spawn time.");
  }
  const executablePath = canonicalPath(input?.executablePath, "root executable");
  const inventoryExecutablePath = canonicalPath(
    input?.inventoryExecutablePath,
    "inventory executable"
  );
  const bundleRoot = resolve(dirname(executablePath), "..", "..");
  if (
    basename(dirname(executablePath)) !== "MacOS" ||
    basename(dirname(dirname(executablePath))) !== "Contents" ||
    !basename(bundleRoot).endsWith(".app")
  ) {
    throw new Error("The macOS packaged root is outside a canonical application bundle.");
  }
  const privateBundle = requireDarwinPrivatePackagedElectronBundle(
    input?.privateBundle
  );
  const exclusiveBundleRoot = canonicalPath(
    privateBundle.applicationPath,
    "exclusive bundle root"
  );
  if (exclusiveBundleRoot !== bundleRoot) {
    throw new Error("The macOS packaged executable is outside its exclusive bundle root.");
  }
  const ownership = {
    bundleRoot,
    executablePath,
    inventoryExecutablePath,
    knownIdentities: new Map(),
    operations,
    processGroupId,
    processId,
    spawnedAtMilliseconds: input.spawnedAtMilliseconds
  };
  ownership.rootIdentity = captureRootIdentity(ownership);
  void ownership.rootIdentity.catch(() => undefined);
  return Object.freeze(ownership);
}

export function createDarwinPrivateBundleProcessContainment(
  input,
  operations = defaultOperations
) {
  const privateBundle = requireDarwinPrivatePackagedElectronBundle(
    input?.privateBundle
  );
  return createDarwinExclusiveBundleProcessContainment({
    bundleRoot: privateBundle.applicationPath,
    inventoryExecutablePath: input?.inventoryExecutablePath,
    processId: input?.processId,
    spawnedAtMilliseconds: input?.spawnedAtMilliseconds
  }, operations);
}

export function createDarwinExclusiveBundleProcessContainment(
  input,
  operations = defaultOperations
) {
  const processId = requireSafeProcessId(input?.processId, "containment root process");
  if (
    !Number.isSafeInteger(input?.spawnedAtMilliseconds) ||
    input.spawnedAtMilliseconds <= 0
  ) {
    throw new Error("The macOS exclusive-bundle containment requires an exact spawn time.");
  }
  const bundleRoot = canonicalPath(input?.bundleRoot, "exclusive bundle root");
  if (!basename(bundleRoot).endsWith(".app")) {
    throw new Error("The macOS exclusive-bundle containment requires an application root.");
  }
  return Object.freeze({
    bundleRoot,
    inventoryExecutablePath: canonicalPath(
      input?.inventoryExecutablePath,
      "inventory executable"
    ),
    knownIdentities: new Map(),
    operations,
    processId,
    spawnedAtMilliseconds: input.spawnedAtMilliseconds
  });
}

export async function waitForDarwinExclusiveBundleProcessAdmission(
  containment,
  expectedExecutablePath,
  deadlineMilliseconds
) {
  const expectedExecutable = canonicalPath(
    expectedExecutablePath,
    "exclusive bundle executable"
  );
  if (!isPathInside(expectedExecutable, containment.bundleRoot)) {
    throw new Error(
      "The macOS exclusive-bundle executable escaped its containment root."
    );
  }
  const deadline = boundedOperationDeadline(
    containment,
    deadlineMilliseconds,
    CAPTURE_DEADLINE_MILLISECONDS
  );
  while (containment.operations.now() < deadline) {
    const snapshot = await exclusiveBundleSnapshot(containment, deadline);
    const admitted = snapshot.remaining.find(
      (entry) => entry.processId === containment.processId &&
        entry.executablePath === expectedExecutable &&
        processStartMilliseconds(entry) >=
          containment.spawnedAtMilliseconds - 1_000 &&
        processStartMilliseconds(entry) <=
          containment.operations.epochMilliseconds() + 1_000
    );
    if (admitted) return admitted;
    await containment.operations.sleep(Math.min(
      POLL_MILLISECONDS,
      remainingMilliseconds(containment, deadline, "bundle admission")
    ));
  }
  throw new Error(
    "The macOS exclusive-bundle executable was not observable after launch."
  );
}

export async function waitForDarwinPackagedProcessOwnership(ownership) {
  await ownership.rootIdentity;
}

export async function assertDarwinPackagedProcessTreeGone(
  ownership,
  deadlineMilliseconds
) {
  const deadline = boundedOperationDeadline(
    ownership,
    deadlineMilliseconds,
    INVENTORY_DEADLINE_MILLISECONDS
  );
  const snapshot = await ownedSnapshot(ownership, deadline);
  if (snapshot.remaining.length > 0) {
    throw new Error(
      `Packaged Electron left ${snapshot.remaining.length} owned macOS process(es) alive.`
    );
  }
}

export async function assertDarwinExclusiveBundleProcessTreeGone(
  ownership,
  deadlineMilliseconds
) {
  const deadline = boundedOperationDeadline(
    ownership,
    deadlineMilliseconds,
    INVENTORY_DEADLINE_MILLISECONDS
  );
  const snapshot = await exclusiveBundleSnapshot(ownership, deadline);
  if (snapshot.remaining.length > 0) {
    throw new Error(
      `Packaged Electron left ${snapshot.remaining.length} exclusive-bundle macOS process(es) alive.`
    );
  }
}

export async function terminateDarwinPackagedProcessTree(
  ownership,
  deadlineMilliseconds
) {
  const deadline = boundedOperationDeadline(
    ownership,
    deadlineMilliseconds,
    TOTAL_CLEANUP_MILLISECONDS
  );
  const failures = [];
  let admissionFailed = false;
  try {
    await ownership.rootIdentity;
  } catch (error) {
    admissionFailed = true;
    failures.push(error);
  }
  const snapshotReader = admissionFailed
    ? exclusiveBundleSnapshot
    : ownedSnapshot;
  const gracefulDeadline = Math.min(
    deadline,
    ownership.operations.now() + GRACEFUL_EXIT_MILLISECONDS
  );
  await captureFailure(
    failures,
    () => signalOwnedCandidates(
      ownership,
      "SIGTERM",
      snapshotReader,
      gracefulDeadline
    )
  );
  let gracefullyExited = false;
  await captureFailure(failures, async () => {
    gracefullyExited = await waitForOwnedExit(
      ownership,
      snapshotReader,
      gracefulDeadline
    );
  });
  if (!gracefullyExited) {
    await captureFailure(
      failures,
      () => signalOwnedCandidates(
        ownership,
        "SIGKILL",
        snapshotReader,
        deadline
      )
    );
    await captureFailure(failures, async () => {
      if (!await waitForOwnedExit(
        ownership,
        snapshotReader,
        deadline
      )) {
        const snapshot = await snapshotReader(ownership, deadline);
        throw new Error(
          `${snapshot.remaining.length} owned macOS process(es) survived audit-token SIGKILL.`
        );
      }
    });
  }
  await captureFailure(
    failures,
    () => admissionFailed
      ? assertDarwinExclusiveBundleProcessTreeGone(ownership, deadline)
      : assertDarwinPackagedProcessTreeGone(ownership, deadline)
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Packaged Electron macOS process-tree cleanup was indeterminate."
    );
  }
}

export async function terminateDarwinPrivateBundleProcessContainment(
  containment,
  deadlineMilliseconds
) {
  return terminateDarwinExclusiveBundleProcessContainment(
    containment,
    deadlineMilliseconds
  );
}

export async function terminateDarwinExclusiveBundleProcessContainment(
  containment,
  deadlineMilliseconds
) {
  const deadline = boundedOperationDeadline(
    containment,
    deadlineMilliseconds,
    TOTAL_CLEANUP_MILLISECONDS
  );
  const failures = [];
  const gracefulDeadline = Math.min(
    deadline,
    containment.operations.now() + GRACEFUL_EXIT_MILLISECONDS
  );
  await captureFailure(
    failures,
    () => signalOwnedCandidates(
      containment,
      "SIGTERM",
      exclusiveBundleSnapshot,
      gracefulDeadline
    )
  );
  let gracefullyExited = false;
  await captureFailure(failures, async () => {
    gracefullyExited = await waitForOwnedExit(
      containment,
      exclusiveBundleSnapshot,
      gracefulDeadline
    );
  });
  if (!gracefullyExited) {
    await captureFailure(
      failures,
      () => signalOwnedCandidates(
        containment,
        "SIGKILL",
        exclusiveBundleSnapshot,
        deadline
      )
    );
    await captureFailure(failures, async () => {
      if (!await waitForOwnedExit(
        containment,
        exclusiveBundleSnapshot,
        deadline
      )) {
        const snapshot = await exclusiveBundleSnapshot(containment, deadline);
        throw new Error(
          `${snapshot.remaining.length} exclusive-bundle macOS process(es) survived audit-token SIGKILL.`
        );
      }
    });
  }
  await captureFailure(
    failures,
    () => assertDarwinExclusiveBundleProcessTreeGone(containment, deadline)
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Packaged Electron exclusive-bundle containment cleanup was indeterminate."
    );
  }
}

async function exclusiveBundleSnapshot(ownership, deadlineMilliseconds) {
  const inventory = await readOwnedInventory(ownership, deadlineMilliseconds);
  const owned = new Map();
  const ownedUniqueIds = new Set(ownership.knownIdentities.keys());
  for (const entry of inventory) {
    if (
      ownedUniqueIds.has(entry.processUniqueId) ||
      isPathInside(entry.executablePath, ownership.bundleRoot)
    ) {
      owned.set(entry.processUniqueId, entry);
      ownedUniqueIds.add(entry.processUniqueId);
    }
  }
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const entry of inventory) {
      if (
        !owned.has(entry.processUniqueId) &&
        ownedUniqueIds.has(entry.parentProcessUniqueId)
      ) {
        owned.set(entry.processUniqueId, entry);
        ownedUniqueIds.add(entry.processUniqueId);
        discovered = true;
      }
    }
  }
  for (const entry of owned.values()) rememberIdentity(ownership, entry);
  return Object.freeze({ remaining: Object.freeze([...owned.values()]) });
}

async function captureRootIdentity(ownership) {
  const deadline = ownership.operations.now() + CAPTURE_DEADLINE_MILLISECONDS;
  while (ownership.operations.now() < deadline) {
    const inventory = await readOwnedInventory(ownership, deadline);
    const candidate = inventory.find((entry) => entry.processId === ownership.processId);
    if (candidate) {
      const startMilliseconds = processStartMilliseconds(candidate);
      if (candidate.executablePath !== ownership.executablePath) {
        throw new Error("The macOS packaged root executable identity changed after spawn.");
      }
      if (candidate.processGroupId !== ownership.processGroupId) {
        throw new Error("The macOS packaged root escaped its owned process group before admission.");
      }
      if (candidate.parentProcessId !== process.pid) {
        throw new Error("The macOS packaged root was not parented by the exact smoke runner.");
      }
      if (
        startMilliseconds < ownership.spawnedAtMilliseconds - 1_000 ||
        startMilliseconds > ownership.operations.epochMilliseconds() + 1_000
      ) {
        throw new Error("The macOS packaged root start identity predates its spawn fence.");
      }
      rememberIdentity(ownership, candidate);
      return candidate;
    }
    await ownership.operations.sleep(Math.min(
      POLL_MILLISECONDS,
      remainingMilliseconds(ownership, deadline, "root identity capture")
    ));
  }
  throw new Error("The macOS packaged root identity was not observable after spawn.");
}

async function ownedSnapshot(ownership, deadlineMilliseconds) {
  const [root, inventory] = await Promise.all([
    ownership.rootIdentity,
    readOwnedInventory(ownership, deadlineMilliseconds)
  ]);
  const rootIsAlive = inventory.some((entry) => sameIdentity(entry, root));
  const entriesByUniqueId = new Map(
    inventory.map((entry) => [entry.processUniqueId, entry])
  );
  const owned = new Map();
  const ownedUniqueIds = new Set(ownership.knownIdentities.keys());

  for (const entry of inventory) {
    if (
      entry.processId === process.pid ||
      entry.userId !== root.userId ||
      compareStart(entry, root) < 0
    ) {
      continue;
    }
    if (
      sameIdentity(entry, root) ||
      ownership.knownIdentities.has(entry.processUniqueId) ||
      isPathInside(entry.executablePath, ownership.bundleRoot) ||
      (rootIsAlive && entry.processGroupId === ownership.processGroupId)
    ) {
      owned.set(entry.processUniqueId, entry);
      ownedUniqueIds.add(entry.processUniqueId);
    }
  }

  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const entry of entriesByUniqueId.values()) {
      if (
        owned.has(entry.processUniqueId) ||
        entry.userId !== root.userId ||
        compareStart(entry, root) < 0 ||
        !ownedUniqueIds.has(entry.parentProcessUniqueId)
      ) {
        continue;
      }
      owned.set(entry.processUniqueId, entry);
      ownedUniqueIds.add(entry.processUniqueId);
      discovered = true;
    }
  }

  for (const entry of owned.values()) rememberIdentity(ownership, entry);
  return Object.freeze({
    remaining: Object.freeze([...owned.values()])
  });
}

async function signalOwnedCandidates(
  ownership,
  signal,
  snapshotReader,
  deadlineMilliseconds
) {
  const snapshot = await snapshotReader(ownership, deadlineMilliseconds);
  const candidates = [...snapshot.remaining].sort((left, right) => {
    if (left.processId === ownership.processId) return 1;
    if (right.processId === ownership.processId) return -1;
    return compareStart(right, left);
  });
  const failures = [];
  const rootCandidate = candidates.find(
    (candidate) => candidate.processId === ownership.processId
  );
  const descendants = candidates.filter(
    (candidate) => candidate !== rootCandidate
  );
  await Promise.all(descendants.map((candidate) =>
    captureFailure(failures, async () => {
      await ownership.operations.signalAuditToken(
        ownership.inventoryExecutablePath,
        candidate.auditToken,
        signal,
        Math.min(
          INVENTORY_DEADLINE_MILLISECONDS,
          remainingMilliseconds(ownership, deadlineMilliseconds, `${signal} signal`)
        )
      );
    })
  ));
  if (rootCandidate) {
    await captureFailure(failures, async () => {
      await ownership.operations.signalAuditToken(
        ownership.inventoryExecutablePath,
        rootCandidate.auditToken,
        signal,
        Math.min(
          INVENTORY_DEADLINE_MILLISECONDS,
          remainingMilliseconds(
            ownership,
            deadlineMilliseconds,
            `${signal} root signal`
          )
        )
      );
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `One or more owned macOS processes rejected ${signal}.`
    );
  }
}

async function waitForOwnedExit(ownership, snapshotReader, deadlineMilliseconds) {
  while (ownership.operations.now() < deadlineMilliseconds) {
    try {
      if ((await snapshotReader(
        ownership,
        deadlineMilliseconds
      )).remaining.length === 0) return true;
    } catch (error) {
      if (ownership.operations.now() >= deadlineMilliseconds) return false;
      throw error;
    }
    const remaining = Math.ceil(
      deadlineMilliseconds - ownership.operations.now()
    );
    if (remaining <= 0) return false;
    await ownership.operations.sleep(Math.min(POLL_MILLISECONDS, remaining));
  }
  return false;
}

async function readOwnedInventory(ownership, deadlineMilliseconds) {
  return ownership.operations.readInventory(
    ownership.inventoryExecutablePath,
    {
      minimumStartSeconds: Math.max(
        1,
        Math.floor(ownership.spawnedAtMilliseconds / 1_000) - 2
      ),
      rootProcessId: ownership.processId,
      bundleRoot: ownership.bundleRoot,
      knownProcessFences: [...ownership.knownIdentities.values()].map(
        (entry) => ({
          processId: entry.processId,
          startMicroseconds: entry.startMicroseconds,
          startSeconds: entry.startSeconds
        })
      )
    },
    Math.min(
      INVENTORY_DEADLINE_MILLISECONDS,
      remainingMilliseconds(
        ownership,
        deadlineMilliseconds,
        "process inventory"
      )
    )
  );
}

async function readInventory(executablePath, fences, timeoutMilliseconds) {
  const result = await executeFile(executablePath, [], {
    encoding: "utf8",
    env: {
      ...process.env,
      [BUNDLE_ROOT_ENVIRONMENT_KEY]: fences.bundleRoot,
      [KNOWN_FENCES_ENVIRONMENT_KEY]: fences.knownProcessFences.map(
        (entry) => `${entry.processId}:${entry.startSeconds}:${entry.startMicroseconds}`
      ).join(","),
      [MINIMUM_START_ENVIRONMENT_KEY]: String(fences.minimumStartSeconds),
      [ROOT_PID_ENVIRONMENT_KEY]: String(fences.rootProcessId)
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMilliseconds
  });
  return parseDarwinProcessInventory(result.stdout);
}

async function signalAuditToken(
  executablePath,
  auditToken,
  signal,
  timeoutMilliseconds
) {
  const signalNumber = signal === "SIGTERM" ? "15" : "9";
  try {
    await executeFile(executablePath, ["--signal", auditToken, signalNumber], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMilliseconds
    });
  } catch (error) {
    if (error?.code === 44) return;
    throw error;
  }
}

export function parseDarwinProcessInventory(source) {
  if (typeof source !== "string" || source.length > 32 * 1024 * 1024) {
    throw new Error("The macOS process inventory output is invalid or oversized.");
  }
  const entries = [];
  const auditTokens = new Set();
  const processIds = new Set();
  const processUniqueIds = new Set();
  for (const line of source.split("\n")) {
    if (line.length === 0) continue;
    const match = /^(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t(\d+)\t([0-9a-f]{64})\t([0-9a-f]+|-)$/u.exec(line);
    if (!match || (match[10] !== "-" && match[10].length % 2 !== 0)) {
      throw new Error("The macOS process inventory returned a malformed record.");
    }
    const numbers = match.slice(1, 7).map(Number);
    if (
      numbers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      numbers[0] <= 1 || numbers[2] <= 0 || numbers[4] <= 0 ||
      numbers[5] >= 1_000_000 || processIds.has(numbers[0]) ||
      processUniqueIds.has(match[7]) || auditTokens.has(match[9])
    ) {
      throw new Error("The macOS process inventory returned an unsafe identity.");
    }
    const executablePath = match[10] === "-"
      ? undefined
      : Buffer.from(match[10], "hex").toString("utf8");
    if (
      executablePath !== undefined && (
        executablePath.length === 0 || executablePath.includes("\0") ||
        resolve(executablePath) !== executablePath ||
        Buffer.from(executablePath, "utf8").toString("hex") !== match[10]
      )
    ) {
      throw new Error("The macOS process inventory returned an unsafe executable path.");
    }
    processIds.add(numbers[0]);
    processUniqueIds.add(match[7]);
    auditTokens.add(match[9]);
    entries.push(Object.freeze({
      auditToken: match[9],
      executablePath,
      parentProcessId: numbers[1],
      parentProcessUniqueId: match[8],
      processGroupId: numbers[2],
      processId: numbers[0],
      processUniqueId: match[7],
      startMicroseconds: numbers[5],
      startSeconds: numbers[4],
      userId: numbers[3]
    }));
  }
  return Object.freeze(entries);
}

function rememberIdentity(ownership, entry) {
  const existing = ownership.knownIdentities.get(entry.processUniqueId);
  if (existing && (
    existing.processId !== entry.processId ||
    existing.userId !== entry.userId ||
    existing.startSeconds !== entry.startSeconds ||
    existing.startMicroseconds !== entry.startMicroseconds
  )) {
    throw new Error("A macOS unique process identity changed its stable fields.");
  }
  ownership.knownIdentities.set(entry.processUniqueId, entry);
}

function sameIdentity(left, right) {
  return left.auditToken === right.auditToken &&
    left.processId === right.processId &&
    left.processUniqueId === right.processUniqueId &&
    left.userId === right.userId &&
    left.startSeconds === right.startSeconds &&
    left.startMicroseconds === right.startMicroseconds;
}

function compareStart(left, right) {
  return left.startSeconds === right.startSeconds
    ? left.startMicroseconds - right.startMicroseconds
    : left.startSeconds - right.startSeconds;
}

function processStartMilliseconds(entry) {
  return entry.startSeconds * 1_000 + Math.floor(entry.startMicroseconds / 1_000);
}

function isPathInside(path, root) {
  return typeof path === "string" && (path === root || path.startsWith(`${root}/`));
}

function requireSafeProcessId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 1 || value === process.pid) {
    throw new Error(`The macOS packaged ${label} is unsafe.`);
  }
  return value;
}

function canonicalPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || resolve(value) !== value) {
    throw new Error(`The macOS packaged ${label} path must be canonical and absolute.`);
  }
  return value;
}

function boundedOperationDeadline(ownership, value, maximumMilliseconds) {
  const now = ownership.operations.now();
  const maximum = now + maximumMilliseconds;
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value <= now) {
    throw new Error("The macOS packaged-process operation deadline is exhausted or invalid.");
  }
  return Math.min(value, maximum);
}

function remainingMilliseconds(ownership, deadlineMilliseconds, label) {
  const remaining = Math.ceil(
    deadlineMilliseconds - ownership.operations.now()
  );
  if (remaining <= 0) {
    throw new Error(`The macOS packaged ${label} deadline was exhausted.`);
  }
  return remaining;
}

async function captureFailure(failures, operation) {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}

const defaultOperations = Object.freeze({
  epochMilliseconds: () => Date.now(),
  now: () => performance.now(),
  readInventory,
  signalAuditToken,
  sleep: (milliseconds) => new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  })
});
