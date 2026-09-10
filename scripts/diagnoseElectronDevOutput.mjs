import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CATEGORY_ORDER = Object.freeze([
  "product-error",
  "toolchain-regression",
  "unclassified",
  "extension-compatibility",
  "macos-framework-noise",
  "gpu-watch"
]);

const RULES = Object.freeze([
  Object.freeze({
    category: "product-error",
    id: "retired-flyff-caret-request",
    recommendation: "Remove the retired overlay diagnostic sender or restore its bounded owner.",
    test: (line) => line.startsWith("Error occurred in handler for 'rion:chromium-role-overlay:v1':")
      && line.includes("flyff-caret-diagnostic")
  }),
  Object.freeze({
    category: "product-error",
    id: "unsupported-appkit-action",
    recommendation: "Add the exact retained AppKit action to its privileged native event consumer.",
    test: (line) => line.includes("[ELECTRON_MACOS_APPKIT_ACTION_UNSUPPORTED]")
  }),
  Object.freeze({
    category: "product-error",
    id: "workspace-divider-transient-receipt",
    recommendation: "Verify the divider consumer accepts the exact transient non-durable receipt.",
    test: (line) => line.includes("[WORKSPACE_DIVIDER_WINDOW_NOT_SAVED]")
  }),
  Object.freeze({
    category: "toolchain-regression",
    id: "ts-rs-serde-attribute-warning",
    recommendation: "Verify the workspace ts-rs dependency enables no-serde-warnings.",
    test: (line) => line.trim() === "warning: failed to parse serde attribute"
  }),
  Object.freeze({
    category: "extension-compatibility",
    id: "unsupported-extension-api",
    recommendation: "Keep the extension warning visible and verify the affected feature before release.",
    test: (line) => line.includes("ExtensionLoadWarning: Warnings loading extension at ")
  }),
  Object.freeze({
    category: "macos-framework-noise",
    id: "macos-tsm-caps-lock",
    recommendation: "Escalate only with a reproducible physical keyboard or Caps Lock defect.",
    test: (line) => line.includes("TSM AdjustCapsLockLEDForKeyTransitionHandling")
  }),
  Object.freeze({
    category: "macos-framework-noise",
    id: "macos-imk-run-loop",
    recommendation: "Escalate only with a reproducible IME, text-input, or focus defect.",
    test: (line) => line.includes("IMKCFRunLoopWakeUpReliable")
  }),
  Object.freeze({
    category: "gpu-watch",
    id: "chromium-shared-image-mailbox",
    recommendation: "Collect Graphics Information if repeated with visual corruption, context loss, or GPU-process exit.",
    test: (line) => line.includes("SharedImageManager::ProduceSkia:")
      && line.includes("non-existent mailbox")
  })
]);

function looksDiagnostic(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("warning:") ||
    /^\(node:\d+\) .*Warning:/u.test(trimmed) ||
    trimmed.startsWith("Error occurred") ||
    /^error(?:\s|:)/iu.test(trimmed) ||
    /:ERROR:[^\]]*\]/u.test(line) ||
    /Electron\[[^\]]+\] error /u.test(line) ||
    /^\[[A-Z][A-Z0-9_]+\]/u.test(trimmed);
}

function findingKey(category, id) {
  return `${category}\0${id}`;
}

export function classifyElectronDevOutput(source) {
  if (typeof source !== "string") {
    throw new TypeError("Electron development output must be a string.");
  }
  const findings = new Map();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const rule = RULES.find((candidate) => candidate.test(line));
    if (rule) {
      const key = findingKey(rule.category, rule.id);
      const existing = findings.get(key);
      findings.set(key, {
        category: rule.category,
        count: (existing?.count ?? 0) + 1,
        id: rule.id,
        recommendation: rule.recommendation,
        samples: existing?.samples ?? [line.trim().slice(0, 240)]
      });
      continue;
    }
    if (!looksDiagnostic(line)) continue;
    const sample = line.trim().slice(0, 240);
    const key = findingKey("unclassified", sample);
    const existing = findings.get(key);
    findings.set(key, {
      category: "unclassified",
      count: (existing?.count ?? 0) + 1,
      id: "unclassified-diagnostic",
      recommendation: "Classify this warning or error before treating the run as clean.",
      samples: [sample]
    });
  }
  const ordered = [...findings.values()].sort((left, right) => {
    const category = CATEGORY_ORDER.indexOf(left.category) -
      CATEGORY_ORDER.indexOf(right.category);
    return category || left.id.localeCompare(right.id) ||
      left.samples[0].localeCompare(right.samples[0]);
  });
  const actionRequired = ordered.some((finding) =>
    ["product-error", "toolchain-regression", "unclassified"].includes(finding.category)
  );
  return Object.freeze({
    exitCode: actionRequired ? 1 : 0,
    findings: Object.freeze(ordered.map((finding) => Object.freeze({
      ...finding,
      samples: Object.freeze(finding.samples)
    }))),
    status: actionRequired ? "action-required" : ordered.length > 0 ? "notes" : "clean"
  });
}

export function formatElectronDevOutputDiagnosis(diagnosis) {
  const lines = [
    `Electron development output diagnosis: ${diagnosis.status}`
  ];
  if (diagnosis.findings.length === 0) {
    lines.push("No warning or error signatures were found.");
    return `${lines.join("\n")}\n`;
  }
  let category;
  for (const finding of diagnosis.findings) {
    if (finding.category !== category) {
      category = finding.category;
      lines.push("", `${category}:`);
    }
    lines.push(`- ${finding.id} x${finding.count}: ${finding.recommendation}`);
    if (finding.category === "unclassified") {
      lines.push(`  sample: ${finding.samples[0]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runElectronDevOutputDiagnostics(
  rawArguments,
  io = Object.freeze({ readFile, stderr: process.stderr, stdout: process.stdout })
) {
  const args = rawArguments.filter((argument) => argument !== "--");
  if (args.length === 1 && args[0] === "--help") {
    io.stdout.write("Usage: diagnose:electron-dev-output -- <log-file|->\n");
    return 0;
  }
  if (args.length !== 1) {
    io.stderr.write("Usage: diagnose:electron-dev-output -- <log-file|->\n");
    return 2;
  }
  try {
    const source = await io.readFile(args[0] === "-" ? 0 : args[0], "utf8");
    const diagnosis = classifyElectronDevOutput(source);
    io.stdout.write(formatElectronDevOutputDiagnosis(diagnosis));
    return diagnosis.exitCode;
  } catch (error) {
    io.stderr.write(`Unable to read Electron development output: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runElectronDevOutputDiagnostics(process.argv.slice(2));
}
