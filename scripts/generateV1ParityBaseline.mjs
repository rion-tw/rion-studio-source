import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(
  projectRoot,
  "tests/parity/v1.37.0-rust-surface.json"
);
const baseline = {
  tag: "v1.37.0",
  commit: "a3c7504da111c43d25c098c3b178fa2add8b668e"
};
const files = [
  ["tests/background-activity-migration.test.ts", "state/migration"],
  ["tests/browser-font-applier.test.ts", "resource/platform"],
  ["tests/browser-fonts.test.ts", "resource/platform"],
  ["tests/browser-launch-configuration.test.ts", "browser/workspace"],
  ["tests/browser-manager.test.ts", "browser/workspace"],
  ["tests/browser-proxy-applier.test.ts", "browser/workspace"],
  ["tests/cdn-compatibility-manager.test.ts", "external Chrome/CDN"],
  ["tests/chrome-profile-import-manager.test.ts", "portable/profile"],
  ["tests/chrome-profile-session-importer.test.ts", "portable/profile"],
  ["tests/chrome-zoom-preference-applier.test.ts", "browser/workspace"],
  ["tests/electron-automation-target.test.ts", "effect lifecycle"],
  ["tests/electron-builder-config.test.ts", "platform/effect lifecycle"],
  ["tests/electron-workspace-resource-target.test.ts", "resource/platform"],
  ["tests/embedded-runtime-diagnostics.test.ts", "logging"],
  ["tests/external-chrome-automation-target.test.ts", "external Chrome/CDN"],
  ["tests/external-chrome-manager.test.ts", "external Chrome/CDN"],
  ["tests/game-browser-settings-store.test.ts", "state/migration"],
  ["tests/game-compatibility-manager.test.ts", "browser/workspace"],
  ["tests/game-store.test.ts", "state/migration"],
  ["tests/graphics-diagnostics-service.test.ts", "resource/platform"],
  ["tests/launch-workspace-store.test.ts", "state/migration"],
  ["tests/legal-acceptance-store.test.ts", "state/migration"],
  ["tests/log-sanitizer.test.ts", "logging"],
  ["tests/log-service.test.ts", "logging"],
  ["tests/macro-manager.test.ts", "macro"],
  ["tests/macro-overlay-injector.test.ts", "overlay"],
  ["tests/macro-overlay-interactions.test.ts", "overlay"],
  ["tests/macro-settings-store.test.ts", "state/migration"],
  ["tests/macro-store.test.ts", "state/migration"],
  ["tests/portable-data-manager.test.ts", "portable/profile"],
  ["tests/release-workflows.test.ts", "platform/effect lifecycle"],
  ["tests/renderer-status-indicators.test.tsx", "macro"],
  ["tests/role-browser-data-manager.test.ts", "portable/profile"],
  ["tests/role-store.test.ts", "state/migration"],
  ["tests/runtime-window-preferences-store.test.ts", "state/migration"],
  ["tests/settings-graphics-restart.test.ts", "resource/platform"],
  ["tests/startup-window.test.ts", "platform/effect lifecycle"],
  ["tests/system-chrome-closer.test.ts", "resource/platform"],
  ["tests/system-font-service.test.ts", "resource/platform"],
  ["tests/system-pressure-monitor.test.ts", "resource/platform"],
  ["tests/windows-external-chrome-window-bounds-adapter.test.ts", "resource/platform"],
  ["tests/windows-graphics-event-collector.test.ts", "resource/platform"],
  ["tests/windows-window-frame-helper-project.test.ts", "resource/platform"],
  ["tests/workspace-adaptive-zoom.test.ts", "browser/workspace"],
  ["tests/workspace-layout.test.ts", "browser/workspace"],
  ["tests/workspace-resource-coordinator.test.ts", "resource/platform"],
  ["tests/zip-writer.test.ts", "logging"]
];

const previous = await readPreviousManifest();
const previousById = new Map(
  (previous?.entries ?? []).map((entry) => [entry.id, entry])
);
const legacyTargetUsage = new Map();
if (previous?.schemaVersion === 1) {
  for (const entry of previous.entries) {
    for (const mapping of entry.current ?? []) {
      const key = `${mapping.file}\0${mapping.test}`;
      legacyTargetUsage.set(key, (legacyTargetUsage.get(key) ?? 0) + 1);
    }
  }
}

const sources = [];
const inventory = [];
for (const [file, area] of files) {
  const source = gitShow(file);
  const cases = extractTestCases(source, file);
  sources.push({
    file,
    area,
    sha256: createHash("sha256").update(source).digest("hex"),
    behaviorCount: cases.length
  });
  for (const testCase of cases) {
    inventory.push({
      id: behaviorId(area, file, testCase),
      area,
      contract: testCase.variant
        ? `${testCase.title} (${testCase.variant})`
        : testCase.title,
      source: {
        file,
        test: testCase.variant
          ? `${testCase.title} [${testCase.variant}]`
          : testCase.title
      }
    });
  }
}

const entries = inventory.map((candidate) => {
  const existing = previousById.get(candidate.id);
  if (!existing) {
    return { ...candidate, classification: "unresolved", current: [] };
  }
  if (previous.schemaVersion === 2) {
    return {
      ...candidate,
      classification: existing.classification,
      ...(existing.decision ? { decision: existing.decision } : {}),
      ...(existing.reason ? { reason: existing.reason } : {}),
      current: existing.current ?? [],
      ...(existing.suggestedCurrent
        ? { suggestedCurrent: existing.suggestedCurrent }
        : {})
    };
  }
  return migrateLegacyEntry(candidate, existing);
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify({ schemaVersion: 2, baseline, sources, entries }, null, 2)}\n`
);
process.stdout.write(
  `wrote ${entries.length} v1 Rust-surface behaviors; ` +
    `${entries.filter((entry) => entry.classification === "unresolved").length} unresolved\n`
);

function migrateLegacyEntry(candidate, existing) {
  const direct =
    existing.current?.length === 1 &&
    existing.current[0].file === candidate.source.file &&
    candidate.source.test.startsWith(existing.current[0].test) &&
    legacyTargetUsage.get(
      `${existing.current[0].file}\0${existing.current[0].test}`
    ) === 1;
  if (direct) {
    return {
      ...candidate,
      classification: "direct-test",
      current: existing.current
    };
  }
  return {
    ...candidate,
    classification:
      existing.disposition === "intentional-change"
        ? "intentional-change"
        : "unresolved",
    ...(existing.decision ? { decision: existing.decision } : {}),
    ...(existing.reason ? { reason: existing.reason } : {}),
    current: [],
    ...(existing.current?.length > 0
      ? { suggestedCurrent: existing.current }
      : {})
  };
}

async function readPreviousManifest() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return undefined;
  }
}

function gitShow(file) {
  return execFileSync("git", ["show", `${baseline.commit}:${file}`], {
    cwd: projectRoot,
    encoding: "utf8"
  });
}

function extractTestCases(source, file) {
  const syntax = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, syntax);
  const cases = [];
  visit(tree);
  return cases;

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const direct = isTestIdentifier(node.expression);
      const parameterized = isParameterizedTest(node.expression);
      if ((direct || parameterized) && node.arguments.length > 0) {
        const title = stringValue(node.arguments[0]);
        if (title) {
          const variants = parameterized
            ? parameterizedVariants(node.expression.arguments[0], tree)
            : [];
          if (variants.length > 0) {
            variants.forEach((variant) => cases.push({ title, variant }));
          } else {
            cases.push({ title });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
}

function isTestIdentifier(expression) {
  return ts.isIdentifier(expression) && ["it", "test"].includes(expression.text);
}

function isParameterizedTest(expression) {
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    ["it", "test"].includes(expression.expression.expression.text) &&
    expression.expression.name.text === "each"
  );
}

function parameterizedVariants(value, tree, seen = new Set()) {
  const unwrapped = unwrapExpression(value);
  if (ts.isIdentifier(unwrapped)) {
    if (seen.has(unwrapped.text)) return [];
    const initializer = variableInitializer(tree, unwrapped.text);
    if (!initializer) return [];
    return parameterizedVariants(initializer, tree, new Set([...seen, unwrapped.text]));
  }
  if (!ts.isArrayLiteralExpression(unwrapped)) return [];
  const elements = unwrapped.elements.flatMap((element) => {
    if (!ts.isSpreadElement(element)) return [element];
    return expandedElements(element.expression, tree, seen);
  });
  return elements.map((element, index) => {
    if (ts.isObjectLiteralExpression(element)) {
      const parts = element.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property)) return [];
        const name = property.name.getText().replaceAll(/['"]/g, "");
        return [`${name}=${variantValue(property.initializer, tree)}`];
      });
      if (parts.length > 0) return parts.join(",");
    }
    return variantValue(element, tree) || `case-${index + 1}`;
  });
}

function stringValue(value) {
  const unwrapped = unwrapExpression(value);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
}

function unwrapExpression(value) {
  let current = value;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function variableInitializer(tree, name) {
  let found;
  visit(tree);
  return found;

  function visit(node) {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function expandedElements(value, tree, seen) {
  const unwrapped = unwrapExpression(value);
  if (ts.isArrayLiteralExpression(unwrapped)) return [...unwrapped.elements];
  if (ts.isIdentifier(unwrapped) && !seen.has(unwrapped.text)) {
    const initializer = variableInitializer(tree, unwrapped.text);
    return initializer
      ? expandedElements(initializer, tree, new Set([...seen, unwrapped.text]))
      : [];
  }
  return [];
}

function variantValue(value, tree) {
  const unwrapped = unwrapExpression(value);
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  if (
    ts.isNumericLiteral(unwrapped) ||
    unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
    unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
    unwrapped.kind === ts.SyntaxKind.NullKeyword
  ) {
    return unwrapped.getText(tree);
  }
  if (ts.isArrayLiteralExpression(unwrapped)) {
    return unwrapped.elements
      .map((element) => variantValue(element, tree))
      .join(",");
  }
  return unwrapped.getText(tree).replaceAll(/\s+/g, " ").trim();
}

function areaId(area) {
  return area.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

function behaviorId(area, file, testCase) {
  const identity = `${file}\0${testCase.title}\0${testCase.variant ?? ""}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${areaId(area)}-${digest}`;
}
