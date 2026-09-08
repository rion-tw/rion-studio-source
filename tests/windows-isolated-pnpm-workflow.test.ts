import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

it("keeps isolated CI commands on the native pnpm entrypoint verified during setup", async () => {
  const workflow = (await readFile(".github/workflows/ci.yml", "utf8"))
    .replace(/\r\n/gu, "\n");
  const job = workflow.slice(
    workflow.indexOf("  electron-platform-validation:"),
    workflow.indexOf("  desktop-e2e:")
  );
  // A shim bypasses the native child-execution proof and grants path access
  // to the shim directory instead of the actual executable's directory.
  expect(job).not.toContain("Get-Command pnpm.cmd");
  expect(job.match(/Get-Command pnpm\.exe -ErrorAction Stop/gu)).toHaveLength(2);
  const nativeSetup = job.indexOf("./scripts/selectWindowsPnpm.ps1");
  expect(nativeSetup).toBeGreaterThan(0);
  for (const stepName of [
    "Verify packaged Windows Rust-owned updater transactions",
    "Run packaged Windows Chromium Role black-box E2E"
  ]) {
    const start = job.indexOf(`- name: ${stepName}`);
    const nextStep = job.indexOf("\n      - name:", start + 1);
    const step = job.slice(start, nextStep);
    expect(start).toBeGreaterThan(nativeSetup);
    expect(step).toContain("Get-Command pnpm.exe -ErrorAction Stop");
    expect(step).toContain("-CommandPath $pnpm");
    if (stepName.includes("updater")) {
      expect(step).toContain("$sourceSha = (& git rev-parse HEAD).Trim()");
      expect(step).toContain('"--diagnostics-source-sha", $sourceSha');
      expect(step).toContain('"--diagnostics-output", "$env:GITHUB_WORKSPACE\\.desktop-e2e-artifacts\\packaged-updater-probe-observations.json"');
    }
  }
});
