import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("retains Windows E2E failure after collecting independent package evidence", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const electronChecks = workflow.split("  electron-platform-validation:")[1]
    ?.split("  desktop-e2e:")[0];
  expect(electronChecks).toBeDefined();
  expect(electronChecks).toContain("id: chromium_windows_smoke\n        continue-on-error: true");
  expect(electronChecks).toContain(
    "if: ${{ !cancelled() && runner.os == 'Windows' && steps.chromium_windows_smoke.outcome != 'success' }}\n        run: exit 1"
  );
  expect(electronChecks!.indexOf("Require complete Windows Chromium E2E after independent package evidence"))
    .toBeGreaterThan(electronChecks!.indexOf("Upload packaged Chromium Role black-box E2E diagnostics"));
  expect(electronChecks).toContain("pnpm run verify:electron:windows-nsis-process-gate");
  expect(electronChecks!.indexOf("pnpm run verify:electron:windows-nsis-process-gate"))
    .toBeGreaterThan(electronChecks!.indexOf('Remove-Item -LiteralPath "Env:$($_.Name)"'));
});
