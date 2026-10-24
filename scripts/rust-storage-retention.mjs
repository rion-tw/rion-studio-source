import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

export function runRustRetention(repositoryRoot = root, options = {}) {
  const platform = options.platform ?? process.platform;
  if (!["darwin", "linux"].includes(platform)) {
    return { skipped: "Rust retention requires macOS/Linux process inspection and flock; outputs retained", removedBytes: 0 };
  }
  const policy = options.policy ?? JSON.parse(readFileSync(
    new URL("./rust-storage-retention.json", import.meta.url), "utf8"
  ));
  const request = {
    root: repositoryRoot, policy, apply: options.apply ?? false,
    node: process.execPath,
    activityModule: new URL("./storage-retention.mjs", import.meta.url).href,
    ...(options.activity ? { activity: options.activity } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.markProfile ? { markProfile: options.markProfile } : {})
  };
  const child = spawnSync("python3", ["-B", fileURLToPath(new URL("./rust_storage_retention.py", import.meta.url))], {
    input: JSON.stringify(request), encoding: "utf8", maxBuffer: 32 * 1024 ** 2
  });
  if (child.error || child.status !== 0) {
    throw new Error(child.error?.message ?? child.stderr.trim() ?? "Rust retention failed");
  }
  return JSON.parse(child.stdout);
}

export function maintainRustStorage({ release = false } = {}) {
  try {
    const result = runRustRetention(root, { apply: true, markProfile: release ? "release" : "debug" });
    reportRustRetention(result);
  } catch (error) {
    console.warn(`[rust-storage] retained outputs: ${error.message}`);
  }
}

function reportRustRetention(result) {
  if (result.skipped) console.log(`[rust-storage] ${result.skipped}`);
  const bytes = result.apply ? result.removedBytes : result.plannedBytes;
  if (bytes) console.log(`[rust-storage] ${result.apply ? "removed" : "preview"} ${(bytes / 1024 ** 3).toFixed(2)} GiB`);
  for (const error of result.errors ?? []) console.warn(`[rust-storage] retained remainder: ${error.path}: ${error.message}`);
  if (result.overBudget || result.incrementalOverBudget) console.log("[rust-storage] above target; active, recent or protected artifacts retained");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  try {
    if (args.some(arg => !["--apply", "--json", "--auto", "--before-build", "--release"].includes(arg))) {
      throw new Error("Usage: rust-storage-retention.mjs [--apply] [--json] [--auto] [--before-build] [--release]");
    }
    const result = runRustRetention(root, {
      apply: args.includes("--apply") || args.includes("--before-build"),
      ...(args.includes("--before-build") ? { markProfile: args.includes("--release") ? "release" : "debug" } : {})
    });
    if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
    else reportRustRetention(result);
    if (result.errors?.length && !args.includes("--auto")) process.exitCode = 1;
  } catch (error) {
    console.error(`[rust-storage] retained outputs: ${error.message}`);
    process.exitCode = args.includes("--auto") ? 0 : 1;
  }
}
