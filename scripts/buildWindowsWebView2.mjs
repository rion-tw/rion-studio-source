import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sdkVersion = "1.0.4078.44";
const sdkSha256 = "dc4d1d9168df26b830398303e50210b6e1729f6ce5a7ac69d2c766852f489962";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeDirectory = join(repositoryRoot, "native", "windows", "webview2");
const sdkDirectory = join(repositoryRoot, "build", "webview2-sdk", sdkVersion);
const sdkHeader = join(sdkDirectory, "build", "native", "include", "WebView2.h");
const sdkArchive = join(repositoryRoot, "build", "webview2-sdk", `webview2-${sdkVersion}.zip`);
const builtAddon = join(nativeDirectory, "build", "Release", "rion-webview2.node");

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: "inherit",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(
          signal
            ? `${command} was terminated by ${signal}.`
            : `${command} exited with code ${code ?? "unknown"}.`
        ));
      }
    });
  });
}

async function prepareSdk() {
  if (await exists(sdkHeader)) return;
  await mkdir(join(repositoryRoot, "build", "webview2-sdk"), { recursive: true });
  if (!await exists(sdkArchive)) {
    const response = await fetch(
      `https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/${sdkVersion}`
    );
    if (!response.ok) {
      throw new Error(`WebView2 SDK download failed with HTTP ${response.status}.`);
    }
    await writeFile(sdkArchive, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256").update(await readFile(sdkArchive)).digest("hex");
  if (digest !== sdkSha256) {
    throw new Error(`WebView2 SDK checksum mismatch: received ${digest}.`);
  }
  await mkdir(sdkDirectory, { recursive: true });
  await run("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive",
    "-LiteralPath",
    sdkArchive,
    "-DestinationPath",
    sdkDirectory,
    "-Force"
  ]);
  if (!await exists(sdkHeader)) {
    throw new Error(`WebView2 SDK header was not extracted to ${sdkHeader}.`);
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.log("Skipping the Windows WebView2 native build on this platform.");
    return;
  }
  if (process.arch !== "x64") {
    throw new Error(`The Windows WebView2 prototype currently requires x64, not ${process.arch}.`);
  }
  await prepareSdk();
  await run(
    "pnpm.cmd",
    ["exec", "node-gyp", "rebuild", "--directory", nativeDirectory, "--arch=x64"],
    { ...process.env, RION_WEBVIEW2_SDK_DIR: sdkDirectory }
  );
  if (!await exists(builtAddon)) {
    throw new Error(`Windows WebView2 addon was not produced at ${builtAddon}.`);
  }
  const outputDirectory = join(repositoryRoot, "build", "native", "win32-x64");
  await mkdir(outputDirectory, { recursive: true });
  await copyFile(builtAddon, join(outputDirectory, "rion-webview2.node"));
  console.log(`Built Windows WebView2 addon with SDK ${sdkVersion}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
