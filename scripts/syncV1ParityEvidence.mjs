import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import ts from "typescript";

const projectRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(
  projectRoot,
  "tests/parity/v1.37.0-rust-surface.json"
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== 2) {
  throw new Error("Run generateV1ParityBaseline.mjs before syncing evidence.");
}

const entriesById = new Map(manifest.entries.map((entry) => [entry.id, entry]));
const evidence = new Map();
const files = execFileSync("rg", ["--files", "crates", "tests"], {
  cwd: projectRoot,
  encoding: "utf8"
})
  .trim()
  .split("\n")
  .filter((file) => [".rs", ".ts", ".tsx"].includes(extname(file)));

for (const file of files) {
  const source = await readFile(resolve(projectRoot, file), "utf8");
  if (!source.includes("v1_case!") && !source.includes("v1Case(")) continue;
  const scopes = file.endsWith(".rs")
    ? rustTestScopes(source)
    : typescriptTestScopes(source, file);
  for (const scope of scopes) {
    for (const id of entriesById.keys()) {
      if (!scope.source.includes(id)) continue;
      const records = evidence.get(id) ?? [];
      records.push({ file, test: scope.test, caseId: id });
      evidence.set(id, records);
    }
  }
}

for (const entry of manifest.entries) {
  const records = evidence.get(entry.id) ?? [];
  if (records.length > 1) {
    throw new Error(`${entry.id} has duplicate executable evidence.`);
  }
  if (records.length === 1) {
    entry.current = records;
    if (entry.classification !== "intentional-change") {
      entry.classification = "assertion-case";
      delete entry.decision;
      delete entry.reason;
    }
    delete entry.suggestedCurrent;
  } else if (
    entry.classification === "assertion-case" ||
    entry.classification === "intentional-change"
  ) {
    entry.suggestedCurrent ??= entry.current;
    entry.current = [];
    if (entry.classification === "assertion-case") {
      entry.classification = "unresolved";
    }
  }
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `synced ${evidence.size} executable v1 assertion cases; ` +
    `${manifest.entries.filter((entry) => entry.classification === "unresolved").length} unresolved\n`
);

function rustTestScopes(source) {
  const scopes = [];
  const matcher = /(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/g;
  for (const match of source.matchAll(matcher)) {
    const open = source.indexOf("{", match.index + match[0].length);
    if (open < 0) continue;
    const close = matchingRustBrace(source, open);
    if (close < 0) continue;
    const body = source.slice(match.index, close + 1);
    if (body.includes("v1_case!")) {
      scopes.push({ test: match[1], source: body });
    }
  }
  return scopes;
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
      if (char === "\\") index += 1;
      else if (
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

function typescriptTestScopes(source, file) {
  const syntax = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, syntax);
  const scopes = [];
  visit(tree);
  return scopes;

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      isTestCall(node.expression)
    ) {
      const title = stringValue(node.arguments[0]);
      const body = node.getText(tree);
      if (title && body.includes("v1Case(")) {
        scopes.push({ test: title, source: body });
      }
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
