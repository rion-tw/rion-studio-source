import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";

const options = parseArguments(process.argv.slice(2));
const version = requiredOption("version");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("--version must be a semantic version without a leading v.");
}
const macDmg = resolve(requiredOption("mac-dmg"));
const windowsInstaller = resolve(requiredOption("windows-installer"));
const outputDirectory = resolve(requiredOption("output-directory"));
const releaseDate = options.get("published-at") ?? new Date().toISOString();
if (Number.isNaN(Date.parse(releaseDate))) throw new Error("--published-at must be RFC 3339.");

await mkdir(outputDirectory, { recursive: true });
await writeManifest("latest-mac.yml", await artifact(macDmg));
await writeManifest("latest.yml", await artifact(windowsInstaller));

async function writeManifest(name, file) {
  const source = [
    `version: ${version}`,
    "files:",
    `  - url: ${file.name}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
    `path: ${file.name}`,
    `sha512: ${file.sha512}`,
    `releaseDate: '${releaseDate}'`,
    ""
  ].join("\n");
  await writeFile(join(outputDirectory, name), source, { encoding: "utf8", flag: "wx" });
}

async function artifact(path) {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0) throw new Error(`${path} is not a release artifact.`);
  return { name: basename(path), sha512: await sha512(path), size: details.size };
}

function sha512(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha512");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("base64")));
  });
}

function requiredOption(name) {
  const value = options.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function parseArguments(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (parsed.has(key)) throw new Error(`Duplicate option --${key}.`);
    parsed.set(key, value);
  }
  return parsed;
}
