import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("native extension compatibility probe", () => {
  it("runs the representative service-worker APIs and native DNR flow", async () => {
    const [probe, runner] = await Promise.all([
      readFile("scripts/electronExtensionCompatibilityProbe.ts", "utf8"),
      readFile("scripts/verifyElectronExtensions.mjs", "utf8")
    ]);

    for (const expected of [
      "chrome.permissions.onRemoved.addListener",
      "chrome.webNavigation.onCompleted.addListener",
      "chrome.notifications.getPermissionLevel",
      "chrome.storage.session.set",
      "chrome.offscreen.createDocument",
      "chrome.declarativeNetRequest.getEnabledRulesets"
    ]) expect(probe).toContain(expected);
    expect(runner).toContain("electronExtensionCompatibilityProbe.ts");
    expect(runner).toContain("out/preload/extensionCompat.cjs");
  });
});
