import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const options = parseArguments(process.argv.slice(2));
const version = requiredOption(options, "version");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("--version must be a semantic version without a leading v.");
}

const baseUrl = new URL(requiredOption(options, "base-url"));
if (baseUrl.protocol !== "https:") {
  throw new Error("--base-url must use HTTPS.");
}

const macArchive = requiredArtifact(options, "mac-archive");
const windowsInstaller = requiredArtifact(options, "windows-installer");
const output = path.resolve(requiredOption(options, "output"));
const notes = options.get("notes-file")
  ? readFileSync(path.resolve(options.get("notes-file")), "utf8").trim()
  : undefined;
const publishedAt = options.get("published-at") ?? new Date().toISOString();
if (Number.isNaN(Date.parse(publishedAt))) {
  throw new Error("--published-at must be an RFC 3339 timestamp.");
}

const manifest = {
  version,
  ...(notes ? { notes } : {}),
  pub_date: publishedAt,
  platforms: {
    "darwin-aarch64": updaterArtifact(baseUrl, macArchive),
    "windows-x86_64": updaterArtifact(baseUrl, windowsInstaller)
  }
};

writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

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

function requiredArtifact(options, name) {
  const archivePath = path.resolve(requiredOption(options, name));
  const signaturePath = `${archivePath}.sig`;
  if (!existsSync(archivePath)) throw new Error(`${archivePath} does not exist.`);
  if (!existsSync(signaturePath)) throw new Error(`${signaturePath} does not exist.`);
  return { archivePath, signaturePath };
}

function updaterArtifact(baseUrl, artifact) {
  const signature = readFileSync(artifact.signaturePath, "utf8").trim();
  if (!signature) throw new Error(`${artifact.signaturePath} is empty.`);
  return {
    url: new URL(encodeURIComponent(path.basename(artifact.archivePath)), ensureTrailingSlash(baseUrl)).href,
    signature
  };
}

function ensureTrailingSlash(url) {
  const value = new URL(url);
  if (!value.pathname.endsWith("/")) value.pathname += "/";
  return value;
}
