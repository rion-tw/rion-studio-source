import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repositoryRoot = process.cwd();
const { stdout } = await execute("cargo", ["metadata", "--format-version=1", "--no-deps"], {
  cwd: repositoryRoot,
  maxBuffer: 64 * 1024 * 1024
});
const metadata = JSON.parse(stdout);
const workspacePackageIds = new Set(metadata.workspace_members);
const workspacePackages = metadata.packages.filter(({ id }) => workspacePackageIds.has(id));
const failures = [];
const inheritedDependencies = new Set(
  workspacePackages.flatMap(({ dependencies }) => dependencies.map(({ name }) => name))
);
for (const dependency of await workspaceDependencyNames()) {
  if (!inheritedDependencies.has(dependency)) {
    failures.push(`Cargo.toml: unused workspace dependency ${dependency}`);
  }
}

for (const packageMetadata of workspacePackages) {
  const packageRoot = dirname(packageMetadata.manifest_path);
  const sourceFiles = await rustSourceFiles(packageRoot);
  const sources = await Promise.all(sourceFiles.map(async (path) => ({
    path,
    source: await readFile(path, "utf8")
  })));
  for (const dependency of packageMetadata.dependencies) {
    const crateName = (dependency.rename ?? dependency.name).replaceAll("-", "_");
    const relevantSources = dependency.kind === "build"
      ? sources.filter(({ path }) => path === join(packageRoot, "build.rs"))
      : sources;
    const reference = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegex(crateName)}\\s*(?:::|!)`, "mu");
    if (!relevantSources.some(({ source }) => reference.test(source))) {
      failures.push(
        `${relative(repositoryRoot, packageMetadata.manifest_path)}: ` +
        `unused ${dependency.kind ?? "normal"} dependency ${dependency.rename ?? dependency.name}`
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`Cargo dependency hygiene found ${failures.length} violation(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Cargo dependency hygiene passed for ${workspacePackages.length} workspace crates.`);
}

async function workspaceDependencyNames() {
  const manifest = await readFile(join(repositoryRoot, "Cargo.toml"), "utf8");
  const dependencies = [];
  let insideWorkspaceDependencies = false;
  for (const line of manifest.split(/\r?\n/u)) {
    const section = /^\[([^\]]+)\]\s*$/u.exec(line)?.[1];
    if (section !== undefined) {
      if (insideWorkspaceDependencies) break;
      insideWorkspaceDependencies = section === "workspace.dependencies";
      continue;
    }
    if (!insideWorkspaceDependencies) continue;
    const dependency = /^([A-Za-z0-9_-]+)\s*=/u.exec(line)?.[1];
    if (dependency !== undefined) dependencies.push(dependency);
  }
  return dependencies;
}

async function rustSourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "target" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await rustSourceFiles(path));
    else if (entry.isFile() && extname(entry.name) === ".rs") files.push(path);
  }
  return files;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
