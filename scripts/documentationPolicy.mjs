import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

const ARCHIVE_PREFIX = "docs/validation/archive/";
const ARCHIVE_MANIFEST = `${ARCHIVE_PREFIX}manifest.json`;
const CONTRACT_PREFIX = "docs/contracts/system-runtime/";
const ACTIVE_DOCUMENT_LIMITS = { bytes: 24 * 1024, lines: 220 };
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;

export async function validateDocumentation(rootDirectory) {
  const root = resolve(rootDirectory);
  const failures = [];
  const docs = (await walk(resolve(root, "docs"), root)).map(normalizePath);
  const activeDocs = docs.filter(isActiveEngineeringDocument);
  const catalogPath = resolve(root, "docs/README.md");
  const catalog = await readText(catalogPath, failures, "docs/README.md");

  for (const path of activeDocs.filter((path) => path !== "docs/README.md")) {
    const relativePath = path.slice("docs/".length);
    if (!catalog.includes(`](${relativePath})`) && !catalog.includes(`](${relativePath}#`)) {
      failures.push(`docs/README.md: missing active document ${path}`);
    }
  }

  const languagePaths = [
    "AGENTS.md",
    ".agents/context.md",
    ...await contextDocuments(root),
    ...activeDocs
  ];
  for (const path of languagePaths) {
    const source = await readText(resolve(root, path), failures, path);
    if (CJK_PATTERN.test(source)) failures.push(`${path}: active engineering documentation must be English`);
  }

  for (const path of activeDocs) {
    const source = await readText(resolve(root, path), failures, path);
    failures.push(...await brokenMarkdownLinks(root, path, source));
    failures.push(...await brokenRepositoryReferences(root, path, source));
    if (path.startsWith(CONTRACT_PREFIX)) {
      const bytes = Buffer.byteLength(source);
      const lines = lineCount(source);
      if (bytes > ACTIVE_DOCUMENT_LIMITS.bytes || lines > ACTIVE_DOCUMENT_LIMITS.lines) {
        failures.push(`${path}: ${lines} lines/${bytes} bytes exceeds contract limits`);
      }
    }
  }

  failures.push(...await validateArchive(root, docs));
  const routineContext = await routineContextSource(root, failures);
  if (routineContext.includes(ARCHIVE_PREFIX)) {
    failures.push("AI routine context must not route directly to validation archive files");
  }
  return failures;
}

function isActiveEngineeringDocument(path) {
  if (extname(path) !== ".md") return false;
  if (path.startsWith(ARCHIVE_PREFIX) || path.startsWith("docs/legal/") ||
      path.startsWith("docs/public-repository/")) return false;
  if (/^docs\/README\.(?:ja|zh-CN|zh-TW)\.md$/u.test(path)) return false;
  if (path === "docs/AGENTS.md") return false;
  return true;
}

async function validateArchive(root, docs) {
  const failures = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolve(root, ARCHIVE_MANIFEST), "utf8"));
  } catch (error) {
    return [`${ARCHIVE_MANIFEST}: ${error.message}`];
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)) {
    failures.push(`${ARCHIVE_MANIFEST}: invalid schema`);
    return failures;
  }
  const archiveDocs = docs.filter((path) => path.startsWith(ARCHIVE_PREFIX) && path.endsWith(".md"));
  const entryPaths = new Set();
  for (const entry of manifest.entries) {
    if (!entry.path || entryPaths.has(entry.path)) {
      failures.push(`${ARCHIVE_MANIFEST}: entry paths must be unique`);
      continue;
    }
    entryPaths.add(entry.path);
    let source;
    try { source = await readFile(resolve(root, entry.path)); }
    catch { failures.push(`${ARCHIVE_MANIFEST}: missing archive ${entry.path}`); continue; }
    const digest = createHash("sha256").update(source).digest("hex");
    if (digest !== entry.contentSha256) failures.push(`${entry.path}: archive hash changed`);
  }
  for (const path of archiveDocs) {
    if (!entryPaths.has(path)) failures.push(`${ARCHIVE_MANIFEST}: unregistered archive ${path}`);
  }
  for (const path of entryPaths) {
    if (!archiveDocs.includes(path)) failures.push(`${ARCHIVE_MANIFEST}: stale archive entry ${path}`);
  }
  return failures;
}

async function brokenMarkdownLinks(root, sourcePath, source) {
  const failures = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of source.matchAll(pattern)) {
    const target = match[1].trim().replace(/^<|>$/gu, "");
    if (!target || target.startsWith("#") || /^[a-z]+:/iu.test(target)) continue;
    const withoutAnchor = decodeURIComponent(target.split("#", 1)[0]);
    if (!withoutAnchor) continue;
    const absolute = resolve(root, dirname(sourcePath), withoutAnchor);
    if (!await exists(absolute)) failures.push(`${sourcePath}: broken link ${target}`);
  }
  return failures;
}

async function brokenRepositoryReferences(root, sourcePath, source) {
  const failures = [];
  const pattern = /`((?:AGENTS\.md|\.agents|\.github|crates|docs|e2e|scripts|src|src-tauri|tests)\/[^`\n]+|AGENTS\.md)`/gu;
  for (const match of source.matchAll(pattern)) {
    const target = match[1];
    if (/[?*{}<>]/u.test(target) || target.includes("[")) continue;
    if (!await exists(resolve(root, target))) failures.push(`${sourcePath}: missing repository reference ${target}`);
  }
  return failures;
}

async function routineContextSource(root, failures) {
  const paths = [".agents/context.md", ".agents/context-map.json", ...await contextDocuments(root)];
  const sources = [];
  for (const path of paths) sources.push(await readText(resolve(root, path), failures, path));
  return sources.join("\n");
}

async function contextDocuments(root) {
  const entries = await readdir(resolve(root, ".agents/context"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => `.agents/context/${entry.name}`)
    .sort();
}

async function walk(directory, root) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) results.push(...await walk(path, root));
    else results.push(relative(root, path));
  }
  return results;
}

async function readText(path, failures, label) {
  try { return await readFile(path, "utf8"); }
  catch (error) { failures.push(`${label}: ${error.message}`); return ""; }
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function lineCount(source) {
  if (!source) return 0;
  return source.split(/\r?\n/u).length - (source.endsWith("\n") ? 1 : 0);
}
