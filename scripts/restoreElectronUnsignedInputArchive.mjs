import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractSafeTarGzipSubtree } from "./safeTarGzipExtraction.mjs";

const ELECTRON_UNSIGNED_ARCHIVE_ROOT = "release/electron";

export async function restoreElectronUnsignedInputArchive(argumentsList) {
  const parsed = parseArguments(argumentsList);
  return extractSafeTarGzipSubtree({
    archivePath: parsed.archivePath,
    archiveRoot: ELECTRON_UNSIGNED_ARCHIVE_ROOT,
    destinationPath: parsed.destinationPath
  });
}

function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if ((name !== "--archive" && name !== "--destination") || value === undefined) {
      throw new Error(
        "Usage: node scripts/restoreElectronUnsignedInputArchive.mjs --archive <absolute-path> --destination <absolute-create-new-path>"
      );
    }
    if (values.has(name)) throw new Error(`Duplicate argument ${name}.`);
    values.set(name, value);
  }
  if (values.size !== 2) {
    throw new Error("Both --archive and --destination are required.");
  }
  return {
    archivePath: values.get("--archive"),
    destinationPath: values.get("--destination")
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  restoreElectronUnsignedInputArchive(process.argv.slice(2)).then(
    (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
