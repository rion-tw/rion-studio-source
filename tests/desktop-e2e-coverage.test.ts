import { appendFile, copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateDesktopE2eCoverage } from "../scripts/checkDesktopE2eCoverage.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
type CoverageManifest = {
  journeys: Array<{
    coverageGroup?: string;
    id: string;
    phases?: string[];
    platforms?: string[];
    profile?: string;
    replaces?: string[];
  }>;
  profiles: Record<string, { runtimeTarget: string; specs: string[] }>;
  runtimeTargets: Record<string, {
    cutoverRequired: boolean;
    driver: string;
    platforms: string[];
    status: string;
  }>;
  stateCombinations: Array<{ id: string; spec: string }>;
};

async function createCoverageFixture(): Promise<string> {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rion-e2e-coverage-"));
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
  ) as CoverageManifest;
  const specs = new Set<string>(
    Object.values(manifest.profiles).flatMap((profile) => profile.specs)
  );
  await mkdir(resolve(temporaryRoot, "docs"), { recursive: true });
  await mkdir(resolve(temporaryRoot, "e2e/desktop"), { recursive: true });
  await writeFile(
    resolve(temporaryRoot, "docs/e2e-coverage.json"),
    JSON.stringify(manifest)
  );
  await copyFile(
    resolve(repositoryRoot, "e2e/desktop/wdio.conf.ts"),
    resolve(temporaryRoot, "e2e/desktop/wdio.conf.ts")
  );
  await copyFile(
    resolve(repositoryRoot, "e2e/desktop/phaseSpecs.ts"),
    resolve(temporaryRoot, "e2e/desktop/phaseSpecs.ts")
  );
  for (const spec of specs) {
    await mkdir(dirname(resolve(temporaryRoot, spec)), { recursive: true });
    await copyFile(resolve(repositoryRoot, spec), resolve(temporaryRoot, spec));
  }
  return temporaryRoot;
}

describe("desktop E2E coverage policy", () => {
  it("accepts the repository journey manifest", async () => {
    const result = await validateDesktopE2eCoverage(repositoryRoot);
    expect(result.failures).toEqual([]);
    expect(result.manifest.runtimeTargets).toMatchObject({
      "tauri-v22": { status: "active-compatibility", cutoverRequired: false },
      "chromium-v23-macos-appkit": {
        status: "planned",
        cutoverRequired: true,
        driver: "electron",
        platforms: ["macos"]
      },
      "chromium-v23-windows": {
        status: "planned",
        cutoverRequired: true,
        driver: "electron",
        platforms: ["windows"]
      }
    });
    expect(result.cutoverParity).toEqual({
      "chromium-v23-macos-appkit": {
        covered: 40,
        required: 40,
        missingJourneyIds: []
      },
      "chromium-v23-windows": {
        covered: 40,
        required: 40,
        missingJourneyIds: []
      }
    });
  });

  it("blocks a cutover target from becoming active before every v22 P0/P1 replacement exists", async () => {
    const temporaryRoot = await createCoverageFixture();
    const manifestPath = resolve(temporaryRoot, "docs/e2e-coverage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CoverageManifest;
    manifest.journeys = manifest.journeys.filter(
      ({ id }) => id !== "CHROMIUM-MACOS-APPKIT-MACRO-BACKGROUND-TAB-004"
    );
    manifest.runtimeTargets["chromium-v23-macos-appkit"]!.status = "active-compatibility";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContainEqual(expect.stringMatching(
      /^chromium-v23-macos-appkit: cutover parity is incomplete \(39\/40; missing MACRO-BACKGROUND-TAB-004\)$/u
    ));
  });

  it("rejects replacement claims that change the source journey semantics", async () => {
    const temporaryRoot = await createCoverageFixture();
    const manifestPath = resolve(temporaryRoot, "docs/e2e-coverage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CoverageManifest;
    const chromiumGame = manifest.journeys.find(
      (journey) => journey.id === "CHROMIUM-MACOS-APPKIT-GAME-CRUD-002"
    );
    if (!chromiumGame) throw new Error("Expected the macOS Chromium Game journey");
    chromiumGame.replaces = ["APP-LEGAL-001"];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContain(
      "CHROMIUM-MACOS-APPKIT-GAME-CRUD-002: replacement APP-LEGAL-001 must retain priority, feature, journey kind, risk, and every source outcome"
    );
  });

  it("retains exact replacement accounting independently for each cutover target", async () => {
    const temporaryRoot = await createCoverageFixture();
    const manifestPath = resolve(temporaryRoot, "docs/e2e-coverage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CoverageManifest;
    for (const id of [
      "CHROMIUM-MACOS-APPKIT-GAME-CRUD-002",
      "CHROMIUM-WINDOWS-GAME-CRUD-002"
    ]) {
      const journey = manifest.journeys.find((candidate) => candidate.id === id);
      if (!journey) throw new Error(`Expected Chromium cutover journey ${id}`);
      journey.replaces = ["GAMES-UI-001"];
    }
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toEqual([]);
    expect(result.cutoverParity["chromium-v23-macos-appkit"]).toMatchObject({
      covered: 40,
      required: 40
    });
    expect(result.cutoverParity["chromium-v23-windows"]).toMatchObject({
      covered: 40,
      required: 40
    });
  });

  it("pairs the exact background-tab replacement without sharing native verdicts", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const journeys = manifest.journeys.filter(
      ({ coverageGroup }) => coverageGroup === "chromium-v23-macro-background-tab"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map(({ platforms }) => platforms)).toEqual([["macos"], ["windows"]]);
    expect(journeys.every((journey) =>
      journey.replaces?.length === 1 &&
      journey.replaces[0] === "MACRO-BACKGROUND-TAB-004"
    )).toBe(true);
    expect(journeys[0]?.phases).toEqual(["chromium-macro-background-tab"]);
    expect(journeys[1]?.phases).toEqual([
      "chromium-windows-trusted-input-physical",
      "chromium-macro-background-tab"
    ]);
  });

  it("pairs both Chromium app CRUD replacements without sharing platform verdicts", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    for (const [coverageGroup, replacement, phases] of [
      [
        "chromium-v23-app-full-crud",
        "APP-FULL-CRUD-001",
        ["chromium-app-crud-mutations", "chromium-app-crud-cleanup"]
      ],
      [
        "chromium-v23-app-crud-reorder",
        "APP-CRUD-REORDER-002",
        [
          "chromium-app-crud-mutations",
          "chromium-app-crud-cleanup",
          "chromium-app-crud-final-restart"
        ]
      ]
    ] as const) {
      const journeys = manifest.journeys.filter(
        (journey) => journey.coverageGroup === coverageGroup
      );
      expect(journeys).toHaveLength(2);
      expect(journeys.map((journey) => journey.platforms)).toEqual([["macos"], ["windows"]]);
      expect(journeys.every((journey) =>
        journey.replaces?.length === 1
          && journey.replaces[0] === replacement
          && JSON.stringify(journey.phases) === JSON.stringify(phases)
      )).toBe(true);
    }
  });

  it("pairs the exact system-settings replacement without sharing platform verdicts", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const journeys = manifest.journeys.filter(
      (journey) => journey.coverageGroup === "chromium-v23-system-settings"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([["macos"], ["windows"]]);
    expect(journeys.every((journey) =>
      journey.replaces?.length === 1
        && journey.replaces[0] === "SETTINGS-SYSTEM-001"
        && JSON.stringify(journey.phases) === JSON.stringify(["chromium-system-settings"])
    )).toBe(true);
  });

  it("pairs the exact application quit-guard replacement without sharing platform verdicts", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const journeys = manifest.journeys.filter(
      (journey) => journey.coverageGroup === "chromium-v23-application-quit-guard"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([["macos"], ["windows"]]);
    expect(journeys.every((journey) =>
      journey.replaces?.length === 1
        && journey.replaces[0] === "APP-QUIT-GUARD-002"
        && JSON.stringify(journey.phases) === JSON.stringify([
          "chromium-quit-guard-seed",
          "chromium-quit-guard-restart"
        ])
    )).toBe(true);
  });

  it("pairs the exact Game Window UI replacement without sharing native verdicts", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const journeys = manifest.journeys.filter(
      (journey) => journey.coverageGroup === "chromium-v23-game-window-ui"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([["macos"], ["windows"]]);
    expect(journeys.every((journey) =>
      journey.replaces?.length === 1
        && journey.replaces[0] === "GAME-WINDOWS-UI-001"
        && JSON.stringify(journey.phases) === JSON.stringify([
          "chromium-game-window-ui-seed",
          "chromium-game-window-ui-restart"
        ])
    )).toBe(true);
  });

  it("pairs the exact mixed Workspace Web replacement without sharing native verdicts", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const journeys = manifest.journeys.filter(
      (journey) => journey.coverageGroup === "chromium-v23-workspace-web-slot"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([["macos"], ["windows"]]);
    expect(journeys.every((journey) =>
      journey.replaces?.length === 1
        && journey.replaces[0] === "WORKSPACE-WEB-SLOT-004"
        && JSON.stringify(journey.phases) === JSON.stringify([
          "chromium-workspace-web-slot-seed",
          "chromium-workspace-web-slot-restart"
        ])
    )).toBe(true);
  });

  it("rejects merging the AppKit and Windows Chromium cutover targets", async () => {
    const temporaryRoot = await createCoverageFixture();
    const manifestPath = resolve(temporaryRoot, "docs/e2e-coverage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CoverageManifest;
    manifest.runtimeTargets["chromium-v23-macos-appkit"]!.platforms = ["macos", "windows"];
    delete manifest.runtimeTargets["chromium-v23-windows"];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContain(
      "runtime targets must retain separate macOS AppKit and Windows Chromium cutover gates"
    );
  });

  it("rejects inheriting evidence from a different runtime target", async () => {
    const temporaryRoot = await createCoverageFixture();
    const manifestPath = resolve(temporaryRoot, "docs/e2e-coverage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CoverageManifest;
    manifest.profiles.full!.runtimeTarget = "chromium-v23-windows";
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContain(
      "full: inherited profiles must use the same runtime target"
    );
  });

  it("requires platform-scoped Chromium P0/P1 journeys to have the other cutover target", async () => {
    const temporaryRoot = await createCoverageFixture();
    const manifestPath = resolve(temporaryRoot, "docs/e2e-coverage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as CoverageManifest;
    const windowsJourney = manifest.journeys.find(
      (journey) => journey.id === "CHROMIUM-WINDOWS-GAME-CRUD-002"
    );
    if (!windowsJourney) throw new Error("Expected the Windows Chromium Game journey");
    delete windowsJourney.coverageGroup;
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContain(
      "chromium-v23-game-crud: cutover coverage group must pair equivalent automated macOS and Windows P0/P1 journeys"
    );
    expect(result.failures).toContain(
      "CHROMIUM-WINDOWS-GAME-CRUD-002: P0/P1 journeys must cover macos and windows or join a platform-complete cutover group"
    );
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
    await copyFile(
      resolve(repositoryRoot, "e2e/desktop/phaseSpecs.ts"),
      resolve(temporaryRoot, "e2e/desktop/phaseSpecs.ts")
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
    await copyFile(
      resolve(repositoryRoot, "e2e/desktop/phaseSpecs.ts"),
      resolve(temporaryRoot, "e2e/desktop/phaseSpecs.ts")
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

  it("rejects automated P0/P1 journeys without phase evidence", async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rion-e2e-coverage-"));
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, "docs/e2e-coverage.json"), "utf8")
    ) as CoverageManifest;
    const legal = manifest.journeys.find((journey) => journey.id === "APP-LEGAL-001");
    if (!legal) throw new Error("Expected the legal journey");
    delete legal.phases;
    const specs = new Set<string>(Object.values(manifest.profiles).flatMap((profile) => profile.specs));
    await mkdir(resolve(temporaryRoot, "docs"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "e2e/desktop"), { recursive: true });
    await writeFile(resolve(temporaryRoot, "docs/e2e-coverage.json"), JSON.stringify(manifest));
    await copyFile(
      resolve(repositoryRoot, "e2e/desktop/wdio.conf.ts"),
      resolve(temporaryRoot, "e2e/desktop/wdio.conf.ts")
    );
    await copyFile(
      resolve(repositoryRoot, "e2e/desktop/phaseSpecs.ts"),
      resolve(temporaryRoot, "e2e/desktop/phaseSpecs.ts")
    );
    for (const spec of specs) {
      await mkdir(dirname(resolve(temporaryRoot, spec)), { recursive: true });
      await copyFile(resolve(repositoryRoot, spec), resolve(temporaryRoot, spec));
    }

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContain(
      "APP-LEGAL-001: automated P0/P1 journey must list evidence phases"
    );
  });

  it("rejects a missing state-combination marker", async () => {
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
    await copyFile(
      resolve(repositoryRoot, "e2e/desktop/phaseSpecs.ts"),
      resolve(temporaryRoot, "e2e/desktop/phaseSpecs.ts")
    );
    for (const spec of specs) {
      await mkdir(dirname(resolve(temporaryRoot, spec)), { recursive: true });
      await copyFile(resolve(repositoryRoot, spec), resolve(temporaryRoot, spec));
    }
    const combination = manifest.stateCombinations[0];
    if (!combination) throw new Error("Expected one state combination");
    const target = resolve(temporaryRoot, combination.spec);
    const marker = `[state-combination:${combination.id}]`;
    await writeFile(target, (await readFile(target, "utf8")).replace(marker, "removed-marker"));

    const result = await validateDesktopE2eCoverage(temporaryRoot);
    expect(result.failures).toContain(
      `${combination.id}: spec is missing its state-combination marker`
    );
  });
});
