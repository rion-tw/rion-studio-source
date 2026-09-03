import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_SIGNATURE_BYTES = 64 * 1024;

export async function createUpdaterManifest(argumentsList) {
  const options = parseArguments(argumentsList);
  const version = requiredOption(options, "version");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("--version must be a semantic version without a leading v.");
  }

  const baseUrl = new URL(requiredOption(options, "base-url"));
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error("--base-url must use public HTTPS without credentials, query, or fragment.");
  }

  const macArchive = await requiredArtifact(options, "mac-archive");
  const windowsInstaller = await requiredArtifact(options, "windows-installer");
  if (macArchive.archivePath === windowsInstaller.archivePath) {
    throw new Error("macOS and Windows updater artifacts must be different files.");
  }
  const output = path.resolve(requiredOption(options, "output"));
  const notes = options.get("notes-file")
    ? (await readFile(path.resolve(options.get("notes-file")), "utf8")).trim()
    : undefined;
  const publishedAt = options.get("published-at") ?? new Date().toISOString();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(publishedAt) ||
    Number.isNaN(Date.parse(publishedAt))
  ) {
    throw new Error("--published-at must be an RFC 3339 timestamp.");
  }

  const [macPlatform, windowsPlatform] = await Promise.all([
    updaterArtifact(baseUrl, macArchive),
    updaterArtifact(baseUrl, windowsInstaller)
  ]);
  const manifest = {
    version,
    ...(notes ? { notes } : {}),
    pub_date: publishedAt,
    platforms: {
      "darwin-aarch64": macPlatform,
      "windows-x86_64": windowsPlatform
    }
  };

  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export async function runUpdaterManifestCli(argumentsList = process.argv.slice(2)) {
  await createUpdaterManifest(argumentsList);
}

function parseArguments(argumentsList) {
  const parsed = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (parsed.has(key)) throw new Error(`Duplicate option --${key}.`);
    parsed.set(key, value);
  }
  return parsed;
}

function requiredOption(options, name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

async function requiredArtifact(options, name) {
  const archivePath = path.resolve(requiredOption(options, name));
  const signaturePath = `${archivePath}.sig`;
  const [archive, signature] = await Promise.all([
    requiredFile(archivePath),
    requiredFile(signaturePath)
  ]);
  if (archive.size === 0) throw new Error(`${archivePath} is empty.`);
  if (signature.size === 0) throw new Error(`${signaturePath} is empty.`);
  if (signature.size > MAX_SIGNATURE_BYTES) {
    throw new Error(`${signaturePath} exceeds the verified signature size bound.`);
  }
  return { archivePath, signaturePath };
}

async function updaterArtifact(baseUrl, artifact) {
  const [signature, sha256] = await Promise.all([
    readFile(artifact.signaturePath, "utf8").then((value) => value.trim()),
    hashFile(artifact.archivePath)
  ]);
  if (!signature || signature.includes("\0")) {
    throw new Error(`${artifact.signaturePath} is empty or invalid.`);
  }
  return {
    url: new URL(
      encodeURIComponent(path.basename(artifact.archivePath)),
      ensureTrailingSlash(baseUrl)
    ).href,
    signature,
    sha256
  };
}

function ensureTrailingSlash(url) {
  const value = new URL(url);
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}

function hashFile(filePath) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function requiredFile(filePath) {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`${filePath} does not exist.`, { cause: error });
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${filePath} is not a regular file.`);
  }
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runUpdaterManifestCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
