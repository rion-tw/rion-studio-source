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

/** Every snapshot is admitted only after all of its exact scoped fragments validate. */
export function assembleAppKitConstraintFragments(fragments, processIds) {
  const groups = new Map();
  const errors = [];
  for (const [position, fragment] of fragments.entries()) {
    const prefix = appKitConstraintPrefixes.find(value => fragment?.eventMessage?.startsWith(value));
    if (!processIds.includes(fragment?.processId) || !prefix) {
      errors.push(`Fragment ${position} has no admitted PID/prefix scope`);
      continue;
    }
    let chunk;
    try { chunk = JSON.parse(fragment.eventMessage.slice(prefix.length)); }
    catch { errors.push(`Fragment ${position} has incomplete chunk JSON`); continue; }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk) ||
        Object.keys(chunk).sort().join(",") !== "count,data,id,index,type" || chunk.type !== "chunk" ||
        typeof chunk.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(chunk.id) ||
        !Number.isSafeInteger(chunk.count) || chunk.count < 1 || chunk.count > 128 ||
        !Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= chunk.count ||
        typeof chunk.data !== "string" || chunk.data.length < 1 || chunk.data.length > 320 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(chunk.data)) {
      errors.push(`Fragment ${position} has an invalid chunk envelope`);
      continue;
    }
    const key = `${fragment.processId}|${prefix}|${chunk.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { processId: fragment.processId, prefix, id: chunk.id, count: chunk.count,
        chunks: new Map(), invalid: false };
      groups.set(key, group);
    }
    if (group.count !== chunk.count) {
      group.invalid = true;
      errors.push(`Snapshot ${key} has conflicting chunk counts`);
    }
    if (group.chunks.has(chunk.index)) {
      group.invalid = true;
      errors.push(`Snapshot ${key} has ${group.chunks.get(chunk.index).data === chunk.data ? "duplicate" : "conflicting"} chunk ${chunk.index}`);
    } else group.chunks.set(chunk.index, { ...fragment, data: chunk.data });
  }
  const rows = [];
  const snapshots = [];
  for (const [key, group] of groups) {
    const snapshot = { processId: group.processId, prefix: group.prefix.trimEnd(), id: group.id,
      expectedCount: group.count, receivedCount: group.chunks.size, status: "failed" };
    snapshots.push(snapshot);
    if (group.invalid) continue;
    if (group.chunks.size !== group.count) {
      errors.push(`Snapshot ${key} is missing chunks`);
      continue;
    }
    try {
      const base64 = Array.from({ length: group.count }, (_, index) => group.chunks.get(index).data).join("");
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length > 16*1024 || bytes.toString("base64") !== base64) throw new Error("invalid or oversized Base64 payload");
      const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const data = JSON.parse(json);
      if (!data || typeof data !== "object" || Array.isArray(data) || data.serializationError === true) {
        throw new Error("invalid native JSON or explicit serialization error");
      }
      snapshot.status = "complete";
      rows.push({ timestamp: group.chunks.get(0).timestamp, processId: group.processId,
        prefix: group.prefix.trimEnd(), id: group.id, data });
    } catch { errors.push(`Snapshot ${key} has invalid Base64, UTF-8, JSON, or native serialization failure`); }
  }
  return { rows, summary: { fragmentCount: fragments.length, completedSnapshotCount: rows.length,
    failedSnapshotCount: snapshots.filter(value => value.status !== "complete").length,
    errorCount: errors.length, errors, snapshots } };
}

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
  const fragments = records.filter(row => processIds.includes(row?.processID) &&
    typeof row.eventMessage === "string" && appKitConstraintPrefixes.some(prefix => row.eventMessage.startsWith(prefix)))
    .map(row => ({ timestamp: row.timestamp, processId: row.processID, eventMessage: row.eventMessage }));
  await writeFile(resolve(output, "native-constraint-fragments.json"), JSON.stringify(fragments, null, 2)+"\n");
  const assembly = assembleAppKitConstraintFragments(fragments, processIds);
  await writeFile(resolve(output, "native-constraint-rows.json"), JSON.stringify(assembly.rows, null, 2)+"\n");
  await writeFile(resolve(output, "assembly-report.json"), JSON.stringify(assembly.summary, null, 2)+"\n");
  const summary = { witnesses, processIds, rowCount: assembly.rows.length,
    invalidPayloadCount: assembly.summary.errorCount,
    fragmentCount: fragments.length,
    prefixCounts: Object.fromEntries(appKitConstraintPrefixes.map(prefix =>
      [prefix.trimEnd(), assembly.rows.filter(row => row.prefix === prefix.trimEnd()).length])) };
  await writeFile(resolve(output, "collection-report.json"), JSON.stringify(summary, null, 2)+"\n");
  if (assembly.summary.errorCount !== 0) throw new Error("Native AppKit constraint diagnostic fragment assembly failed");
  if (assembly.rows.length === 0) throw new Error("No native AppKit constraint diagnostic rows were captured");
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const summary = await collectAppKitConstraintDiagnostics({ artifactRoot: process.argv[2] ?? ".desktop-e2e-artifacts" });
  process.stdout.write(`Captured ${summary.rowCount} scoped AppKit constraint rows from ${summary.processIds.length} admitted processes.\n`);
}
