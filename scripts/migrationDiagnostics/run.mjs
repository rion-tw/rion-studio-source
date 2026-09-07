import { chmod, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { resolveCargoExecutable } from "../cargoExecutable.mjs";
import { runProcess } from "./process.mjs";
import { buildHelper, verifySynthetic } from "./chromium.mjs";

const args = process.argv.slice(2).filter(argument => argument !== "--");
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!["--output", "--source-data"].includes(args[index]) || !args[index + 1] || options[args[index]]) {
    throw new Error("Usage: diagnose:session-migration --output <new absolute directory> [--source-data <existing Rion directory>]");
  }
  options[args[index]] = args[index + 1];
}
if (!options["--output"] || !isAbsolute(options["--output"]) || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("NEW_ABSOLUTE_OUTPUT_AND_NATIVE_PLATFORM_REQUIRED");
}
// The root is created exclusively; the driver never adopts an existing directory.
const root = options["--output"];
const parent = await realpath(resolve(root, ".."));
if (resolve(root, "..") !== parent) throw new Error("OUTPUT_PARENT_MUST_BE_CANONICAL");
const protectedRoots = process.platform === "darwin"
  ? [join(homedir(), "Library", "WebKit"), join(homedir(), "Library", "Application Support")]
  : [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
for (const source of [...protectedRoots, options["--source-data"]].filter(Boolean)) {
  if (resolve(root) === resolve(source) || resolve(root).startsWith(`${resolve(source)}/`) ||
      resolve(root).toLowerCase().startsWith(`${resolve(source).toLowerCase()}\\`)) throw new Error("OUTPUT_OVERLAPS_USER_DATA");
}
await mkdir(root, { mode: 0o700 });
await chmod(root, 0o700);
const abort = new AbortController();
const interrupted = () => abort.abort();
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
const report = { reportVersion: 1, createdAt: new Date().toISOString(), platform: process.platform,
  osRelease: release(), electronVersion: createRequire(import.meta.url)("electron/package.json").version,
  implementation: "working-tree", nativeCoverage: { macos14: "pending", macos15: "pending", macos26: "pending", windows: "pending" },
  sourceInventory: "notRun", webkitExport: "notRun", chromium: "notRun", login: { role: "里優", status: "notRun", reason: "Offline source admission required" } };

try {
  report.commit = (await runProcess("git", ["rev-parse", "HEAD"])).stdout.toString().trim();
  report.workingTreeDirty = (await runProcess("git", ["status", "--porcelain"])).stdout.length > 0;
  await runProcess(await resolveCargoExecutable(), ["build", "--locked", "-p", "rion-core", "--features", "session-migration-diagnostics", "--bin", "rion-session-migration-diagnostics"], { signal: abort.signal, timeout: 600_000 });
  const binary = resolve("target/debug", process.platform === "win32" ? "rion-session-migration-diagnostics.exe" : "rion-session-migration-diagnostics");
  const rust = async input => JSON.parse((await runProcess(binary, [], { input: JSON.stringify(input), signal: abort.signal })).stdout);
  if (options["--source-data"]) {
    const sourceRoots = [];
    if (process.platform === "darwin") {
      for (const appId of ["com.rionstudio.launcher", "com.rionstudio.launcher.dev", "rion-tauri"]) {
        const path = join(homedir(), "Library/WebKit", appId, "WebsiteDataStore");
        if (await stat(path).then(info => info.isDirectory(), () => false)) sourceRoots.push({ appId, path });
      }
    } else sourceRoots.push({ appId: "webview2", path: join(options["--source-data"], "roles") });
    report.sourceInventory = await rust({ mode: "inventory", user_data_dir: options["--source-data"], source_roots: sourceRoots,
      output_dir: join(root, "source-inventory"), capture: true });
    const liyou = report.sourceInventory.roles.find(role => role.roleName === "里優");
    report.login.reason = liyou?.sourceAssessment ?? "ROLE_NOT_AVAILABLE";
  }
  let serialization;
  const macosVersion = process.platform === "darwin"
    ? (await runProcess("/usr/bin/sw_vers", ["-productVersion"])).stdout.toString().trim() : null;
  report.macosVersion = macosVersion;
  if (process.platform === "darwin" && Number(macosVersion.split(".")[0]) >= 26) {
    const probe = join(root, "webkit-probe");
    await runProcess("/usr/bin/swiftc", ["scripts/migrationDiagnostics/webkitProbe.swift", "-o", probe, "-framework", "WebKit", "-framework", "AppKit"], { signal: abort.signal });
    try {
      const result = JSON.parse((await runProcess(probe, [], { signal: abort.signal })).stdout);
      if (result.status !== "exported" || !result.synthetic) throw new Error("WEBKIT_PROBE_FAILED");
      serialization = result.serialization;
      const decoded = await rust({ mode: "decodeWebkit", serialization });
      const read = record => Buffer.from(record.data, "base64").toString("utf16le");
      const expected = new Map([["https://migration-one.invalid", "角色\0測試"], ["https://migration-two.invalid", "independent-role"]]);
      if (decoded.localStorage.length !== 2 || decoded.localStorage.some(origin => origin.entries.length !== 1 ||
          read(origin.entries[0].key) !== "character" || read(origin.entries[0].value) !== expected.get(origin.origin))) {
        throw new Error("WEBKIT_EXACT_READBACK_FAILED");
      }
      report.webkitExport = { status: "passed", osVersion: result.osVersion, origins: 2, entries: 2, cookieApiCount: result.cookieCount,
        cookieAttributeCompleteness: "notProven", store: "nonpersistent synthetic", nativeSerializationDecodedByRust: true };
      report.nativeCoverage.macos26 = "synthetic API verified; real migration not admitted";
    } catch (error) { report.webkitExport = { status: "failedOrUnavailable", code: error.message }; }
  }
  const fixtureA = await rust({ mode: "synthetic", output_dir: join(root, "synthetic-a"), ...(serialization ? { serialization } : {}) });
  const fixtureB = await rust({ mode: "synthetic", output_dir: join(root, "synthetic-b"), second_role: true });
  const entry = await buildHelper(root);
  try { report.chromium = await verifySynthetic(root, entry, fixtureA, fixtureB, abort.signal); }
  catch (error) { report.chromium = { status: "failed", code: error.message }; throw error; }
  report.status = "completed";
} catch (error) {
  report.status = abort.signal.aborted ? "cancelled" : "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  // Rust RAII handles normal failures. A killed Rust process cannot run Drop,
  // so remove only its explicitly named plaintext directories in this new run.
  const inventoryRoot = join(root, "source-inventory");
  for (const name of await readdir(inventoryRoot).catch(() => [])) {
    if (name.startsWith("plaintext-")) {
      await rm(join(inventoryRoot, name), { recursive: true, force: true })
        .catch(() => { report.cleanupFailed = true; process.exitCode = 1; });
    }
  }
  // Only these run-owned synthetic roots are removed; never a caller-supplied source.
  for (const name of ["synthetic-a", "synthetic-b", "helper", "webkit-probe"]) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => { report.cleanupFailed = true; process.exitCode = 1; });
  }
  report.syntheticTemporaryRemoved = !report.cleanupFailed;
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  const inventory = typeof report.sourceInventory === "object" ? report.sourceInventory : null;
  const roles = inventory?.roles ?? [];
  const sum = key => roles.reduce((total, role) => total + (role.assessment?.data?.[key] ?? 0), 0);
  const rows = roles.map(role => `| ${role.roleName.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ")} | ${role.sourceCandidates.length} | ${role.sourceAssessment} | ${role.assessment?.data?.localStorageEntriesReadable ?? "—"} | ${role.assessment?.data?.cookieRecordsStructurallyReadable ?? "—"} | ${role.sourceCandidates.some(candidate => candidate.otherWebsiteDataPresent) ? "present" : "not observed"} |`);
  const markdown = [`# Session migration diagnostic evidence`, "", `- Source: ${report.commit ?? "unknown"}; dirty: ${report.workingTreeDirty ?? "unknown"}`,
    `- OS: ${report.platform} ${report.macosVersion ?? report.osRelease}; kernel: ${report.osRelease}; Electron: ${report.electronVersion}`,
    `- Source application version: ${inventory?.sourceAppVersion ?? "synthetic only"}; source SQLite schema: ${inventory?.schemaVersion ?? "not applicable"}`,
    `- Run: ${report.status}; WebKit API: ${typeof report.webkitExport === "object" ? report.webkitExport.status : report.webkitExport}`,
    `- Chromium synthetic verification: ${typeof report.chromium === "object" ? report.chromium.status : report.chromium}`,
    `- 里優 login: ${report.login.status}; ${report.login.reason}`, "",
    "No production journal was promoted. Synthetic success is not a real-role migration or login success rate.", "",
    `Source DB/WAL content unchanged: ${inventory?.sourceDatabaseAndWalUnchanged ?? "not applicable"}.`,
    `Offline inventory: ${roles.length} roles, ${roles.filter(role => role.sourceAssessment === "SNAPSHOT_ASSESSED").length} encrypted snapshots, ${roles.filter(role => role.sourceAssessment === "SOURCE_AMBIGUOUS").length} ambiguous sources.`,
    `Readable LocalStorage: ${sum("localStorageOriginsReadable")} origins / ${sum("localStorageEntriesReadable")} entries. Structurally readable cookies: ${sum("cookieRecordsStructurallyReadable")}. These counts do not establish complete source transfer.`, "",
    "| Role | Sources | Source assessment | LS entries | Cookie structures | IndexedDB / Service Worker |", "| --- | ---: | --- | ---: | ---: | --- |", ...rows, "",
    "All real-role target equality, persistence, isolation and login results remain not run. See each role's classified errors and authenticated-package assessment in report.json.",
    "WebKit binary cookies still need complete attribute, session and partition evidence. Missing cookie files are unproven, not empty accounts. IndexedDB and Service Worker data are never reported as migrated.", "",
    "| Native environment | Evidence |", "| --- | --- |",
    ...Object.entries(report.nativeCoverage).map(([platform, evidence]) => `| ${platform} | ${evidence} |`), "",
    "Decision: retain explicit unsupported-source boundaries. Resolve source-use provenance and complete cookie formats before designing automatic v9 migration. No role is reset; no release or production migration UI is included.",
    "The authorized single-role online check requires all offline gates and an isolated AppKit/Electron visible launch. It is not exposed while those gates cannot pass. Online validation may rotate server credentials; deleting a clone cannot undo that effect.",
    `Temporary cleanup: ${report.cleanupFailed ? "FAILED — inspect this run" : "completed"}; protected source snapshots retained. Snapshots are not downgrade guarantees.`, "",
    report.error ? `Run error: ${report.error}` : ""].join("\n");
  await writeFile(join(root, "report.md"), markdown, { mode: 0o600 });
  process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  console.log(`Diagnostic report: ${join(root, "report.md")}`);
}
