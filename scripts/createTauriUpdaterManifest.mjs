import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { runUpdaterManifestCli } from "./createUpdaterManifest.mjs";

export * from "./createUpdaterManifest.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runUpdaterManifestCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
