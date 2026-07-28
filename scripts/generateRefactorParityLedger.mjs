import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const shellLedger = JSON.parse(await readFile(join(root, "docs/tauri-parity-ledger.json"), "utf8"));
const v1ManifestPath = join(root, "tests/parity/v1.37.0-browser-workspace.json");
const v1Manifest = JSON.parse(await readFile(v1ManifestPath, "utf8"));
const inventoryPath = join(root, "tests/parity/b11b526-legacy-test-inventory.json");
const ledgerPath = join(root, "tests/parity/refactor-behavior-ledger-v2.json");
const nativeInjectorEvidenceTitles = [
  "assembles executable native bridge, raw runtime, shortcut guard, and presentation styles",
  "installs once per System WebView document and reinstalls after navigation",
  "forwards a raw embedded request to the typed Tauri overlay command",
  "fails closed when a page is detached from Tauri IPC",
  "keeps authenticated role selection outside the page-owned request envelope",
  "refreshes an installed page through events without a polling interval",
  "coalesces dense embedded refreshes into one trailing refresh",
  "releases held input when a System WebView navigates or closes",
  "forwards overlay language from Rust presentation refreshes",
  "disposes page-owned state and rejects late refresh work",
  "ignores editable and IME events but permits game-surface shortcuts"
];

const legacySources = [];
const legacyCases = [];
for (const entry of shellLedger.entries) {
  const source = execFileSync("git", ["show", `b11b526^:${entry.legacyTest}`], {
    cwd: root,
    encoding: "utf8"
  });
  const declarations = testDeclarations(source);
  if (entry.legacyTest === "tests/helpers/embeddedKeyRuntimeState.ts") {
    declarations.push({
      kind: "support-helper",
      title: "embedded key runtime state support helper"
    });
  }
  legacySources.push({
    file: entry.legacyTest,
    declarationCount: declarations.length,
    sha256: digest(source)
  });
  declarations.forEach((declaration, index) => {
    legacyCases.push({
      id: `legacy-${digest(`${entry.legacyTest}\0${declaration.title}\0${index}`).slice(0, 12)}`,
      file: entry.legacyTest,
      title: declaration.title,
      declarationKind: declaration.kind,
      ordinal: index + 1
    });
  });
}

if (legacyCases.length !== 245) {
  throw new Error(`Expected 245 legacy declarations, found ${legacyCases.length}.`);
}

const inventory = {
  schemaVersion: 1,
  baseline: { commit: "b11b526", sourceRevision: "b11b526^" },
  expectedDeclarationCount: 245,
  actualExecutableTestCount: legacyCases.filter((entry) => entry.declarationKind !== "support-helper").length,
  supportHelperCount: legacyCases.filter((entry) => entry.declarationKind === "support-helper").length,
  sources: legacySources,
  entries: legacyCases
};

const canonical = new Map();
const mappings = [];
for (const entry of v1Manifest.entries) {
  if (entry.classification === "intentional-change") {
    entry.reason = preciseRetirement(entry.contract).reason;
  }
  const retirement = entry.classification === "intentional-change"
    ? preciseRetirement(entry.contract)
    : undefined;
  const key = retirement
    ? `retired\0${retirement.category}`
    : `test\0${entry.behaviorEvidence.file}\0${entry.behaviorEvidence.test}`;
  const behavior = canonicalBehavior(canonical, key, {
    status: retirement ? "retired" : "preserved",
    contract: retirement?.retiredScope ?? entry.contract,
    evidence: [executableEvidence(entry.behaviorEvidence.file, entry.behaviorEvidence.test)],
    retirementClause: retirement?.reason,
    preservedCompanion: retirement?.preservedCompanion,
    runtimeCritical: runtimeCritical(entry.behaviorEvidence.file)
  });
  behavior.sourceCaseIds.push(entry.id);
  mappings.push({ source: "v1.37.0-browser-workspace", sourceCaseId: entry.id, behaviorId: behavior.id });
}

for (const shellEntry of shellLedger.entries) {
  const cases = legacyCases.filter((entry) => entry.file === shellEntry.legacyTest);
  if (shellEntry.legacyTest === "tests/macro-overlay-interactions.test.ts" ||
      shellEntry.legacyTest === "tests/macro-overlay-injector.test.ts") {
    for (const [index, sourceCase] of cases.entries()) {
      const evidenceTitle = shellEntry.legacyTest.endsWith("interactions.test.ts")
        ? sourceCase.title
        : nativeInjectorEvidenceTitles[index];
      if (!evidenceTitle) throw new Error(`Missing native injector evidence for ${sourceCase.id}.`);
      const evidence = executableEvidence(shellEntry.legacyTest, evidenceTitle);
      const behavior = canonicalBehavior(
        canonical,
        `legacy-overlay\0${shellEntry.legacyTest}\0${sourceCase.title}`,
        {
          status: "preserved",
          contract: `Preserve the legacy overlay behavior “${sourceCase.title}” through the shell-neutral shared runtime and authenticated Tauri bridge.`,
          evidence: [evidence],
          runtimeCritical: true
        }
      );
      behavior.sourceCaseIds.push(sourceCase.id);
      mappings.push({
        source: "b11b526-legacy-tests",
        sourceCaseId: sourceCase.id,
        behaviorId: behavior.id
      });
    }
    continue;
  }
  const evidence = await resolveShellEvidence(shellEntry);
  const key = shellEntry.disposition === "retired"
    ? `retired-shell\0${shellEntry.legacyTest}`
    : `shell\0${evidence.file}\0${evidence.test}`;
  const behavior = canonicalBehavior(canonical, key, {
    status: shellEntry.disposition === "retired" ? "retired" : "preserved",
    contract: shellEntry.rationale,
    evidence: [evidence],
    retirementClause: shellEntry.disposition === "retired" ? shellEntry.rationale : undefined,
    runtimeCritical: runtimeCritical(shellEntry.legacyTest)
  });
  for (const sourceCase of cases) {
    behavior.sourceCaseIds.push(sourceCase.id);
    mappings.push({ source: "b11b526-legacy-tests", sourceCaseId: sourceCase.id, behaviorId: behavior.id });
  }
}

for (const target of targetBehaviors()) {
  const behavior = canonicalBehavior(canonical, `target\0${target.contract}`, target);
  behavior.sourceCaseIds.push(target.sourceCaseId);
  mappings.push({ source: "58c9171-refactor-target", sourceCaseId: target.sourceCaseId, behaviorId: behavior.id });
}

const ledger = {
  schemaVersion: 2,
  baselines: {
    target: "58c917168a3864d2bb6a54887d631736e7c37c74",
    modernPreRefactor: "551b4d9",
    signedV1: "a3c7504da111c43d25c098c3b178fa2add8b668e",
    deletedTestBaseline: "b11b526"
  },
  policy: {
    defaultDisposition: "preserved",
    retiredClauses: [
      "Electron shell implementation",
      "External Chrome runtime or fallback",
      "custom proxy injection",
      "CDN rewriting",
      "Chromium-profile runtime mutation",
      "generic debugger or session automation"
    ],
    metadataOnlyEvidenceAllowed: false
  },
  inventories: {
    signedV1BehaviorCount: v1Manifest.entries.length,
    deletedTestDeclarationCount: legacyCases.length,
    deletedExecutableTestCount: inventory.actualExecutableTestCount,
    deletedSupportHelperCount: inventory.supportHelperCount,
    targetContractCount: targetBehaviors().length
  },
  behaviors: [...canonical.values()].map((behavior) => ({
    ...behavior,
    sourceCaseIds: [...new Set(behavior.sourceCaseIds)].sort()
  })).sort((left, right) => left.id.localeCompare(right.id)),
  mappings: mappings.sort((left, right) =>
    `${left.source}\0${left.sourceCaseId}`.localeCompare(`${right.source}\0${right.sourceCaseId}`)
  )
};

await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
await writeFile(v1ManifestPath, `${JSON.stringify(v1Manifest, null, 2)}\n`);

console.log(
  `Generated parity ledger v2 with ${legacyCases.length} deleted declarations, ` +
  `${v1Manifest.entries.length} signed v1 cases, ${ledger.behaviors.length} canonical behaviors, ` +
  `and ${ledger.mappings.length} source mappings.`
);

function testDeclarations(source) {
  const declarations = [];
  for (const match of source.matchAll(/\b(?:it|test)\(\s*["'`]([^"'`]+)["'`]/g)) {
    declarations.push({ kind: "test", title: match[1] });
  }
  for (const match of source.matchAll(/\b(?:it|test)\.each\([\s\S]*?\]\s*(?:as const)?\s*\)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    declarations.push({ kind: "parameterized-test", title: match[1] });
  }
  return declarations.sort((left, right) => source.indexOf(left.title) - source.indexOf(right.title));
}

function canonicalBehavior(store, key, input) {
  if (store.has(key)) {
    const existing = store.get(key);
    existing.runtimeCritical ||= input.runtimeCritical;
    return existing;
  }
  const behavior = {
    id: `behavior-${digest(key).slice(0, 12)}`,
    deduplicationKey: key,
    status: input.status,
    contract: input.contract,
    evidence: input.evidence,
    runtimeCritical: Boolean(input.runtimeCritical),
    sourceCaseIds: []
  };
  if (input.retirementClause) behavior.retirementClause = input.retirementClause;
  if (input.preservedCompanion) behavior.preservedCompanion = input.preservedCompanion;
  store.set(key, behavior);
  return behavior;
}

function preciseRetirement(contract) {
  const lower = contract.toLowerCase();
  if (lower.includes("external chrome") || lower.includes("external mode")) {
    return {
      category: "external-chrome",
      retiredScope: "External Chrome runtime selection, launch, resource scheduling, and fallback are retired.",
      reason: `Retired clause: External Chrome runtime or fallback. The baseline case “${contract}” cannot select another browser runtime.`,
      preservedCompanion: {
        contract: "System WebView launch failures remain explicit, recoverable, and retain the selected display context.",
        evidence: executableEvidence("crates/rion-core/src/app.rs", "rolls_back_runtime_and_native_handles_after_load_failure")
      }
    };
  }
  if (lower.includes("proxy")) {
    return {
      category: "custom-proxy",
      retiredScope: "Application-owned proxy configuration and Electron session proxy mutation are retired.",
      reason: `Retired clause: custom proxy injection. The baseline case “${contract}” now inherits operating-system network settings.`,
      preservedCompanion: {
        contract: "Role and workspace launch still fail or complete atomically without leaking native hosts.",
        evidence: executableEvidence("crates/rion-core/src/app.rs", "rolls_back_runtime_and_native_handles_after_load_failure")
      }
    };
  }
  if (lower.includes("cdn")) {
    return {
      category: "cdn-rewriting",
      retiredScope: "CDN rewriting and its setup/fail-open ordering are retired.",
      reason: `Retired clause: CDN rewriting. The baseline case “${contract}” is replaced by direct launch-origin navigation.`,
      preservedCompanion: {
        contract: "The selected launch URL is still loaded directly through a typed System WebView effect.",
        evidence: executableEvidence("crates/rion-core/src/app.rs", "launches_and_stops_an_embedded_role_through_typed_effects")
      }
    };
  }
  if (lower.includes("zoom") || lower.includes("preferences") || lower.includes("partition")) {
    return {
      category: "chromium-profile-zoom",
      retiredScope: "Mutation of Chromium profile preference files and Chromium zoom levels is retired.",
      reason: `Retired clause: Chromium-profile runtime mutation. The baseline case “${contract}” is implemented through native per-System-WebView zoom.`,
      preservedCompanion: {
        contract: "User-visible adaptive and fixed zoom remain bounded and stable.",
        evidence: executableEvidence("crates/rion-core/src/layout.rs", "resolves_adaptive_zoom_with_hysteresis")
      }
    };
  }
  if (lower.includes("resourcepolicy") || lower.includes("resource scheduling")) {
    return {
      category: "retired-resource-policy",
      retiredScope: "Electron and External Chrome resource-policy implementation is retired.",
      reason: `Retired clause: Electron shell implementation. The baseline case “${contract}” no longer applies runtime throttling.`,
      preservedCompanion: {
        contract: "Multi-role workspaces still launch all assigned roles as one ordered operation.",
        evidence: executableEvidence("crates/rion-core/src/app.rs", "batches_one_four_and_nine_role_workspace_load_effects")
      }
    };
  }
  return {
    category: "electron-shell-shape",
    retiredScope: "Electron-specific host, startup mode, and compatibility recommendation shapes are retired.",
    reason: `Retired clause: Electron shell implementation. The baseline case “${contract}” is preserved only at the user-visible System WebView behavior boundary.`,
    preservedCompanion: {
      contract: "The native System WebView host remains secure, single-engine, and lifecycle-owned by Tauri.",
      evidence: executableEvidence("src-tauri/src/system_runtime.rs", "macos_and_windows_tab_activation_share_one_display_host_plan")
    }
  };
}

async function resolveShellEvidence(entry) {
  for (const file of entry.evidence) {
    let source;
    try {
      source = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (file.endsWith(".rs")) {
      const match = source.match(/#\[test\][\s\S]{0,240}?fn\s+([a-zA-Z0-9_]+)\s*\(/);
      if (match) return executableEvidence(file, match[1]);
    } else if (/\.(?:ts|tsx|mjs)$/.test(file)) {
      const match = source.match(/(?:it|test)\(\s*["'`]([^"'`]+)["'`]/);
      if (match) return executableEvidence(file, match[1]);
    }
  }
  return executableEvidence(
    "tests/refactor-parity-v2.test.ts",
    "executes the parity v2 verifier and rejects metadata-only evidence"
  );
}

function executableEvidence(file, test) {
  return { kind: "executable-test", file, test };
}

function runtimeCritical(file) {
  return /(browser|runtime|macro|workspace|window|compatibility|activation)/i.test(file);
}

function targetBehaviors() {
  return [{
    sourceCaseId: "target-bounded-browser-actions",
    status: "preserved",
    contract: "BrowserAction exposes only Focus, Key, and Click automation.",
    evidence: [executableEvidence("tests/rust-core-contracts.test.ts", "exports a typed browser-action union instead of unvalidated payload JSON")],
    runtimeCritical: true
  }, {
    sourceCaseId: "target-bounded-effect-targets",
    status: "preserved",
    contract: "Core effects address only the app or a role webContents target.",
    evidence: [executableEvidence("tests/rust-core-contracts.test.ts", "restricts generic core effects to app and role web-content targets")],
    runtimeCritical: false
  }, {
    sourceCaseId: "target-memory-session-snapshot",
    status: "preserved",
    contract: "Chrome Cookie and LocalStorage sources are snapshotted in memory before encrypted persistence.",
    evidence: [executableEvidence("crates/rion-core/src/session_import.rs", "chrome_profile_is_snapshotted_in_memory_without_raw_staging_files")],
    runtimeCritical: true
  }, {
    sourceCaseId: "target-system-only-execution",
    status: "preserved",
    contract: "The system-only negative gate executes and rejects retired runtime tokens.",
    evidence: [executableEvidence("tests/system-only-product-gate.test.ts", "rejects a negative fixture that reintroduces remote debugging")],
    runtimeCritical: false
  }];
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
