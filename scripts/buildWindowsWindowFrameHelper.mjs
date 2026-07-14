import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const solutionPath = join(
  repositoryRoot,
  "native",
  "windows",
  "window-frame-helper",
  "RionWindowFrameHelper.sln"
);
const outputDirectory = join(repositoryRoot, "build", "native", "win32-x64");
const helperPath = join(outputDirectory, "rion-window-frame-helper.exe");

async function isFile(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findVsWhere() {
  const candidates = [
    process.env.VSWHERE_PATH,
    process.env["ProgramFiles(x86)"]
      ? join(
          process.env["ProgramFiles(x86)"],
          "Microsoft Visual Studio",
          "Installer",
          "vswhere.exe"
        )
      : undefined,
    process.env.ProgramFiles
      ? join(process.env.ProgramFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe")
      : undefined
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not find vswhere.exe. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload."
  );
}

async function findMsBuild(vsWherePath) {
  const { stdout } = await execFileAsync(
    vsWherePath,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.Component.MSBuild",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-find",
      "MSBuild\\**\\Bin\\MSBuild.exe"
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      windowsHide: true
    }
  );
  const msBuildPath = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);

  if (!msBuildPath || !(await isFile(msBuildPath))) {
    throw new Error(
      "Could not find MSBuild with the MSVC x64 tools. Install Visual Studio 2022 Build Tools with the Desktop development with C++ workload."
    );
  }

  return msBuildPath;
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      windowsHide: true
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `MSBuild was terminated by ${signal}.`
            : `MSBuild exited with code ${code ?? "unknown"}.`
        )
      );
    });
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.log("Skipping the Windows window frame helper build on this platform.");
    return;
  }

  if (!(await isFile(solutionPath))) {
    throw new Error(`Windows window frame helper solution was not found at ${solutionPath}.`);
  }

  const vsWherePath = await findVsWhere();
  const msBuildPath = await findMsBuild(vsWherePath);

  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await run(msBuildPath, [
    solutionPath,
    "/m",
    "/nologo",
    "/restore",
    "/t:Build",
    "/p:Configuration=Release",
    "/p:Platform=x64",
    "/p:PlatformToolset=v143",
    "/p:PreferredToolArchitecture=x64",
    `/p:OutDir=${outputDirectory}${sep}`,
    "/v:minimal"
  ]);

  if (!(await isFile(helperPath))) {
    throw new Error(`MSBuild completed without producing ${helperPath}.`);
  }

  console.log(`Built Windows window frame helper: ${helperPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
