import { execFile, spawn } from "node:child_process";
import { glob, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const appKitConstraintPrefixes = Object.freeze([
  "RION_APPKIT_CONSTRAINT_DIAGNOSTIC ", "RION_APPKIT_CORNER_CONSTRAINT_DIAGNOSTIC "
]);

async function nativePrefixes(addon) {
  const child = spawn("/usr/bin/strings", [addon], { stdio: ["ignore", "pipe", "pipe"] });
  const found = new Set();
  let error = "";
  child.stderr.on("data", chunk => { if (error.length < 4096) error += chunk.toString(); });
  const completed = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? done() :
      reject(new Error(`Native prefix inspection failed (${code ?? signal}): ${error}`)));
  });
  const consumed = (async () => {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      for (const prefix of appKitConstraintPrefixes) if (line.includes(prefix.trimEnd())) found.add(prefix);
    }
  })();
  // Consume strings to its terminal event; never stop the pipe after a match.
  await Promise.all([completed, consumed]);
  return appKitConstraintPrefixes.filter(prefix => found.has(prefix));
}

/** Diagnostic-only readback from the exact processes admitted by the E2E harness. */
export async function collectAppKitConstraintDiagnostics(input) {
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("AppKit constraint log collection requires macOS");
  const root = await realpath(resolve(input.artifactRoot));
  const output = resolve(root, "appkit-constraint-native-logs");
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink() || await realpath(output) !== output) {
    throw new Error("AppKit diagnostic output escaped the owned artifact scope");
  }
  const inspectPrefixes = input.inspectPrefixes ?? nativePrefixes;
  const prefixes = await inspectPrefixes(resolve(input.nativeAddonPath ?? "build/native/darwin-arm64/rion-core.node"));
  const found = appKitConstraintPrefixes.filter(prefix => prefixes.includes(prefix));
  await writeFile(resolve(output, "native-prefix-presence.txt"), found.map(prefix => prefix.trimEnd()).join("\n")+"\n");
  if (found.length !== appKitConstraintPrefixes.length) throw new Error("Native addon is missing a diagnostic prefix");

  const witnesses = [];
  for await (const relative of glob("*/phases/*/appkit-constraint-launch-witness.json", { cwd: root })) {
    const path = resolve(root, relative);
    if ((await lstat(path)).isSymbolicLink() || !(await realpath(path)).startsWith(root+sep)) {
      throw new Error("AppKit launch witness escaped the owned artifact scope");
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.processId) || value.processId <= 1 ||
        value.bridgeProcessId !== value.processId || value.nativeDiagnosticEnabled !== true ||
        typeof value.phase !== "string" || !/^[a-z][a-z0-9-]+$/u.test(value.phase)) {
      throw new Error("AppKit native process/flag witness is invalid");
    }
    witnesses.push({ processId: value.processId, phase: value.phase });
  }
  if (witnesses.length === 0) throw new Error("No AppKit native process/flag witnesses were captured");
  const processIds = [...new Set(witnesses.map(value => value.processId))].sort((a, b) => a-b);
  const predicate = `(${processIds.map(pid => `processID == ${pid}`).join(" OR ")}) AND `+
    `(${appKitConstraintPrefixes.map(prefix => `eventMessage BEGINSWITH "${prefix}"`).join(" OR ")})`;
  const run = input.execute ?? execute;
  const { stdout } = await run("/usr/bin/log", ["show", "--style", "json", "--info", "--debug",
    "--last", "15m", "--predicate", predicate], { timeout: 60_000, maxBuffer: 64*1024*1024 });
  const records = JSON.parse(stdout);
  if (!Array.isArray(records)) throw new Error("Native AppKit unified log returned no JSON row array");
  const rows = records.filter(row => processIds.includes(row?.processID) &&
    typeof row.eventMessage === "string" && appKitConstraintPrefixes.some(prefix => row.eventMessage.startsWith(prefix)))
    .map(row => ({ timestamp: row.timestamp, processId: row.processID, eventMessage: row.eventMessage }));
  await writeFile(resolve(output, "native-constraint-rows.json"), JSON.stringify(rows, null, 2)+"\n");
  const invalidPayloadCount = rows.filter(row => {
    try {
      const prefix = appKitConstraintPrefixes.find(value => row.eventMessage.startsWith(value));
      const value = JSON.parse(row.eventMessage.slice(prefix.length));
      return value === null || typeof value !== "object" || Array.isArray(value) || value.serializationError === true;
    } catch { return true; }
  }).length;
  const summary = { witnesses, processIds, rowCount: rows.length,
    invalidPayloadCount,
    prefixCounts: Object.fromEntries(appKitConstraintPrefixes.map(prefix =>
      [prefix.trimEnd(), rows.filter(row => row.eventMessage.startsWith(prefix)).length])) };
  await writeFile(resolve(output, "collection-report.json"), JSON.stringify(summary, null, 2)+"\n");
  if (rows.length === 0) throw new Error("No native AppKit constraint diagnostic rows were captured");
  if (invalidPayloadCount !== 0) throw new Error("Native AppKit constraint diagnostic rows have incomplete JSON payloads");
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const summary = await collectAppKitConstraintDiagnostics({ artifactRoot: process.argv[2] ?? ".desktop-e2e-artifacts" });
  process.stdout.write(`Captured ${summary.rowCount} scoped AppKit constraint rows from ${summary.processIds.length} admitted processes.\n`);
}
