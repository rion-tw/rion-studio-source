import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";
import { sanitizeUpdaterRuntimeEnvironment } from "./runtimeEnvironmentPolicy.mjs";

export function electronPackageScript(platform) {
  if (platform === "darwin") return "package:electron:mac";
  if (platform === "win32") return "package:electron:win";
  throw new Error(`Desktop packages are supported only on macOS and Windows: ${platform}`);
}

export async function packageElectron({ platform = process.platform, environment = process.env } = {}) {
  const command = platform === "win32" ? "pnpm.cmd" : "pnpm";
  const child = spawnPlatformCommand(command, ["run", electronPackageScript(platform)], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: sanitizeUpdaterRuntimeEnvironment(environment),
    stdio: "inherit",
    windowsHide: true
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`Electron packaging failed: ${signal ?? code ?? "unknown exit"}`));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((argument) => argument !== "--")) {
    throw new Error("Usage: pnpm run package");
  }
  await packageElectron();
}
