import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const reportOnly = process.argv.includes("--report");
const sourceExtensions = new Set([
  ".css",
  ".h",
  ".js",
  ".m",
  ".mjs",
  ".mm",
  ".mts",
  ".ps1",
  ".rs",
  ".ts",
  ".tsx"
]);
const generatedPrefixes = ["src/shared/generated/"];
const limits = { bytes: 64 * 1024, lines: 800 };
const facadeLineLimit = 250;

const { stdout } = await execute("git", ["ls-files", "-z"], {
  cwd: process.cwd(),
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024
});
const trackedFiles = stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((path) => path.replaceAll("\\", "/"));

const failures = [];
for (const path of trackedFiles) {
  if (!sourceExtensions.has(extname(path))) continue;
  if (generatedPrefixes.some((prefix) => path.startsWith(prefix))) continue;

  let source;
  try {
    source = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  const lineCount = source.length === 0
    ? 0
    : source.toString("utf8").split(/\r?\n/u).length - (source.at(-1) === 10 ? 1 : 0);
  if (lineCount > limits.lines || source.length > limits.bytes) {
    failures.push(
      `${path}: ${lineCount} lines, ${source.length} bytes ` +
      `(limits: ${limits.lines} lines, ${limits.bytes} bytes)`
    );
  }
  if (isFacade(path) && lineCount > facadeLineLimit) {
    failures.push(`${path}: facade has ${lineCount} lines (limit: ${facadeLineLimit})`);
  }
}

for (const path of trackedFiles.filter((candidate) => /^tsconfig(?:\.[^.]+)?\.json$/u.test(candidate))) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  for (const include of config.include ?? []) {
    if (/[*?{}]/u.test(include)) continue;
    try {
      await access(include);
    } catch {
      failures.push(`${path}: stale include path ${normalize(include)}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Source hygiene found ${failures.length} violation(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  if (!reportOnly) process.exitCode = 1;
} else {
  console.log(`Source hygiene passed for ${trackedFiles.length} tracked files.`);
}

function isFacade(path) {
  return path.endsWith("/mod.rs") ||
    path === "crates/rion-core/src/lib.rs" ||
    path === "crates/rion-platform/src/lib.rs" ||
    path === "src-tauri/src/lib.rs";
}
