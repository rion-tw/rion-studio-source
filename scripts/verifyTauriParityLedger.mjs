import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ledgerPath = join(root, "docs/tauri-parity-ledger.json");
const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
const allowed = new Set(["retired", "existing-rust-tauri-equivalent", "replacement-added"]);
const failures = [];
const seen = new Set();

if (ledger.baseline !== "b11b526") failures.push("baseline must remain b11b526");
if (ledger.expectedLegacyTestCount !== 57) failures.push("expected legacy test count must remain 57");
if (!Array.isArray(ledger.entries) || ledger.entries.length !== ledger.expectedLegacyTestCount) {
  failures.push(`ledger must classify exactly ${ledger.expectedLegacyTestCount} legacy test files`);
}

for (const entry of ledger.entries ?? []) {
  if (typeof entry.legacyTest !== "string" || !entry.legacyTest.startsWith("tests/")) {
    failures.push("every ledger entry needs a tests/ legacyTest path");
    continue;
  }
  if (seen.has(entry.legacyTest)) failures.push(`duplicate legacy test: ${entry.legacyTest}`);
  seen.add(entry.legacyTest);
  if (!allowed.has(entry.disposition)) {
    failures.push(`${entry.legacyTest} has invalid disposition ${entry.disposition}`);
  }
  if (typeof entry.rationale !== "string" || entry.rationale.trim().length < 24) {
    failures.push(`${entry.legacyTest} needs a concrete rationale`);
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    failures.push(`${entry.legacyTest} has no replacement or retirement evidence`);
    continue;
  }
  for (const evidence of entry.evidence) {
    try {
      await access(join(root, evidence));
    } catch {
      failures.push(`${entry.legacyTest} references missing evidence: ${evidence}`);
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Tauri parity ledger failed:\n- ${failures.join("\n- ")}`);
}
console.log(`Verified ${ledger.entries.length} legacy-shell test classifications against ${ledger.baseline}.`);
