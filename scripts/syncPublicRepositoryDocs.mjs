import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_DOCUMENT_FILES = [
  { sourcePath: "README.md", targetPath: "README.md" },
  { sourcePath: "docs/README.ja.md", targetPath: "docs/README.ja.md" },
  { sourcePath: "docs/README.zh-CN.md", targetPath: "docs/README.zh-CN.md" },
  { sourcePath: "docs/README.zh-TW.md", targetPath: "docs/README.zh-TW.md" },
  { sourcePath: "NOTICE.md", targetPath: "NOTICE.md" },
  { sourcePath: "SECURITY.md", targetPath: "SECURITY.md" },
  { sourcePath: "SUPPORT.md", targetPath: "SUPPORT.md" },
  {
    sourcePath: "docs/public-repository/CONTRIBUTING.md",
    targetPath: ".github/CONTRIBUTING.md"
  }
];

export const PUBLIC_DOCUMENT_TREES = [
  { sourcePath: "docs/legal", targetPath: "docs/legal" },
  { sourcePath: ".github/assets", targetPath: ".github/assets" }
];

const MANAGED_FILE_TARGETS = new Set(PUBLIC_DOCUMENT_FILES.map(({ targetPath }) => targetPath));
const MANAGED_TREE_TARGETS = PUBLIC_DOCUMENT_TREES.map(({ targetPath }) => `${targetPath}/`);

export function gitBlobSha(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export function assertUniqueDocumentTargets(entries) {
  const targets = new Set();
  for (const { targetPath } of entries) {
    const normalized = posix.normalize(targetPath);
    if (
      !targetPath
      || targetPath.startsWith("/")
      || targetPath.includes("\\")
      || normalized !== targetPath
      || normalized === ".."
      || normalized.startsWith("../")
    ) {
      throw new Error(`Unsafe public document target: ${targetPath}`);
    }
    if (targets.has(targetPath)) {
      throw new Error(`Duplicate public document target: ${targetPath}`);
    }
    targets.add(targetPath);
  }
}

async function collectTree(root, sourceRoot, targetRoot) {
  const directory = resolve(root, sourceRoot);
  const entries = [];
  const visit = async (relativePath) => {
    const children = await readdir(join(directory, relativePath), { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childRelativePath = relativePath ? join(relativePath, child.name) : child.name;
      if (child.isDirectory()) {
        await visit(childRelativePath);
      } else if (child.isFile()) {
        const sourcePath = posix.join(sourceRoot, childRelativePath.split(posix.sep).join("/"));
        const targetPath = posix.join(targetRoot, childRelativePath.split(posix.sep).join("/"));
        const content = await readFile(resolve(root, sourcePath));
        entries.push({ sourcePath, targetPath, content, sha: gitBlobSha(content) });
      }
    }
  };
  await visit("");
  return entries;
}

export async function collectPublicDocuments(root = process.cwd()) {
  const entries = [];
  for (const { sourcePath, targetPath } of PUBLIC_DOCUMENT_FILES) {
    const content = await readFile(resolve(root, sourcePath));
    entries.push({ sourcePath, targetPath, content, sha: gitBlobSha(content) });
  }
  for (const { sourcePath, targetPath } of PUBLIC_DOCUMENT_TREES) {
    entries.push(...await collectTree(root, sourcePath, targetPath));
  }
  entries.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  assertUniqueDocumentTargets(entries);
  return entries;
}

function isManagedDocumentPath(path) {
  return MANAGED_FILE_TARGETS.has(path)
    || MANAGED_TREE_TARGETS.some((prefix) => path.startsWith(prefix));
}

export function planPublicDocumentChanges(desiredEntries, remoteEntries) {
  assertUniqueDocumentTargets(desiredEntries);
  const desired = new Map(desiredEntries.map((entry) => [entry.targetPath, entry]));
  const remote = new Map(
    remoteEntries
      .filter(({ type }) => type === "blob" || type === "commit")
      .map((entry) => [entry.path, entry])
  );
  const changes = [];
  for (const entry of desiredEntries) {
    const existing = remote.get(entry.targetPath);
    if (!existing) {
      changes.push({ action: "add", path: entry.targetPath, entry });
    } else if (existing.sha !== entry.sha || existing.mode !== "100644" || existing.type !== "blob") {
      changes.push({ action: "update", path: entry.targetPath, entry });
    }
  }
  for (const entry of remoteEntries) {
    if (
      (entry.type === "blob" || entry.type === "commit")
      && isManagedDocumentPath(entry.path)
      && !desired.has(entry.path)
    ) {
      changes.push({ action: "delete", path: entry.path });
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertPublicDocumentsMatch(desiredEntries, remoteEntries) {
  const changes = planPublicDocumentChanges(desiredEntries, remoteEntries);
  if (changes.length > 0) {
    throw new Error(`Public document verification failed: ${changes
      .map(({ action, path }) => `${action}:${path}`)
      .join(", ")}`);
  }
}

export function shouldSynchronizeLatestTag(tag, latestTag) {
  return tag === latestTag;
}

function createGitHubApi(repository, token = process.env.GH_TOKEN) {
  if (!repository) throw new Error("A public repository is required.");
  if (!token) throw new Error("GH_TOKEN is required to synchronize public documents.");
  return {
    async request(endpoint, options = {}) {
      const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "rion-studio-public-document-sync",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`GitHub API ${response.status} for ${endpoint}: ${body.message ?? "unknown error"}`);
      }
      return body;
    }
  };
}

export async function synchronizePublicDocuments({
  api: providedApi,
  repository,
  root = process.cwd(),
  tag,
  branch = "main"
}) {
  const api = providedApi ?? createGitHubApi(repository);
  const latest = await api.request("releases/latest");
  const latestTag = latest.tag_name;
  if (!shouldSynchronizeLatestTag(tag, latestTag)) {
    return { status: "skipped-not-latest", latestTag };
  }

  const desiredEntries = await collectPublicDocuments(root);
  const reference = await api.request(`git/ref/heads/${branch}`);
  const commitSha = reference.object.sha;
  const currentCommit = await api.request(`git/commits/${commitSha}`);
  const currentTree = await api.request(`git/trees/${currentCommit.tree.sha}?recursive=1`);
  if (currentTree.truncated) throw new Error("The public repository tree response was truncated.");
  const changes = planPublicDocumentChanges(desiredEntries, currentTree.tree);
  if (changes.length === 0) return { status: "unchanged", commitSha };

  const tree = [];
  for (const change of changes) {
    if (change.action === "delete") {
      tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await api.request("git/blobs", {
      method: "POST",
      body: { content: change.entry.content.toString("base64"), encoding: "base64" }
    });
    tree.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const createdTree = await api.request("git/trees", {
    method: "POST",
    body: { base_tree: currentCommit.tree.sha, tree }
  });
  const createdCommit = await api.request("git/commits", {
    method: "POST",
    body: {
      message: `docs: synchronize public documents for ${tag}`,
      tree: createdTree.sha,
      parents: [commitSha]
    }
  });
  await api.request(`git/refs/heads/${branch}`, {
    method: "PATCH",
    body: { sha: createdCommit.sha, force: false }
  });
  const updatedCommit = await api.request(`git/commits/${createdCommit.sha}`);
  const updated = await api.request(`git/trees/${updatedCommit.tree.sha}?recursive=1`);
  if (updated.truncated) throw new Error("The updated public repository tree response was truncated.");
  assertPublicDocumentsMatch(desiredEntries, updated.tree);
  return { status: "updated", commitSha: createdCommit.sha, changes };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${name ?? ""}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const repository = argumentsMap.get("repository");
  const tag = argumentsMap.get("tag");
  if (!repository || !tag) {
    throw new Error("Usage: syncPublicRepositoryDocs.mjs --repository owner/name --tag vX.Y.Z");
  }
  const result = await synchronizePublicDocuments({ repository, tag });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
