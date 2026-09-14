import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);

it.skipIf(process.platform !== "darwin")("retains one AppKit workspace background through resize, mount, and rejected projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rion-workspace-background-"));
  try {
    const path = join(directory, "evidence.json");
    await promisify(execFile)(require("electron") as string,
      ["scripts/probeWorkspaceBackground.cjs", path, join(directory, "data")], { timeout: 30_000 });
    const result = JSON.parse(await readFile(path, "utf8"));
    expect(result.platform).toBe("darwin");
    expect(result.beforeProjectionCoverage).toBe(true);
    expect(result.rejectedProjectionPreserved).toBe(true);
    expect(result.observations).toHaveLength(14);
    expect(new Set(result.observations.map((item: { address: string }) => item.address)).size).toBe(1);
    expect(new Set(result.observations.slice(1).map((item: { nativeViews: number }) => item.nativeViews)).size).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
