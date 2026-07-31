import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

describe("system-only product gate", () => {
  const execute = promisify(execFile);

  it("is a required CI and signed-candidate check", async () => {
    const [packageJson, ci, release, candidate, gate] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
      readFile(".github/workflows/tauri-release-candidate.yml", "utf8"),
      readFile("scripts/verifySystemOnlyProduct.mjs", "utf8")
    ]);
    const candidateBuild = candidate.slice(
      candidate.indexOf("  build:"),
      candidate.indexOf("  manifest:")
    );

    expect(packageJson).toContain(
      '"verify:system-only": "node scripts/verifySystemOnlyProduct.mjs"'
    );
    expect(ci).toContain("pnpm run verify:system-only");
    expect(release).toContain("verified_sha: ${{ needs.validate-ci-run.outputs.source_ref }}");
    expect(candidate).toContain("verified_sha:");
    expect(candidate).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(candidateBuild).not.toContain("pnpm run verify:system-only");
    expect(gate).toContain("CdnCompatibilityManager");
    expect(gate).toContain("ExternalChrome");
    expect(gate).toContain("ChromeProfileImport");
    expect(gate).toContain("proxy_url");
    expect(gate).toContain("CoreEffectAction still exposes");
  });

  it("executes the product gate instead of checking only source strings", async () => {
    await expect(execute(process.execPath, ["scripts/verifySystemOnlyProduct.mjs"], {
      cwd: process.cwd()
    })).resolves.toMatchObject({ stderr: "" });
  });

  it("rejects a negative fixture that reintroduces remote debugging", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-system-only-negative-"));
    const fixture = join(directory, "retired-runtime.ts");
    try {
      await writeFile(fixture, 'export const argument = "remote-debugging-port";\n');
      await expect(execute(process.execPath, [
        "scripts/verifySystemOnlyProduct.mjs",
        "--probe",
        fixture
      ], { cwd: process.cwd() })).rejects.toMatchObject({
        stderr: expect.stringContaining("remote-debugging-port")
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
