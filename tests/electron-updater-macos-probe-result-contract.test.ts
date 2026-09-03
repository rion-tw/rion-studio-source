import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ELECTRON_UPDATER_MACOS_BUNDLE_PROBE_RESULT_NAME,
  readElectronUpdaterMacosBundleProbeResult
} from "../scripts/electronUpdaterMacosProbeResultContract.mjs";

describe("macOS updater probe result contract", () => {
  it("admits two executed v23-runtime transitions with arbitrary app SemVer", async () => {
    const fixture = await createFixture(bundleCases());
    try {
      await expect(readElectronUpdaterMacosBundleProbeResult(fixture))
        .resolves.toMatchObject({ cases: bundleCases() });
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects an applied self-transition", async () => {
    const cases = bundleCases();
    cases[1] = { ...cases[1], targetVersion: cases[1].sourceVersion };
    const fixture = await createFixture(cases);
    try {
      await expect(readElectronUpdaterMacosBundleProbeResult(fixture))
        .rejects.toThrow("strictly newer");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects results that repeat one source version", async () => {
    const cases = bundleCases();
    cases[1] = { ...cases[1], sourceVersion: cases[0].sourceVersion };
    const fixture = await createFixture(cases);
    try {
      await expect(readElectronUpdaterMacosBundleProbeResult(fixture))
        .rejects.toThrow("source versions must be distinct");
    } finally {
      await fixture.cleanup();
    }
  });
});

function bundleCases() {
  return [
    {
      outcome: "applied",
      probe: "macos-bundle-replacement",
      sourceRuntime: "electron-v23",
      sourceVersion: "8.4.2",
      targetVersion: "8.6.0"
    },
    {
      outcome: "applied",
      probe: "macos-bundle-replacement",
      sourceRuntime: "electron-v23",
      sourceVersion: "8.5.0",
      targetVersion: "8.6.0"
    }
  ];
}

async function createFixture(cases: ReturnType<typeof bundleCases>) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "rion-macos-probe-result-"));
  const resultPath = join(
    fixtureRoot,
    ELECTRON_UPDATER_MACOS_BUNDLE_PROBE_RESULT_NAME
  );
  await writeFile(resultPath, JSON.stringify({ cases }), { mode: 0o600 });
  return {
    cleanup: () => rm(fixtureRoot, { force: true, recursive: true }),
    fixtureRoot,
    resultPath
  };
}
