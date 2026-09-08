import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function assertElectronPackageBuildTarget(platform, architecture) {
  const required = platform === "darwin" ? "arm64" : platform === "win32" ? "x64" : null;
  if (!required || architecture !== required) {
    throw new Error(
      `Electron distribution builds require macOS arm64 or Windows x64 Node and Rust; received ${platform}-${architecture}. ` +
      "Use the matching build runtime so packaging cannot consume an old addon from another architecture."
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assertElectronPackageBuildTarget(process.platform, process.arch);
}
