import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROBE_PREFIX = "RION_ELECTRON_RUNTIME_PROBE=";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

export const EXPECTED_ELECTRON_RUNTIME = Object.freeze({
  chrome: "150.0.7871.224",
  electron: "43.4.1",
  modules: "148",
  napi: "10",
  node: "24.18.1"
});
export const EXPECTED_APPKIT_RUNTIME_ABI = 5;

export function assertElectronRuntimeProbe(
  probe,
  packageElectronVersion,
  expectedCoreVersion = "0.1.0"
) {
  for (const [name, expected] of Object.entries(EXPECTED_ELECTRON_RUNTIME)) {
    if (probe[name] !== expected) {
      throw new Error(`Electron runtime ${name} mismatch: expected ${expected}, received ${probe[name] ?? "missing"}.`);
    }
  }
  if (packageElectronVersion !== EXPECTED_ELECTRON_RUNTIME.electron) {
    throw new Error(
      `package.json Electron pin mismatch: expected ${EXPECTED_ELECTRON_RUNTIME.electron}, received ${packageElectronVersion ?? "missing"}.`
    );
  }
  if (probe.core !== expectedCoreVersion) {
    throw new Error(
      `Rust Core version mismatch: expected ${expectedCoreVersion}, received ${probe.core ?? "missing"}.`
    );
  }
  const expectedAppKitRuntimeAbi = process.platform === "darwin"
    ? EXPECTED_APPKIT_RUNTIME_ABI
    : 0;
  if (probe.appKitRuntimeAbi !== expectedAppKitRuntimeAbi) {
    throw new Error(
      `AppKit runtime ABI mismatch: expected ${expectedAppKitRuntimeAbi}, received ${probe.appKitRuntimeAbi ?? "missing"}.`
    );
  }
  if (probe.platform !== process.platform || probe.arch !== process.arch) {
    throw new Error(
      `Electron runtime target mismatch: expected ${process.platform}-${process.arch}, received ${probe.platform ?? "missing"}-${probe.arch ?? "missing"}.`
    );
  }
}

export async function verifyElectronRuntime() {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("The Electron runtime verifier supports only macOS and Windows.");
  }
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const configuredReleaseVersion = process.env.RION_STUDIO_ELECTRON_PACKAGE_VERSION?.trim();
  if (
    configuredReleaseVersion &&
    (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(configuredReleaseVersion) ||
      packageJson.version !== configuredReleaseVersion)
  ) {
    throw new Error(
      "RION_STUDIO_ELECTRON_PACKAGE_VERSION must be semantic and match package.json."
    );
  }
  const requireFromRepository = createRequire(join(repositoryRoot, "package.json"));
  const electronExecutable = requireFromRepository("electron");
  const addonPath = join(
    repositoryRoot,
    "build",
    "native",
    `${process.platform}-${process.arch}`,
    "rion-core.node"
  );
  const probePath = join(repositoryRoot, "scripts", "electronRuntimeProbe.cjs");
  const isolatedUserData = await mkdtemp(join(tmpdir(), "rion-electron-runtime-probe-"));
  try {
    const probe = await runProbe(electronExecutable, probePath, addonPath, isolatedUserData);
    assertElectronRuntimeProbe(
      probe,
      packageJson.devDependencies?.electron,
      configuredReleaseVersion || "0.1.0"
    );
    console.log(
      `Verified Electron ${probe.electron}, Chromium ${probe.chrome}, Node ${probe.node}, Node-API ${probe.napi}, and Rust Core ${probe.core} (${probe.platform}-${probe.arch}).`
    );
  } finally {
    await rm(isolatedUserData, { force: true, recursive: true });
  }
}

async function runProbe(electronExecutable, probePath, addonPath, isolatedUserData) {
  const { code, signal, stderr, stdout } = await new Promise((resolvePromise, reject) => {
    const child = spawn(electronExecutable, [probePath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ELECTRON_ENABLE_SECURITY_WARNINGS: "1",
        RION_ELECTRON_ADDON_PATH: addonPath,
        RION_ELECTRON_PROBE_USER_DATA_DIR: isolatedUserData
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal, stderr, stdout }));
  });
  if (code !== 0) {
    throw new Error(signal
      ? `Electron runtime probe was terminated by ${signal}.\n${stderr}`
      : `Electron runtime probe exited with code ${code ?? "unknown"}.\n${stderr}`);
  }
  const probeLine = stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(PROBE_PREFIX));
  if (!probeLine) {
    throw new Error(`Electron runtime probe returned no contract payload.\n${stderr}`);
  }
  return JSON.parse(probeLine.slice(PROBE_PREFIX.length));
}

const launchedAsScript = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedAsScript) await verifyElectronRuntime();
