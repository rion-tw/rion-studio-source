import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

// Every target is regenerable by a documented command, so the worst outcome of a
// removal is a slower next build. The groups exist so reclaiming 20 GB of E2E
// evidence does not also discard a warm 6.7 GB Rust target directory.
const groups = {
  artifacts: {
    description: "Desktop E2E run evidence",
    regenerate: "pnpm run test:e2e:desktop",
    paths: [".desktop-e2e-artifacts"]
  },
  build: {
    description: "Bundler, packaging and native addon output",
    regenerate: "pnpm run build:electron",
    paths: ["out", "release", join("build", "native")]
  },
  rust: {
    description: "Cargo target directory",
    regenerate: "pnpm run build:electron:rust",
    paths: ["target"]
  }
};

// Spotlight indexes these continuously while they churn. The marker files are
// themselves ignored output, so they are restored after a removal.
const spotlightMarker = ".metadata_never_index";
const spotlightExclusions = ["target", ".desktop-e2e-artifacts"];

const argumentsList = process.argv.slice(2);
const unknown = argumentsList.filter((argument) =>
  argument !== "--delete" && !Object.keys(groups).includes(argument.replace(/^--/u, "")));
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(", ")}`);
  console.error(`Usage: cleanGeneratedOutput.mjs [--${Object.keys(groups).join("] [--")}] [--delete]`);
  process.exit(2);
}

const del = argumentsList.includes("--delete");
const selectedNames = Object.keys(groups).filter((name) => argumentsList.includes(`--${name}`));
const selected = selectedNames.length > 0 ? selectedNames : Object.keys(groups);

let totalByteLength = 0;
let removedByteLength = 0;
for (const name of selected) {
  const group = groups[name];
  console.log(`\n${name} — ${group.description} (regenerate with \`${group.regenerate}\`)`);
  for (const path of group.paths) {
    const absolutePath = resolve(repositoryRoot, path);
    // A path that escapes the repository, or that is not ignored by git, is never
    // removed: only regenerable, untracked output is in scope for this script.
    const relativePath = relative(repositoryRoot, absolutePath);
    if (relativePath.startsWith("..") || relativePath.startsWith(sep)) {
      throw new Error(`Refusing to act outside the repository: ${path}`);
    }
    if (!(await isIgnoredByGit(relativePath))) {
      throw new Error(`Refusing to remove a path git does not ignore: ${relativePath}`);
    }

    const byteLength = await directoryByteLength(absolutePath);
    if (byteLength === undefined) {
      console.log(`  absent   ${relativePath}`);
      continue;
    }
    totalByteLength += byteLength;
    console.log(`  ${formatBytes(byteLength).padStart(9)}  ${relativePath}`);
    if (del) {
      const excluded = spotlightExclusions.includes(path) &&
        await stat(join(absolutePath, spotlightMarker)).then(() => true, () => false);
      await rm(absolutePath, { recursive: true, force: true });
      removedByteLength += byteLength;
      // Removing the directory also removes its Spotlight exclusion marker, which
      // would otherwise silently lapse and let mds index the next rebuild.
      if (excluded) {
        await mkdir(absolutePath, { recursive: true });
        await writeFile(join(absolutePath, spotlightMarker), "");
      }
    }
  }
}

console.log("");
if (del) {
  console.log(`Removed ${formatBytes(removedByteLength)}.`);
} else {
  console.log(`${formatBytes(totalByteLength)} is reclaimable.`);
  console.log("Nothing was removed. Re-run the same command with --delete to remove it.");
}

async function isIgnoredByGit(relativePath) {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", relativePath], { cwd: repositoryRoot });
    return true;
  } catch {
    return false;
  }
}

async function directoryByteLength(absolutePath) {
  const statistics = await stat(absolutePath).catch(() => undefined);
  if (statistics === undefined) return undefined;
  if (!statistics.isDirectory()) return statistics.size;

  let total = 0;
  const pending = [absolutePath];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const entryStatistics = await stat(entryPath).catch(() => undefined);
      if (entryStatistics !== undefined) total += entryStatistics.size;
    }
  }
  return total;
}

function formatBytes(byteLength) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = byteLength;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
