import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

describe("system-only product gate", () => {
  const execute = promisify(execFile);

  it("is a required CI and signed-candidate check", async () => {
    const [packageJson, ci, release, preflight, buildWorkflow, candidate, gate] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile(".github/workflows/release.yml", "utf8"),
      readFile(".github/workflows/tauri-release-preflight.yml", "utf8"),
      readFile(".github/workflows/tauri-release-build.yml", "utf8"),
      readFile(".github/workflows/tauri-release-candidate.yml", "utf8"),
      readFile("scripts/verifySystemOnlyProduct.mjs", "utf8")
    ]);
    const build = buildWorkflow.slice(
      buildWorkflow.indexOf("  build:"),
      buildWorkflow.indexOf("  manifest:")
    );

    expect(packageJson).toContain(
      '"verify:system-only": "node scripts/verifySystemOnlyProduct.mjs"'
    );
    expect(ci).toContain("pnpm run verify:system-only");
    expect(release).toContain("- await-preflight");
    expect(release).toContain("- verify-upgrade-compatibility");
    expect(release).toContain("ref: ${{ needs.await-preflight.outputs.source_ref }}");
    expect(preflight).toContain("uses: ./.github/workflows/tauri-release-build.yml");
    expect(preflight).toContain("source_ref: ${{ needs.plan-release.outputs.source_ref }}");
    expect(buildWorkflow).toContain("source_ref:");
    expect(buildWorkflow).not.toContain("verified_sha:");
    expect(candidate).toContain("verified_sha:");
    expect(candidate).toContain("run_quality: ${{ github.event_name == 'workflow_dispatch' }}");
    expect(build).not.toContain("pnpm run verify:system-only");
    expect(gate).toContain("CdnCompatibilityManager");
    expect(gate).toContain("ExternalChrome");
    expect(gate).toContain("ChromeProfileImport");
    expect(gate).toContain("proxy_url");
    expect(gate).toContain("BrowserProxySettingsRecord");
    expect(gate).toContain("CoreEffectAction still exposes");
  });

  it("executes the product gate instead of checking only source strings", async () => {
    await expect(execute(process.execPath, ["scripts/verifySystemOnlyProduct.mjs"], {
      cwd: process.cwd()
    })).resolves.toMatchObject({ stderr: "" });
  }, 10_000);

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

  it.each([
    ["renderer raw proxy flag", 'export const argument = "--proxy-server=http://127.0.0.1:9";\n', "--proxy-server"],
    ["Electron proxy API", "export const apply = session.setProxy;\n", "session.setProxy"],
    ["unapproved native proxy property", "void apply(id store) { store.proxyConfigurations = nil; }\n", "proxyConfigurations"]
  ])("rejects retired %s anywhere", async (_name, source, token) => {
    const directory = await mkdtemp(join(tmpdir(), "rion-proxy-negative-"));
    const fixture = join(directory, "proxy-fixture.ts");
    try {
      await writeFile(fixture, source);
      await expect(execute(process.execPath, [
        "scripts/verifySystemOnlyProduct.mjs",
        "--probe",
        fixture
      ], { cwd: process.cwd() })).rejects.toMatchObject({
        stderr: expect.stringContaining(token)
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
