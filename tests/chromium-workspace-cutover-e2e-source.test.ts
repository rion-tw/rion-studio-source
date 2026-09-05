import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { desktopE2eSpecForPhase } from "../e2e/desktop/phaseSpecs";
import {
  chromiumWorkspaceCutoverPhaseDependencies,
  chromiumWorkspaceCutoverPhaseNamespaces,
  isChromiumWorkspaceCutoverPhase,
  validateChromiumWorkspaceCutoverRuntimeEvidence,
  validateChromiumWorkspaceCutoverSqliteEvidence
} from "../scripts/desktopE2eChromiumWorkspaceCutoverEvidence.mjs";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

const settings = [{
  key: "runtimeRestoreSession",
  payload: { cleanExit: true, liveWindowIds: [] }
}];

function webOnlyObservation(input: Readonly<{
  attemptGeneration: string;
  generation: number;
  phase: "activating" | "degraded" | "ready";
  visible: boolean;
}>) {
  const tabId = "00000000-0000-4000-8000-000000000031";
  const windowId = "00000000-0000-4000-8000-000000000032";
  const profile = "/tmp/web-profiles/global-web/chromium";
  const contentUrl = input.phase === "degraded"
    ? "http://127.0.0.1:1/rion-navigation-failure"
    : "https://fixture.invalid/role/chromium-workspace-web-only";
  return {
    appKitIdentity: {
      launchGeneration: input.attemptGeneration,
      logicalWindowId: windowId,
      nativeGeneration: input.generation
    },
    attemptGeneration: input.attemptGeneration,
    coreSlots: [{
      id: "slot-1",
      rect: { height: 1, width: 1, x: 0, y: 0 },
      roleId: null,
      web: {
        name: "Chromium Web Only App",
        startUrl: "https://fixture.invalid/role/chromium-workspace-web-only"
      }
    }],
    focused: input.visible,
    hostKind: "appkit-chromium",
    parentNativeHostId: 41,
    phase: input.phase,
    popups: [],
    presentation: "normal",
    role: null,
    tabId,
    topologyRevision: input.generation,
    visible: input.visible,
    web: {
      canGoBack: input.phase === "degraded",
      canGoForward: false,
      chromeBounds: { height: 34, width: 960, x: 0, y: 8 },
      chromeShellSession: "rion-web-chrome-shell:memory",
      chromeShellStoragePath: null,
      chromeShellUrl: "file:///runtime-web-chrome-electron.html",
      chromeVisible: input.visible,
      containedFullscreen: false,
      containedFullscreenRevision: 0,
      contentBounds: { height: 598, width: 960, x: 0, y: 42 },
      contentProfilePath: profile,
      contentSession: "global-web-persistent",
      contentSessionStoragePath: profile,
      contentUrl,
      contentVisible: input.visible,
      generation: input.generation,
      isolatedSessions: true,
      slotBounds: { height: 632, width: 960, x: 0, y: 8 },
      slotId: "slot-1",
      surfaceId: `web-${tabId}-1`,
      tabId,
      visible: input.visible
    },
    windowBounds: { height: 640, width: 960, x: 32, y: 50 },
    windowGeneration: input.generation,
    windowId
  };
}

async function validateWebOnlyHistory(
  observations: readonly ReturnType<typeof webOnlyObservation>[]
) {
  const directory = await mkdtemp(join(tmpdir(), "rion-web-only-evidence-"));
  try {
    await writeFile(
      join(directory, "electron-workspace-web-only-observations.json"),
      JSON.stringify(observations)
    );
    return await validateChromiumWorkspaceCutoverRuntimeEvidence({
      phase: "chromium-workspace-web-only-seed",
      phaseDirectory: directory,
      platform: "macos"
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Chromium Workspace cutover paired replacements", () => {
  it("accepts only the hidden activating projection sampled during visible reopen", async () => {
    const ready = webOnlyObservation({
      attemptGeneration: "attempt-1", generation: 1, phase: "ready", visible: true
    });
    const degraded = webOnlyObservation({
      attemptGeneration: "attempt-1", generation: 1, phase: "degraded", visible: true
    });
    const activating = webOnlyObservation({
      attemptGeneration: "attempt-2", generation: 2, phase: "activating", visible: false
    });
    const recovered = webOnlyObservation({
      attemptGeneration: "attempt-2", generation: 2, phase: "ready", visible: true
    });

    await expect(validateWebOnlyHistory([
      ready, degraded, activating, recovered
    ])).resolves.toMatchObject({ navigationFailureRecovered: true });
    await expect(validateWebOnlyHistory([
      ready, degraded, recovered
    ])).resolves.toMatchObject({ navigationFailureRecovered: true });
    await expect(validateWebOnlyHistory([
      ready,
      degraded,
      { ...activating, focused: true, visible: true },
      recovered
    ])).rejects.toThrow("malformed Core/native Web-only history");
  });

  it("routes independent Web-only, shared-Role, and recovery phase state", () => {
    const routes = {
      "chromium-workspace-shared-role":
        "e2e/desktop/specs/chromium-workspace-shared-role.e2e.ts",
      "chromium-workspace-web-only-restart":
        "e2e/desktop/specs/chromium-workspace-web-only.e2e.ts",
      "chromium-workspace-web-only-seed":
        "e2e/desktop/specs/chromium-workspace-web-only.e2e.ts",
      "chromium-workspaces-recovery":
        "e2e/desktop/specs/chromium-workspaces-recovery.e2e.ts"
    } as const;
    for (const [phase, spec] of Object.entries(routes)) {
      expect(desktopE2eSpecForPhase(phase)).toBe(spec);
      expect(isChromiumWorkspaceCutoverPhase(phase)).toBe(true);
    }
    expect(chromiumWorkspaceCutoverPhaseDependencies).toEqual([[
      "chromium-workspace-web-only-restart",
      ["chromium-workspace-web-only-seed"]
    ]]);
    expect(chromiumWorkspaceCutoverPhaseNamespaces).toEqual([
      ["chromium-workspace-web-only-seed", "chromium-workspace-web-only-lifecycle"],
      ["chromium-workspace-web-only-restart", "chromium-workspace-web-only-lifecycle"],
      ["chromium-workspace-shared-role", "chromium-workspace-shared-role-lifecycle"],
      ["chromium-workspaces-recovery", "chromium-workspaces-recovery-lifecycle"]
    ]);
  });

  it("uses visible controls while preserving retained AppKit and exact Core fences", async () => {
    const [webOnly, shared, recovery, placeholder, reporter, coreFailure, coreStatus,
      appKit] = await Promise.all([
        source("e2e/desktop/specs/chromium-workspace-web-only.e2e.ts"),
        source("e2e/desktop/specs/chromium-workspace-shared-role.e2e.ts"),
        source("e2e/desktop/specs/chromium-workspaces-recovery.e2e.ts"),
        source("src/electron/main/chromiumRuntimeRolePlaceholderRegistry.ts"),
        source("src/electron/main/chromiumRoleNavigationFailureReporter.ts"),
        source("crates/rion-core/src/app/section_08_stop_embedded_workspace_with_operation_lease.rs"),
        source("crates/rion-core/src/app/section_06_acquire_browser_operation_async.rs"),
        source("src/electron/main/macosAppKitRuntimeHostFactory.ts")
      ]);
    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024",
      "CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024",
      "button=New game window",
      "quick-access-destination-workspace-${workspace.id}",
      "quick-access-destination-option-window-${gameWindow.id}",
      "button[aria-label='Open workspace']",
      "navigateVisibleElectronWorkspaceWebChrome",
      "closeVisibleRuntimeTab",
      "const restored = await waitInspectionPhase(saved.id, \"ready\")",
      "listRoleStatuses",
      "chromeShellStoragePath: null",
      "contentSession: \"global-web-persistent\""
    ]) expect(webOnly).toContain(marker);
    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-WORKSPACE-SHARED-ROLE-025",
      "CHROMIUM-WINDOWS-WORKSPACE-SHARED-ROLE-025",
      '"#claim"',
      "ownerGeneration",
      "electronDesktopE2eRolePlaceholderRuntime"
    ]) expect(shared).toContain(marker);
    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-WORKSPACES-RECOVERY-026",
      "CHROMIUM-WINDOWS-WORKSPACES-RECOVERY-026",
      '"#active-navigation-failure"',
      "navigation-requested",
      "stopCutoverWindow",
      'fixtureRequest("/api/gate"',
      "healthyAfter.coreStatus",
      "failingAfter.nativeOwner.generation"
    ]) expect(recovery).toContain(marker);
    for (const spec of [webOnly, shared, recovery]) {
      expect(spec).not.toContain("runtimeUiAction(");
      expect(spec).not.toContain("controlWindow(");
      expect(spec).not.toContain("setTimeout(");
      expect(spec).not.toContain("setInterval(");
    }

    expect(placeholder).toContain("ELECTRON_ROLE_PLACEHOLDER_ACTION_STALE");
    expect(placeholder).toContain("Core did not terminalize the exact visible Role-slot claim");
    expect(placeholder).toContain('session.storagePath !== null');
    expect(reporter).toContain("expectedOwnerGeneration");
    expect(reporter).toContain("expectedTabId");
    expect(reporter).toContain('code === "RUNTIME_ROLE_OWNER_STALE"');
    expect(coreFailure).toContain("runtime_authority_barrier");
    expect(coreFailure).toContain("let affected_role_ids = [role_id.to_owned()]");
    expect(coreStatus).toContain("Runtime issues belong to the exact Role surface");
    expect(coreStatus).toContain("failed sibling surface must not degrade another Role");
    expect(appKit).not.toContain("runtime-role-placeholder-electron.html");
  });

  it("publishes six platform-scoped replacement verdicts and aggregate evidence", async () => {
    const [manifestSource, aggregate, evidence] = await Promise.all([
      source("docs/e2e-coverage.json"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumWorkspaceCutoverEvidence.mjs")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    for (const [group, replacement, phases, outcomes] of [
      [
        "chromium-v23-workspace-web-only",
        "WORKSPACE-WEB-ONLY-006",
        ["chromium-workspace-web-only-seed", "chromium-workspace-web-only-restart"],
        ["success", "failure", "restart"]
      ],
      [
        "chromium-v23-workspace-shared-role",
        "WORKSPACE-SHARED-ROLE-003",
        ["chromium-workspace-shared-role"],
        ["success", "failure"]
      ],
      [
        "chromium-v23-workspaces-recovery",
        "WORKSPACES-RECOVERY-002",
        ["chromium-workspaces-recovery"],
        ["success", "failure", "cancel"]
      ]
    ] as const) {
      const journeys = manifest.journeys.filter(
        (journey) => journey.coverageGroup === group
      );
      expect(journeys).toHaveLength(2);
      expect(journeys.map((journey) => journey.platforms)).toEqual([
        ["macos"],
        ["windows"]
      ]);
      for (const journey of journeys) {
        expect(journey.replaces).toEqual([replacement]);
        expect(journey.phases).toEqual(phases);
        expect(journey.outcomes).toEqual(outcomes);
      }
    }
    for (const profile of [
      manifest.profiles["chromium-macos-appkit-smoke"],
      manifest.profiles["chromium-windows-smoke"]
    ]) {
      expect(profile.phases).toEqual(expect.arrayContaining([
        "chromium-workspace-web-only-seed",
        "chromium-workspace-web-only-restart",
        "chromium-workspace-shared-role",
        "chromium-workspaces-recovery"
      ]));
      expect(profile.specs).toEqual(expect.arrayContaining([
        "e2e/desktop/specs/chromium-workspace-web-only.e2e.ts",
        "e2e/desktop/specs/chromium-workspace-shared-role.e2e.ts",
        "e2e/desktop/specs/chromium-workspaces-recovery.e2e.ts"
      ]));
    }
    expect(aggregate).toContain("...chromiumWorkspaceCutoverPhaseDependencies");
    expect(aggregate).toContain("...chromiumWorkspaceCutoverPhaseNamespaces");
    expect(aggregate).toContain("validateChromiumWorkspaceCutoverRuntimeEvidence(input)");
    expect(aggregate).toContain("validateChromiumWorkspaceCutoverSqliteEvidence(");
    expect(evidence).toContain("ready/degraded/visible-reopen ordering");
    expect(evidence).toContain("http://127.0.0.1:1/rion-navigation-failure");
    expect(evidence).toContain("observation.visible === false");
    expect(evidence).toContain("observation.phase === \"ready\" && observation.visible");
    expect(evidence).toContain("observation.placeholders.length <= 1");
    expect(evidence).toContain("zero-placeholder transfer gap");
    expect(evidence).toContain("terminal Core owner transfer");
    expect(evidence).toContain("failure isolation, no-auto-recovery");
  });

  it("rejects inexact durable Workspace definitions", () => {
    const rect = { height: 1, width: 1, x: 0, y: 0 };
    const webEntities = {
      games: [], gameWindows: [], macros: [], roles: [],
      workspaces: [{ id: "web-workspace", name: "Chromium Web Only Workspace",
        payload: { slots: [{ id: "web-slot", rect, roleId: null, web: {
          name: "Chromium Web Only App",
          startUrl: "https://127.0.0.1/role/chromium-workspace-web-only"
        } }] } }]
    };
    expect(validateChromiumWorkspaceCutoverSqliteEvidence(
      "chromium-workspace-web-only-seed",
      webEntities,
      settings
    )).toMatchObject({ emptyRoleTopology: true, workspaceId: "web-workspace" });
    expect(() => validateChromiumWorkspaceCutoverSqliteEvidence(
      "chromium-workspace-web-only-seed",
      { ...webEntities, roles: [{ id: "synthetic", name: "Chromium Web Only Role" }] },
      settings
    )).toThrow("synthesized a persistent Role");

    const shared = { id: "shared", name: "Chromium Shared Role", payload: {} };
    const uniqueA = { id: "unique-a", name: "Chromium Shared Workspace A Role", payload: {} };
    const uniqueB = { id: "unique-b", name: "Chromium Shared Workspace B Role", payload: {} };
    const sharedEntities = {
      games: [], gameWindows: [], macros: [], roles: [shared, uniqueA, uniqueB],
      workspaces: [
        { id: "workspace-a", name: "Chromium Shared Workspace A", payload: {
          slots: [{ rect, roleId: shared.id }, { rect, roleId: uniqueA.id }]
        } },
        { id: "workspace-b", name: "Chromium Shared Workspace B", payload: {
          slots: [{ rect, roleId: shared.id }, { rect, roleId: uniqueB.id }]
        } }
      ]
    };
    expect(validateChromiumWorkspaceCutoverSqliteEvidence(
      "chromium-workspace-shared-role",
      sharedEntities,
      settings
    )).toMatchObject({ sharedRoleId: "shared" });
  });
});
