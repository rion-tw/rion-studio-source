import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyPackagedUpdateConfig(source, expectedRepository) {
  const [owner, repo] = expectedRepository.split("/");
  const expected = new Map([
    ["provider", "github"],
    ["owner", owner],
    ["repo", repo]
  ]);

  for (const [key, value] of expected) {
    const actual = source.match(new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, "mu"))?.[1];
    if (actual !== value) {
      throw new Error(`app-update.yml ${key} ${actual ?? "<missing>"} does not match ${value}`);
    }
  }
}

async function runCli() {
  const [pathArg, repository = "rion-tw/rion-studio"] = process.argv.slice(2);
  if (!pathArg) {
    throw new Error(
      "Usage: node scripts/verifyPackagedUpdateConfig.mjs <app-update.yml> [owner/repo]"
    );
  }

  verifyPackagedUpdateConfig(await readFile(resolve(pathArg), "utf8"), repository);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
