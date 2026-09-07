// Offline real-source proof; no production target or journal is ever opened.
import { writeFile, rm, lstat, readFile, readdir } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "vite";
import { buildHelper, invoke, requestFor } from "./chromium.mjs";
import { runProcess } from "./process.mjs";
import { resolveCargoExecutable } from "../cargoExecutable.mjs";
const args = process.argv.slice(2).filter(a => a !== "--");
const opts = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--role", "--application", "--output", "--current-data", "--restore-missing"].includes(args[i]) || !args[i + 1] || opts[args[i]]) throw new Error("INVALID_ARGUMENTS");
  opts[args[i]] = args[i + 1];
}
if (!opts["--role"] || !opts["--application"] || !isAbsolute(opts["--output"] ?? "")) throw new Error("ROLE_APPLICATION_NEW_OUTPUT_REQUIRED");
if (opts["--restore-missing"] && (opts["--restore-missing"] !== "yes" || !opts["--current-data"])) throw new Error("RESTORE_REQUIRES_CURRENT_DATA");
if (opts["--current-data"] && !isAbsolute(opts["--current-data"])) throw new Error("ABSOLUTE_CURRENT_DATA_REQUIRED");
const restore = opts["--restore-missing"] === "yes";
const root = opts["--output"];
if (await lstat(root).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("NEW_OUTPUT_REQUIRED");
const abort = new AbortController();
const cancel = () => abort.abort();
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
// Rust creates and validates this new output, including protected-root exclusions.
const report = { createdAt: new Date().toISOString(), roleId: opts["--role"], application: opts["--application"],
  platform: process.platform, electronVersion: createRequire(import.meta.url)("electron/package.json").version,
  synthetic: false, targetEquality: "notRun", persistence: "notRun", login: "notRun", productionMutationPerformed: false };
let created = false;
let repairCloneSha;
try {
  await runProcess(await resolveCargoExecutable(), ["build", "--locked", "-p", "rion-core", "--features", "session-migration-diagnostics", "--bin", "rion-session-migration-diagnostics"], { signal: abort.signal, timeout: 600_000 });
  report.commit = (await runProcess("git", ["rev-parse", "HEAD"])).stdout.toString().trim();
  report.workingTreeDirty = (await runProcess("git", ["status", "--porcelain"])).stdout.length > 0;
  report.osVersion = (await runProcess("/usr/bin/sw_vers", ["-productVersion"])).stdout.toString().trim();
  const fixture = JSON.parse((await runProcess(resolve("target/debug/rion-session-migration-diagnostics"), [], {
    signal: abort.signal, input: JSON.stringify({ mode: "retainedWebkit", role_id: opts["--role"], application: opts["--application"], output_dir: root, current_user_data: opts["--current-data"] ?? null })
  })).stdout);
  created = true;
  report.source = fixture.assessment;
  if (report.source.comparison) {
    const comparison = report.source.comparison;
    await build({ configFile: false, logLevel: "silent", build: { ssr: true, outDir: join(root, "inspect-helper"), rollupOptions: {
      input: resolve("scripts/migrationDiagnostics/inspectLocalStorage.ts"), external: ["electron", /^node:/u], output: { format: "es", entryFileNames: "inspect.mjs" }
    } } });
    const env = { ...process.env, RION_MIGRATION_DIAGNOSTICS: "1", RION_MIGRATION_DIAGNOSTIC_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE;
    const envelope = JSON.parse(Buffer.from(fixture.canonicalEnvelopeBase64, "base64"));
    const inspect = async (mode, expected) => runProcess(createRequire(import.meta.url)("electron"), [join(root, "inspect-helper/inspect.mjs")], {
      env, signal: abort.signal, input: JSON.stringify({ profile: comparison.clonePath, origins: envelope.inventory.localStorage, mode, expected })
    });
    const first = await inspect(restore ? "applyMissing" : undefined);
    comparison.chromium = JSON.parse(first.stdout);
    if (restore) {
      const fresh = await inspect("verify", comparison.chromium.digest);
      const readback = JSON.parse(fresh.stdout);
      if (first.pid === fresh.pid || readback.digest !== comparison.chromium.digest || readback.mode !== "verify") throw new Error("FRESH_REPAIR_VERIFICATION_FAILED");
      report.repairVerification = { exactSelectedOrigins: true, persistence: "freshProcessVerified", existingKeysPreserved: true, externalNetwork: "blocked" };
      const rust = async input => JSON.parse((await runProcess(resolve("target/debug/rion-session-migration-diagnostics"), [], { input: JSON.stringify(input), signal: abort.signal })).stdout);
      const { sha256 } = await rust({ mode: "digestLocalStorageClone", output_dir: root });
      repairCloneSha = sha256;
    }
    delete comparison.currentOrigins;
    delete comparison.clonePath;
  }
  const entry = await buildHelper(root);
  const a = requestFor(fixture);
  const apply = await invoke(root, entry, a.request, a.envelope, abort.signal);
  if (apply.outcome !== 0) throw new Error(`APPLY_FAILED:${apply.metadata.code ?? apply.metadata.stableErrorCode ?? "UNKNOWN"}`);
  const verification = await invoke(root, entry, { ...a.request, kind: "verify", parentExitEvidenceSha256: apply.exitEvidence }, a.envelope, abort.signal);
  if (verification.outcome !== 0) throw new Error(`VERIFY_FAILED:${verification.metadata.code ?? verification.metadata.stableErrorCode ?? "UNKNOWN"}`);
  if (verification.pid === apply.pid || verification.metadata.parentExitEvidenceSha256 !== apply.exitEvidence) throw new Error("FRESH_PROCESS_EVIDENCE_MISMATCH");
  if (restore) {
    report.repair = JSON.parse((await runProcess(resolve("target/debug/rion-session-migration-diagnostics"), [], { signal: abort.signal,
      input: JSON.stringify({ mode: "publishLocalStorage", output_dir: root, expected_clone_sha256: repairCloneSha }) })).stdout);
    report.productionMutationPerformed = true;
    report.source.sourceSelectedForProduction = true;
  }
  report.targetEquality = "allRecordsEqual"; report.persistence = "freshProcessVerified";
  report.externalNetwork = "blocked";
  report.counts = { cookies: a.request.cookieCount, origins: a.request.localStorageOriginCount, entries: a.request.localStorageEntryCount };
} catch (error) {
  report.error = error instanceof Error ? error.message : "UNKNOWN_FAILURE";
  process.exitCode = 1;
} finally {
  if (!created) {
    const context = await readFile(join(root, "source-context.json"), "utf8").then(text => JSON.parse(text).context, () => "");
    created = typeof context === "string" && context.startsWith(`rion-partial-session-snapshot-v1:${opts["--role"]}:`);
  }
  if (created) {
    for (const parent of [root, join(root, "current-local-storage")]) {
      for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && (entry.name.startsWith("plaintext-") || entry.name.startsWith("source-plaintext-"))) await rm(join(parent, entry.name), { recursive: true, force: true });
      }
    }
    if (report.source?.comparison) { delete report.source.comparison.clonePath; delete report.source.comparison.currentOrigins; }
    // Solely this run's isolated Chromium/vault/SQLite tree; encrypted source remains.
    await rm(join(root, ".session-recovery"), { recursive: true, force: true });
    await rm(join(root, "current-local-storage/chromium-copy"), { recursive: true, force: true });
    report.isolatedTargetRemoved = true;
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    await writeFile(join(root, "report.md"), `# Retained LocalStorage offline proof\n\n${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  console.log(JSON.stringify(report));
}
