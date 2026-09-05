import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  resolveElectronPackageLayout,
  verifyPackagedElectron
} from "./verifyElectronPackage.mjs";
import {
  capturePackagedScreen,
  closePackagedRoleWindow,
  launchRoleThroughNativeInput,
  pressPackagedRoleContent,
  quitPackagedApplication,
  seedPackagedElectronRole
} from "./packagedElectronBlackBox.mjs";
import {
  PACKAGED_ELECTRON_BLACK_BOX_KIND,
  PACKAGED_ELECTRON_BLACK_BOX_SCREENSHOT_NAME,
  PACKAGED_ELECTRON_BLACK_BOX_SOURCE_REPORT_NAME,
  serializePackagedElectronBlackBoxReport
} from "./packagedElectronBlackBoxReportContract.mjs";
import { resolvePackagedElectronSmokeIsolation } from
  "./packagedElectronSmokeIsolation.mjs";
import { createPackagedElectronRuntimeEnvironment } from
  "./runtimeEnvironmentPolicy.mjs";
import { createDarwinPrivatePackagedElectronBundle } from
  "./packagedElectronDarwinPrivateBundle.mjs";
import {
  assertPackagedElectronPackageManifestUnchanged,
  capturePackagedElectronPackageManifest,
  summarizePackagedElectronPackageManifest
} from "./packagedElectronPackageManifest.mjs";
import {
  assertPackagedElectronProcessTreeGone,
  buildDarwinPackagedProcessInventory,
  createPackagedElectronProcessCleanupDeadline,
  createPackagedElectronPrivateBundleContainment,
  createPackagedElectronProcessOwner,
  packagedElectronSpawnOptions,
  packagedSmokeFailure,
  terminatePackagedElectronProcessTree,
  terminatePackagedElectronPrivateBundleContainment,
  waitForPackagedElectronProcessClose,
  waitForPackagedElectronProcessOwnership
} from "./packagedElectronProcessCleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const applicationPath = resolve(parseApplicationPath(process.argv.slice(2)));
if (process.platform !== "darwin" && process.platform !== "win32") {
  throw new Error("Packaged Electron smoke supports only macOS and Windows.");
}

const verifiedSource = await verifyPackagedElectron(applicationPath);
const sourceLayout = resolveElectronPackageLayout(applicationPath);
if (
  sourceLayout.executablePath !== verifiedSource.executablePath ||
  sourceLayout.resourcesPath !== verifiedSource.resourcesPath
) {
  throw new Error("Packaged Electron layout changed after verification.");
}
const runtimeTarget = process.platform === "darwin"
  ? "chromium-v23-macos-appkit"
  : "chromium-v23-windows";
const sourceAppAsarPath = join(sourceLayout.resourcesPath, "app.asar");
const sourceNativeAddonPath = join(
  sourceLayout.resourcesPath,
  "native",
  "rion-core.node"
);
const sourcePackageManifest = await capturePackagedElectronPackageManifest(
  applicationPath
);
const packageManifestSummary = summarizePackagedElectronPackageManifest(
  sourcePackageManifest
);
const packageHashes = await hashPackagedRuntime({
  appAsarPath: sourceAppAsarPath,
  executablePath: sourceLayout.executablePath,
  nativeAddonPath: sourceNativeAddonPath
});
const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
const artifactRoot = resolve(
  process.env.RION_STUDIO_E2E_ARTIFACT_ROOT ??
    resolve(repositoryRoot, ".desktop-e2e-artifacts")
);
await mkdir(artifactRoot, { recursive: true });
const artifactDirectory = resolve(
  artifactRoot,
  `${runId}-${randomUUID()}-${process.platform}-packaged-black-box`
);
await mkdir(artifactDirectory, { mode: 0o700 });
const isolation = resolvePackagedElectronSmokeIsolation(
  artifactDirectory,
  process.platform
);
await mkdir(isolation.userDataDirectory, { recursive: true });
const inventoryExecutablePath = process.platform === "darwin"
  ? await buildDarwinPackagedProcessInventory(join(artifactDirectory, "native-tools"))
  : undefined;

const fixtureButtonName = "Packaged Chromium interaction target";
const gameName = "Packaged Chromium Black Box";
const roleName = "Packaged Chromium Role";
const fixture = await startRoleFixture(fixtureButtonName);
let child;
let childOwner;
let childPrivateBundleContainment;
let stdout = "";
let stderr = "";
let nativeHostKind;
let privateBundle;
let processTreeTerminal = false;
try {
  if (process.platform === "darwin") {
    privateBundle = await createDarwinPrivatePackagedElectronBundle(applicationPath);
  }
  const executionApplicationPath = privateBundle?.applicationPath ?? applicationPath;
  const verifiedExecution = await verifyPackagedElectron(executionApplicationPath);
  const { executablePath, resourcesPath } = resolveElectronPackageLayout(
    executionApplicationPath
  );
  if (
    executablePath !== verifiedExecution.executablePath ||
    resourcesPath !== verifiedExecution.resourcesPath
  ) {
    throw new Error("The private packaged Electron layout changed after verification.");
  }
  const appAsarPath = join(resourcesPath, "app.asar");
  const nativeAddonPath = join(resourcesPath, "native", "rion-core.node");
  const executionPackageManifest =
    await capturePackagedElectronPackageManifest(executionApplicationPath);
  assertPackagedElectronPackageManifestUnchanged(
    sourcePackageManifest,
    executionPackageManifest
  );
  await assertPackagedRuntimeUnchanged(packageHashes, {
    appAsarPath,
    executablePath,
    nativeAddonPath
  });
  const seeded = await seedPackagedElectronRole({
    gameName,
    launchUrl: fixture.url,
    platform: process.platform,
    resourcesPath,
    roleName,
    userDataDirectory: isolation.userDataDirectory
  });
  const childEnvironment = createPackagedElectronRuntimeEnvironment({
    ...process.env,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8"
  }, {
    ...isolation.environment
  });
  const spawnedAtMilliseconds = Date.now();
  child = spawn(executablePath, ["--force-renderer-accessibility"], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    ...packagedElectronSpawnOptions(process.platform)
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  const spawned = waitForSpawn(child);
  if (process.platform === "darwin" && child.pid) {
    childPrivateBundleContainment =
      createPackagedElectronPrivateBundleContainment({
        child,
        inventoryExecutablePath,
        platform: "darwin",
        privateBundle,
        spawnedAtMilliseconds
      });
  }
  if (child.pid) {
    childOwner = createPackagedElectronProcessOwner({
      child,
      executablePath,
      inventoryExecutablePath,
      platform: process.platform,
      privateBundle,
      spawnedAtMilliseconds
    });
  }
  await spawned;
  childOwner ??= createPackagedElectronProcessOwner({
    child,
    executablePath,
    inventoryExecutablePath,
    platform: process.platform,
    privateBundle,
    spawnedAtMilliseconds
  });
  await waitForPackagedElectronProcessOwnership(childOwner);
  await launchRoleThroughNativeInput({
    platform: process.platform,
    processId: childOwner.processId,
    roleName
  });
  nativeHostKind = await pressPackagedRoleContent({
    buttonName: fixtureButtonName,
    platform: process.platform,
    processId: childOwner.processId,
    roleName
  });
  await fixture.clicked;
  const screenshot = await capturePackagedScreen({
    buttonName: fixtureButtonName,
    outputPath: join(
      artifactDirectory,
      PACKAGED_ELECTRON_BLACK_BOX_SCREENSHOT_NAME
    ),
    platform: process.platform,
    processId: childOwner.processId,
    roleName
  });
  await closePackagedRoleWindow({
    buttonName: fixtureButtonName,
    platform: process.platform,
    processId: childOwner.processId,
    roleName
  });
  await quitPackagedApplication({
    platform: process.platform,
    processId: childOwner.processId
  });
  const exit = await waitForPackagedElectronProcessClose(childOwner, 60_000);
  if (exit.code !== 0) {
    throw new Error(
      `Packaged Electron exited with ${exit.code ?? exit.signal ?? "unknown"}.`
    );
  }
  await assertPackagedElectronProcessTreeGone(childOwner);
  processTreeTerminal = true;
  assertPackagedElectronPackageManifestUnchanged(
    executionPackageManifest,
    await capturePackagedElectronPackageManifest(executionApplicationPath)
  );
  assertPackagedElectronPackageManifestUnchanged(
    sourcePackageManifest,
    await capturePackagedElectronPackageManifest(applicationPath)
  );
  await assertPackagedRuntimeUnchanged(packageHashes, {
    appAsarPath,
    executablePath,
    nativeAddonPath
  });
  await assertPackagedRuntimeUnchanged(packageHashes, {
    appAsarPath: sourceAppAsarPath,
    executablePath: sourceLayout.executablePath,
    nativeAddonPath: sourceNativeAddonPath
  });
  await verifyPackagedElectron(executionApplicationPath);
  await verifyPackagedElectron(applicationPath);
  await fixture.close();
  await Promise.all([
    writeFile(join(artifactDirectory, "packaged-stdout.log"), stdout, "utf8"),
    writeFile(join(artifactDirectory, "packaged-stderr.log"), stderr, "utf8")
  ]);
  await privateBundle?.cleanup();
  await writePassedReport(artifactDirectory, {
    schemaVersion: 1,
    kind: PACKAGED_ELECTRON_BLACK_BOX_KIND,
    verdict: "passed",
    appVersion: seeded.appVersion,
    application: {
      path: resolve(applicationPath)
    },
    executable: {
      path: sourceLayout.executablePath,
      sha256: packageHashes.executableSha256
    },
    appAsar: {
      path: sourceAppAsarPath,
      sha256: packageHashes.archiveSha256
    },
    nativeAddon: {
      path: sourceNativeAddonPath,
      sha256: packageHashes.addonSha256
    },
    exitCode: exit.code,
    fixtureInteraction: "visible-os-accessibility-click",
    gameId: seeded.gameId,
    isolationKind: isolation.isolationKind,
    nativeHostKind,
    packageManifest: packageManifestSummary,
    platform: process.platform,
    remoteDebugging: false,
    roleId: seeded.roleId,
    runtimeHomeDirectory: isolation.runtimeHomeDirectory,
    runtimeTarget,
    screenshot,
    userDataDirectory: isolation.userDataDirectory
  });
  console.log(`Packaged Electron black-box smoke passed: ${sourceLayout.executablePath}`);
} catch (error) {
  const cleanupErrors = [];
  const processCleanupDeadline =
    createPackagedElectronProcessCleanupDeadline();
  if (childOwner) {
    try {
      await terminatePackagedElectronProcessTree(
        childOwner,
        undefined,
        processCleanupDeadline
      );
      processTreeTerminal = true;
    } catch (cleanupError) {
      cleanupErrors.push(new Error(
        "Packaged Electron owned process-tree cleanup failed.",
        { cause: cleanupError }
      ));
    }
  }
  if (!processTreeTerminal && childPrivateBundleContainment) {
    try {
      await terminatePackagedElectronPrivateBundleContainment(
        childPrivateBundleContainment,
        processCleanupDeadline
      );
      processTreeTerminal = true;
    } catch (containmentError) {
      cleanupErrors.push(new Error(
        "Packaged Electron private-bundle fallback cleanup failed.",
        { cause: containmentError }
      ));
    }
  }
  if (!processTreeTerminal && child?.pid) {
    cleanupErrors.push(new Error(
      process.platform === "darwin"
        ? `The private macOS launch bundle was retained because PID ${child.pid} could not be proven terminal: ${
            privateBundle?.privateRoot ?? "<unavailable>"
          }.`
        : `The packaged Windows process PID ${child.pid} could not be proven terminal.`
    ));
  } else if (!child?.pid) {
    processTreeTerminal = true;
  }
  await captureCleanupFailure(
    cleanupErrors,
    () => fixture.close(),
    "Packaged role fixture cleanup failed."
  );
  await captureCleanupFailure(
    cleanupErrors,
    () => writeFile(join(artifactDirectory, "packaged-stdout.log"), stdout, "utf8"),
    "Packaged Electron stdout evidence could not be written."
  );
  await captureCleanupFailure(
    cleanupErrors,
    () => writeFile(join(artifactDirectory, "packaged-stderr.log"), stderr, "utf8"),
    "Packaged Electron stderr evidence could not be written."
  );
  if (privateBundle && processTreeTerminal) {
    await captureCleanupFailure(
      cleanupErrors,
      () => privateBundle.cleanup(),
      "The private macOS packaged launch bundle could not be removed."
    );
  }
  throw packagedSmokeFailure(error, cleanupErrors);
}

function parseApplicationPath(argumentsList) {
  const normalizedArguments = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  if (normalizedArguments.length !== 2 || normalizedArguments[0] !== "--app") {
    throw new Error(
      "Usage: runPackagedElectronSmoke.mjs --app <application bundle or unpacked directory>"
    );
  }
  return normalizedArguments[1];
}

async function startRoleFixture(buttonName) {
  let clickedResolve;
  let clickedReject;
  const clicked = new Promise((resolvePromise, reject) => {
    clickedResolve = resolvePromise;
    clickedReject = reject;
  });
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/clicked") {
      response.writeHead(204).end();
      clickedResolve();
      return;
    }
    if (request.method !== "GET" || request.url !== "/") {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8"
    }).end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Packaged Chromium Role</title></head>
<body>
  <main>
    <h1>Packaged Chromium role surface</h1>
    <button id="interaction" aria-label="${buttonName}">${buttonName}</button>
  </main>
  <script>
    document.querySelector("#interaction").addEventListener("click", async () => {
      await fetch("/clicked", { method: "POST" });
      document.body.dataset.interaction = "applied";
    });
  </script>
</body>
</html>`);
  });
  server.on("error", clickedReject);
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Packaged role fixture did not bind a TCP port.");
  }
  const clickDeadline = setTimeout(() => {
    clickedReject(new Error("Packaged role fixture did not observe its visible click."));
  }, 60_000);
  const observedClick = clicked.finally(() => clearTimeout(clickDeadline));
  void observedClick.catch(() => undefined);
  let closePromise;
  const close = () => {
    if (!closePromise) {
      clearTimeout(clickDeadline);
      closePromise = new Promise((resolvePromise, reject) => {
        server.close((error) => error ? reject(error) : resolvePromise());
        server.closeAllConnections();
      });
      void closePromise.catch(() => undefined);
    }
    return closePromise;
  };
  return Object.freeze({
    clicked: observedClick,
    close,
    url: `http://127.0.0.1:${address.port}/`
  });
}

function waitForSpawn(childProcess) {
  if (childProcess.pid) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    childProcess.once("spawn", resolvePromise);
    childProcess.once("error", reject);
  });
}

function appendBounded(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= 1024 * 1024 ? next : next.slice(-1024 * 1024);
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

async function hashPackagedRuntime(input) {
  const [executableSha256, archiveSha256, addonSha256] = await Promise.all([
    hashFile(input.executablePath),
    hashFile(input.appAsarPath),
    hashFile(input.nativeAddonPath)
  ]);
  return Object.freeze({ addonSha256, archiveSha256, executableSha256 });
}

async function assertPackagedRuntimeUnchanged(expected, paths) {
  const observed = await hashPackagedRuntime(paths);
  const changed = [
    ["executable", expected.executableSha256, observed.executableSha256],
    ["app.asar", expected.archiveSha256, observed.archiveSha256],
    ["native addon", expected.addonSha256, observed.addonSha256]
  ].filter(([, before, after]) => before !== after);
  if (changed.length > 0) {
    throw new Error(
      `Packaged Electron runtime changed during black-box execution: ${
        changed.map(([name]) => name).join(", ")
      }.`
    );
  }
}

async function captureCleanupFailure(errors, cleanup, message) {
  try {
    await cleanup();
  } catch (error) {
    errors.push(new Error(message, { cause: error }));
  }
}

async function writePassedReport(directory, report) {
  const reportPath = join(
    directory,
    PACKAGED_ELECTRON_BLACK_BOX_SOURCE_REPORT_NAME
  );
  const pendingPath = join(directory, ".packaged-smoke-report.pending");
  await writeFile(
    pendingPath,
    serializePackagedElectronBlackBoxReport(report),
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
  await rename(pendingPath, reportPath);
}
