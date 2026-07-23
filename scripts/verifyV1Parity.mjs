import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const failures = [];

if (manifest.schemaVersion !== 1) {
  failures.push("manifest schemaVersion must be 1");
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

const ids = new Set();
const sourceCases = new Set();
const currentSources = new Map();

for (const entry of manifest.entries ?? []) {
  if (typeof entry.id !== "string" || !entry.id) {
    failures.push("every parity entry requires a stable id");
    continue;
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

  if (!["equivalent", "intentional-change"].includes(entry.disposition)) {
    failures.push(`${entry.id}: unresolved or invalid disposition`);
  }
  if (
    entry.disposition === "intentional-change" &&
    (typeof entry.decision !== "string" || !entry.decision.startsWith("docs/"))
  ) {
    failures.push(`${entry.id}: intentional changes require a docs/ decision reference`);
  }
  if (
    entry.disposition === "intentional-change" &&
    (typeof entry.reason !== "string" || entry.reason.trim().length < 20)
  ) {
    failures.push(`${entry.id}: intentional changes require a concrete reason`);
  }
  if (entry.disposition === "intentional-change" && entry.decision) {
    try {
      await stat(resolve(projectRoot, entry.decision));
    } catch {
      failures.push(`${entry.id}: decision document does not exist: ${entry.decision}`);
    }
  }
  if (!Array.isArray(entry.current) || entry.current.length === 0) {
    failures.push(`${entry.id}: at least one current test mapping is required`);
    continue;
  }

  for (const mapping of entry.current) {
    if (!mapping.file || !mapping.test) {
      failures.push(`${entry.id}: current mappings require file and test`);
      continue;
    }
    const absolute = resolve(projectRoot, mapping.file);
    try {
      await stat(absolute);
    } catch {
      failures.push(`${entry.id}: mapped file does not exist: ${mapping.file}`);
      continue;
    }
    let source = currentSources.get(absolute);
    if (source === undefined) {
      source = await readFile(absolute, "utf8");
      currentSources.set(absolute, source);
    }
    if (!source.includes(mapping.test)) {
      failures.push(
        `${entry.id}: mapped test locator is missing from ${mapping.file}: ${mapping.test}`
      );
    }
  }
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
  process.stdout.write(
    `v1 parity verified: ${manifest.entries.length} baseline behaviors, ` +
      `${ids.size} resolved mappings, 0 unresolved\n`
  );
}

function renderReport(value) {
  const grouped = Map.groupBy(value.entries, (entry) => entry.area);
  const lines = [
    "# v1.37.0 Rust surface parity",
    "",
    `Baseline: \`${value.baseline.tag}\` (` + `\`${value.baseline.commit}\`)`,
    "",
    "This report is generated from `tests/parity/v1.37.0-rust-surface.json`.",
    "Every listed v1 behavior must retain at least one live Rust or Vitest mapping.",
    ""
  ];
  for (const [area, entries] of [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const equivalent = entries.filter(
      (entry) => entry.disposition === "equivalent"
    ).length;
    const intentional = entries.length - equivalent;
    lines.push(
      `## ${area}`,
      "",
      `- Behaviors: ${entries.length}`,
      `- Equivalent: ${equivalent}`,
      `- Intentional architecture changes: ${intentional}`,
      ""
    );
    for (const entry of entries) {
      const targets = entry.current
        .map((mapping) => `\`${mapping.file}\` — \`${mapping.test}\``)
        .join("; ");
      lines.push(
        `- **${entry.id}** — ${entry.contract}`,
        `  - v1: \`${entry.source.file}\` — ${entry.source.test}`,
        `  - current: ${targets}`,
        ...(entry.decision ? [`  - decision: \`${entry.decision}\``] : []),
        ...(entry.reason ? [`  - reason: ${entry.reason}`] : [])
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
