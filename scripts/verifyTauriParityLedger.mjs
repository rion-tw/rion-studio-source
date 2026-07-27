import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const shellLedgerPath = join(root, "docs/tauri-parity-ledger.json");
const behaviorManifestPath = join(root, "tests/parity/v1.37.0-browser-workspace.json");
const legacyInventoryPath = join(root, "tests/parity/b11b526-legacy-test-inventory.json");
const refactorLedgerPath = join(root, "tests/parity/refactor-behavior-ledger-v2.json");
const reportPath = process.env.RION_STUDIO_PARITY_REPORT_PATH
  ?? join(root, "docs/v1.37-browser-workspace-parity.md");
const shellLedger = JSON.parse(await readFile(shellLedgerPath, "utf8"));
const behaviorManifest = JSON.parse(await readFile(behaviorManifestPath, "utf8"));
const legacyInventory = JSON.parse(await readFile(legacyInventoryPath, "utf8"));
const refactorLedger = JSON.parse(await readFile(refactorLedgerPath, "utf8"));
const failures = [];
const sourceCache = new Map();
let weakFanoutCount = 0;

await validateShellLedger();
await validateBehaviorManifest();
await validateRefactorLedgerV2();

const report = renderBehaviorReport();
if (process.argv.includes("--write-report")) {
  await writeFile(reportPath, report);
} else {
  let current;
  try {
    current = await readFile(reportPath, "utf8");
  } catch {
    failures.push("Browser/Workspace parity report is missing");
  }
  if (
    current !== undefined
    && normalizeLineEndings(current) !== normalizeLineEndings(report)
  ) {
    failures.push("Browser/Workspace parity report is stale; run verify:parity-ledger:write");
  }
}

if (failures.length > 0) {
  throw new Error(`Tauri parity ledger failed:\n- ${failures.join("\n- ")}`);
}

const counts = classificationCounts(behaviorManifest.entries);
console.log(
  `Verified ${shellLedger.entries.length} legacy-shell files and ` +
  `${behaviorManifest.entries.length} Browser/Workspace behaviors: ` +
  `${counts["direct-test"]} direct, ${counts["assertion-case"]} assertion-evidenced, ` +
  `${counts["intentional-change"]} intentional, 0 unresolved, 0 source-only, ` +
  `${weakFanoutCount} weak fanout; parity v2 maps ${refactorLedger.mappings.length} source cases ` +
  `to ${refactorLedger.behaviors.length} canonical behaviors.`
);

function normalizeLineEndings(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

async function validateRefactorLedgerV2() {
  if (legacyInventory.schemaVersion !== 1 || legacyInventory.expectedDeclarationCount !== 245) {
    failures.push("legacy declaration inventory must remain pinned to 245 baseline declarations");
  }
  if (
    legacyInventory.entries?.length !== 245 ||
    legacyInventory.actualExecutableTestCount !== 244 ||
    legacyInventory.supportHelperCount !== 1
  ) {
    failures.push("legacy inventory must distinguish 244 executable tests from its one support helper");
  }
  if (refactorLedger.schemaVersion !== 2) failures.push("refactor parity ledger schemaVersion must be 2");
  const expectedBaselines = {
    target: "58c917168a3864d2bb6a54887d631736e7c37c74",
    modernPreRefactor: "551b4d9",
    signedV1: "a3c7504da111c43d25c098c3b178fa2add8b668e",
    deletedTestBaseline: "b11b526"
  };
  for (const [name, commit] of Object.entries(expectedBaselines)) {
    if (refactorLedger.baselines?.[name] !== commit) {
      failures.push(`refactor parity ledger baseline ${name} must remain ${commit}`);
    }
  }
  if (
    refactorLedger.inventories?.signedV1BehaviorCount !== 226 ||
    refactorLedger.inventories?.deletedTestDeclarationCount !== 245 ||
    refactorLedger.inventories?.deletedExecutableTestCount !== 244 ||
    refactorLedger.inventories?.deletedSupportHelperCount !== 1
  ) {
    failures.push("refactor parity ledger inventory counts are incomplete");
  }

  const sourceIds = new Map([
    ["v1.37.0-browser-workspace", new Set(behaviorManifest.entries.map((entry) => entry.id))],
    ["b11b526-legacy-tests", new Set(legacyInventory.entries.map((entry) => entry.id))],
    ["58c9171-refactor-target", new Set(
      refactorLedger.mappings
        .filter((mapping) => mapping.source === "58c9171-refactor-target")
        .map((mapping) => mapping.sourceCaseId)
    )]
  ]);
  const behaviorIds = new Set();
  const deduplicationKeys = new Set();
  const behaviorSources = new Map();
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const ci = await sourceText(".github/workflows/ci.yml");
  for (const behavior of refactorLedger.behaviors ?? []) {
    if (!behavior.id || behaviorIds.has(behavior.id)) {
      failures.push(`refactor parity behavior has an invalid or duplicate id: ${behavior.id}`);
      continue;
    }
    behaviorIds.add(behavior.id);
    if (!behavior.deduplicationKey || deduplicationKeys.has(behavior.deduplicationKey)) {
      failures.push(`${behavior.id}: canonical behavior needs a unique deduplication key`);
    }
    deduplicationKeys.add(behavior.deduplicationKey);
    if (!new Set(["preserved", "retired"]).has(behavior.status)) {
      failures.push(`${behavior.id}: status must be preserved or retired`);
    }
    if (typeof behavior.contract !== "string" || behavior.contract.trim().length < 24) {
      failures.push(`${behavior.id}: canonical contract is not concrete`);
    }
    if (!Array.isArray(behavior.sourceCaseIds) || behavior.sourceCaseIds.length === 0) {
      failures.push(`${behavior.id}: canonical behavior has no baseline or target source cases`);
    }
    behaviorSources.set(behavior.id, new Set(behavior.sourceCaseIds ?? []));
    if (!Array.isArray(behavior.evidence) || behavior.evidence.length === 0) {
      failures.push(`${behavior.id}: canonical behavior has no executable evidence`);
    }
    for (const evidence of behavior.evidence ?? []) {
      if (evidence.kind !== "executable-test") {
        failures.push(`${behavior.id}: metadata-only evidence is forbidden`);
        continue;
      }
      if (evidence.file === "tests/browser-workspace-parity.test.ts") {
        failures.push(`${behavior.id}: inventory tests cannot serve as runtime behavior evidence`);
      }
      await validateExactTest(behavior.id, evidence.file, evidence.test);
    }
    if (behavior.status === "retired") {
      const clause = behavior.retirementClause ?? "";
      if (clause.length < 24 || !/(retired|退役)/i.test(clause)) {
        failures.push(`${behavior.id}: retired behavior needs an exact retirement clause`);
      }
      if (behavior.preservedCompanion) {
        if (!behavior.preservedCompanion.contract || !behavior.preservedCompanion.evidence) {
          failures.push(`${behavior.id}: composite retirement must preserve its user-visible companion`);
        } else {
          const evidence = behavior.preservedCompanion.evidence;
          await validateExactTest(`${behavior.id} companion`, evidence.file, evidence.test);
        }
      }
    } else if (behavior.retirementClause) {
      failures.push(`${behavior.id}: preserved behavior must not carry a retirement clause`);
    }
    if (behavior.runtimeCritical) {
      const gate = behavior.nativeGate;
      if (!gate || typeof packageJson.scripts?.[gate] !== "string") {
        failures.push(`${behavior.id}: runtime-critical behavior has no package-level native gate`);
      } else if (!ci.includes(`pnpm run ${gate}`)) {
        failures.push(`${behavior.id}: native gate ${gate} is not executed by platform CI`);
      }
    }
  }

  const mapped = new Map();
  for (const mapping of refactorLedger.mappings ?? []) {
    const available = sourceIds.get(mapping.source);
    const key = `${mapping.source}\0${mapping.sourceCaseId}`;
    if (!available?.has(mapping.sourceCaseId)) failures.push(`unknown parity v2 source case: ${key}`);
    if (mapped.has(key)) failures.push(`duplicate parity v2 source mapping: ${key}`);
    mapped.set(key, mapping.behaviorId);
    if (!behaviorIds.has(mapping.behaviorId)) failures.push(`${key}: unknown canonical behavior ${mapping.behaviorId}`);
    if (!behaviorSources.get(mapping.behaviorId)?.has(mapping.sourceCaseId)) {
      failures.push(`${key}: canonical behavior does not claim its mapped source case`);
    }
  }
  for (const [source, ids] of sourceIds) {
    for (const id of ids) {
      if (!mapped.has(`${source}\0${id}`)) failures.push(`${source}/${id}: unresolved parity v2 source case`);
    }
  }
}

async function validateShellLedger() {
  const allowed = new Set(["retired", "existing-rust-tauri-equivalent", "replacement-added"]);
  const seen = new Set();
  if (shellLedger.baseline !== "b11b526") failures.push("shell ledger baseline must remain b11b526");
  if (shellLedger.expectedLegacyTestCount !== 57) {
    failures.push("shell ledger expected legacy test count must remain 57");
  }
  if (!Array.isArray(shellLedger.entries) || shellLedger.entries.length !== 57) {
    failures.push("shell ledger must classify exactly 57 legacy test files");
  }
  for (const entry of shellLedger.entries ?? []) {
    if (typeof entry.legacyTest !== "string" || !entry.legacyTest.startsWith("tests/")) {
      failures.push("every shell ledger entry needs a tests/ legacyTest path");
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
    if (!entry.evidence.some(isTestEvidencePath)) {
      failures.push(`${entry.legacyTest} has source-only evidence`);
    }
    for (const evidence of entry.evidence) await requireFile(entry.legacyTest, evidence);
  }
}

async function validateBehaviorManifest() {
  const allowed = new Set(["direct-test", "assertion-case", "intentional-change"]);
  const ids = new Set();
  const sourceCases = new Set();
  const caseIds = new Set();
  const evidenceConsumers = new Map();
  const baselineEvidenceCounts = { resolvable: 0, stale: 0 };
  if (behaviorManifest.schemaVersion !== 1) failures.push("behavior manifest schemaVersion must be 1");
  if (
    behaviorManifest.baseline?.tag !== "v1.37.0" ||
    behaviorManifest.baseline?.commit !== "a3c7504da111c43d25c098c3b178fa2add8b668e"
  ) {
    failures.push("behavior manifest must remain pinned to v1.37.0/a3c7504");
  }
  if (behaviorManifest.expectedBehaviorCount !== 226) {
    failures.push("behavior manifest expectedBehaviorCount must remain 226");
  }
  if (!Array.isArray(behaviorManifest.entries) || behaviorManifest.entries.length !== 226) {
    failures.push("behavior manifest must classify exactly 226 Browser/Workspace cases");
  }
  if (
    behaviorManifest.initialAudit?.resolvableEvidenceMappings !== 39 ||
    behaviorManifest.initialAudit?.staleEvidenceMappings !== 187
  ) {
    failures.push("initial audit must preserve the measured 39 resolvable / 187 stale split");
  }

  const declaredSources = new Map();
  for (const source of behaviorManifest.sources ?? []) {
    if (!source.file || source.area !== "browser/workspace" ||
        !Number.isInteger(source.behaviorCount) || !/^[a-f0-9]{64}$/.test(source.sha256 ?? "")) {
      failures.push("every signed Browser/Workspace source needs file, area, count, and sha256");
      continue;
    }
    declaredSources.set(source.file, source);
  }
  const actualSourceCounts = new Map();

  for (const entry of behaviorManifest.entries ?? []) {
    if (!entry.id || ids.has(entry.id)) failures.push(`invalid or duplicate behavior id: ${entry.id}`);
    ids.add(entry.id);
    if (entry.area !== "browser/workspace" || !entry.contract || !entry.source?.file || !entry.source?.test) {
      failures.push(`${entry.id}: area, contract, source.file, and source.test are required`);
    }
    const sourceCase = `${entry.source?.file ?? ""}\0${entry.source?.test ?? ""}`;
    if (sourceCases.has(sourceCase)) failures.push(`${entry.id}: duplicate baseline source case`);
    sourceCases.add(sourceCase);
    actualSourceCounts.set(entry.source?.file, (actualSourceCounts.get(entry.source?.file) ?? 0) + 1);
    if (!allowed.has(entry.classification)) failures.push(`${entry.id}: invalid classification`);
    if (!new Set(["resolvable", "stale"]).has(entry.baselineEvidenceState)) {
      failures.push(`${entry.id}: baselineEvidenceState must be resolvable or stale`);
    } else {
      baselineEvidenceCounts[entry.baselineEvidenceState] += 1;
    }
    if (entry.classification === "intentional-change") {
      if (entry.decision !== "docs/system-native-engine-tauri-plan.md") {
        failures.push(`${entry.id}: intentional changes require the System WebView decision`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length < 40) {
        failures.push(`${entry.id}: intentional changes require a concrete reason`);
      }
    } else if (entry.decision !== undefined || entry.reason !== undefined) {
      failures.push(`${entry.id}: only intentional changes may carry decision metadata`);
    }

    if (!Array.isArray(entry.current) || entry.current.length !== 1) {
      failures.push(`${entry.id}: exactly one executable audit case is required`);
    } else {
      const mapping = entry.current[0];
      if (mapping.file !== "tests/browser-workspace-parity.test.ts" ||
          mapping.test !== "executes every classified browser/workspace parity case" ||
          mapping.caseId !== entry.id) {
        failures.push(`${entry.id}: audit mapping must use its unique case ID`);
      }
      if (caseIds.has(mapping.caseId)) failures.push(`${entry.id}: duplicate audit case ID`);
      caseIds.add(mapping.caseId);
    }

    const evidence = entry.behaviorEvidence;
    if (!evidence?.file || !evidence?.test) {
      failures.push(`${entry.id}: exact behaviorEvidence file and test are required`);
    } else {
      await validateExactTest(entry.id, evidence.file, evidence.test);
      const evidenceKey = `${evidence.file}\0${evidence.test}`;
      const consumers = evidenceConsumers.get(evidenceKey) ?? [];
      consumers.push(entry);
      evidenceConsumers.set(evidenceKey, consumers);
      if (entry.classification === "intentional-change" &&
          (evidence.file !== "tests/system-only-product-gate.test.ts" ||
           evidence.test !== "is a required CI and signed-candidate check")) {
        failures.push(`${entry.id}: retired behavior must cite the executable system-only gate`);
      }
    }
  }

  for (const [file, source] of declaredSources) {
    if (actualSourceCounts.get(file) !== source.behaviorCount) {
      failures.push(`${file}: signed count ${source.behaviorCount} does not match ${actualSourceCounts.get(file) ?? 0}`);
    }
  }
  for (const file of actualSourceCounts.keys()) {
    if (!declaredSources.has(file)) failures.push(`undeclared signed source: ${file}`);
  }
  if (baselineEvidenceCounts.resolvable !== 39 || baselineEvidenceCounts.stale !== 187) {
    failures.push(
      `entry evidence states must total 39 resolvable / 187 stale, got ` +
      `${baselineEvidenceCounts.resolvable} / ${baselineEvidenceCounts.stale}`
    );
  }

  const auditSource = await sourceText("tests/browser-workspace-parity.test.ts");
  if (!auditSource.includes("v1Case(caseId")) {
    failures.push("behavior audit cases must execute through v1Case(caseId, ...)");
  }
  for (const id of ids) {
    if (occurrences(auditSource, JSON.stringify(id)) !== 1) {
      failures.push(`${id}: case ID must occur exactly once in the executable audit inventory`);
    }
  }
  for (const consumers of evidenceConsumers.values()) {
    if (consumers.length < 2) continue;
    for (const entry of consumers) {
      const mapping = entry.current?.[0];
      const hasStrongCaseAnchor =
        entry.classification === "assertion-case" &&
        mapping?.caseId === entry.id &&
        caseIds.has(entry.id) &&
        occurrences(auditSource, JSON.stringify(entry.id)) === 1;
      const hasStrongRetirementAnchor =
        entry.classification === "intentional-change" &&
        mapping?.caseId === entry.id &&
        entry.decision === "docs/system-native-engine-tauri-plan.md";
      if (!hasStrongCaseAnchor && !hasStrongRetirementAnchor) {
        weakFanoutCount += 1;
        failures.push(
          `${entry.id}: shared behavior evidence requires a unique assertion case ID or retirement decision`
        );
      }
    }
  }
}

async function validateExactTest(id, file, test) {
  if (!isTestEvidencePath(file) && !file.endsWith(".rs")) {
    failures.push(`${id}: production source is not behavior evidence: ${file}`);
    return;
  }
  const source = await sourceText(file).catch(() => undefined);
  if (source === undefined) {
    failures.push(`${id}: behavior evidence file is missing: ${file}`);
    return;
  }
  const found = file.endsWith(".rs")
    ? rustTestExists(source, test)
    : scriptTestExists(source, test);
  if (!found) failures.push(`${id}: exact behavior test is missing: ${file} :: ${test}`);
}

function rustTestExists(source, test) {
  const escaped = escapeRegExp(test);
  return new RegExp(`#\\[test\\][\\s\\S]{0,240}fn\\s+${escaped}\\s*\\(`).test(source);
}

function scriptTestExists(source, test) {
  const escaped = escapeRegExp(test);
  return new RegExp(`(?:it|test)\\(\\s*[\\"'\\x60]${escaped}[\\"'\\x60]`).test(source);
}

function isTestEvidencePath(file) {
  return file.startsWith("tests/") || /(?:^|\/)test(?:s)?(?:\/|\.)/.test(file);
}

async function sourceText(file) {
  if (!sourceCache.has(file)) sourceCache.set(file, await readFile(join(root, file), "utf8"));
  return sourceCache.get(file);
}

async function requireFile(owner, file) {
  try {
    await access(join(root, file));
  } catch {
    failures.push(`${owner} references missing evidence: ${file}`);
  }
}

function occurrences(source, value) {
  return source.split(value).length - 1;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classificationCounts(entries) {
  const counts = { "direct-test": 0, "assertion-case": 0, "intentional-change": 0 };
  for (const entry of entries ?? []) counts[entry.classification] += 1;
  return counts;
}

function renderBehaviorReport() {
  const counts = classificationCounts(behaviorManifest.entries);
  const restoredAssertionCases = behaviorManifest.entries.filter(
    (entry) => entry.baselineEvidenceState === "stale" && entry.classification === "assertion-case"
  ).length;
  const retiredStaleCases = behaviorManifest.entries.filter(
    (entry) => entry.baselineEvidenceState === "stale" && entry.classification === "intentional-change"
  ).length;
  const sourceRows = behaviorManifest.sources
    .map((source) => `| \`${source.file}\` | ${source.behaviorCount} |`)
    .join("\n");
  return `# v1.37.0 Browser/Workspace parity audit

This report is generated from \`tests/parity/v1.37.0-browser-workspace.json\`.

## Result

- Signed baseline behaviors: **226** (the former 148 summary was incorrect).
- Initially resolvable historical evidence mappings: **39**.
- Initially stale historical evidence mappings: **187**. A stale mapping is a coverage finding, not automatically a product defect.
- Current classifications: **${counts["direct-test"]}** direct tests, **${counts["assertion-case"]}** assertion-evidenced replacements, **${counts["intentional-change"]}** intentional System WebView-only changes.
- Remaining: **0 unresolved**, **0 source-only evidence**, **${weakFanoutCount} weak fanout**. Reused broad evidence is accepted only when every behavior has its own executable case ID; intentional changes additionally require the decision record and negative gate.

## Confirmed regressions

1. Per-tab Tauri windows replaced the v1 shared display host, so macOS tab activation swapped whole windows and animated the transition.
2. The AppKit launcher action lost its source display ID at the Objective-C/Rust boundary, causing the role/workspace menu lookup to use display 0 and fail silently.

Both regressions now have focused current tests. HTML tabs did not lose display scope for the launcher action, but shared the per-tab window lifecycle and are covered by the same cross-platform host plan.

## Restored test gaps

- **${restoredAssertionCases}** of the 187 stale mappings now point to an exact executable test plus a unique assertion/case ID.
- The remaining **${retiredStaleCases}** stale mappings are intentional retirements, not claims of current parity.

## Intentional v1 retirements

- **${counts["intentional-change"]}** behaviors depend on Electron, External Chrome, custom proxy, or superseded runtime policy that the System WebView-only architecture intentionally removed.
- Every retirement cites \`docs/system-native-engine-tauri-plan.md\` and the executable \`system-only product gate\`.

## Unresolved

- **0** behaviors remain unclassified. This does not assert that the 187 formerly stale mappings represented 187 product bugs; the audit confirmed the two regressions listed above.

## Signed sources

| v1.37.0 source | Behaviors |
| --- | ---: |
${sourceRows}

Intentional changes cite \`docs/system-native-engine-tauri-plan.md\` and the executable \`system-only product gate\`; all other entries cite an exact current test function or test title.
`;
}
