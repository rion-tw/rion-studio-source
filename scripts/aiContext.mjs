import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP_PATH = ".agents/context-map.json";
const CHANGE_KINDS = new Set([
  "compile-only",
  "internal-only",
  "lower-layer-covered",
  "unknown",
  "user-visible"
]);
const ROUTED_ROOTS = [
  ".agents/",
  ".github/",
  "crates/",
  "docs/",
  "e2e/",
  "release/",
  "scripts/",
  "src-tauri/",
  "src/",
  "tests/"
];
const ROUTED_ROOT_FILES = new Set([
  "AGENTS.md",
  "Cargo.lock",
  "Cargo.toml",
  "eslint.config.mjs",
  "knip.jsonc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "release.config.mjs",
  "rust-toolchain.toml",
  "vite.tauri.config.ts",
  "vitest.config.ts"
]);

export async function loadContextMap(root = ROOT) {
  return JSON.parse(await readFile(resolve(root, MAP_PATH), "utf8"));
}

export function matchesGlob(path, glob) {
  return globToRegExp(glob).test(normalizePath(path));
}

export async function analyzeContext({
  root = ROOT,
  contextMap,
  intents = [],
  paths = [],
  changeKind = "unknown",
  hostPlatform = process.platform
}) {
  if (!CHANGE_KINDS.has(changeKind)) throw new Error(`invalid change kind ${changeKind}`);
  const map = contextMap ?? await loadContextMap(root);
  const normalizedPaths = paths.map((path) => normalizeRepositoryPath(root, path));
  const reasonsByArea = new Map();

  for (const intent of intents) {
    const area = map.areas.find((candidate) =>
      candidate.id === intent || candidate.intentAliases.includes(intent)
    );
    if (!area) throw new Error(`unknown intent ${intent}`);
    addReason(reasonsByArea, area.id, `intent:${intent}`);
  }

  for (const path of normalizedPaths) {
    const matchingAreas = map.areas.filter((area) =>
      area.pathGlobs.some((glob) => matchesGlob(path, glob))
    );
    if (isRoutedPath(path) && matchingAreas.length === 0) {
      throw new Error(`unclassified repository path ${path}`);
    }
    for (const area of matchingAreas) addReason(reasonsByArea, area.id, `path:${path}`);
  }

  if (reasonsByArea.size === 0) {
    throw new Error("no task area matched; pass --intent, --paths, or --changed");
  }

  const matchedAreas = map.areas
    .filter((area) => reasonsByArea.has(area.id))
    .map((area) => ({ ...area, reasons: reasonsByArea.get(area.id) }));
  const validationProfiles = unique(matchedAreas.flatMap((area) => area.validationProfiles));
  const fastChecks = unique(validationProfiles.flatMap((profile) =>
    map.validationProfiles[profile].fastChecks
  ));
  const requiredChecks = unique(validationProfiles.flatMap((profile) =>
    map.validationProfiles[profile].requiredChecks
  ));
  const platforms = unique(matchedAreas.flatMap((area) => area.platforms));
  const featureMatches = map.featurePaths
    .filter((entry) => normalizedPaths.some((path) =>
      entry.pathGlobs.some((glob) => matchesGlob(path, glob))
    ))
    .map((entry) => entry.feature);
  const e2eFeatures = unique([
    ...matchedAreas.flatMap((area) => area.e2eFeatures),
    ...featureMatches
  ]);
  const journeys = changeKind === "user-visible" || changeKind === "unknown"
    ? await journeysForFeatures(root, e2eFeatures)
    : [];
  const host = hostName(hostPlatform);

  return {
    changeKind,
    paths: normalizedPaths,
    areas: matchedAreas.map(({ id, reasons }) => ({ id, reasons })),
    contextFiles: unique([
      ...map.alwaysContext,
      ...matchedAreas.flatMap((area) => area.contextFiles)
    ]),
    canonicalDocs: unique(matchedAreas.flatMap((area) => area.canonicalDocs)),
    risks: unique(matchedAreas.flatMap((area) => area.risks)),
    fastChecks,
    requiredChecks,
    platforms: {
      required: platforms,
      local: platforms.filter((platform) => platform === "portable" || platform === host),
      pending: platforms.filter((platform) => platform !== "portable" && platform !== host)
    },
    e2e: {
      features: e2eFeatures,
      candidateJourneys: journeys,
      omissionReason: ["internal-only", "compile-only", "lower-layer-covered"].includes(changeKind)
        ? changeKind
        : null
    }
  };
}

export async function collectChangedPaths(root = ROOT, base) {
  const commands = base
    ? [
        ["diff", "--name-only", `${base}...HEAD`],
        ["diff", "--name-only"],
        ["diff", "--name-only", "--cached"],
        ["ls-files", "--others", "--exclude-standard"]
      ]
    : [
        ["diff", "--name-only"],
        ["diff", "--name-only", "--cached"],
        ["ls-files", "--others", "--exclude-standard"]
      ];
  const outputs = [];
  for (const args of commands) {
    try {
      const { stdout } = await execute("git", args, { cwd: root, encoding: "utf8" });
      outputs.push(stdout);
    } catch (error) {
      const detail = error?.stderr?.trim() || error?.message || String(error);
      throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
    }
  }
  return unique(outputs.flatMap((output) =>
    output.split(/\r?\n/u).filter(Boolean)
  ).map(normalizePath));
}

export async function validateAiContext(root = ROOT) {
  const failures = [];
  let map;
  try {
    map = await loadContextMap(root);
  } catch (error) {
    return [`${MAP_PATH}: ${error.message}`];
  }
  if (map.schemaVersion !== 1) failures.push(`${MAP_PATH}: schemaVersion must be 1`);
  if (!Array.isArray(map.areas) || map.areas.length === 0) failures.push(`${MAP_PATH}: areas are required`);
  const areaIds = new Set();
  const aliases = new Set();
  for (const area of map.areas ?? []) {
    if (!area.id || areaIds.has(area.id)) failures.push(`${MAP_PATH}: area IDs must be unique`);
    areaIds.add(area.id);
    for (const alias of area.intentAliases ?? []) {
      if (aliases.has(alias)) failures.push(`${MAP_PATH}: duplicate intent alias ${alias}`);
      aliases.add(alias);
    }
    for (const glob of area.pathGlobs ?? []) {
      try { globToRegExp(glob); } catch { failures.push(`${area.id}: invalid glob ${glob}`); }
    }
    for (const profile of area.validationProfiles ?? []) {
      if (!map.validationProfiles?.[profile]) failures.push(`${area.id}: unknown validation profile ${profile}`);
    }
    for (const path of [...(area.contextFiles ?? []), ...(area.canonicalDocs ?? [])]) {
      if (!await exists(resolve(root, path))) failures.push(`${area.id}: missing reference ${path}`);
    }
  }
  for (const path of map.alwaysContext ?? []) {
    if (!await exists(resolve(root, path))) failures.push(`${MAP_PATH}: missing alwaysContext ${path}`);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  } catch {
    packageJson = {};
  }
  for (const [profile, checks] of Object.entries(map.validationProfiles ?? {})) {
    for (const command of [...(checks.fastChecks ?? []), ...(checks.requiredChecks ?? [])]) {
      const match = /^pnpm run ([\w:-]+)$/u.exec(command);
      if (match && !packageJson.scripts?.[match[1]]) {
        failures.push(`${profile}: command references missing package script ${match[1]}`);
      }
    }
  }

  const repositoryFiles = await gitFiles(root);
  for (const path of repositoryFiles.filter(isRoutedPath)) {
    if (!(map.areas ?? []).some((area) => area.pathGlobs.some((glob) => matchesGlob(path, glob)))) {
      failures.push(`${MAP_PATH}: unclassified repository path ${path}`);
    }
  }

  const contextLimits = map.contextFileLimits ?? {};
  for (const path of repositoryFiles.filter((path) =>
    path === ".agents/context.md" || /^\.agents\/context\/[^/]+\.md$/u.test(path)
  )) {
    const source = await readFile(resolve(root, path));
    const lines = lineCount(source.toString("utf8"));
    if (source.length > contextLimits.bytes || lines > contextLimits.lines) {
      failures.push(`${path}: ${lines} lines/${source.length} bytes exceeds context limits`);
    }
  }

  const agentFiles = repositoryFiles.filter((path) => path.endsWith("AGENTS.md"));
  for (const path of agentFiles) {
    const chain = agentFiles.filter((candidate) => appliesToAgentPath(candidate, path));
    let bytes = 0;
    for (const candidate of chain) bytes += (await readFile(resolve(root, candidate))).length;
    if (bytes > map.instructionBudgetBytes) {
      failures.push(`${path}: AGENTS.md instruction chain is ${bytes} bytes`);
    }
  }

  const allowedAgentRootMarkdown = new Set([".agents/AGENTS.md", ".agents/context.md"]);
  for (const path of repositoryFiles.filter((path) => /^\.agents\/[^/]+\.md$/u.test(path))) {
    if (!allowedAgentRootMarkdown.has(path)) failures.push(`${path}: task evidence does not belong in .agents`);
  }
  failures.push(...await validateSkill(root));
  return failures;
}

export function formatContextReport(report) {
  const lines = [
    `Change kind: ${report.changeKind}`,
    `Areas: ${report.areas.map((area) => area.id).join(", ")}`
  ];
  for (const area of report.areas) lines.push(`- ${area.id}: ${area.reasons.join(", ")}`);
  appendList(lines, "Context", report.contextFiles);
  appendList(lines, "Canonical docs", report.canonicalDocs);
  appendList(lines, "Risks", report.risks);
  appendList(lines, "Fast checks", report.fastChecks);
  appendList(lines, "Required checks", report.requiredChecks);
  lines.push(`Platforms local: ${report.platforms.local.join(", ") || "none"}`);
  lines.push(`Platforms pending: ${report.platforms.pending.join(", ") || "none"}`);
  if (report.e2e.features.length > 0) lines.push(`E2E features: ${report.e2e.features.join(", ")}`);
  if (report.e2e.candidateJourneys.length > 0) {
    appendList(lines, "Candidate journeys", report.e2e.candidateJourneys);
  }
  if (report.e2e.omissionReason) lines.push(`E2E omission reason: ${report.e2e.omissionReason}`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.validate) {
    const failures = await validateAiContext(ROOT);
    if (failures.length > 0) throw new Error(`AI context validation failed:\n- ${failures.join("\n- ")}`);
    console.log("AI context validation passed.");
    return;
  }
  const map = await loadContextMap(ROOT);
  if (options.list) {
    for (const area of map.areas) console.log(`${area.id}: ${area.intentAliases.join(", ")}`);
    return;
  }
  for (const path of options.paths) await assertPathExists(ROOT, path);
  const paths = [...options.paths];
  if (options.changed) paths.push(...await collectChangedPaths(ROOT, options.base));
  const report = await analyzeContext({
    root: ROOT,
    contextMap: map,
    intents: options.intents,
    paths,
    changeKind: options.changeKind
  });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatContextReport(report));
}

function parseArguments(args) {
  const options = {
    base: undefined,
    changeKind: "unknown",
    changed: false,
    intents: [],
    json: false,
    list: false,
    paths: [],
    validate: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--changed") options.changed = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--validate") options.validate = true;
    else if (["--base", "--change-kind", "--intent"].includes(argument)) {
      const value = args[index += 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      if (argument === "--base") options.base = value;
      else if (argument === "--change-kind") options.changeKind = value;
      else options.intents.push(value);
    } else if (argument === "--paths") {
      let consumed = 0;
      while (args[index + 1] && !args[index + 1].startsWith("--")) {
        options.paths.push(args[index += 1]);
        consumed += 1;
      }
      if (consumed === 0) throw new Error("--paths requires at least one path");
    } else throw new Error(`unknown option ${argument}`);
  }
  return options;
}

function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "/" && glob.slice(index, index + 3) === "/**") {
      source += "(?:/.*)?";
      index += 2;
    } else if (char === "*") {
      if (glob[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else source += "[^/]*";
    } else source += "\\^$+?.()|{}[]".includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`, "u");
}

function normalizeRepositoryPath(root, path) {
  const repositoryPath = normalizePath(relative(root, resolve(root, path)));
  if (repositoryPath === ".." || repositoryPath.startsWith("../")) {
    throw new Error(`path is outside the repository: ${path}`);
  }
  return repositoryPath;
}

function normalizePath(path) {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

function isRoutedPath(path) {
  return ROUTED_ROOT_FILES.has(path) || /^tsconfig(?:\.[^.]+)?\.json$/u.test(path) ||
    ROUTED_ROOTS.some((prefix) => path.startsWith(prefix));
}

function addReason(map, id, reason) {
  if (!map.has(id)) map.set(id, []);
  map.get(id).push(reason);
}

function unique(values) {
  return [...new Set(values)];
}

async function journeysForFeatures(root, features) {
  if (features.length === 0) return [];
  const manifest = JSON.parse(await readFile(resolve(root, "docs/e2e-coverage.json"), "utf8"));
  return manifest.journeys
    .filter((journey) => features.includes(journey.feature))
    .map((journey) => journey.id);
}

function hostName(platform) {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "other";
}

function appendList(lines, heading, values) {
  if (values.length === 0) return;
  lines.push(`${heading}:`);
  for (const value of values) lines.push(`- ${value}`);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function assertPathExists(root, path) {
  const normalized = normalizeRepositoryPath(root, path);
  if (!await exists(resolve(root, normalized))) throw new Error(`missing path ${normalized}`);
}

async function gitFiles(root) {
  const { stdout } = await execute(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const files = unique(stdout.split(/\r?\n/u).filter(Boolean).map(normalizePath));
  const existing = [];
  for (const path of files) {
    if (await exists(resolve(root, path))) existing.push(path);
  }
  return existing;
}

function lineCount(source) {
  if (source.length === 0) return 0;
  return source.split(/\r?\n/u).length - (source.endsWith("\n") ? 1 : 0);
}

function appliesToAgentPath(candidate, target) {
  if (candidate === "AGENTS.md") return true;
  return target === candidate || target.startsWith(`${dirname(candidate)}/`);
}

async function validateSkill(root) {
  const failures = [];
  const skillPath = resolve(root, ".agents/skills/rion-task-router/SKILL.md");
  const metadataPath = resolve(root, ".agents/skills/rion-task-router/agents/openai.yaml");
  if (!await exists(skillPath)) return ["missing rion-task-router skill"];
  if (!await exists(metadataPath)) return ["missing rion-task-router agents/openai.yaml"];
  const skill = await readFile(skillPath, "utf8");
  const metadata = await readFile(metadataPath, "utf8");
  if (!/^---\nname: rion-task-router\ndescription: .+\n---/u.test(skill)) {
    failures.push("rion-task-router: invalid SKILL.md frontmatter");
  }
  if (skill.includes("TODO")) failures.push("rion-task-router: unresolved TODO");
  if (!metadata.includes('display_name: "Rion Task Router"') ||
      !metadata.includes("$rion-task-router")) {
    failures.push("rion-task-router: stale agents/openai.yaml metadata");
  }
  return failures;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
