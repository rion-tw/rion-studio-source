import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import {
  assertDarwinExclusiveBundleProcessTreeGone,
  buildDarwinPackagedProcessInventory,
  createDarwinExclusiveBundleProcessContainment,
  terminateDarwinExclusiveBundleProcessContainment,
  waitForDarwinExclusiveBundleProcessAdmission
} from "./packagedElectronDarwinProcessOwnership.mjs";

const APPLICATION_NAME = "Rion Studio.app";
const EXECUTABLE_NAME = "Rion Studio";
const SUPERVISOR_STATES = new WeakMap();
const COMPLETION_EVIDENCE = new WeakSet();
export const ELECTRON_UPDATER_DARWIN_ISOLATION_EVIDENCE_KIND =
  "rion-electron-updater-darwin-supervisor-isolation";

export const buildElectronUpdaterDarwinProcessInventory =
  buildDarwinPackagedProcessInventory;

export async function createElectronUpdaterDarwinProcessSupervisor(
  input,
  operations
) {
  if (input?.platform !== "darwin") {
    throw new Error("The Electron updater Darwin supervisor requires macOS.");
  }
  const runtimeRoot = requiredCanonicalPath(input?.runtimeRoot, "runtime root");
  const applicationPath = requiredCanonicalPath(
    input?.applicationPath,
    "application"
  );
  const inventoryExecutablePath = requiredCanonicalPath(
    input?.inventoryExecutablePath,
    "process inventory"
  );
  if (
    basename(applicationPath) !== APPLICATION_NAME ||
    !isStrictlyInside(runtimeRoot, applicationPath)
  ) {
    throw new Error(
      "The Electron updater application must be the fixed app inside its runtime root."
    );
  }
  const mainExecutablePath = join(
    applicationPath,
    "Contents",
    "MacOS",
    EXECUTABLE_NAME
  );
  const paths = Object.freeze({
    application: await captureRealDirectoryIdentity(
      applicationPath,
      "application"
    ),
    contents: await captureRealDirectoryIdentity(
      join(applicationPath, "Contents"),
      "application Contents"
    ),
    executableDirectory: await captureRealDirectoryIdentity(
      join(applicationPath, "Contents", "MacOS"),
      "application executable directory"
    ),
    inventoryExecutable: await captureRealExecutableIdentity(
      inventoryExecutablePath,
      "process inventory",
      16 * 1024 * 1024
    ),
    mainExecutable: await captureRealExecutableIdentity(
      mainExecutablePath,
      "application executable",
      1024 * 1024 * 1024
    ),
    runtimeRoot: await captureRealDirectoryIdentity(
      runtimeRoot,
      "runtime root"
    )
  });
  const containment = createDarwinExclusiveBundleProcessContainment({
    bundleRoot: applicationPath,
    inventoryExecutablePath,
    processId: input?.helperProcessId,
    spawnedAtMilliseconds: input?.launchedAfterMilliseconds
  }, operations);
  const supervisor = Object.freeze({
    applicationPath,
    helperProcessId: containment.processId,
    inventoryExecutablePath,
    launchedAfterMilliseconds: containment.spawnedAtMilliseconds,
    mainExecutablePath,
    runtimeRoot
  });
  SUPERVISOR_STATES.set(supervisor, {
    admissionPromise: undefined,
    completionPromise: undefined,
    containment,
    paths,
    terminationPromise: undefined
  });
  return supervisor;
}

export function waitForElectronUpdaterDarwinProcessSupervisorAdmission(
  supervisor,
  deadlineMilliseconds
) {
  const state = requireSupervisor(supervisor);
  if (!state.admissionPromise) {
    state.admissionPromise = (async () => {
      await revalidateSupervisorPaths(state.paths);
      const identity = await waitForDarwinExclusiveBundleProcessAdmission(
        state.containment,
        supervisor.mainExecutablePath,
        deadlineMilliseconds
      );
      await revalidateSupervisorPaths(state.paths);
      return identity;
    })();
    void state.admissionPromise.catch(() => undefined);
  }
  return state.admissionPromise;
}

export function terminateElectronUpdaterDarwinProcessSupervisor(
  supervisor,
  deadlineMilliseconds
) {
  const state = requireSupervisor(supervisor);
  if (!state.terminationPromise) {
    state.terminationPromise = (async () => {
      await terminateDarwinExclusiveBundleProcessContainment(
        state.containment,
        deadlineMilliseconds
      );
      await assertDarwinExclusiveBundleProcessTreeGone(
        state.containment,
        deadlineMilliseconds
      );
      await revalidateSupervisorPaths(state.paths);
    })();
    void state.terminationPromise.catch(() => undefined);
  }
  return state.terminationPromise;
}

export async function assertElectronUpdaterDarwinProcessTreeGone(
  supervisor,
  deadlineMilliseconds
) {
  const state = requireSupervisor(supervisor);
  await assertDarwinExclusiveBundleProcessTreeGone(
    state.containment,
    deadlineMilliseconds
  );
  await revalidateSupervisorPaths(state.paths);
}

export function completeElectronUpdaterDarwinProcessIsolationEvidence(
  supervisor
) {
  const state = requireSupervisor(supervisor);
  if (!state.admissionPromise || !state.terminationPromise) {
    throw new Error(
      "Darwin isolation evidence requires exact admission and termination."
    );
  }
  if (!state.completionPromise) {
    state.completionPromise = (async () => {
      const [admittedIdentity] = await Promise.all([
        state.admissionPromise,
        state.terminationPromise
      ]);
      await assertDarwinExclusiveBundleProcessTreeGone(state.containment);
      await revalidateSupervisorPaths(state.paths);
      const evidence = Object.freeze({
        admittedIdentity: Object.freeze({ ...admittedIdentity }),
        applicationPath: supervisor.applicationPath,
        bundleRoot: state.containment.bundleRoot,
        helperProcessId: supervisor.helperProcessId,
        inventoryExecutablePath: supervisor.inventoryExecutablePath,
        kind: ELECTRON_UPDATER_DARWIN_ISOLATION_EVIDENCE_KIND,
        launchedAfterMilliseconds: supervisor.launchedAfterMilliseconds,
        mainExecutablePath: supervisor.mainExecutablePath,
        outcome: "active-zero"
      });
      COMPLETION_EVIDENCE.add(evidence);
      return evidence;
    })();
    void state.completionPromise.catch(() => undefined);
  }
  return state.completionPromise;
}

export function requireElectronUpdaterDarwinProcessIsolationEvidence(value) {
  if (
    !value || typeof value !== "object" ||
    !COMPLETION_EVIDENCE.has(value)
  ) {
    throw new Error(
      "Darwin isolation evidence requires a supervisor-issued capability."
    );
  }
  return value;
}

function requireSupervisor(value) {
  const state = value && typeof value === "object"
    ? SUPERVISOR_STATES.get(value)
    : undefined;
  if (!state) {
    throw new Error(
      "The Electron updater Darwin supervisor was not factory-issued."
    );
  }
  return state;
}

async function revalidateSupervisorPaths(paths) {
  for (const identity of Object.values(paths)) {
    const observed = identity.kind === "directory"
      ? await captureRealDirectoryIdentity(identity.path, identity.label)
      : await captureRealExecutableIdentity(
          identity.path,
          identity.label,
          identity.maximumBytes
        );
    if (
      observed.device !== identity.device ||
      observed.inode !== identity.inode ||
      observed.mode !== identity.mode ||
      observed.links !== identity.links ||
      observed.size !== identity.size
    ) {
      throw new Error(
        `The Electron updater ${identity.label} identity changed during supervision.`
      );
    }
  }
}

async function captureRealDirectoryIdentity(path, label) {
  const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    canonical !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`The Electron updater ${label} must be a real directory.`);
  }
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    kind: "directory",
    label,
    links: metadata.nlink,
    mode: metadata.mode,
    path,
    size: undefined
  });
}

async function captureRealExecutableIdentity(path, label, maximumBytes) {
  const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (
    canonical !== path ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes ||
    (metadata.mode & 0o111) === 0
  ) {
    throw new Error(
      `The Electron updater ${label} must be a bounded real single-link executable.`
    );
  }
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    kind: "executable",
    label,
    links: metadata.nlink,
    maximumBytes,
    mode: metadata.mode,
    path,
    size: metadata.size
  });
}

function requiredCanonicalPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(
      `The Electron updater ${label} path must be canonical and absolute.`
    );
  }
  return value;
}

function isStrictlyInside(root, candidate) {
  const child = relative(root, candidate);
  return child.length > 0 && child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child);
}
