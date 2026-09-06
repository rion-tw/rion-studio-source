import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  watch,
  writeFile
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep
} from "node:path";
import process from "node:process";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { extractFile } from "@electron/asar";

import { createUpdaterManifest } from "./createUpdaterManifest.mjs";
import {
  ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME,
  writeElectronUpdaterDarwinProcessIsolationResult
} from "./electronUpdaterDarwinIsolationResultContract.mjs";
import { normalizeUpdaterPublicKey } from "./electronProductionCandidate.mjs";
import { runElectronUpdaterDarwinHelperProbe } from
  "./electronUpdaterDarwinHelperProbe.mjs";
import {
  ELECTRON_UPDATER_MACOS_BUNDLE_PROBE_RESULT_NAME,
  readElectronUpdaterMacosBundleProbeResult
} from "./electronUpdaterMacosProbeResultContract.mjs";
import { writeElectronUpdaterCompatibilityProvisionalReceipt } from
  "./electronUpdaterCompatibilityProvisionalReceipt.mjs";
import { readElectronUpdaterPreparedProbeInput } from
  "./electronUpdaterPreparedProbeInput.mjs";
import { createUpdaterProbeRuntimeEnvironment } from
  "./runtimeEnvironmentPolicy.mjs";
import { signUpdaterArtifact } from "./updaterSignerEnvironment.mjs";
import { resolveVerifiedWindowsProfileIsolation } from
  "./windowsIsolatedProfile.mjs";

const execFileAsync = promisify(execFile);
const EXTERNAL_ACK_DEADLINE_MS = 120_000;

export async function runElectronUpdaterTransactionProbe(
  argumentsList,
  environment = process.env
) {
  assertSupportedProbeEnvironment(environment);
  const options = parseArguments(argumentsList);
  const artifact = requiredAbsolutePath(options.get("artifact"), "--artifact");
  const application = process.platform === "darwin"
    ? requiredAbsolutePath(options.get("app"), "--app")
    : null;
  const fixtureRoot = requiredAbsolutePath(
    environment.RION_UPDATER_CI_FIXTURE_ROOT,
    "RION_UPDATER_CI_FIXTURE_ROOT"
  );
  const updaterTrust = requiredUpdaterTrust(
    environment.RION_STUDIO_UPDATER_PUBLIC_KEY,
    "RION_STUDIO_UPDATER_PUBLIC_KEY"
  );
  const publicKey = updaterTrust.canonicalBase64;
  const compatibilityEvidence = await readCompatibilityEvidence(
    options,
    updaterTrust.sha256,
    process.platform,
    fixtureRoot
  );
  const windowsProfile = process.platform === "win32"
    ? resolveVerifiedWindowsProfileIsolation(environment)
    : null;
  const version = requiredSemanticVersion(
    environment.RION_STUDIO_ELECTRON_PACKAGE_VERSION,
    "RION_STUDIO_ELECTRON_PACKAGE_VERSION"
  );
  if (compatibilityEvidence) {
    requiredHttpsManifestEndpoint(
      environment.RION_STUDIO_UPDATER_ENDPOINT,
      "RION_STUDIO_UPDATER_ENDPOINT"
    );
  }
  const darwinIsolationBindings = requireDarwinIsolationBindings(
    options,
    process.platform,
    compatibilityEvidence !== null && process.platform === "darwin"
  );
  const preparedInputPath = options.get("prepared-input");
  if (compatibilityEvidence && !preparedInputPath) {
    throw new Error(
      "Production-trust compatibility probes require a separately prepared signed input."
    );
  }
  let companion;
  let manifest;
  let preparedInput;
  let preparedInputReadRequest;
  if (preparedInputPath) {
    const preparedInputRoot = requiredAbsolutePath(
      environment.RION_UPDATER_PREPARED_INPUT_ROOT,
      "RION_UPDATER_PREPARED_INPUT_ROOT"
    );
    if (preparedInputRoot === fixtureRoot) {
      throw new Error(
        "Prepared updater inputs must be separate from runtime outputs."
      );
    }
    preparedInputReadRequest = Object.freeze({
      architecture: process.arch,
      artifactPath: artifact,
      environment,
      fixtureRoot: preparedInputRoot,
      platform: process.platform,
      receiptPath: requiredAbsolutePath(
        preparedInputPath,
        "--prepared-input"
      ),
      version
    });
    preparedInput = await readElectronUpdaterPreparedProbeInput(
      preparedInputReadRequest
    );
    companion = preparedInput.companion;
    manifest = preparedInput.manifest;
  } else {
    let privateKeyPath = requiredAbsolutePath(
      environment.TAURI_SIGNING_PRIVATE_KEY_PATH,
      "TAURI_SIGNING_PRIVATE_KEY_PATH"
    );
    if (
      !privateKeyPath.startsWith(
        `${fixtureRoot}${process.platform === "win32" ? "\\" : "/"}`
      )
    ) {
      throw new Error(
        "The updater probe signing key must be inside its ephemeral CI fixture root."
      );
    }
    privateKeyPath = await assertPrivateKeyInsideFixtureRoot(
      fixtureRoot,
      privateKeyPath
    );
    const signingEnvironment = {
      ...environment,
      TAURI_SIGNING_PRIVATE_KEY_PATH: privateKeyPath
    };
    companion = join(
      fixtureRoot,
      process.platform === "darwin"
        ? "Rion.Studio-win.exe"
        : "Rion.Studio-mac.app.tar.gz"
    );
    await writeFile(companion, "signed foreign-platform fixture\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await signUpdaterArtifact({
      artifactPath: artifact,
      environment: signingEnvironment,
      workingDirectory: resolve(".")
    });
    await signUpdaterArtifact({
      artifactPath: companion,
      environment: signingEnvironment,
      workingDirectory: resolve(".")
    });
    await Promise.all([
      assertRegularNonempty(`${artifact}.sig`),
      assertRegularNonempty(`${companion}.sig`)
    ]);
    const macArtifact = process.platform === "darwin" ? artifact : companion;
    const windowsArtifact = process.platform === "win32" ? artifact : companion;
    manifest = join(fixtureRoot, `latest-${process.platform}.json`);
    await createUpdaterManifest([
      "--version", version,
      "--base-url", "https://updates.invalid/ci-fixture/",
      "--published-at", "2026-08-30T00:00:00Z",
      "--mac-archive", macArtifact,
      "--windows-installer", windowsArtifact,
      "--output", manifest
    ]);
    await assertRegularNonempty(manifest);
  }

  const probeOverrides = {
    RION_UPDATER_PROBE_APP: application ?? "",
    RION_UPDATER_PROBE_ARTIFACT: artifact,
    RION_UPDATER_PROBE_COMPANION: companion,
    RION_UPDATER_PROBE_MANIFEST: manifest,
    RION_UPDATER_PROBE_PLATFORM:
      process.platform === "darwin" ? "darwin-aarch64" : "windows-x86_64",
    RION_UPDATER_PROBE_PUBLIC_KEY: publicKey,
    RION_UPDATER_PROBE_VERSION: version
  };
  for (const name of [
    "RION_UPDATER_PREVIOUS_TAURI_V22_INSTALLER",
    "RION_UPDATER_PREVIOUS_TAURI_V22_VERSION",
    "RION_UPDATER_PREVIOUS_V23_INSTALLER",
    "RION_UPDATER_PREVIOUS_V23_VERSION",
    "RION_UPDATER_PROBE_PREVIOUS_APP",
    "RION_UPDATER_PROBE_PREVIOUS_VERSIONS"
  ]) {
    if (typeof environment[name] === "string") {
      probeOverrides[name] = environment[name];
    }
  }
  let runtimeSourceEnvironment = environment;
  if (process.platform === "darwin") {
    const runtimeHome = join(fixtureRoot, "runtime-home");
    const runtimeTemp = join(fixtureRoot, "runtime-temp");
    await Promise.all([
      ensurePrivateRuntimeDirectory(runtimeHome),
      ensurePrivateRuntimeDirectory(runtimeTemp)
    ]);
    runtimeSourceEnvironment = {
      ...environment,
      ...macosUpdaterProbeToolchainHomes(environment, homedir()),
      CFFIXED_USER_HOME: runtimeHome,
      HOME: runtimeHome,
      TEMP: runtimeTemp,
      TMP: runtimeTemp,
      TMPDIR: runtimeTemp
    };
  }
  const probeEnvironment = createUpdaterProbeRuntimeEnvironment(
    runtimeSourceEnvironment,
    probeOverrides
  );
  const cases = [{
    outcome: "applied",
    probe: "packaged-artifact-manifest-fail-closed",
    sourceRuntime: "electron-v23"
  }];
  await runCargoProbe(
    "package_probe::packaged_artifact_manifest_fail_closed_probe",
    probeEnvironment
  );
  if (process.platform === "darwin") {
    cases.push(...await runMacosProbe(
      probeEnvironment,
      fixtureRoot,
      darwinIsolationBindings
    ));
  } else {
    cases.push(...await runWindowsProbe(
      probeEnvironment,
      fixtureRoot,
      version,
      windowsProfile
    ));
  }
  let sealedPreparedInput = null;
  if (preparedInputReadRequest) {
    sealedPreparedInput = await readElectronUpdaterPreparedProbeInput(
      preparedInputReadRequest
    );
    if (
      !isDeepStrictEqual(preparedInput.receipt, sealedPreparedInput.receipt) ||
      !isDeepStrictEqual(
        preparedInput.receiptIdentity,
        sealedPreparedInput.receiptIdentity
      )
    ) {
      throw new Error(
        "The prepared updater input receipt changed while the runtime probe executed."
      );
    }
  }
  if (compatibilityEvidence) {
    assertSealedPreparedInputMatchesProbe(
      sealedPreparedInput,
      artifact,
      manifest
    );
  }
  const receipt = compatibilityEvidence
    ? (await writeElectronUpdaterCompatibilityProvisionalReceipt({
        cases,
        outputPath: compatibilityEvidence.outputPath,
        platform: process.platform
      })).receipt
    : null;
  return { artifact, manifest, platform: process.platform, receipt, version };
}

async function runMacosProbe(environment, fixtureRoot, isolationBindings) {
  const bundleResultPath = join(
    fixtureRoot,
    ELECTRON_UPDATER_MACOS_BUNDLE_PROBE_RESULT_NAME
  );
  await runCargoProbe(
    "platform_install::macos::tests::packaged_macos_updater_transaction_probe",
    {
      ...environment,
      RION_UPDATER_PROBE_TRANSACTION_RESULT: bundleResultPath
    }
  );
  const bundleResult = await readElectronUpdaterMacosBundleProbeResult({
    fixtureRoot,
    resultPath: bundleResultPath
  });
  const helper = await runElectronUpdaterDarwinHelperProbe({
    environment,
    fixtureRoot,
    platform: "darwin",
    workingDirectory: resolve(".")
  });
  if (isolationBindings) {
    await writeElectronUpdaterDarwinProcessIsolationResult({
      ...isolationBindings,
      cargoProcessGroupId: helper.cargoProcessGroupId,
      cargoProcessGroupOutcome: helper.cargoProcessGroupOutcome,
      childOutputRoot: fixtureRoot,
      childSandbox: helper.childSandbox,
      cleanupVerified: true,
      helperAttemptId: helper.attemptId,
      isolationEvidence: helper.isolationEvidence,
      outputPath: join(
        fixtureRoot,
        ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME
      )
    });
  }
  if (
    helper.sourceVersion !== bundleResult.cases[0].sourceVersion ||
    !bundleResult.cases.every(
      (entry) => entry.targetVersion === helper.targetVersion
    )
  ) {
    throw new Error(
      "The macOS helper source and target did not match the executed bundle cases."
    );
  }
  return [
    ...bundleResult.cases,
    {
      outcome: "applied",
      probe: "macos-helper-handoff-and-relaunch",
      sourceRuntime: helper.sourceRuntime,
      sourceVersion: helper.sourceVersion,
      targetVersion: helper.targetVersion
    }
  ];
}

async function runWindowsProbe(
  environment,
  fixtureRoot,
  targetVersion,
  profile
) {
  const cases = [];
  const evidenceCases = [];
  const tauriInstaller = environment.RION_UPDATER_PREVIOUS_TAURI_V22_INSTALLER;
  const tauriVersion = environment.RION_UPDATER_PREVIOUS_TAURI_V22_VERSION;
  if (tauriInstaller || tauriVersion) {
    cases.push(["tauri-v22", requiredAbsolutePath(
      tauriInstaller,
      "RION_UPDATER_PREVIOUS_TAURI_V22_INSTALLER"
    ), requiredSemanticVersion(
      tauriVersion,
      "RION_UPDATER_PREVIOUS_TAURI_V22_VERSION"
    )]);
  }
  cases.push(
    ["electron-v23", requiredAbsolutePath(
      environment.RION_UPDATER_PREVIOUS_V23_INSTALLER,
      "RION_UPDATER_PREVIOUS_V23_INSTALLER"
    ), requiredSemanticVersion(
      environment.RION_UPDATER_PREVIOUS_V23_VERSION,
      "RION_UPDATER_PREVIOUS_V23_VERSION"
    )]
  );
  for (const [sourceRuntime, previousInstaller, currentVersion] of cases) {
    const caseRoot = join(
      fixtureRoot,
      `windows-${sourceRuntime}-${currentVersion}-to-${targetVersion}`
    );
    const userData = profile.userDataDirectory;
    await Promise.all([
      mkdir(caseRoot, { recursive: true }),
      mkdir(userData, { recursive: true })
    ]);
    const caseEnvironment = environment;
    await execFileAsync(previousInstaller, ["/S"], {
      env: caseEnvironment,
      maxBuffer: 4 * 1024 * 1024,
      timeout: EXTERNAL_ACK_DEADLINE_MS,
      windowsHide: true
    });
    const previousExecutable = await findUniqueWindowsExecutable(
      profile.localAppDataDirectory,
      sourceRuntime === "tauri-v22" ? "rion-tauri.exe" : "Rion Studio.exe",
      caseEnvironment
    );
    const installDirectory = dirname(previousExecutable);
    const installedExecutable = join(installDirectory, "Rion Studio.exe");
    await assertRegularNonempty(previousExecutable);
    const marker = join(userData, `preserved-user-data-marker-${sourceRuntime}`);
    await writeFile(marker, "preserve", { flag: "wx", mode: 0o600 });
    const resultPath = join(caseRoot, "installer-handoff-pid");
    await runCargoProbe(
      "platform_install::windows::tests::packaged_windows_updater_transaction_probe",
      {
        ...caseEnvironment,
        RION_UPDATER_PROBE_CURRENT_VERSION: currentVersion,
        RION_UPDATER_PROBE_RESULT: resultPath,
        RION_UPDATER_PROBE_USER_DATA: userData
      }
    );
    const installerProcessId = Number((await readFile(resultPath, "utf8")).trim());
    if (!Number.isSafeInteger(installerProcessId) || installerProcessId <= 0) {
      throw new Error("The Windows updater handoff did not return an installer PID.");
    }
    await waitForWindowsProcess(installerProcessId, caseEnvironment);
    await assertRegularNonempty(installedExecutable);
    await assertWindowsUnsigned(installedExecutable, caseEnvironment);
    assertInstalledVersion(installDirectory, targetVersion);
    if (sourceRuntime === "tauri-v22") {
      await assertPathAbsent(previousExecutable);
    }
    const launched = spawn(installedExecutable, [], {
      env: caseEnvironment,
      stdio: "ignore",
      windowsHide: true
    });
    try {
      await waitForPathRemoval(
        join(userData, "app-update-install-journal.json"),
        EXTERNAL_ACK_DEADLINE_MS
      );
      await assertRegularNonempty(marker);
    } finally {
      await terminateWindowsProcessTree(launched.pid, caseEnvironment);
    }
    evidenceCases.push({
      outcome: "applied",
      probe: "windows-installed-layout-replacement-and-relaunch",
      sourceRuntime
    });
  }
  return evidenceCases;
}

async function findUniqueWindowsExecutable(root, name, environment) {
  const rootLiteral = root.replaceAll("'", "''");
  const nameLiteral = name.replaceAll("'", "''");
  const script = [
    `$matches = @(Get-ChildItem -LiteralPath '${rootLiteral}' -Filter '${nameLiteral}' -File -Recurse -Force -ErrorAction Stop)`,
    "if ($matches.Count -ne 1) { throw \"Expected exactly one installed source executable; found $($matches.Count).\" }",
    "[Console]::Out.Write($matches[0].FullName)"
  ].join("\n");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script
  ], {
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: EXTERNAL_ACK_DEADLINE_MS,
    windowsHide: true
  });
  return requiredAbsolutePath(stdout.trim(), `installed ${name}`);
}

async function assertPathAbsent(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`The previous runtime executable survived target installation: ${path}`);
}

async function runCargoProbe(testName, environment) {
  await execFileAsync("cargo", [
    "test", "--locked", "--offline", "-p", "rion-updater", "--lib", testName,
    "--", "--ignored", "--exact", "--nocapture"
  ], {
    cwd: resolve("."),
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
}

/** Pin build caches before HOME changes to the isolated application profile. */
export function macosUpdaterProbeToolchainHomes(environment, defaultHome) {
  const sourceHome = environment.HOME || defaultHome;
  if (typeof sourceHome !== "string" || !isAbsolute(sourceHome)) {
    throw new Error("The macOS updater probe requires an absolute source home.");
  }
  return {
    CARGO_HOME: environment.CARGO_HOME || join(sourceHome, ".cargo"),
    RUSTUP_HOME: environment.RUSTUP_HOME || join(sourceHome, ".rustup")
  };
}

async function ensurePrivateRuntimeDirectory(directoryPath) {
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directoryPath);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("The updater runtime home and temporary paths must be private directories.");
  }
}

async function waitForPathRemoval(path, deadlineMilliseconds) {
  try {
    await access(path);
  } catch {
    return;
  }
  const parent = resolve(path, "..");
  const expectedName = path.slice(parent.length + 1);
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), deadlineMilliseconds);
  try {
    for await (const event of watch(parent, { signal: abort.signal })) {
      if (event.filename && String(event.filename) !== expectedName) continue;
      try {
        await access(path);
      } catch {
        return;
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out waiting for updater acknowledgement: ${path}`, {
        cause: error
      });
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function waitForWindowsProcess(processId, environment) {
  const script = [
    `$process = Get-Process -Id ${processId} -ErrorAction SilentlyContinue`,
    "if ($process) { $process | Wait-Process -Timeout 120 -ErrorAction Stop }"
  ].join("; ");
  await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script
  ], {
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: EXTERNAL_ACK_DEADLINE_MS,
    windowsHide: true
  });
}

async function terminateWindowsProcessTree(processId, environment) {
  if (!Number.isSafeInteger(processId) || processId <= 1) {
    throw new Error("Refusing to terminate an invalid updater target process.");
  }
  const script = [
    `$root = Get-Process -Id ${processId} -ErrorAction SilentlyContinue`,
    "if ($root) {",
    `  & "$env:SystemRoot\\System32\\taskkill.exe" /PID ${processId} /T /F | Out-Null`,
    "  if ($LASTEXITCODE -ne 0) { throw 'Updater target process tree did not terminate.' }",
    "}",
    `$remaining = Get-Process -Id ${processId} -ErrorAction SilentlyContinue`,
    "if ($remaining) { throw 'Updater target root process survived termination.' }"
  ].join("\n");
  await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script
  ], {
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: EXTERNAL_ACK_DEADLINE_MS,
    windowsHide: true
  });
}

async function assertWindowsUnsigned(executable, environment) {
  const script = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${executable.replaceAll("'", "''")}'`,
    "if ($signature.Status -ne 'NotSigned') { throw 'Installed executable must be unsigned.' }"
  ].join("; ");
  await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script
  ], { env: environment, maxBuffer: 1024 * 1024, windowsHide: true });
}

function assertInstalledVersion(installDirectory, expectedVersion) {
  const packageJson = JSON.parse(extractFile(
    join(installDirectory, "resources", "app.asar"),
    "package.json",
    false
  ).toString("utf8"));
  if (packageJson.version !== expectedVersion) {
    throw new Error(
      `Installed Electron version ${String(packageJson.version)} did not match ${expectedVersion}.`
    );
  }
}

async function assertRegularNonempty(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) {
    throw new Error(`Expected a non-empty regular file: ${path}`);
  }
}

async function assertPrivateKeyInsideFixtureRoot(fixtureRoot, privateKeyPath) {
  const [fixtureMetadata, keyMetadata, realFixtureRoot, realPrivateKeyPath] =
    await Promise.all([
      lstat(fixtureRoot),
      lstat(privateKeyPath),
      realpath(fixtureRoot),
      realpath(privateKeyPath)
    ]);
  if (
    !fixtureMetadata.isDirectory() ||
    fixtureMetadata.isSymbolicLink() ||
    !keyMetadata.isFile() ||
    keyMetadata.isSymbolicLink() ||
    keyMetadata.size <= 0 ||
    keyMetadata.size > 1024 * 1024 ||
    keyMetadata.nlink !== 1
  ) {
    throw new Error(
      "The updater probe signing key must be a bounded real file in a real fixture root."
    );
  }
  const relative = relativePath(realFixtureRoot, realPrivateKeyPath);
  const comparison = process.platform === "win32"
    ? relative.toLowerCase()
    : relative;
  if (
    !comparison ||
    comparison === ".." ||
    comparison.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relative)
  ) {
    throw new Error(
      "The updater probe signing key resolved outside its ephemeral fixture root."
    );
  }
  return realPrivateKeyPath;
}

async function readCompatibilityEvidence(options, publicKeySha256, platform, fixtureRoot) {
  const names = ["input-receipt", "provisional-receipt", "target-sha"];
  const supplied = names.filter((name) => options.has(name));
  if (supplied.length === 0) return null;
  if (supplied.length !== names.length) {
    throw new Error(
      "--input-receipt, --provisional-receipt, and --target-sha must be supplied together."
    );
  }
  const inputReceiptPath = requiredAbsolutePath(
    options.get("input-receipt"),
    "--input-receipt"
  );
  const outputPath = requiredAbsolutePath(
    options.get("provisional-receipt"),
    "--provisional-receipt"
  );
  if (inputReceiptPath === outputPath) {
    throw new Error("The compatibility input and provisional receipt paths must differ.");
  }
  const outputRelative = relativePath(fixtureRoot, outputPath);
  if (
    !outputRelative || outputRelative === ".." ||
    outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)
  ) {
    throw new Error("The provisional compatibility receipt must stay inside the probe root.");
  }
  await assertBoundedRegularFile(inputReceiptPath, 1024 * 1024);
  let inputReceipt;
  try {
    inputReceipt = JSON.parse(await readFile(inputReceiptPath, "utf8"));
  } catch (error) {
    throw new Error("The Tauri v22 compatibility input receipt is invalid.", {
      cause: error
    });
  }
  const expectedPlatform = platform === "darwin"
    ? "darwin-aarch64"
    : "windows-x86_64";
  const expectedArtifactName = platform === "darwin"
    ? "Rion.Studio-mac.app.tar.gz"
    : "Rion.Studio-win.exe";
  const expectedSignatureName = `${expectedArtifactName}.sig`;
  const targetSha = requiredCommitSha(options.get("target-sha"), "--target-sha");
  if (
    inputReceipt?.schemaVersion !== 2 ||
    inputReceipt.evidenceKind !== "tauri-v22-published-input" ||
    inputReceipt.runtime !== "tauri-v22" ||
    inputReceipt.repository !== "rion-tw/rion-studio" ||
    inputReceipt.platform !== expectedPlatform ||
    inputReceipt.targetSha !== targetSha ||
    inputReceipt.updaterPublicKeySha256 !== publicKeySha256 ||
    !/^[0-9a-f]{40}$/u.test(inputReceipt.sourceSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(inputReceipt.artifactSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(inputReceipt.signatureSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(inputReceipt.manifestSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(inputReceipt.checksumSha256 ?? "") ||
    inputReceipt.artifactName !== expectedArtifactName ||
    inputReceipt.signatureName !== expectedSignatureName ||
    inputReceipt.manifestName !== "latest.json" ||
    inputReceipt.checksumName !== "SHA256SUMS.txt" ||
    !Number.isSafeInteger(inputReceipt.artifactBytes) ||
    inputReceipt.artifactBytes < 1 ||
    !/^v?[0-9][0-9A-Za-z._-]{0,63}$/u.test(inputReceipt.releaseTag ?? "") ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(
      inputReceipt.releaseVersion ?? ""
    )
  ) {
    throw new Error(
      "The Tauri v22 input receipt does not bind this target, platform, and updater trust root."
    );
  }
  const inputDirectory = dirname(inputReceiptPath);
  const sourcePaths = Object.freeze({
    artifact: join(inputDirectory, expectedArtifactName),
    checksum: join(inputDirectory, "SHA256SUMS.txt"),
    manifest: join(inputDirectory, "latest.json"),
    signature: join(inputDirectory, expectedSignatureName)
  });
  await Promise.all([
    assertBoundedRegularFile(sourcePaths.artifact, 1024 * 1024 * 1024),
    assertBoundedRegularFile(sourcePaths.signature, 64 * 1024),
    assertBoundedRegularFile(sourcePaths.manifest, 1024 * 1024),
    assertBoundedRegularFile(sourcePaths.checksum, 1024 * 1024)
  ]);
  const [artifactSha256, signatureSha256, manifestSha256, checksumSha256] =
    await Promise.all([
      hashFile(sourcePaths.artifact),
      hashFile(sourcePaths.signature),
      hashFile(sourcePaths.manifest),
      hashFile(sourcePaths.checksum)
    ]);
  if (
    artifactSha256 !== inputReceipt.artifactSha256 ||
    signatureSha256 !== inputReceipt.signatureSha256 ||
    manifestSha256 !== inputReceipt.manifestSha256 ||
    checksumSha256 !== inputReceipt.checksumSha256
  ) {
    throw new Error("The published Tauri v22 inputs changed after receipt verification.");
  }
  return Object.freeze({
    inputReceipt,
    inputReceiptPath,
    inputReceiptSha256: await hashFile(inputReceiptPath),
    outputPath,
    publicKeySha256,
    targetSha
  });
}

export async function verifyElectronUpdaterCompatibilityInput(input) {
  const updaterTrust = requiredUpdaterTrust(input.publicKey, "publicKey");
  if (input.platform !== "darwin" && input.platform !== "win32") {
    throw new Error("platform must be darwin or win32.");
  }
  const options = new Map([
    ["input-receipt", input.inputReceiptPath],
    ["provisional-receipt", input.outputPath],
    ["target-sha", input.targetSha]
  ]);
  await readCompatibilityEvidence(
    options,
    updaterTrust.sha256,
    input.platform,
    requiredAbsolutePath(input.fixtureRoot, "fixtureRoot")
  );
}

function assertSealedPreparedInputMatchesProbe(preparedInput, artifact, manifest) {
  if (!preparedInput) {
    throw new Error(
      "The compatibility observation requires a sealed prepared updater input."
    );
  }
  if (
    preparedInput.receipt.artifact.path !== artifact ||
    preparedInput.receipt.manifest.path !== manifest
  ) {
    throw new Error(
      "The sealed prepared updater input does not match the runtime probe target."
    );
  }
}

function requireDarwinIsolationBindings(options, platform, required) {
  const names = [
    "isolation-attempt-nonce",
    "isolation-command-invocation-sha256",
    "isolation-sandbox-profile-sha256"
  ];
  const supplied = names.filter((name) => options.has(name));
  if (!required) {
    if (supplied.length > 0) {
      throw new Error(
        "Darwin isolation bindings require a production compatibility probe."
      );
    }
    return null;
  }
  if (platform !== "darwin" || supplied.length !== names.length) {
    throw new Error([
      "macOS production compatibility probes require",
      "--isolation-attempt-nonce, --isolation-command-invocation-sha256,",
      "and --isolation-sandbox-profile-sha256 together."
    ].join(" "));
  }
  return Object.freeze({
    attemptNonce: requiredLowercaseHex(
      options.get("isolation-attempt-nonce"),
      32,
      "--isolation-attempt-nonce"
    ),
    commandInvocationSha256: requiredLowercaseHex(
      options.get("isolation-command-invocation-sha256"),
      64,
      "--isolation-command-invocation-sha256"
    ),
    sandboxProfileSha256: requiredLowercaseHex(
      options.get("isolation-sandbox-profile-sha256"),
      64,
      "--isolation-sandbox-profile-sha256"
    )
  });
}

function requiredLowercaseHex(value, length, label) {
  const normalized = requiredValue(value, label);
  if (!(new RegExp(`^[0-9a-f]{${length}}$`, "u")).test(normalized)) {
    throw new Error(`${label} must be ${length} lowercase hexadecimal characters.`);
  }
  return normalized;
}

async function assertBoundedRegularFile(path, maximumBytes) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.size <= 0 || metadata.size > maximumBytes
  ) {
    throw new Error(`Expected a bounded regular evidence file: ${path}`);
  }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const option = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!option?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid updater probe option near ${option ?? "<end>"}.`);
    }
    const name = option.slice(2);
    if (values.has(name)) throw new Error(`Duplicate updater probe option --${name}.`);
    values.set(name, value);
  }
  return values;
}

function assertSupportedProbeEnvironment(environment) {
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true") {
    throw new Error(
      "The packaged updater transaction probe is restricted to GitHub CI."
    );
  }
  if (
    !(
      (process.platform === "darwin" && process.arch === "arm64") ||
      (process.platform === "win32" && process.arch === "x64")
    )
  ) {
    throw new Error(
      "The packaged updater transaction probe requires macOS arm64 or Windows x64."
    );
  }
}

function requiredAbsolutePath(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function requiredValue(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function requiredUpdaterTrust(value, name) {
  try {
    return normalizeUpdaterPublicKey(value);
  } catch (error) {
    throw new Error(`${name} must contain one valid Minisign public key.`, {
      cause: error
    });
  }
}

function requiredSemanticVersion(value, name) {
  const normalized = requiredValue(value, name);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error(`${name} must be a semantic version.`);
  }
  return normalized;
}

function requiredCommitSha(value, name) {
  const normalized = requiredValue(value, name);
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(`${name} must be a lowercase 40-character commit SHA.`);
  }
  return normalized;
}

function requiredHttpsManifestEndpoint(value, name) {
  const normalized = requiredValue(value, name);
  let endpoint;
  try {
    endpoint = new URL(normalized);
  } catch (error) {
    throw new Error(`${name} must be one valid HTTPS latest.json URL.`, { cause: error });
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.pathname.endsWith("/latest.json")
  ) {
    throw new Error(`${name} must be one direct HTTPS latest.json URL.`);
  }
  return endpoint.href;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--") argumentsList.shift();
  const result = await runElectronUpdaterTransactionProbe(argumentsList);
  console.log(
    `Verified ${result.platform} packaged updater transaction for ${result.version}.`
  );
}
