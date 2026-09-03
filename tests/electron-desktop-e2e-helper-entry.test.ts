import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entryObservations = vi.hoisted(() => ({
  desktopE2e: vi.fn(),
  productionMain: vi.fn()
}));

vi.mock("../src/electron/e2e/index", () => {
  entryObservations.desktopE2e();
  return {};
});

vi.mock("../src/electron/main/index", () => {
  entryObservations.productionMain();
  return {};
});

const originalArgv = [...process.argv];

function replaceArgv(...argv: string[]): void {
  process.argv.splice(0, process.argv.length, ...argv);
}

describe("Electron desktop E2E fixed helper entry", () => {
  beforeEach(() => {
    vi.resetModules();
    entryObservations.desktopE2e.mockClear();
    entryObservations.productionMain.mockClear();
  });

  afterEach(() => replaceArgv(...originalArgv));

  it("delegates helper argv to production main before E2E seed or observers load", async () => {
    replaceArgv(
      originalArgv[0] ?? "electron",
      "--rion-internal-chrome-profile-helper"
    );

    await import("../src/electron/e2e/entry");

    expect(entryObservations.productionMain).toHaveBeenCalledOnce();
    expect(entryObservations.desktopE2e).not.toHaveBeenCalled();
  });

  it("preserves the normal desktop E2E entry when helper mode is absent", async () => {
    replaceArgv(originalArgv[0] ?? "electron", "out/main/index.js");

    await import("../src/electron/e2e/entry");

    expect(entryObservations.desktopE2e).toHaveBeenCalledOnce();
    expect(entryObservations.productionMain).not.toHaveBeenCalled();
  });

  it("routes the E2E build through the side-effect-free dispatcher", () => {
    const configuration = readFileSync("electron.vite.config.ts", "utf8");
    const entry = readFileSync("src/electron/e2e/entry.ts", "utf8");

    expect(configuration).toContain(
      'desktopE2eBuild ? "src/electron/e2e/entry.ts" : "src/electron/main/index.ts"'
    );
    expect(configuration).toContain("input: { index: electronMainInput }");
    expect(entry).not.toMatch(/from\s+["']electron["']/u);
    expect(entry).toContain('await import("../main/index")');
    expect(entry).toContain('await import("./index")');
  });
});
