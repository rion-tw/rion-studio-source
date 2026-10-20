import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("collects Windows distribution evidence beside the E2E job and still fails on E2E failure", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const [, afterE2eHeader] = workflow.split("  electron-platform-validation:");
  const [e2eJob, distributionJob] = afterE2eHeader!.split("  electron-distribution-validation:");
  expect(e2eJob).toBeDefined();
  expect(distributionJob).toBeDefined();
  expect(e2eJob).toContain("id: chromium_windows_smoke\n        continue-on-error: true");
  expect(e2eJob).toContain(
    "if: ${{ !cancelled() && runner.os == 'Windows' && steps.chromium_windows_smoke.outcome != 'success' }}\n        run: exit 1"
  );
  expect(e2eJob!.indexOf("Require complete Windows Chromium E2E after independent package evidence"))
    .toBeGreaterThan(e2eJob!.indexOf("Upload Chromium shell E2E diagnostics"));
  // Packaging no longer waits for, or reruns with, the desktop E2E job.
  expect(e2eJob).not.toContain("pnpm run verify:electron:windows-nsis-process-gate");
  expect(distributionJob!.split("    steps:")[0]).not.toContain("needs:");
  expect(distributionJob).toContain("pnpm run verify:electron:windows-nsis-process-gate");
  expect(distributionJob!.indexOf("pnpm run verify:electron:windows-nsis-process-gate"))
    .toBeGreaterThan(distributionJob!.indexOf('Remove-Item -LiteralPath "Env:$($_.Name)"'));
});
