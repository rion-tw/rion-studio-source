import { spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { createMacosGameModeDevelopmentBundle } from
  "./electronMacosGameModeBundle.mjs";

if (process.platform !== "darwin") {
  throw new Error("The signed DRM development launcher currently supports macOS only.");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const applicationPath = resolve(
  process.env.RION_STUDIO_SIGNED_ECS_APP ||
    join(repositoryRoot, ".electron-cache", "evs-control", "Electron.app")
);
const executablePath = join(applicationPath, "Contents", "MacOS", "Electron");
const python = process.env.RION_EVS_PYTHON ||
  join(repositoryRoot, ".electron-cache", "evs", "bin", "python");
const userData = join(repositoryRoot, ".electron-cache", "drm-manual-user-data");

async function runChecked(command, arguments_, { capture = false } = {}) {
  return await new Promise((resolveResult, reject) => {
    let output = "";
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"]
    });
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.once("error", reject);
    child.once("close", code => code === 0
      ? resolveResult(output)
      : reject(new Error(`${command} exited with status ${code}`)));
  });
}

async function verifyProductionVmp(path) {
  const output = await runChecked(python, [
    "-m", "castlabs_evs.vmp", "--no-ask", "verify-pkg", "--streaming", path
  ], { capture: true });
  if (!/Signature is valid: streaming/.test(output) || /development only/i.test(output)) {
    throw new Error(`A production streaming VMP signature is required:\n${output}`);
  }
  process.stdout.write(output);
}

const application = await lstat(applicationPath);
if (!application.isDirectory() || application.isSymbolicLink()) {
  throw new Error(`Expected a real signed ECS application: ${applicationPath}`);
}
await verifyProductionVmp(dirname(applicationPath));
await runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", applicationPath]);

const bundle = await createMacosGameModeDevelopmentBundle(executablePath);
try {
  await runChecked("/usr/bin/codesign", [
    "--force", "--deep", "--sign", "-", bundle.applicationPath
  ]);
  await runChecked("/usr/bin/codesign", [
    "--verify", "--deep", "--strict", bundle.applicationPath
  ]);
  await verifyProductionVmp(bundle.privateRoot);

  if (!process.argv.includes("--check")) {
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const environment = {
      ...process.env,
      RION_STUDIO_USER_DATA_DIR: userData
    };
    for (const key of Object.keys(environment)) {
      if (key.startsWith("RION_STUDIO_E2E_") ||
          key === "RION_STUDIO_DESKTOP_E2E_BUILD") delete environment[key];
    }
    console.log(`Signed DRM prototype data: ${userData}`);
    const result = await new Promise((resolveExit, reject) => {
      const child = spawn(bundle.executablePath, [repositoryRoot], {
        cwd: repositoryRoot,
        env: environment,
        stdio: "inherit"
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    process.exitCode = result.signal === "SIGINT" ? 130 : result.code ?? 1;
  }
} finally {
  await bundle.cleanup();
}
