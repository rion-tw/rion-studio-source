import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("updater install transaction contract", () => {
  it("exports typed attempts and every recoverable update state", async () => {
    const [attempt, status, api] = await Promise.all([
      readFile("src/shared/generated/AppUpdateInstallAttemptRecord.ts", "utf8"),
      readFile("src/shared/generated/AppUpdateStatusRecord.ts", "utf8"),
      readFile("src/shared/api.ts", "utf8")
    ]);

    for (const phase of [
      "accepted",
      "preparing",
      "installing",
      "draining",
      "installerHandoff",
      "restartPending",
      "applied",
      "failedBeforeDrain",
      "failedAfterDrain"
    ]) {
      expect(attempt).toContain(`"${phase}"`);
    }
    for (const stateName of [
      "preparing",
      "installing",
      "draining",
      "restart_pending",
      "install_failed"
    ]) {
      expect(status).toContain(`"${stateName}"`);
    }
    expect(api).toContain("installDownloadedUpdate: () => Promise<AppUpdateInstallAttempt>");
  });

});
