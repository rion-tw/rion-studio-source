import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY_PATTERN = "rion-tw\\/(?:rion-studio-source|rion-studio)";

export function sanitizePublicReleaseNotes(source) {
  const compareLink = new RegExp(
    `\\[([^\\]]+)\\]\\(https:\\/\\/github\\.com\\/${REPOSITORY_PATTERN}\\/compare\\/[^)]+\\)`,
    "gu"
  );
  const commitSuffix = new RegExp(
    `\\s*\\(\\[[0-9a-f]{7,40}\\]\\(https:\\/\\/github\\.com\\/${REPOSITORY_PATTERN}\\/commit\\/[0-9a-f]{40}\\)\\)`,
    "giu"
  );
  const repositoryUrl = new RegExp(
    `https:\\/\\/github\\.com\\/${REPOSITORY_PATTERN}(?:\\/[^\\s)]+)?`,
    "giu"
  );
  const privateRepositoryName = /rion-tw\/rion-studio-source/giu;

  return source
    .replace(commitSuffix, "")
    .replace(compareLink, "$1")
    .replace(repositoryUrl, "")
    .replace(privateRepositoryName, "Rion Studio")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .concat("\n");
}

export function assertPublicReleaseNotesSafe(source) {
  const forbidden = [
    /rion-studio-source/iu,
    /github\.com\/rion-tw\/rion-studio\/(?:commit|compare)\//iu,
    /github\.com\/rion-tw\/rion-studio-source/iu
  ];

  for (const pattern of forbidden) {
    if (pattern.test(source)) {
      throw new Error(`Public release notes contain a forbidden source reference: ${pattern}`);
    }
  }
}

async function runCli() {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    throw new Error(
      "Usage: node scripts/sanitizePublicReleaseNotes.mjs <input-notes> <output-notes>"
    );
  }

  const sanitized = sanitizePublicReleaseNotes(await readFile(resolve(inputPath), "utf8"));
  assertPublicReleaseNotesSafe(sanitized);
  await writeFile(resolve(outputPath), sanitized, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
