import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "vite";
import { exactResponse, runProcess } from "./process.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function buildHelper(root) {
  await build({ configFile: false, logLevel: "silent", build: { ssr: true, outDir: join(root, "helper"),
    rollupOptions: { input: resolve("scripts/migrationDiagnostics/helperEntry.ts"), external: ["electron", /^node:/u],
      output: { format: "es", entryFileNames: "helper.mjs", codeSplitting: false } } } });
  return join(root, "helper", "helper.mjs");
}

export function requestFor(fixture) {
  // Preserve Rust's canonical byte ordering; serializing the outer report's
  // JSON Value again would change the inventory digest.
  const envelope = Buffer.from(fixture.canonicalEnvelopeBase64, "base64");
  const { journal, rolePaths } = fixture;
  return { envelope, request: {
    version: 1, family: "roleSessionMigration", kind: "apply", platform: journal.platform,
    roleId: journal.roleId, transferId: journal.transferId, expectedJournalRevision: journal.journalRevision,
    targetRevision: journal.targetRevision, sourceRevision: journal.sourceRevision, phase: journal.phase,
    rolePaths, envelopeSha256: fixture.evidence.envelopeSha256, inventorySha256: fixture.evidence.inventorySha256,
    cookieCount: fixture.evidence.cookieCount, localStorageOriginCount: fixture.evidence.localStorageOriginCount,
    localStorageEntryCount: fixture.evidence.localStorageEntryCount, envelopeBytes: envelope.length
  } };
}

export async function invoke(root, entry, request, envelope, signal) {
  const environment = { ...process.env, RION_MIGRATION_DIAGNOSTICS: "1", RION_MIGRATION_DIAGNOSTIC_ROOT: root,
    ELECTRON_NO_ATTACH_CONSOLE: "1" };
  delete environment.ELECTRON_RUN_AS_NODE;
  const metadata = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(16);
  header.write("RCHREQ01"); header.writeUInt32BE(metadata.length, 8); header.writeUInt32BE(envelope.length, 12);
  const result = await runProcess(createRequire(import.meta.url)("electron"), [entry], {
    env: environment, signal, input: Buffer.concat([header, metadata, envelope])
  });
  const parsed = exactResponse(result.stdout, process.platform);
  const pid = Buffer.alloc(4); pid.writeUInt32BE(result.pid);
  const exitEvidence = hash(Buffer.concat([Buffer.from("rion-chrome-profile-helper-exit-v1\0"), pid,
    Buffer.from([0]), createHash("sha256").update(result.stdout).digest()]));
  return { ...parsed, pid: result.pid, exitEvidence };
}

function applied(result, stage) {
  if (result.outcome !== 0) throw new Error(`HELPER_REJECTED:${stage}:${result.metadata.code ?? result.metadata.stableErrorCode ?? "UNKNOWN"}`);
}

export async function verifySynthetic(root, entry, fixtureA, fixtureB, signal) {
  const a = requestFor(fixtureA); const b = requestFor(fixtureB);
  const applyA = await invoke(root, entry, a.request, a.envelope, signal); applied(applyA, "applyA");
  const verifyA = await invoke(root, entry, { ...a.request, kind: "verify", parentExitEvidenceSha256: applyA.exitEvidence }, a.envelope, signal); applied(verifyA, "verifyA");
  const applyB = await invoke(root, entry, b.request, b.envelope, signal); applied(applyB, "applyB");
  const verifyB = await invoke(root, entry, { ...b.request, kind: "verify", parentExitEvidenceSha256: applyB.exitEvidence }, b.envelope, signal); applied(verifyB, "verifyB");
  const rollback = await invoke(root, entry, { ...a.request, kind: "rollback" }, a.envelope, signal); applied(rollback, "rollbackA");
  const empty = await invoke(root, entry, { ...a.request, kind: "rollbackVerify", parentExitEvidenceSha256: rollback.exitEvidence }, a.envelope, signal); applied(empty, "rollbackVerifyA");
  const stillB = await invoke(root, entry, { ...b.request, kind: "verify", parentExitEvidenceSha256: applyB.exitEvidence }, b.envelope, signal); applied(stillB, "verifyBAfterRollbackA");
  if (applyA.pid === verifyA.pid || applyB.pid === verifyB.pid) throw new Error("FRESH_PROCESS_IDENTITY_FAILED");
  if (verifyA.metadata.parentExitEvidenceSha256 !== applyA.exitEvidence || verifyB.metadata.parentExitEvidenceSha256 !== applyB.exitEvidence) {
    throw new Error("FRESH_PARENT_RECEIPT_FAILED");
  }
  return { status: "passed", source: "synthetic", twoRoles: true, exactReadback: true,
    independentProcessPersistence: true, rollbackA: true, roleBAfterRollbackA: true,
    externalNetwork: "blocked", productionJournalsModified: false,
    verificationProcessIds: [verifyA.pid, verifyB.pid, stillB.pid] };
}
