import { appendFile, copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateDesktopE2eCoverage } from "../scripts/checkDesktopE2eCoverage.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
type CoverageManifest = {
  profiles: Record<string, { specs: string[] }>;
};

describe("desktop E2E coverage policy", () => {
  it("accepts the repository journey manifest", async () => {
    const result = await validateDesktopE2eCoverage(repositoryRoot);
    expect(result.failures).toEqual([]);
  });

  it("rejects a missing journey marker", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rion-e2e-coverage-"));
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const specs = new Set<string>(Object.values(manifest.profiles).flatMap((profile) => profile.specs));
    await mkdir(resolve(temporaryRoot, "docs"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "e2e/desktop"), { recursive: true });
    await writeFile(resolve(temporaryRoot, "docs/e2e-coverage.json"), JSON.stringify(manifest));
    await copyFile(
      resolve(repositoryRoot, "e2e/desktop/wdio.conf.ts"),
      resolve(temporaryRoot, "e2e/desktop/wdio.conf.ts")
    );
    for (const spec of specs) {
      await mkdir(dirname(resolve(temporaryRoot, spec)), { recursive: true });
      await writeFile(resolve(temporaryRoot, spec), "// no journey markers\n");
    }

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures.some((failure) => failure.includes("spec is missing its journey marker"))).toBe(true);
  });

  it("rejects a duplicate journey marker", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rion-e2e-coverage-"));
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const specs = new Set<string>(Object.values(manifest.profiles).flatMap((profile) => profile.specs));
    await mkdir(resolve(temporaryRoot, "docs"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "e2e/desktop"), { recursive: true });
    await writeFile(resolve(temporaryRoot, "docs/e2e-coverage.json"), JSON.stringify(manifest));
    await copyFile(
      resolve(repositoryRoot, "e2e/desktop/wdio.conf.ts"),
      resolve(temporaryRoot, "e2e/desktop/wdio.conf.ts")
    );
    for (const spec of specs) {
      await mkdir(dirname(resolve(temporaryRoot, spec)), { recursive: true });
      await copyFile(resolve(repositoryRoot, spec), resolve(temporaryRoot, spec));
    }
    await appendFile(
      resolve(temporaryRoot, "e2e/desktop/specs/app-journeys.e2e.ts"),
      "\n// [journey:APP-LEGAL-001]\n"
    );

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContain("APP-LEGAL-001: journey marker must appear exactly once");
  });
});
