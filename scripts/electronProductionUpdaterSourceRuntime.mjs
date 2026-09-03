import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  captureStableBoundedFileIdentity
} from "./electronProductionCandidateAssetBinding.mjs";
import { createUpdaterProbeRuntimeEnvironment } from "./runtimeEnvironmentPolicy.mjs";
import { extractSafeTarGzipSubtree } from "./safeTarGzipExtraction.mjs";
import {
  assertEqual,
  assertExactKeys,
  publicIdentity,
  readCanonicalJsonFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

const execFileAsync = promisify(execFile);

export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_KIND =
  "rion-electron-production-updater-source-runtime-preparation";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_KIND =
  "rion-electron-production-updater-source-runtime-launch";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_FILE =
  "source-runtime-preparation.json";
export const ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_FILE =
  "source-runtime-launch.json";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;
const PLATFORM_HOSTS = Object.freeze({
  "darwin-aarch64": "darwin",
  "windows-x86_64": "win32"
});
const TRANSITION_RUNTIMES = Object.freeze({
  "tauri-v22-to-electron-v23": "tauri-v22",
  "electron-v23-to-electron-v23": "electron-v23"
});

export async function prepareElectronProductionUpdaterSourceRuntime(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "artifactPath",
    "bindingsPath",
    "installRoot",
    "outputPath",
    "platform",
    "signal",
    "transitionKind",
    "userDataDirectory"
  ], "updater source-runtime preparation input");
  const dependencies = resolveDependencies(dependencyOverrides);
  const platform = requiredPlatform(input.platform);
  const transitionKind = requiredTransition(input.transitionKind);
  assertEqual(
    dependencies.hostPlatform,
    PLATFORM_HOSTS[platform],
    "updater source-runtime host platform"
  );
  const signal = requiredAbortSignal(input.signal);
  throwIfAborted(signal, "preparation");
  const bindingsPath = requiredAbsolutePath(
    input.bindingsPath,
    "updater evidence bundle bindings"
  );
  const bindingsFile = await readCanonicalJsonFile(
    bindingsPath,
    MAX_DOCUMENT_BYTES,
    "updater evidence bundle bindings"
  );
  const sourceBinding = assertSourceBinding(
    bindingsFile.value,
    transitionKind
  );
  const artifactPath = requiredAbsolutePath(
    input.artifactPath,
    "updater source artifact"
  );
  assertEqual(
    path.basename(artifactPath),
    sourceBinding.artifactName,
    "updater source artifact filename"
  );
  const installRoot = await resolveCreateNewDirectoryPath(
    input.installRoot,
    "updater source install root"
  );
  if (platform === "windows-x86_64" && /\s/u.test(installRoot)) {
    throw new Error("The Windows source install root must not contain whitespace.");
  }
  const userDataDirectory = await resolveCreateNewStandardUserDataDirectory(
    input.userDataDirectory,
    platform,
    dependencies.expectedUserDataDirectory
  );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_FILE,
    "updater source-runtime preparation receipt"
  );
  assertOutsideRoots(outputPath, [installRoot, userDataDirectory]);

  const artifactBefore = await dependencies.captureFile(
    artifactPath,
    MAX_ARTIFACT_BYTES,
    "updater source artifact"
  );
  assertEqual(
    artifactBefore.sha256,
    sourceBinding.artifactSha256,
    "updater source artifact SHA-256"
  );
  let installed = false;
  let userDataCreated = false;
  let outputWritten = false;
  try {
    throwIfAborted(signal, "preparation");
    await mkdir(userDataDirectory, { mode: 0o700 });
    userDataCreated = true;
    const installation = platform === "darwin-aarch64"
      ? await prepareDarwinSource({
          artifactPath,
          installRoot,
          runtime: sourceBinding.runtime,
          signal
        }, dependencies)
      : await prepareWindowsSource({
          artifactPath,
          installRoot,
          runtime: sourceBinding.runtime,
          signal
        }, dependencies);
    installed = true;
    throwIfAborted(signal, "preparation");
    const executable = await dependencies.captureFile(
      installation.executablePath,
      MAX_EXECUTABLE_BYTES,
      "installed updater source executable"
    );
    assertEqual(
      executable.sha256,
      sourceBinding.runningImageSha256,
      "installed updater source executable SHA-256"
    );
    const artifactAfter = await dependencies.captureFile(
      artifactPath,
      MAX_ARTIFACT_BYTES,
      "updater source artifact"
    );
    assertFileIdentityEqual(
      artifactBefore,
      artifactAfter,
      "updater source artifact"
    );
    const preparedAt = requiredNow(
      dependencies.now(),
      "source preparation time"
    ).toISOString();
    const receipt = assertPreparationReceipt({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_KIND,
      platform,
      transitionKind,
      bindingsSha256: bindingsFile.sha256,
      source: sourceBinding,
      artifact: {
        ...artifactAfter,
        fileName: path.basename(artifactPath)
      },
      installation: {
        applicationPath: installation.applicationPath,
        executablePath: installation.executablePath,
        installKind: installation.installKind,
        installRoot,
        userDataDirectory
      },
      runningImage: {
        ...executable,
        fileName: path.basename(installation.executablePath)
      },
      launchPolicy: {
        arguments: [],
        embeddedUpdaterEndpointOnly: true,
        privateUpdaterMaterialPresent: false,
        remoteDebugging: false,
        userDataOverrideUsed: false
      },
      preparedAt
    });
    await writeExclusive(outputPath, serializeCanonicalJson(receipt));
    outputWritten = true;
    const written = await readPreparationReceipt({ preparationPath: outputPath });
    return deepFreeze({
      ...written,
      installRoot,
      userDataDirectory
    });
  } catch (error) {
    if (outputWritten) await rm(outputPath, { force: true });
    if (installed || await pathExists(installRoot)) {
      await rm(installRoot, { force: true, recursive: true });
    }
    if (userDataCreated) {
      await rm(userDataDirectory, { force: true, recursive: true });
    }
    throw error;
  }
}

export async function launchElectronProductionUpdaterSourceRuntime(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "expectedPreparationSha256",
    "outputPath",
    "preparationPath",
    "signal"
  ], "updater source-runtime launch input");
  const dependencies = resolveDependencies(dependencyOverrides);
  const signal = requiredAbortSignal(input.signal);
  throwIfAborted(signal, "launch");
  const preparation = await readPreparationReceipt({
    expectedSha256: input.expectedPreparationSha256,
    preparationPath: input.preparationPath
  });
  assertEqual(
    dependencies.hostPlatform,
    PLATFORM_HOSTS[preparation.receipt.platform],
    "updater source-runtime launch host platform"
  );
  await requiredRealDirectory(
    preparation.receipt.installation.userDataDirectory,
    "updater source user-data directory"
  );
  const executable = await dependencies.captureFile(
    preparation.receipt.installation.executablePath,
    MAX_EXECUTABLE_BYTES,
    "prepared updater source executable"
  );
  assertFileIdentityEqual(
    preparation.receipt.runningImage,
    executable,
    "prepared updater source executable"
  );
  const outputPath = await resolveCreateNewFile(
    input.outputPath,
    ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_FILE,
    "updater source-runtime launch receipt"
  );
  assertOutsideRoots(outputPath, [
    preparation.receipt.installation.installRoot,
    preparation.receipt.installation.userDataDirectory
  ]);
  throwIfAborted(signal, "launch");
  const launchedAfterMilliseconds = requiredNow(
    dependencies.now(),
    "source launch fence"
  ).getTime();
  let child;
  let outputWritten = false;
  try {
    child = await dependencies.launchProcess({
      arguments: [],
      environment: dependencies.runtimeEnvironment(process.env),
      executablePath: preparation.receipt.installation.executablePath,
      signal
    });
    const processId = requiredProcessId(child.processId);
    const launchedAt = requiredNow(
      dependencies.now(),
      "source launch observation time"
    ).toISOString();
    if (Date.parse(launchedAt) < launchedAfterMilliseconds) {
      throw new Error("The source launch observation precedes its launch fence.");
    }
    const receipt = assertLaunchReceipt({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_KIND,
      platform: preparation.receipt.platform,
      transitionKind: preparation.receipt.transitionKind,
      preparationSha256: preparation.preparationIdentity.sha256,
      executablePath: preparation.receipt.installation.executablePath,
      arguments: [],
      launchedAfterMilliseconds,
      launchedAt,
      processId,
      remoteDebugging: false,
      userDataOverrideUsed: false
    });
    await writeExclusive(outputPath, serializeCanonicalJson(receipt));
    outputWritten = true;
    const file = await readCanonicalJsonFile(
      outputPath,
      MAX_DOCUMENT_BYTES,
      "updater source-runtime launch receipt"
    );
    assertLaunchReceipt(file.value);
    child.unref();
    return deepFreeze({
      launch: receipt,
      launchIdentity: publicIdentity(outputPath, file),
      launchPath: outputPath
    });
  } catch (error) {
    child?.terminate?.();
    if (outputWritten) await rm(outputPath, { force: true });
    throw error;
  }
}

async function readPreparationReceipt(input) {
  const expectedKeys = input.expectedSha256 === undefined
    ? ["preparationPath"]
    : ["expectedSha256", "preparationPath"];
  assertExactKeys(input, expectedKeys, "updater source-runtime preparation read input");
  const preparationPath = requiredAbsolutePath(
    input.preparationPath,
    "updater source-runtime preparation receipt"
  );
  assertEqual(
    path.basename(preparationPath),
    ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_FILE,
    "updater source-runtime preparation filename"
  );
  const file = await readCanonicalJsonFile(
    preparationPath,
    MAX_DOCUMENT_BYTES,
    "updater source-runtime preparation receipt"
  );
  if (input.expectedSha256 !== undefined) {
    assertEqual(
      file.sha256,
      requiredDigest(input.expectedSha256, "source preparation SHA-256"),
      "source preparation SHA-256"
    );
  }
  return deepFreeze({
    receipt: assertPreparationReceipt(file.value),
    preparationIdentity: publicIdentity(preparationPath, file),
    preparationPath
  });
}

function assertPreparationReceipt(value) {
  assertExactKeys(value, [
    "artifact", "bindingsSha256", "installation", "kind", "launchPolicy",
    "platform", "preparedAt", "runningImage", "schemaVersion", "source",
    "transitionKind"
  ], "updater source-runtime preparation receipt");
  assertEqual(value.schemaVersion, 1, "source preparation schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_PREPARATION_KIND,
    "source preparation kind");
  const platform = requiredPlatform(value.platform);
  const transitionKind = requiredTransition(value.transitionKind);
  const source = assertStandaloneSourceBinding(value.source, transitionKind);
  const artifact = assertFileIdentity(value.artifact, "source artifact identity");
  assertEqual(artifact.fileName, source.artifactName, "source artifact filename");
  assertEqual(artifact.sha256, source.artifactSha256, "source artifact SHA-256");
  const runningImage = assertFileIdentity(
    value.runningImage,
    "source running-image identity"
  );
  assertEqual(runningImage.sha256, source.runningImageSha256,
    "source running-image SHA-256");
  const installation = assertInstallation(value.installation, platform, source.runtime);
  assertEqual(runningImage.fileName, path.basename(installation.executablePath),
    "source running-image filename");
  assertExactKeys(value.launchPolicy, [
    "arguments", "embeddedUpdaterEndpointOnly", "privateUpdaterMaterialPresent",
    "remoteDebugging", "userDataOverrideUsed"
  ], "source launch policy");
  if (!Array.isArray(value.launchPolicy.arguments) ||
      value.launchPolicy.arguments.length !== 0 ||
      value.launchPolicy.embeddedUpdaterEndpointOnly !== true ||
      value.launchPolicy.privateUpdaterMaterialPresent !== false ||
      value.launchPolicy.remoteDebugging !== false ||
      value.launchPolicy.userDataOverrideUsed !== false) {
    throw new Error("The updater source launch policy is unsafe.");
  }
  return deepFreeze({
    ...value,
    bindingsSha256: requiredDigest(value.bindingsSha256, "source bindings SHA-256"),
    installation,
    platform,
    preparedAt: requiredRfc3339(value.preparedAt, "source preparation time"),
    runningImage,
    source,
    transitionKind
  });
}

function assertLaunchReceipt(value) {
  assertExactKeys(value, [
    "arguments", "executablePath", "kind", "launchedAfterMilliseconds",
    "launchedAt", "platform", "preparationSha256", "processId",
    "remoteDebugging", "schemaVersion", "transitionKind", "userDataOverrideUsed"
  ], "updater source-runtime launch receipt");
  assertEqual(value.schemaVersion, 1, "source launch schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_UPDATER_SOURCE_RUNTIME_LAUNCH_KIND,
    "source launch kind");
  if (!Array.isArray(value.arguments) || value.arguments.length !== 0 ||
      value.remoteDebugging !== false || value.userDataOverrideUsed !== false) {
    throw new Error("The updater source launch receipt contains an unsafe launch.");
  }
  const launchedAfterMilliseconds = requiredPositiveInteger(
    value.launchedAfterMilliseconds,
    "source launch fence"
  );
  const launchedAt = requiredRfc3339(value.launchedAt, "source launch time");
  if (Date.parse(launchedAt) < launchedAfterMilliseconds) {
    throw new Error("The source launch time precedes its launch fence.");
  }
  return deepFreeze({
    ...value,
    executablePath: requiredAbsolutePath(value.executablePath, "source executable"),
    launchedAfterMilliseconds,
    launchedAt,
    platform: requiredPlatform(value.platform),
    preparationSha256: requiredDigest(value.preparationSha256,
      "source preparation SHA-256"),
    processId: requiredProcessId(value.processId),
    transitionKind: requiredTransition(value.transitionKind)
  });
}

function assertSourceBinding(value, transitionKind) {
  assertExactKeys(value, ["provenance", "sourceBinding", "targetBinding"],
    "updater evidence bundle bindings");
  return assertStandaloneSourceBinding(value.sourceBinding, transitionKind);
}

function assertStandaloneSourceBinding(value, transitionKind) {
  const isTauri = transitionKind === "tauri-v22-to-electron-v23";
  assertExactKeys(value, [
    "artifactName", "artifactSha256",
    ...(isTauri ? [] : ["candidateReceiptSha256"]),
    ...(isTauri ? ["defaultUpdaterEndpoint"] : ["embeddedUpdaterEndpoint"]),
    "lineageKind", "manifestName", "manifestSha256",
    ...(isTauri ? ["releaseTag"] : []),
    "runningImageSha256", "runtime", "sourceSha", "version"
  ], "updater source binding");
  const runtime = TRANSITION_RUNTIMES[transitionKind];
  assertEqual(value.runtime, runtime, "updater source runtime");
  assertEqual(value.lineageKind,
    isTauri ? "published-release" : "production-candidate",
    "updater source lineage kind");
  assertEqual(value.manifestName, "latest.json", "updater source manifest name");
  const version = requiredSemanticVersion(value.version, "updater source version");
  if (isTauri) {
    assertEqual(value.releaseTag, `v${version}`, "updater source release tag");
    assertEqual(value.defaultUpdaterEndpoint,
      "https://github.com/rion-tw/rion-studio/releases/latest/download/latest.json",
      "Tauri source updater endpoint");
  } else {
    requiredDigest(value.candidateReceiptSha256,
      "source candidate receipt SHA-256");
    requiredHttpsLatestEndpoint(value.embeddedUpdaterEndpoint,
      "source embedded updater endpoint");
  }
  return deepFreeze({
    ...value,
    artifactName: requiredFileName(value.artifactName, "source artifact name"),
    artifactSha256: requiredDigest(value.artifactSha256,
      "source artifact SHA-256"),
    manifestSha256: requiredDigest(value.manifestSha256,
      "source manifest SHA-256"),
    runningImageSha256: requiredDigest(value.runningImageSha256,
      "source running-image SHA-256"),
    sourceSha: requiredCommitSha(value.sourceSha, "updater source SHA"),
    version
  });
}

async function prepareDarwinSource(input, dependencies) {
  await mkdir(input.installRoot, { mode: 0o700 });
  const applicationPath = path.join(input.installRoot, "Rion Studio.app");
  const extraction = await dependencies.extractDarwin({
    archivePath: input.artifactPath,
    archiveRoot: "Rion Studio.app",
    destinationPath: applicationPath
  });
  assertEqual(extraction.destinationPath, applicationPath,
    "Darwin source application path");
  const executableName = input.runtime === "tauri-v22"
    ? "rion-tauri"
    : "Rion Studio";
  return Object.freeze({
    applicationPath,
    executablePath: path.join(
      applicationPath,
      "Contents",
      "MacOS",
      executableName
    ),
    installKind: "safe-tar-extraction"
  });
}

async function prepareWindowsSource(input, dependencies) {
  const result = await dependencies.installWindows(input);
  assertExactKeys(result, ["applicationPath", "executablePath", "installKind"],
    "Windows source installation result");
  assertEqual(result.applicationPath, input.installRoot,
    "Windows source application path");
  assertEqual(result.executablePath, path.join(
    input.installRoot,
    input.runtime === "tauri-v22" ? "rion-tauri.exe" : "Rion Studio.exe"
  ), "Windows source executable path");
  assertEqual(result.installKind, "silent-current-user-nsis",
    "Windows source install kind");
  await assertWindowsTreeHasNoLinks(input.installRoot);
  return Object.freeze({ ...result });
}

async function defaultInstallWindows(input) {
  if (process.platform !== "win32") {
    throw new Error("Windows source installation requires a Windows host.");
  }
  try {
    await execFileAsync(input.artifactPath, [
      "/S",
      ...(input.runtime === "electron-v23" ? ["/currentuser"] : []),
      `/D=${input.installRoot}`
    ], {
      encoding: "utf8",
      env: createUpdaterProbeRuntimeEnvironment(process.env),
      maxBuffer: MAX_DOCUMENT_BYTES,
      signal: input.signal,
      windowsHide: true
    });
  } catch {
    if (input.signal.aborted) throw cancelled(input.signal.reason, "preparation");
    throw new Error("The exact source NSIS installation failed.");
  }
  return Object.freeze({
    applicationPath: input.installRoot,
    executablePath: path.join(
      input.installRoot,
      input.runtime === "tauri-v22" ? "rion-tauri.exe" : "Rion Studio.exe"
    ),
    installKind: "silent-current-user-nsis"
  });
}

function defaultLaunchProcess(input) {
  if (input.arguments.length !== 0) {
    throw new Error("The source runtime must launch without command-line overrides.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(input.executablePath, [], {
      cwd: path.dirname(input.executablePath),
      detached: false,
      env: input.environment,
      signal: input.signal,
      stdio: "ignore",
      windowsHide: false
    });
    child.once("error", reject);
    child.once("spawn", () => resolve(Object.freeze({
      processId: child.pid,
      terminate: () => child.kill(),
      unref: () => child.unref()
    })));
  });
}

async function resolveCreateNewDirectoryPath(value, label) {
  const requested = requiredAbsolutePath(value, label);
  const parent = await requiredRealDirectory(path.dirname(requested), `${label} parent`);
  const resolved = path.join(parent, path.basename(requested));
  if (await pathExists(resolved)) throw new Error(`The ${label} must be create-new.`);
  return resolved;
}

async function resolveCreateNewStandardUserDataDirectory(
  value,
  platform,
  expectedUserDataDirectory
) {
  const requested = requiredAbsolutePath(value, "updater source user-data directory");
  const expected = requiredAbsolutePath(
    expectedUserDataDirectory(platform),
    "standard updater source user-data directory"
  );
  assertEqual(requested, expected, "standard updater source user-data directory");
  await requiredRealDirectory(path.dirname(requested),
    "standard updater source user-data parent");
  if (await pathExists(requested)) {
    throw new Error("The updater source user-data directory must be create-new.");
  }
  return requested;
}

function defaultExpectedUserDataDirectory(platform) {
  if (platform === "darwin-aarch64") {
    if (typeof process.env.HOME !== "string" || !path.isAbsolute(process.env.HOME)) {
      throw new Error("The macOS runner HOME is unavailable.");
    }
    return path.join(process.env.HOME, "Library", "Application Support", "Rion Studio");
  }
  if (typeof process.env.APPDATA !== "string" || !path.isAbsolute(process.env.APPDATA)) {
    throw new Error("The Windows runner APPDATA is unavailable.");
  }
  return path.join(process.env.APPDATA, "Rion Studio");
}

async function requiredRealDirectory(value, label) {
  const requested = requiredAbsolutePath(value, label);
  const canonical = await realpath(requested);
  const metadata = await lstat(canonical, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  return canonical;
}

async function assertWindowsTreeHasNoLinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const metadata = await lstat(current, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw new Error("The Windows source installation contains a reparse link.");
    }
    if (!metadata.isDirectory()) continue;
    for (const name of await readdir(current)) pending.push(path.join(current, name));
  }
}

function assertInstallation(value, platform, runtime) {
  assertExactKeys(value, [
    "applicationPath", "executablePath", "installKind", "installRoot",
    "userDataDirectory"
  ], "updater source installation");
  const installRoot = requiredAbsolutePath(value.installRoot, "source install root");
  const applicationPath = requiredAbsolutePath(
    value.applicationPath,
    "source application"
  );
  const executablePath = requiredAbsolutePath(
    value.executablePath,
    "source executable"
  );
  const expectedApplication = platform === "darwin-aarch64"
    ? path.join(installRoot, "Rion Studio.app")
    : installRoot;
  assertEqual(applicationPath, expectedApplication, "source application path");
  const expectedExecutable = platform === "darwin-aarch64"
    ? path.join(applicationPath, "Contents", "MacOS",
      runtime === "tauri-v22" ? "rion-tauri" : "Rion Studio")
    : path.join(applicationPath,
      runtime === "tauri-v22" ? "rion-tauri.exe" : "Rion Studio.exe");
  assertEqual(executablePath, expectedExecutable, "source executable path");
  assertEqual(value.installKind,
    platform === "darwin-aarch64"
      ? "safe-tar-extraction"
      : "silent-current-user-nsis",
    "source install kind");
  return Object.freeze({
    applicationPath,
    executablePath,
    installKind: value.installKind,
    installRoot,
    userDataDirectory: requiredAbsolutePath(
      value.userDataDirectory,
      "source user-data directory"
    )
  });
}

function assertFileIdentity(value, label) {
  assertExactKeys(value, ["bytes", "fileName", "sha256"], label);
  return Object.freeze({
    bytes: requiredPositiveInteger(value.bytes, `${label} byte count`),
    fileName: requiredFileName(value.fileName, `${label} filename`),
    sha256: requiredDigest(value.sha256, `${label} SHA-256`)
  });
}

function assertFileIdentityEqual(expected, observed, label) {
  assertEqual(observed.bytes, expected.bytes, `${label} byte count`);
  assertEqual(observed.sha256, expected.sha256, `${label} SHA-256`);
}

function assertOutsideRoots(filePath, roots) {
  for (const root of roots) {
    const relation = path.relative(root, filePath);
    if (relation === "" || (!relation.startsWith(`..${path.sep}`) &&
        relation !== ".." && !path.isAbsolute(relation))) {
      throw new Error("The source-runtime receipt must remain outside runtime roots.");
    }
  }
}

function requiredPlatform(value) {
  if (!Object.hasOwn(PLATFORM_HOSTS, value ?? "")) {
    throw new Error("The updater source platform is invalid.");
  }
  return value;
}

function requiredTransition(value) {
  if (!Object.hasOwn(TRANSITION_RUNTIMES, value ?? "")) {
    throw new Error("The updater source transition is invalid.");
  }
  return value;
}

function requiredHttpsLatestEndpoint(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`The ${label} is invalid.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash || !url.pathname.endsWith("/latest.json")) {
    throw new Error(`The ${label} is invalid.`);
  }
  return url.href;
}

function requiredFileName(value, label) {
  if (typeof value !== "string" || value.length === 0 ||
      path.basename(value) !== value || value === "." || value === "..") {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function requiredProcessId(value) {
  return requiredPositiveInteger(value, "source process ID");
}

function requiredAbortSignal(value) {
  if (!value || typeof value !== "object" || typeof value.aborted !== "boolean" ||
      typeof value.addEventListener !== "function") {
    throw new Error("The updater source runtime requires an AbortSignal.");
  }
  return value;
}

function requiredNow(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`The ${label} must be a valid Date.`);
  }
  return value;
}

function resolveDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Updater source-runtime dependencies must be an object.");
  }
  const allowed = new Set([
    "captureFile", "expectedUserDataDirectory", "extractDarwin", "hostPlatform",
    "installWindows", "launchProcess", "now", "runtimeEnvironment"
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown source-runtime dependency ${key}.`);
  }
  const result = {
    captureFile: value.captureFile ?? captureStableBoundedFileIdentity,
    expectedUserDataDirectory:
      value.expectedUserDataDirectory ?? defaultExpectedUserDataDirectory,
    extractDarwin: value.extractDarwin ?? extractSafeTarGzipSubtree,
    hostPlatform: value.hostPlatform ?? process.platform,
    installWindows: value.installWindows ?? defaultInstallWindows,
    launchProcess: value.launchProcess ?? defaultLaunchProcess,
    now: value.now ?? (() => new Date()),
    runtimeEnvironment:
      value.runtimeEnvironment ?? createUpdaterProbeRuntimeEnvironment
  };
  for (const [name, entry] of Object.entries(result)) {
    if (name !== "hostPlatform" && typeof entry !== "function") {
      throw new Error(`The updater source-runtime dependency ${name} is invalid.`);
    }
  }
  return Object.freeze(result);
}

function throwIfAborted(signal, phase) {
  if (signal.aborted) throw cancelled(signal.reason, phase);
}

function cancelled(reason, phase) {
  const detail = reason instanceof Error ? ` (${reason.message})` : "";
  return new Error(`The updater source-runtime ${phase} was cancelled${detail}.`);
}

async function pathExists(value) {
  try { await lstat(value); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
