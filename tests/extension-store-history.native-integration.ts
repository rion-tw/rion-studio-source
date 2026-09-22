import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
it.skipIf(!["darwin", "win32"].includes(process.platform))("restores SPA history documents without losing Forward in native Chromium", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-store-history-"));
  try {
    const helper = join(directory, "history.cjs");
    await build({ entryPoints: ["src/electron/main/extensionStoreHistoryNavigation.ts"],
      bundle: true, platform: "node", format: "cjs", outfile: helper });
    const evidence = join(directory, "evidence.json");
    await promisify(execFile)(require("electron") as string,
      ["scripts/probeExtensionStoreHistory.cjs", evidence, join(directory, "data"), helper], { timeout: 30_000 });
    const result = JSON.parse(await readFile(evidence, "utf8"));
    expect(result.platform).toBe(process.platform);
    expect(result.observations.map((state: { label: string; heading: string }) => [state.label, state.heading]))
      .toEqual([["detail", "/detail"], ["reload", "/detail"], ["back", "/search"], ["forward", "/detail"], ["back", "/detail"]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
