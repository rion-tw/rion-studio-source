import { readFile, stat, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(
  projectRoot,
  "tests/parity/v1.37.0-rust-surface.json"
);
const reportPath = resolve(projectRoot, "docs/v1.37-rust-parity.md");
const expectedBaseline = {
  tag: "v1.37.0",
  commit: "a3c7504da111c43d25c098c3b178fa2add8b668e"
};
const classifications = new Set([
  "direct-test",
  "assertion-case",
  "intentional-change",
  "unresolved"
]);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const failures = [];
const ids = new Set();
const sourceCases = new Set();
const caseIds = new Set();
const currentSources = new Map();
const targetUsage = new Map();

if (manifest.schemaVersion !== 2) {
  failures.push("manifest schemaVersion must be 2");
}
if (
  manifest.baseline?.tag !== expectedBaseline.tag ||
  manifest.baseline?.commit !== expectedBaseline.commit
) {
  failures.push("manifest baseline does not match the pinned v1.37.0 commit");
}
if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  failures.push("manifest entries must be a non-empty array");
}
validateSourceInventory(manifest);

for (const entry of manifest.entries ?? []) {
  for (const mapping of entry.current ?? []) {
    if (!mapping.file || !mapping.test) continue;
    const key = targetKey(mapping);
    targetUsage.set(key, (targetUsage.get(key) ?? 0) + 1);
  }
}

for (const entry of manifest.entries ?? []) {
  validateEntry(entry);
}

const report = renderReport(manifest);
if (process.argv.includes("--write-report")) {
  await writeFile(reportPath, report);
} else {
  let currentReport;
  try {
    currentReport = await readFile(reportPath, "utf8");
  } catch {
    failures.push("human-readable parity report is missing");
  }
  if (currentReport !== undefined && currentReport !== report) {
    failures.push("human-readable parity report is stale; run verify:v1-parity:write");
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`v1 parity: ${failure}\n`);
  process.exitCode = 1;
} else {
  const counts = classificationCounts(manifest.entries);
  process.stdout.write(
    `v1 parity verified: ${manifest.entries.length} baseline behaviors, ` +
      `${counts["direct-test"]} direct, ${counts["assertion-case"]} assertion-evidenced, ` +
      `${counts["intentional-change"]} intentional, 0 unresolved, 0 weak fanout\n`
  );
}

async function validateEntry(entry) {
  if (typeof entry.id !== "string" || !entry.id) {
    failures.push("every parity entry requires a stable id");
    return;
  }
  if (ids.has(entry.id)) failures.push(`duplicate parity id: ${entry.id}`);
  ids.add(entry.id);

  if (!entry.area || !entry.contract || !entry.source?.file || !entry.source?.test) {
    failures.push(`${entry.id}: area, contract, source.file, and source.test are required`);
  }
  const sourceCase = `${entry.source?.file ?? ""}\0${entry.source?.test ?? ""}`;
  if (sourceCases.has(sourceCase)) {
    failures.push(`${entry.id}: duplicate baseline source case`);
  }
  sourceCases.add(sourceCase);

  if (!classifications.has(entry.classification)) {
    failures.push(`${entry.id}: invalid classification`);
  }
  if (entry.classification === "unresolved") {
    failures.push(`${entry.id}: unresolved behavior`);
  }
  if (entry.classification === "intentional-change") {
    if (typeof entry.decision !== "string" || !entry.decision.startsWith("docs/")) {
      failures.push(`${entry.id}: intentional changes require a docs/ decision reference`);
    } else {
      try {
        await stat(resolve(projectRoot, entry.decision));
      } catch {
        failures.push(`${entry.id}: decision document does not exist: ${entry.decision}`);
      }
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
      failures.push(`${entry.id}: intentional changes require a concrete reason`);
    }
  } else if (entry.decision !== undefined || entry.reason !== undefined) {
    failures.push(`${entry.id}: only intentional changes may carry decision metadata`);
  }

  if (!Array.isArray(entry.current) || entry.current.length === 0) {
    failures.push(`${entry.id}: at least one current test mapping is required`);
    return;
  }

  for (const mapping of entry.current) {
    await validateMapping(entry, mapping);
  }
}

async function validateMapping(entry, mapping) {
  if (!mapping.file || !mapping.test) {
    failures.push(`${entry.id}: current mappings require file and test`);
    return;
  }
  const absolute = resolve(projectRoot, mapping.file);
  try {
    await stat(absolute);
  } catch {
    failures.push(`${entry.id}: mapped file does not exist: ${mapping.file}`);
    return;
  }
  let source = currentSources.get(absolute);
  if (source === undefined) {
    source = await readFile(absolute, "utf8");
    currentSources.set(absolute, source);
  }
  const scope = testScope(source, mapping.file, mapping.test);
  if (scope === undefined) {
    failures.push(
      `${entry.id}: mapped test locator is missing from ${mapping.file}: ${mapping.test}`
    );
    return;
  }

  const requiresCase =
    entry.classification === "assertion-case" ||
    (entry.classification === "intentional-change" &&
      (mapping.caseId !== undefined || (targetUsage.get(targetKey(mapping)) ?? 0) > 1));

  if (requiresCase) {
    if (typeof mapping.caseId !== "string" || mapping.caseId !== entry.id) {
      failures.push(`${entry.id}: assertion evidence requires caseId equal to the behavior id`);
      return;
    }
    if (caseIds.has(mapping.caseId)) {
      failures.push(`${entry.id}: duplicate assertion caseId: ${mapping.caseId}`);
    }
    caseIds.add(mapping.caseId);
    const occurrences = stringOccurrences(scope, mapping.caseId);
    if (occurrences !== 1) {
      failures.push(
        `${entry.id}: caseId must appear exactly once inside ${mapping.file} :: ${mapping.test}`
      );
    }
    const wrapper = mapping.file.endsWith(".rs") ? "v1_case!" : "v1Case(";
    if (!scope.includes(wrapper)) {
      failures.push(
        `${entry.id}: assertion evidence is not executed through ${wrapper} in ${mapping.file}`
      );
    }
  } else {
    if (mapping.caseId !== undefined) {
      failures.push(`${entry.id}: direct-test mappings must not carry caseId`);
    }
    if ((targetUsage.get(targetKey(mapping)) ?? 0) > 1) {
      failures.push(
        `${entry.id}: weak fanout requires assertion-case evidence for ${mapping.file} :: ${mapping.test}`
      );
    }
  }
}

function targetKey(mapping) {
  return `${mapping.file}\0${mapping.test}`;
}

function validateSourceInventory(value) {
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    failures.push("manifest sources must be a non-empty signed inventory");
    return;
  }
  const declared = new Map();
  for (const source of value.sources) {
    if (
      !source.file ||
      !source.area ||
      !Number.isInteger(source.behaviorCount) ||
      !/^[a-f0-9]{64}$/.test(source.sha256 ?? "")
    ) {
      failures.push("every signed source requires file, area, behaviorCount, and sha256");
      continue;
    }
    if (declared.has(source.file)) {
      failures.push(`duplicate signed source file: ${source.file}`);
    }
    declared.set(source.file, source);
  }
  const actual = Map.groupBy(value.entries ?? [], (entry) => entry.source?.file);
  for (const [file, source] of declared) {
    const entries = actual.get(file) ?? [];
    if (entries.length !== source.behaviorCount) {
      failures.push(
        `${file}: signed behaviorCount ${source.behaviorCount} does not match ${entries.length} entries`
      );
    }
    if (entries.some((entry) => entry.area !== source.area)) {
      failures.push(`${file}: entry area does not match the signed source area`);
    }
  }
  for (const file of actual.keys()) {
    if (!declared.has(file)) failures.push(`entry references undeclared baseline source: ${file}`);
  }
}

function stringOccurrences(source, value) {
  return source.split(value).length - 1;
}

function testScope(source, file, title) {
  if (file.endsWith(".rs")) return rustTestScope(source, title);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(extname(file))) {
    return typescriptTestScope(source, file, title);
  }
  return source.includes(title) ? source : undefined;
}

function typescriptTestScope(source, file, title) {
  const syntax = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, syntax);
  let found;
  visit(tree);
  return found;

  function visit(node) {
    if (found !== undefined) return;
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      stringValue(node.arguments[0]) === title &&
      isTestCall(node.expression)
    ) {
      found = node.getText(tree);
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function isTestCall(expression) {
  if (ts.isIdentifier(expression)) return ["it", "test"].includes(expression.text);
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    ["it", "test"].includes(expression.expression.expression.text) &&
    expression.expression.name.text === "each"
  );
}

function stringValue(value) {
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function rustTestScope(source, testName) {
  const escaped = testName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:async\\s+)?fn\\s+${escaped}\\s*\\(`).exec(source);
  if (!match) return undefined;
  const open = source.indexOf("{", match.index + match[0].length);
  if (open < 0) return undefined;
  const close = matchingRustBrace(source, open);
  return close < 0 ? undefined : source.slice(match.index, close + 1);
}

function matchingRustBrace(source, open) {
  let depth = 0;
  let mode = "code";
  let rawHashes = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (char === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "string" || mode === "char") {
      if (char === "\\") {
        index += 1;
      } else if (
        (mode === "string" && char === '"') ||
        (mode === "char" && char === "'")
      ) {
        mode = "code";
      }
      continue;
    }
    if (mode === "raw-string") {
      if (
        char === '"' &&
        source.slice(index + 1, index + 1 + rawHashes) === "#".repeat(rawHashes)
      ) {
        index += rawHashes;
        mode = "code";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
    } else if (char === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
    } else if (char === '"') {
      mode = "string";
    } else if (char === "'") {
      mode = "char";
    } else if (char === "r") {
      const raw = /^r(#+)?"/.exec(source.slice(index));
      if (raw) {
        rawHashes = raw[1]?.length ?? 0;
        index += raw[0].length - 1;
        mode = "raw-string";
      }
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function classificationCounts(entries) {
  const counts = {
    "direct-test": 0,
    "assertion-case": 0,
    "intentional-change": 0,
    unresolved: 0
  };
  for (const entry of entries) counts[entry.classification] += 1;
  return counts;
}

function renderReport(value) {
  const grouped = Map.groupBy(value.entries, (entry) => entry.area);
  const total = classificationCounts(value.entries);
  const lines = [
    "# v1.37.0 Rust surface parity",
    "",
    `Baseline: \`${value.baseline.tag}\` (` + `\`${value.baseline.commit}\`)`,
    "",
    "This report is generated from `tests/parity/v1.37.0-rust-surface.json`.",
    "Assertion cases are executable evidence inside the named current test.",
    "",
    `- Behaviors: ${value.entries.length}`,
    `- Direct tests: ${total["direct-test"]}`,
    `- Assertion-evidenced: ${total["assertion-case"]}`,
    `- Intentional architecture changes: ${total["intentional-change"]}`,
    `- Unresolved: ${total.unresolved}`,
    ""
  ];
  for (const [area, entries] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const counts = classificationCounts(entries);
    lines.push(
      `## ${area}`,
      "",
      `- Behaviors: ${entries.length}`,
      `- Direct tests: ${counts["direct-test"]}`,
      `- Assertion-evidenced: ${counts["assertion-case"]}`,
      `- Intentional architecture changes: ${counts["intentional-change"]}`,
      `- Unresolved: ${counts.unresolved}`,
      ""
    );
    for (const entry of entries) {
      const targets = (entry.current ?? [])
        .map(
          (mapping) =>
            `\`${mapping.file}\` — \`${mapping.test}\`` +
            (mapping.caseId ? ` — case \`${mapping.caseId}\`` : "")
        )
        .join("; ");
      lines.push(
        `- **${entry.id}** (${entry.classification}) — ${entry.contract}`,
        `  - v1: \`${entry.source.file}\` — ${entry.source.test}`,
        `  - current: ${targets || "_unresolved_"}`,
        ...(entry.decision ? [`  - decision: \`${entry.decision}\``] : []),
        ...(entry.reason ? [`  - reason: ${entry.reason}`] : [])
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
